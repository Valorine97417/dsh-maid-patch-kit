#!/usr/bin/env bash
# boot-guard.sh — guarded boot for DeepSeek Harness (macOS/Linux).
#
# Snapshots every profile, starts the harness, health-checks it, and on failure
# kills the server, rolls back to the last good snapshot and retries once.
# On first-attempt failure it also writes an incident report + pending marker.
#
# Wire it into your launcher (or run it directly):
#   DSH_HOME="$HOME/.dsh" HARNESS_ROOT=/path/to/harness ./boot-guard.sh
#
# Overrides: DSH_GUARD_PROFILE, DSH_GUARD_PORT, DSH_GUARD_LAUNCH (an executable
# to start instead of `dsh web`), DSH_GUARD_NODE.
#
# Requires: node (for the guard CLI), curl (health probe).
set -u

FIRST_WAIT_SEC="${FIRST_WAIT_SEC:-60}"
RETRY_WAIT_SEC="${RETRY_WAIT_SEC:-30}"
PORT="${DSH_GUARD_PORT:-0}"                       # 0 = probe below
PROFILE="${DSH_GUARD_PROFILE:-}"
HARNESS_ROOT="${HARNESS_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
export DSH_HOME

if [ -z "$PROFILE" ]; then
  if [ -d "$DSH_HOME/profiles/desktop" ]; then PROFILE=desktop
  elif [ -d "$DSH_HOME/profiles/web" ]; then PROFILE=web
  else PROFILE=desktop; fi
fi

PORTS=""
[ "$PORT" != "0" ] && PORTS="$PORT"
PORTS="$PORTS 19387 3080"
LIVE_PORT=19387

NODE_BIN="${DSH_GUARD_NODE:-}"
if [ -z "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then NODE_BIN=node
  elif [ -x "$HARNESS_ROOT/resources/runtime/primary-runtime/dependencies/node/bin/node" ]; then
    NODE_BIN="$HARNESS_ROOT/resources/runtime/primary-runtime/dependencies/node/bin/node"
  else NODE_BIN=node; fi
fi

CLI=""
for pkg in dsh-maid-guard dsh-plugin-guard; do
  for cand in "$DSH_HOME/profiles/$PROFILE/node_modules/$pkg/scripts/guard-cli.js" \
              "$HARNESS_ROOT/node_modules/$pkg/scripts/guard-cli.js"; do
    if [ -f "$cand" ]; then CLI="$cand"; break; fi
  done
  [ -n "$CLI" ] && break
done

LOG_DIR="$DSH_HOME/guard/logs"
mkdir -p "$LOG_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
BOOT_LOG="$LOG_DIR/boot-$STAMP.log"
SERVER_OUT="$LOG_DIR/server-$STAMP.out.log"
SERVER_ERR="$LOG_DIR/server-$STAMP.err.log"
STATUS_FILE="$LOG_DIR/last-boot.txt"

log() { echo "[$(date +%H:%M:%S)] $*" >> "$BOOT_LOG"; }
set_status() { echo "$(date '+%F %T') $1 $2 (log: $STAMP)" > "$STATUS_FILE"; }
# The desktop shell answers 401 on / without its token; 2xx-4xx still means alive.
port_healthy() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$1/" 2>/dev/null) || return 1
  [ -n "$code" ] && [ "$code" -ge 200 ] && [ "$code" -lt 500 ]
}
healthy() {
  local p
  for p in $PORTS; do
    if port_healthy "$p"; then LIVE_PORT="$p"; return 0; fi
  done
  LIVE_PORT=$(echo "$PORTS" | awk '{print $1}')
  return 1
}
guard() {
  [ -n "$CLI" ] || { log "  [guard] CLI not found; skipping $*"; return 0; }
  "$NODE_BIN" "$CLI" "$@" 2>&1 | while IFS= read -r line; do [ -n "$line" ] && log "  [guard] $line"; done
}

wait_healthy() {
  local deadline=$((SECONDS + $1))
  while [ $SECONDS -lt $deadline ]; do
    healthy && return 0
    sleep 0.5
  done
  return 1
}

start_server() {
  if [ -n "${DSH_GUARD_LAUNCH:-}" ] && [ -x "${DSH_GUARD_LAUNCH}" ]; then
    ( setsid "$DSH_GUARD_LAUNCH" >"$SERVER_OUT" 2>"$SERVER_ERR" < /dev/null & )
  else
    local dsh_cmd="$HARNESS_ROOT/node_modules/.bin/dsh"
    [ -x "$dsh_cmd" ] || dsh_cmd="dsh"
    ( setsid "$dsh_cmd" web >"$SERVER_OUT" 2>"$SERVER_ERR" < /dev/null & )
  fi
  echo $!
}

stop_server() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  sleep 1
  kill -9 -- "-$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
}

log "=== boot guard start ==="
log "root=$HARNESS_ROOT profile=$PROFILE ports=$PORTS"
if healthy; then
  log "already healthy on port $LIVE_PORT"
  set_status OK already-running
  exit 0
fi

guard snapshot --tag pre-boot --reason "automatic snapshot before boot"

PID=$(start_server)
log "started server (pgid $PID)"
if wait_healthy "$FIRST_WAIT_SEC"; then
  log "boot ok on first attempt"
  set_status OK first-attempt
  # Stay attached so launchers that kill the process group on window close
  # keep their close-to-quit semantics.
  wait
  log "server exited; boot guard done"
  exit 0
fi
log "server unhealthy after ${FIRST_WAIT_SEC}s; stopping and rolling back"
stop_server "$PID"

guard rollback --good

PID2=$(start_server)
log "restarted server (pgid $PID2)"
if wait_healthy "$RETRY_WAIT_SEC"; then
  set_status OK rolled-back-retry
else
  stop_server "$PID2"
  set_status FAILED boot-failed
fi

guard incident --kind boot-failure

if healthy; then
  wait
  log "server exited; boot guard done"
  exit 0
fi
exit 1
