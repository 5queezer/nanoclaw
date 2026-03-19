#!/bin/bash
# Rebuild the Docker image and restart NanoClaw
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Building TypeScript..."
cd "$REPO_DIR"
npm run build

echo "==> Rebuilding container image..."
"$REPO_DIR/container/build.sh"

echo "==> Stopping NanoClaw..."
if [[ "$(uname)" == "Darwin" ]]; then
    launchctl kill SIGTERM "gui/$(id -u)/com.nanoclaw" 2>/dev/null || true
    sleep 1
else
    export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    if systemctl --user is-active nanoclaw &>/dev/null; then
        systemctl --user stop nanoclaw
    else
        pkill -f 'node dist/index.js' || true
        sleep 1
    fi
    # Kill any orphan child processes still holding the credential proxy port
    PROXY_PORT=$(grep -oP 'CREDENTIAL_PROXY_PORT=\K\d+' "$REPO_DIR/.env" 2>/dev/null || echo "3001")
    ORPHAN_PID=$(ss -tlnp 2>/dev/null | grep ":${PROXY_PORT}" | grep -oP 'pid=\K[0-9]+' || true)
    if [ -n "$ORPHAN_PID" ]; then
        echo "    Killing orphan process $ORPHAN_PID on port $PROXY_PORT"
        kill "$ORPHAN_PID" 2>/dev/null || true
    fi
    # Wait for port to be released
    for i in 1 2 3 4 5; do
        ss -tlnp 2>/dev/null | grep -q ":${PROXY_PORT}" || break
        sleep 1
    done
fi

echo "==> Advancing message cursors (skip backlog)..."
node --input-type=module -e "
  import { initDatabase, setRouterState, getAllRegisteredGroups } from './dist/db.js';
  initDatabase();
  const now = new Date().toISOString();
  setRouterState('last_timestamp', now);
  const groups = getAllRegisteredGroups();
  const agentTs = {};
  for (const jid of Object.keys(groups)) agentTs[jid] = now;
  setRouterState('last_agent_timestamp', JSON.stringify(agentTs));
  console.log('    Cursors advanced to', now);
"

echo "==> Starting NanoClaw..."
if [[ "$(uname)" == "Darwin" ]]; then
    launchctl kickstart "gui/$(id -u)/com.nanoclaw"
else
    if systemctl --user start nanoclaw 2>/dev/null; then
        true
    else
        echo "    systemctl --user failed, starting process directly..."
        cd "$REPO_DIR"
        nohup node dist/index.js >> "$REPO_DIR/logs/nanoclaw.log" 2>&1 &
        echo "    Started with PID $!"
    fi
fi

echo "==> Health check..."
sleep 3
if pgrep -f 'node dist/index.js' > /dev/null; then
    echo "    Process is running (PID $(pgrep -f 'node dist/index.js'))"
else
    echo "    FAILED: process not running!"
    echo "    Last 20 lines of log:"
    tail -20 "$REPO_DIR/logs/nanoclaw.log" 2>/dev/null || true
    exit 1
fi

echo "==> Done."
