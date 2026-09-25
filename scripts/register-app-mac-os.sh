#!/bin/bash
# Registers promptd as two macOS LaunchAgents that start at login: the hub (the
# web server) and a node that runs its jobs on this Mac.
#
# Run once, from anywhere:
#   ./scripts/register-app-mac-os.sh
#
# On another Mac, to add it as a node of a hub running elsewhere:
#   NODE_ONLY=1 HUB_URL=http://hub-host:4321 NODE_TOKEN=<token> ./scripts/register-app-mac-os.sh
#
# Overrides:
#   PORT=4321                 port the hub listens on
#   HOST=0.0.0.0              bind address; 0.0.0.0 accepts connections from your
#                             whole network. The web page has no password — see
#                             the README before using it.
#   LABEL=local.promptd       launchd name of the hub
#   NODE_LABEL=$LABEL.node    launchd name of the node
#   NODE_ONLY=1               register only the node
#   HUB_URL=http://...        where the node finds the hub (default: this Mac)
#   NODE_TOKEN=...            the hub's node token; read from the hub's storage
#                             folder when the hub is on this Mac
#   NODE_ID, NODE_NAME        how the node names itself (default: this Mac's hostname)
#   FORCE=1                   replace agents that are already registered
set -uo pipefail

PORT="${PORT:-4321}"
HOST="${HOST:-127.0.0.1}"
LABEL="${LABEL:-local.promptd}"
NODE_LABEL="${NODE_LABEL:-$LABEL.node}"
NODE_ONLY="${NODE_ONLY:-0}"
NODE_TOKEN="${NODE_TOKEN:-}"
NODE_ID="${NODE_ID:-}"
NODE_NAME="${NODE_NAME:-}"
FORCE="${FORCE:-0}"

# 0.0.0.0 and :: listen on every interface; anything else is reachable at itself.
case "$HOST" in
  0.0.0.0|::|"") CHECK_HOST="127.0.0.1" ;;
  *)             CHECK_HOST="$HOST" ;;
esac
HUB_URL="${HUB_URL:-http://$CHECK_HOST:$PORT}"
HUB_URL="${HUB_URL%/}"

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORAGE_ROOT="${PROMPTD_HOME:-$HOME/.claude/promptd}"
HUB_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_PLIST="$HOME/Library/LaunchAgents/$NODE_LABEL.plist"
LOG_DIR="$HOME/Library/Logs/promptd"
HUB_LOG="$LOG_DIR/server.log"
NODE_LOG="$LOG_DIR/node.log"
DOMAIN="gui/$(id -u)"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  • %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mFailed:\033[0m %s\n' "$*" >&2; exit 1; }
xml()  { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
registered() { launchctl print "$DOMAIN/$1" >/dev/null 2>&1; }

printf '\nRegistering promptd with launchd\n\n'

[ "$(uname -s)" = "Darwin" ] || die "this script is for macOS; on Linux use systemd user units instead"

# --- what launchd will need to run ------------------------------------

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "node is not on your PATH. Install Node 18 or newer, then run this again."
NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd)/$(basename "$NODE_BIN")"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || die "Node 18 or newer is required, found $("$NODE_BIN" -v 2>/dev/null || echo none)"
ok "node $("$NODE_BIN" -v) at $NODE_BIN"

[ -f "$PROJECT_DIR/src/server.js" ] && [ -f "$PROJECT_DIR/src/node.js" ] || die "$PROJECT_DIR does not look like the project (no src/server.js or src/node.js)"
ok "project at $PROJECT_DIR"

if [ "$NODE_ONLY" != "1" ]; then
  case "$HOST" in
    127.0.0.1|localhost|::1)
      ok "binding $HOST — this machine only"
      ;;
    *)
      warn "binding $HOST — reachable from your network."
      warn "The web page has no password. Anyone who can reach this port can run"
      warn "arbitrary Claude prompts on every node. Only do this on a network you"
      warn "trust, and see 'Network access' in the README."
      ;;
  esac
