#!/usr/bin/env bash
# NanoClaw Doctor — diagnose and fix common issues
# Usage: ./scripts/doctor.sh [--fix]

set -uo pipefail

# ── Helpers ─────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
PASS=0; WARN=0; FAIL=0; FIXED=0

pass()  { ((PASS++));  echo -e "  ${GREEN}✓${NC} $1"; }
warn()  { ((WARN++));  echo -e "  ${YELLOW}⚠${NC} $1"; }
fail()  { ((FAIL++));  echo -e "  ${RED}✗${NC} $1"; }
fixed() { ((FIXED++)); echo -e "  ${BLUE}⟳${NC} $1"; }
section() { echo -e "${BOLD}$1${NC}"; }

FIX=false
[[ "${1:-}" == "--fix" ]] && FIX=true

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

ENV_FILE="$PROJECT_ROOT/.env"
BARREL="$PROJECT_ROOT/src/channels/index.ts"
DB_PATH="$PROJECT_ROOT/store/messages.db"
LOG_FILE="$PROJECT_ROOT/logs/nanoclaw.log"
PROXY_PORT=$(grep -oP 'CREDENTIAL_PROXY_PORT=\K\d+' "$ENV_FILE" 2>/dev/null || echo "3001")

# Check whether a channel is imported in the barrel file
channel_enabled() { grep -q "import.*'\./${1}\.js'" "$BARREL" 2>/dev/null; }

# Kill a process holding a TCP port, wait for release (up to 5s)
kill_port_holder() {
  local port=$1
  local holder_pid
  holder_pid=$(ss -tlnp 2>/dev/null | grep ":${port}" | grep -oP 'pid=\K[0-9]+' || true)
  [ -z "$holder_pid" ] && return 1
  kill "$holder_pid" 2>/dev/null || true
  local i; for i in 1 2 3 4 5; do
    ss -tlnp 2>/dev/null | grep -q ":${port}" || break
    sleep 1
  done
  echo "$holder_pid"
}

echo -e "${BOLD}NanoClaw Doctor${NC}"
$FIX && echo -e "  ${BLUE}--fix mode${NC}"
echo ""

# ── Process ─────────────────────────────────────────────
section "Process"

ALL_PIDS=$(pgrep -f "node.*dist/index.js" 2>/dev/null || true)
PID=$(echo "$ALL_PIDS" | head -1)
ALL_COUNT=$(echo "$ALL_PIDS" | grep -c . 2>/dev/null || echo 0)

if [ -n "$PID" ]; then
  UPTIME=$(ps -p "$PID" -o etime= 2>/dev/null | xargs)
  if [ "$ALL_COUNT" -gt 1 ]; then
    if $FIX; then
      echo "$ALL_PIDS" | tail -n +2 | xargs kill 2>/dev/null
      fixed "Killed $((ALL_COUNT - 1)) extra instance(s), kept PID $PID"
    else
      warn "NanoClaw running (PID $PID, uptime $UPTIME) but $ALL_COUNT instances found — kill extras"
    fi
  else
    pass "NanoClaw running (PID $PID, uptime $UPTIME)"
  fi
elif $FIX; then
  if [ ! -f dist/index.js ]; then
    fail "NanoClaw not running and dist/index.js missing — build first"
  else
    # Kill orphan processes holding the proxy port
    ORPHAN=$(kill_port_holder "$PROXY_PORT") && \
      fixed "Killed orphan process $ORPHAN holding port $PROXY_PORT"
    nohup node dist/index.js >> "$LOG_FILE" 2>&1 &
    PID=$!
    sleep 2
    if kill -0 "$PID" 2>/dev/null; then
      fixed "Started NanoClaw (PID $PID)"
    else
      PID=""
      fail "NanoClaw failed to start — check logs/nanoclaw.log"
    fi
  fi
else
  PID=""
  fail "NanoClaw not running"
fi

# ── Build ───────────────────────────────────────────────
section "Build"

