#!/bin/bash
# Registers Claude Conductor as a macOS LaunchAgent so it starts at login.
#
# Run once, from anywhere:
#   ./scripts/register-app-mac-os.sh
#
# Overrides:
#   PORT=4321                       port the server listens on
#   HOST=0.0.0.0                    bind address; 0.0.0.0 accepts connections
#                                   from your whole network. The app has no
#                                   password — see the README before using it.
#   LABEL=local.claude-conductor    launchd service name
#   FORCE=1                         re-register if it is already registered
set -uo pipefail

PORT="${PORT:-4321}"
HOST="${HOST:-127.0.0.1}"
LABEL="${LABEL:-local.claude-conductor}"
FORCE="${FORCE:-0}"

# 0.0.0.0 and :: listen on every interface; anything else is reachable at itself.
case "$HOST" in
  0.0.0.0|::|"") CHECK_HOST="127.0.0.1" ;;
  *)             CHECK_HOST="$HOST" ;;
esac

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/claude-conductor"
LOG_FILE="$LOG_DIR/server.log"
DOMAIN="gui/$(id -u)"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  • %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mFailed:\033[0m %s\n' "$*" >&2; exit 1; }

printf '\nRegistering Claude Conductor with launchd\n\n'

[ "$(uname -s)" = "Darwin" ] || die "this script is for macOS; on Linux use a systemd user unit instead"

# --- what launchd will need to run ------------------------------------

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "node is not on your PATH. Install Node 18 or newer, then run this again."
NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd)/$(basename "$NODE_BIN")"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || die "Node 18 or newer is required, found $("$NODE_BIN" -v 2>/dev/null || echo none)"
ok "node $("$NODE_BIN" -v) at $NODE_BIN"

[ -f "$PROJECT_DIR/src/server.js" ] || die "$PROJECT_DIR does not look like the project (no src/server.js)"
ok "project at $PROJECT_DIR"

case "$HOST" in
  127.0.0.1|localhost|::1)
    ok "binding $HOST — this machine only"
    ;;
  *)
    warn "binding $HOST — reachable from your network."
    warn "Claude Conductor has no password. Anyone who can reach this port can run"
    warn "arbitrary Claude prompts in any directory this Mac can read. Only do this on"
    warn "a network you trust, and see 'Network access' in the README."
    ;;
esac

# launchd gets a minimal PATH, so claude has to be findable from the one we set.
CLAUDE_BIN="$(command -v claude || true)"
if [ -n "$CLAUDE_BIN" ]; then
  CLAUDE_DIR="$(cd "$(dirname "$CLAUDE_BIN")" && pwd)"
  ok "claude at $CLAUDE_DIR/$(basename "$CLAUDE_BIN")"
else
  CLAUDE_DIR=""
  warn "claude is not on your PATH. The server will start, but every run will fail"
  warn "with 'spawn claude ENOENT' until it can be found. Install Claude Code, then re-run this."
fi

AGENT_PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
[ -n "$CLAUDE_DIR" ] && case ":$AGENT_PATH:" in *":$CLAUDE_DIR:"*) ;; *) AGENT_PATH="$CLAUDE_DIR:$AGENT_PATH" ;; esac
NODE_DIR="$(dirname "$NODE_BIN")"
case ":$AGENT_PATH:" in *":$NODE_DIR:"*) ;; *) AGENT_PATH="$NODE_DIR:$AGENT_PATH" ;; esac

# --- dependencies -----------------------------------------------------

if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  info "node_modules is missing, running npm install"
  (cd "$PROJECT_DIR" && npm install --no-audit --no-fund >/dev/null 2>&1) || die "npm install failed; run it by hand and try again"
  ok "dependencies installed"
else
  ok "dependencies present"
fi

# --- already registered? ---------------------------------------------

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  if [ "$FORCE" = "1" ]; then
    info "$LABEL is already registered, replacing it"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
    sleep 1
  else
    warn "$LABEL is already registered."
    printf '\nTo restart it:      launchctl kickstart -k %s/%s\n' "$DOMAIN" "$LABEL"
    printf 'To replace it:      FORCE=1 %s\n' "${BASH_SOURCE[0]}"
    printf 'To remove it:       launchctl bootout %s/%s && rm %s\n\n' "$DOMAIN" "$LABEL" "$PLIST"
    exit 0
  fi
fi

# Something else already on the port would make the server exit on boot.
if lsof -Pi ":$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  warn "port $PORT is already in use — stop whatever is on it, or re-run with PORT=<other>"
fi

# --- write the plist --------------------------------------------------

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents" || die "could not create $LOG_DIR"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PROJECT_DIR/src/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$AGENT_PATH</string>
    <key>PORT</key><string>$PORT</string>
    <key>HOST</key><string>$HOST</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_FILE</string>
  <key>StandardErrorPath</key><string>$LOG_FILE</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST" >/dev/null 2>&1 || die "generated an invalid plist at $PLIST"
ok "wrote $PLIST"

# --- register and confirm it answers ----------------------------------

launchctl bootstrap "$DOMAIN" "$PLIST" 2>&1 || die "launchctl bootstrap failed. See $LOG_FILE"

printf '  • waiting for the server to answer'
for _ in $(seq 1 30); do
  if curl -fsS "http://$CHECK_HOST:$PORT/api/health" >/dev/null 2>&1; then
    printf '\n'
    ok "serving on http://$CHECK_HOST:$PORT"
    if [ "$CHECK_HOST" = "127.0.0.1" ] && [ "$HOST" != "127.0.0.1" ]; then
      LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
      [ -n "$LAN_IP" ] && ok "on your network at http://$LAN_IP:$PORT"
    fi
    printf '\nStart at login is on. Useful commands:\n\n'
    printf '  Restart      launchctl kickstart -k %s/%s\n' "$DOMAIN" "$LABEL"
    printf '  Stop         launchctl bootout %s/%s\n' "$DOMAIN" "$LABEL"
    printf '  Status       launchctl print %s/%s | grep -E "state =|pid ="\n' "$DOMAIN" "$LABEL"
    printf '  Server log   tail -f %s\n' "$LOG_FILE"
    printf '  Remove       launchctl bootout %s/%s && rm %s\n\n' "$DOMAIN" "$LABEL" "$PLIST"
    exit 0
  fi
  printf '.'
  sleep 1
done

printf '\n'
die "registered, but nothing answered on $CHECK_HOST:$PORT within 30s. Check $LOG_FILE"