fi

if [ -z "$NODE_TOKEN" ] && [ ! -f "$STORAGE_ROOT/node-token" ] && [ "$NODE_ONLY" = "1" ]; then
  die "no node token. Pass NODE_TOKEN=<token>, copied from $STORAGE_ROOT/node-token on the hub's machine."
fi

# launchd gets a minimal PATH, so claude has to be findable from the one we set.
CLAUDE_BIN="$(command -v claude || true)"
if [ -n "$CLAUDE_BIN" ]; then
  CLAUDE_DIR="$(cd "$(dirname "$CLAUDE_BIN")" && pwd)"
  ok "claude at $CLAUDE_DIR/$(basename "$CLAUDE_BIN")"
else
  CLAUDE_DIR=""
  warn "claude is not on your PATH. The node will start, but every run will fail"
  warn "with 'spawn claude ENOENT' until it can be found. Install Claude Code, then re-run this."
fi

AGENT_PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
[ -n "$CLAUDE_DIR" ] && case ":$AGENT_PATH:" in *":$CLAUDE_DIR:"*) ;; *) AGENT_PATH="$CLAUDE_DIR:$AGENT_PATH" ;; esac
NODE_DIR="$(dirname "$NODE_BIN")"
case ":$AGENT_PATH:" in *":$NODE_DIR:"*) ;; *) AGENT_PATH="$NODE_DIR:$AGENT_PATH" ;; esac

# --- dependencies -----------------------------------------------------

if [ ! -d "$PROJECT_DIR/node_modules/typescript" ]; then
  info "dependencies are missing, running npm install"
  (cd "$PROJECT_DIR" && npm install --no-audit --no-fund >/dev/null 2>&1) || die "npm install failed; run it by hand and try again"
  ok "dependencies installed"
else
  ok "dependencies present"
fi

(cd "$PROJECT_DIR" && npm run build >/dev/null 2>&1) || die "the build failed; run npm run build in $PROJECT_DIR to see why"
ok "built"

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents" || die "could not create $LOG_DIR"

# --- one agent at a time ----------------------------------------------

# Answers 0 when the agent should be written: it is not registered, or FORCE
# asked for it to be replaced.
needs_agent() {
  local label="$1"
  if ! registered "$label"; then return 0; fi
  if [ "$FORCE" = "1" ]; then
    info "$label is already registered, replacing it"
    launchctl bootout "$DOMAIN/$label" 2>/dev/null
    sleep 1
    return 0
  fi
  ok "$label is already registered, leaving it as it is"
  return 1
}

agent_plist() {
  local label="$1" script="$2" log="$3" env="$4"
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PROJECT_DIR/src/$script</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$AGENT_PATH</string>
$env
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
EOF
}

env_entry() {
  printf '    <key>%s</key><string>%s</string>\n' "$1" "$(xml "$2")"
}

# A storage folder other than the default has to reach both processes, or the
# node would look for the hub's token in the wrong place.
STORAGE_ENV=""
[ -n "${PROMPTD_HOME:-}" ] && STORAGE_ENV="$(env_entry PROMPTD_HOME "$PROMPTD_HOME")"

install_agent() {
  local label="$1" plist="$2" script="$3" log="$4" env="$5"
  agent_plist "$label" "$script" "$log" "$env" > "$plist"
  plutil -lint "$plist" >/dev/null 2>&1 || die "generated an invalid plist at $plist"
  ok "wrote $plist"
  launchctl bootstrap "$DOMAIN" "$plist" 2>&1 || die "launchctl bootstrap of $label failed. See $log"
}

HUB_INSTALLED=0
if [ "$NODE_ONLY" != "1" ] && needs_agent "$LABEL"; then
  # Something else already on the port would make the hub exit on boot.
  if lsof -Pi ":$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    warn "port $PORT is already in use — stop whatever is on it, or re-run with PORT=<other>"
  fi
  HUB_ENV="$(env_entry PORT "$PORT")