if [ -f dist/index.js ]; then
  STALE_SRC=$(find src -name '*.ts' -newer dist/index.js 2>/dev/null | head -1)
  if [ -n "$STALE_SRC" ]; then
    if $FIX; then
      npm run build >/dev/null 2>&1 && fixed "Rebuilt dist/" || fail "npm run build failed"
    else
      warn "dist/ is stale — src changed after last build (run: npm run build)"
    fi
  else
    pass "dist/ is up to date"
  fi
elif $FIX; then
  npm run build >/dev/null 2>&1 && fixed "Built dist/" || fail "npm run build failed"
else
  fail "dist/index.js missing (run: npm run build)"
fi

# ── Container ──────────────────────────────────────────
section "Container"

if command -v docker &>/dev/null; then
  pass "Docker available"
  if docker image inspect nanoclaw-agent:latest &>/dev/null; then
    BUILT=$(docker image inspect nanoclaw-agent:latest --format '{{.Created}}' 2>/dev/null | cut -dT -f1)
    pass "nanoclaw-agent:latest image exists (built $BUILT)"
  elif $FIX && [ -f container/build.sh ]; then
    ./container/build.sh >/dev/null 2>&1 && fixed "Built nanoclaw-agent:latest" || fail "Container build failed"
  else
    fail "nanoclaw-agent:latest image not found (run: ./container/build.sh)"
  fi

  RUNNING=$(docker ps --filter "ancestor=nanoclaw-agent:latest" -q 2>/dev/null | wc -l)
  if [ "$RUNNING" -gt 0 ]; then
    pass "$RUNNING agent container(s) running"
  else
    pass "No agent containers running (normal when idle)"
  fi
else
  fail "Docker not found"
fi

# ── Database ───────────────────────────────────────────
section "Database"

