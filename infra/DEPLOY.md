# Deploying a hub

This puts a promptd hub on the internet, so nodes on any network can reach it:

- **The host.** One ARM EC2 instance runs the hub in Docker behind Caddy, which gets and renews the HTTPS certificate.
- **The data.** The SQLite database and every run log live on their own EBS volume, snapshotted daily.
- **Shipping.** A push to `main` builds the image, stores it in ECR, and restarts the hub on it.

Nodes stay where they are. Each one polls the hub over HTTPS and needs only outbound access.

Everything below is yours to fill in. `promptd.example.com`, `promptd-admin` and the other sample values are placeholders.

## What you need

1. An AWS account, and an AWS CLI profile with admin rights on it. The examples call it `promptd-admin`.
2. A host name whose DNS you control, such as `promptd.example.com`. The steps show Cloudflare; any DNS provider works.
3. Your own copy of this repository on GitHub, so the deploy workflow runs in it.
4. On your machine: Terraform 1.5 or newer, Docker with `buildx`, Node 20 or newer, and a checkout with `npm install` done.

## 1. Create the Terraform state bucket

```sh
cd infra/bootstrap
terraform init
terraform apply -var aws_profile=promptd-admin
```

Note the `state_bucket` and `lock_table` outputs.

## 2. Create the hub

```sh
cd ../terraform
cp example.tfvars terraform.tfvars   # then fill in your values
terraform init \
  -backend-config="bucket=<state_bucket>" \
  -backend-config="dynamodb_table=<lock_table>" \
  -backend-config="region=us-east-1" \
  -backend-config="profile=promptd-admin"
terraform plan -out=tfplan
terraform apply tfplan
```

`terraform.tfvars` is git-ignored. If your AWS account already has a GitHub OIDC provider, for example from another project, set `create_github_oidc_provider = false`.

The instance boots while this runs. Its first attempt to start the hub fails because there is no image yet; step 5 fixes that.

## 3. Store the secrets

Terraform created empty slots under `/promptd/prod` in SSM Parameter Store. Fill them. Use the `ssm_prefix` output if you changed `name`.

```sh
PREFIX=/promptd/prod
PROFILE=promptd-admin

# The web page's admin password. This prompts for it and prints only a hash.
HASH=$(npm run -s set-password -- --print-hash)
aws --profile $PROFILE ssm put-parameter --overwrite --type SecureString \
  --name $PREFIX/PROMPTD_ADMIN_PASSWORD_HASH --value "$HASH"

aws --profile $PROFILE ssm put-parameter --overwrite --type SecureString \
  --name $PREFIX/SESSION_SECRET --value "$(openssl rand -hex 32)"

# The token every node presents. Keep a copy: each node needs it.
NODE_TOKEN=$(openssl rand -hex 32)
aws --profile $PROFILE ssm put-parameter --overwrite --type SecureString \
  --name $PREFIX/PROMPTD_NODE_TOKEN --value "$NODE_TOKEN"
```

The hub refuses to start without an admin password, so this step has to come before the first deploy.

To use Postgres instead of the SQLite file on the data volume, also add a `DATABASE_URL` parameter holding a `postgres://` address.

## 4. Point your DNS at the hub

There are two ways. Pick one with `manage_dns` in `terraform.tfvars`.

**Route 53 (`manage_dns = true`).** Terraform creates a hosted zone for your host name and its A record, and the name is handed to that zone. This costs $0.50 a month for the zone.

```sh
terraform output hub_nameservers
```

At your parent domain's DNS, add four `NS` records for the host (for example `promptd`), one for each nameserver. In Cloudflare, that's DNS → Records → Add record → type `NS`. Cloudflare won't allow an `NS` and an `A` record on the same name, so delete any existing `A` record in the same edit.

**Your own DNS (`manage_dns = false`, the default).** Add one `A` record yourself:

```sh
terraform output hub_ip
```

In Cloudflare, add an `A` record under DNS → Records:

- **Name:** your host, for example `promptd`
- **IPv4 address:** the `hub_ip` output
- **Proxy status:** DNS only, the grey cloud

Leave the proxy off. With it on, Caddy can't get its certificate, and the page loops on redirects. A proxy in between can also hold back the live log and event streams.

Either way, the address is an Elastic IP. It stays the same across deploys, and even when Terraform replaces the instance, so DNS is set once.

## 5. Push the first image

