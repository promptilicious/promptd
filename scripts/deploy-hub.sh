#!/bin/bash
# Ships this checkout to a hub deployed with infra/terraform, or redeploys an
# image already in ECR.
#
#   ./scripts/deploy-hub.sh               build this commit, push it, deploy it
#   ./scripts/deploy-hub.sh --tag <tag>   deploy an image already pushed (a rollback)
#
# Everything comes from the Terraform outputs in TF_DIR (default infra/terraform),
# so it deploys whichever hub that directory's state describes.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="${TF_DIR:-$PROJECT_DIR/infra/terraform}"
TAG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:?--tag needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  • %s\n' "$*"; }
die()  { printf '\n\033[31mFailed:\033[0m %s\n' "$*" >&2; exit 1; }

output() { terraform -chdir="$TF_DIR" output -raw "$1" 2>/dev/null || die "no '$1' output in $TF_DIR; run terraform apply there first"; }

REPO_URL="$(output ecr_repository_url)"
INSTANCE_ID="$(output hub_instance_id)"
SSM_PREFIX="$(output ssm_prefix)"
HUB_URL="$(output hub_url)"
NAME="$(output name)"
AWS_PROFILE="$(output aws_profile)"
AWS_REGION="$(output aws_region)"
export AWS_PROFILE AWS_REGION
REGISTRY="${REPO_URL%%/*}"

printf '\nDeploying to %s\n\n' "$HUB_URL"

if [ -z "$TAG" ]; then
  cd "$PROJECT_DIR"
  TAG="$(git rev-parse --short=12 HEAD)"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    TAG="$TAG-dirty-$(date -u +%Y%m%d%H%M%S)"
    info "the working tree has uncommitted changes; tagging the image $TAG"
  fi
  aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
  info "building the ARM64 image"
  docker buildx build --platform linux/arm64 -t "$REPO_URL:$TAG" -t "$REPO_URL:latest" --push "$PROJECT_DIR" \
    || die "the image build failed"
  ok "pushed $REPO_URL:$TAG"
else
  aws ecr describe-images --repository-name "${REPO_URL#*/}" --image-ids "imageTag=$TAG" >/dev/null 2>&1 \
    || die "no image tagged $TAG in ${REPO_URL#*/}"
  ok "using $REPO_URL:$TAG, already pushed"
fi

aws ssm put-parameter --overwrite --type String --name "$SSM_PREFIX/IMAGE_TAG" --value "$TAG" >/dev/null
ok "IMAGE_TAG is now $TAG"

COMMAND_ID="$(aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
  --comment "promptd deploy $TAG" --parameters "commands=[\"/opt/$NAME/deploy.sh\"]" \
  --query Command.CommandId --output text)"
info "running deploy.sh on $INSTANCE_ID"
aws ssm wait command-executed --instance-id "$INSTANCE_ID" --command-id "$COMMAND_ID" 2>/dev/null || true
STATUS="$(aws ssm get-command-invocation --instance-id "$INSTANCE_ID" --command-id "$COMMAND_ID" --query Status --output text)"
if [ "$STATUS" != "Success" ]; then
  aws ssm get-command-invocation --instance-id "$INSTANCE_ID" --command-id "$COMMAND_ID" \
    --query '[StandardOutputContent,StandardErrorContent]' --output text | tail -20 >&2
  die "deploy.sh finished with status $STATUS"
fi
ok "deploy.sh succeeded"

for _ in $(seq 1 18); do
  if curl -fsS -m 5 "$HUB_URL/api/health" 2>/dev/null | grep -q '"ok":true'; then
    ok "$HUB_URL answers healthy on $TAG"
    printf '\nRoll back with: %s --tag <earlier tag>\n\n' "$0"
    exit 0
  fi
  sleep 5
done
die "deploy.sh ran, but $HUB_URL did not answer healthy within 90s"