if [ -f "$DB_PATH" ]; then
  pass "messages.db exists"

  DB_RESULT=$(node -e "
    try {
      const db = require('better-sqlite3')('$DB_PATH', { readonly: true });
      const g = db.prepare('SELECT COUNT(*) as c FROM registered_groups').get().c;
      const cutoff = new Date(Date.now() - 3600000).toISOString();
      const m = db.prepare('SELECT COUNT(*) as c FROM messages WHERE timestamp > ?').get(cutoff).c;
      db.close();
      console.log(g + ':' + m);
    } catch(e) { console.log('error:' + e.message); }
  " 2>/dev/null || echo "error:node failed")

  if [[ "$DB_RESULT" == error:* ]]; then
    warn "Cannot query database: ${DB_RESULT#error:}"
  else
    GROUP_COUNT="${DB_RESULT%%:*}"
    MSG_COUNT="${DB_RESULT##*:}"
    [ "$GROUP_COUNT" -eq 0 ] 2>/dev/null && warn "No registered groups" || pass "$GROUP_COUNT registered group(s)"
    [ "$MSG_COUNT" -eq 0 ] 2>/dev/null && warn "No messages in the last hour" || pass "$MSG_COUNT message(s) in the last hour"
  fi
else
  fail "messages.db not found at $DB_PATH"
fi

# ── Channels ──────────────────────────────────────────
section "Channels"

if [ -f "$BARREL" ]; then
  for CHANNEL in telegram gmail whatsapp discord slack; do
    CHANNEL_FILE="$PROJECT_ROOT/src/channels/${CHANNEL}.ts"
    if channel_enabled "$CHANNEL"; then
      [ -f "$CHANNEL_FILE" ] && pass "$CHANNEL: installed and enabled" \
                              || fail "$CHANNEL: enabled in index.ts but ${CHANNEL}.ts missing"
    elif [ -f "$CHANNEL_FILE" ]; then
      warn "$CHANNEL: file exists but not imported in index.ts"
    fi
  done
else
  fail "Channel barrel file not found"
fi

# ── Credentials ───────────────────────────────────────
section "Credentials"

[ -f "$ENV_FILE" ] && pass ".env file exists" || fail ".env file missing"

# Anthropic auth
if grep -q "ANTHROPIC_API_KEY=." "$ENV_FILE" 2>/dev/null; then
  pass "Anthropic auth: API key"
elif ss -tlnp 2>/dev/null | grep -q ":${PROXY_PORT}"; then
  AUTH_MODE=$(curl -s "http://localhost:${PROXY_PORT}/auth-mode" 2>/dev/null || echo "unknown")
  [[ "$AUTH_MODE" == *"oauth"* ]] \
    && pass "Anthropic auth: OAuth (via credential proxy)" \
    || pass "Anthropic auth: credential proxy active"
else
  fail "No Anthropic API key or OAuth configured"
fi

# Channel-specific credentials
if channel_enabled telegram; then
  grep -q "TELEGRAM_BOT_TOKEN\|TELEGRAM_BOT_POOL" "$ENV_FILE" 2>/dev/null \
    && pass "Telegram bot token set" \
    || fail "Telegram enabled but no bot token in .env"
fi

if channel_enabled gmail; then
  [ -f "$HOME/.gmail-mcp/gcp-oauth.keys.json" ] \
    && pass "Gmail OAuth keys present" \
    || fail "Gmail enabled but ~/.gmail-mcp/gcp-oauth.keys.json missing"
  [ -f "$HOME/.gmail-mcp/credentials.json" ] \
    && pass "Gmail credentials present" \
    || fail "Gmail enabled but ~/.gmail-mcp/credentials.json missing (run OAuth flow)"
fi

# ── Credential Proxy ─────────────────────────────────
section "Credential Proxy"

if ss -tlnp 2>/dev/null | grep -q ":${PROXY_PORT}"; then
  pass "Credential proxy listening on port $PROXY_PORT"
elif [ -n "$PID" ]; then
  fail "Credential proxy not listening on port $PROXY_PORT"
else
  warn "Credential proxy not listening (NanoClaw not running)"
fi

# ── Logs ──────────────────────────────────────────────
section "Logs"

if [ -f "$LOG_FILE" ]; then
  LOG_SIZE=$(du -h "$LOG_FILE" | cut -f1)
  LOG_BYTES=$(stat -c%s "$LOG_FILE" 2>/dev/null || stat -f%z "$LOG_FILE" 2>/dev/null || echo "0")
  pass "Log file exists ($LOG_SIZE)"

  RECENT_ERRORS=$(grep -c "ERROR" "$LOG_FILE" 2>/dev/null || echo "0")
  if [ "$RECENT_ERRORS" -gt 0 ]; then
    LAST_ERROR=$(grep "ERROR" "$LOG_FILE" | tail -1 | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-120)
    warn "$RECENT_ERRORS error(s) in log — last: $LAST_ERROR"
  else
    pass "No errors in log"
  fi

  if [ "$LOG_BYTES" -gt 52428800 ] 2>/dev/null; then
    if $FIX; then
      cp "$LOG_FILE" "${LOG_FILE}.old"
      tail -1000 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
      fixed "Rotated log (saved old as nanoclaw.log.old, kept last 1000 lines)"
    else
      warn "Log file is large ($LOG_SIZE) — consider rotating"
    fi
  fi
else
  warn "No log file found"
fi

# ── Sessions ─────────────────────────────────────────
section "Sessions"

STALE_RUNNERS=$(find "$PROJECT_ROOT/data/sessions" -name "agent-runner-src" -type d 2>/dev/null | wc -l)
if [ "$STALE_RUNNERS" -gt 0 ]; then
  if $FIX; then
    rm -r "$PROJECT_ROOT"/data/sessions/*/agent-runner-src 2>/dev/null
    fixed "Removed $STALE_RUNNERS stale agent-runner-src copies"
  else
    warn "$STALE_RUNNERS stale agent-runner-src copies (run: rm -r data/sessions/*/agent-runner-src)"
  fi
else
  pass "No stale agent-runner copies"
fi

# ── Summary ──────────────────────────────────────────
echo ""
SUMMARY="${GREEN}$PASS passed${NC}, ${YELLOW}$WARN warnings${NC}, ${RED}$FAIL failures${NC}"
[ "$FIXED" -gt 0 ] && SUMMARY="$SUMMARY, ${BLUE}$FIXED fixed${NC}"
echo -e "${BOLD}Summary${NC}: $SUMMARY"

[ "$FAIL" -gt 0 ] && exit 1 || exit 0