```sh
REPO_URL=$(terraform output -raw ecr_repository_url)
REGISTRY=${REPO_URL%%/*}

aws --profile promptd-admin ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin "$REGISTRY"

cd ../..
docker buildx build --platform linux/arm64 -t "$REPO_URL:bootstrap" --push .
```

Terraform set the `IMAGE_TAG` parameter to `bootstrap`, so this is the tag the hub looks for. The deploy workflow tags later images by commit.

## 6. Start the hub

```sh
cd infra/terraform
INSTANCE_ID=$(terraform output -raw hub_instance_id)
aws --profile promptd-admin ssm send-command --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript --parameters 'commands=["/opt/promptd/deploy.sh"]'
```

Replace `promptd` in the path if you changed `name`. To look around on the host:

```sh
aws --profile promptd-admin ssm start-session --target "$INSTANCE_ID"
sudo docker compose -f /opt/promptd/docker-compose.yml ps
sudo docker compose -f /opt/promptd/docker-compose.yml logs --tail 50
sudo journalctl -u caddy --no-pager -n 50
```

Open `https://promptd.example.com` (your host) and sign in with the password from step 3. The first visit can take a minute while Caddy gets the certificate. If Caddy started before your DNS was in place, it retries on a backoff that can stretch to hours; `sudo systemctl restart caddy` on the host makes it try again straight away.

## 7. Let GitHub deploy

In your repository, under **Settings → Secrets and variables → Actions → Variables**, add:

| Variable | Value |
| --- | --- |
| `AWS_ROLE_ARN` | `terraform output -raw github_deploy_role_arn` |
| `AWS_REGION` | your region, if not `us-east-1` |
| `ECR_REPOSITORY` | `terraform output -raw ecr_repository` |
| `EC2_INSTANCE_ID` | `terraform output -raw hub_instance_id` |
| `SSM_PREFIX` | `terraform output -raw ssm_prefix` |
| `HUB_URL` | `terraform output -raw hub_url` |
| `NAME` | your `name`, if not `promptd` |

Then add an environment called `production` under **Settings → Environments**. Give it a required reviewer if you want to approve each deploy.

From then on, every push to `main` runs the checks, builds the ARM64 image, rolls `IMAGE_TAG`, runs `deploy.sh` on the host, and checks that `/api/health` answers. Without `AWS_ROLE_ARN` the deploy workflow does nothing, which is what keeps forks from trying to ship.

## 8. Connect nodes

On each Mac that should run jobs, in a checkout of this repository:

```sh
NODE_ONLY=1 HUB_URL=https://promptd.example.com NODE_TOKEN=<token from step 3> \
  ./scripts/register-app-mac-os.sh
```

The first node to connect becomes the default node, which runs every job with no node of its own. The hosted hub does not run jobs itself.

Moving from a Mac that already runs a full local install: that Mac's jobs stay in its own hub, and are not moved to the hosted one. Recreate them on the hosted hub, then stop the local hub with `launchctl bootout gui/$(id -u)/local.promptd`. Register the Mac as a node as above, with `FORCE=1` so it replaces the existing node agent.

## Rolling back

Run the `deploy` workflow by hand (**Actions → deploy → Run workflow**) with an earlier image tag. That skips the build and deploys the tag as it is. ECR keeps the 10 most recent tagged images.

By hand:

```sh
aws --profile promptd-admin ssm put-parameter --overwrite --type String \
  --name /promptd/prod/IMAGE_TAG --value <earlier-tag>
aws --profile promptd-admin ssm send-command --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript --parameters 'commands=["/opt/promptd/deploy.sh"]'
```

## Changing a secret

Write the new value with `aws ssm put-parameter --overwrite` as in step 3, then run `deploy.sh` as in step 6. The hub reads its secrets from SSM on every deploy.

- **A new admin password** signs every session out.
- **A new `SESSION_SECRET`** does the same.
- **A new node token** means every node needs it too. Re-register each node with `FORCE=1` and the new `NODE_TOKEN`.

## Restoring from a backup

The data volume is snapshotted daily at 07:00 UTC and each snapshot is kept for 14 days (`backup_retention_days`).

1. In the AWS Backup console, restore a recovery point to a new EBS volume in the same availability zone.
2. Stop the instance and detach the current `promptd-data` volume.
3. Attach the restored volume as `/dev/sdf`, then start the instance. It mounts by filesystem label, which the restore keeps.

## Tearing it down

`terraform destroy` removes everything except the data volume, which is protected so a refactor cannot delete your jobs and logs. To delete it as well, remove `prevent_destroy` from `compute.tf` first.
