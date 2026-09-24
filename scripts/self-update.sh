#!/bin/bash
# Applies a pending update and restarts the server.
#
# Started detached by src/updater.js, because the last thing it does is restart
# the server that launched it. stdout and stderr are already pointed at
# update.log in the storage folder.
set -uo pipefail

PROJECT_DIR="${PROMPTD_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LABEL="${PROMPTD_LAUNCHD_LABEL:-local.promptd}"
BRANCH=main
REMOTE=origin

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ABORTED: $*"; exit 1; }

export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes}"
export GIT_PAGER=cat

log "=== self-update starting in $PROJECT_DIR (pid $$) ==="
cd "$PROJECT_DIR" || die "cannot enter $PROJECT_DIR"

# Re-check everything here: the server decided to update, but that was a moment
# ago and this process is the one about to touch the working tree.
[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = "true" ] || die "not a git repository"
current_branch=$(git rev-parse --abbrev-ref HEAD)
[ "$current_branch" = "$BRANCH" ] || die "on branch $current_branch, refusing to pull $BRANCH"
[ -z "$(git status --porcelain)" ] || die "working tree has uncommitted changes"

before=$(git rev-parse HEAD)
lock_before=$(git rev-parse "HEAD:package-lock.json" 2>/dev/null || echo none)

log "pulling $REMOTE/$BRANCH (at $(git rev-parse --short HEAD))"
if ! git pull --ff-only "$REMOTE" "$BRANCH" 2>&1; then
  die "git pull failed"
fi

after=$(git rev-parse HEAD)
if [ "$before" = "$after" ]; then
  log "already up to date, nothing to restart"
  exit 0
fi
log "updated $(git rev-parse --short "$before") -> $(git rev-parse --short "$after")"
git --no-pager log --oneline "$before..$after" | sed 's/^/  /'

# Dependencies may have moved with the code.
lock_after=$(git rev-parse "HEAD:package-lock.json" 2>/dev/null || echo none)
if [ "$lock_before" != "$lock_after" ]; then
  log "package-lock.json changed, running npm install"
  if command -v npm >/dev/null 2>&1; then
    npm install --no-audit --no-fund 2>&1 | tail -5
  else
    log "WARNING: npm not on PATH, dependencies not updated"
  fi
else
  log "dependencies unchanged"
fi

# Restart. Only launchd can bring the server back up, so if no agent is
# registered leave the running one alone rather than killing the service.
# Agents registered before the rename to promptd still run under the old label.
if ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 \
  && launchctl print "gui/$(id -u)/local.claude-conductor" >/dev/null 2>&1; then
  LABEL=local.claude-conductor
fi
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  log "restarting $LABEL"
  if launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>&1; then
    log "restart requested"
  else
    log "WARNING: kickstart failed; restart by hand"
  fi
else
  log "no launchd agent named $LABEL is registered"
  log "the new code is on disk but the running server is still the old one — restart it yourself"
fi

log "=== self-update finished ==="