$(env_entry HOST "$HOST")
$(env_entry PROMPTD_LAUNCHD_LABEL "$LABEL")
$(env_entry PROMPTD_NODE_LAUNCHD_LABEL "$NODE_LABEL")"
  [ -n "$STORAGE_ENV" ] && HUB_ENV="$HUB_ENV
$STORAGE_ENV"
  install_agent "$LABEL" "$HUB_PLIST" server.js "$HUB_LOG" "$HUB_ENV"
  HUB_INSTALLED=1
fi

NODE_INSTALLED=0
if needs_agent "$NODE_LABEL"; then
  NODE_ENV="$(env_entry PROMPTD_HUB_URL "$HUB_URL")"
  [ -n "$STORAGE_ENV" ] && NODE_ENV="$NODE_ENV
$STORAGE_ENV"
  [ -n "$NODE_TOKEN" ] && NODE_ENV="$NODE_ENV
$(env_entry PROMPTD_NODE_TOKEN "$NODE_TOKEN")"
  [ -n "$NODE_ID" ] && NODE_ENV="$NODE_ENV
$(env_entry PROMPTD_NODE_ID "$NODE_ID")"
  [ -n "$NODE_NAME" ] && NODE_ENV="$NODE_ENV
$(env_entry PROMPTD_NODE_NAME "$NODE_NAME")"
  install_agent "$NODE_LABEL" "$NODE_PLIST" node.js "$NODE_LOG" "$NODE_ENV"
  [ -n "$NODE_TOKEN" ] && chmod 600 "$NODE_PLIST"
  NODE_INSTALLED=1
fi

# --- confirm they answer ----------------------------------------------

if [ "$HUB_INSTALLED" = "1" ]; then
  printf '  • waiting for the hub to answer'
  answered=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://$CHECK_HOST:$PORT/api/health" >/dev/null 2>&1; then answered=1; break; fi
    printf '.'
    sleep 1
  done
  printf '\n'
  [ "$answered" = "1" ] || die "registered, but nothing answered on $CHECK_HOST:$PORT within 30s. Check $HUB_LOG"
  ok "hub serving on http://$CHECK_HOST:$PORT"
  if [ "$CHECK_HOST" = "127.0.0.1" ] && [ "$HOST" != "127.0.0.1" ]; then
    LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
    [ -n "$LAN_IP" ] && ok "on your network at http://$LAN_IP:$PORT"
  fi
fi

if [ "$NODE_INSTALLED" = "1" ]; then
  printf '  • waiting for the node to connect'
  connected=0
  for _ in $(seq 1 30); do
    if curl -fsS "$HUB_URL/api/nodes" 2>/dev/null | grep -q '"online":true'; then connected=1; break; fi
    printf '.'
    sleep 1
  done
  printf '\n'
  if [ "$connected" = "1" ]; then
    ok "node connected to $HUB_URL"
  else
    warn "the node is registered but no node showed as online at $HUB_URL within 30s. Check $NODE_LOG"
  fi
fi

printf '\nStart at login is on. Useful commands:\n\n'
for label in $([ "$NODE_ONLY" != "1" ] && echo "$LABEL") "$NODE_LABEL"; do
  printf '  %s\n' "$label"
  printf '    Restart   launchctl kickstart -k %s/%s\n' "$DOMAIN" "$label"
  printf '    Stop      launchctl bootout %s/%s\n' "$DOMAIN" "$label"
  printf '    Status    launchctl print %s/%s | grep -E "state =|pid ="\n' "$DOMAIN" "$label"
  printf '    Remove    launchctl bootout %s/%s && rm %s\n' "$DOMAIN" "$label" "$HOME/Library/LaunchAgents/$label.plist"
done
printf '\n  Logs        tail -f %s/*.log\n\n' "$LOG_DIR"
exit 0
