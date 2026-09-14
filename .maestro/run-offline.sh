#!/usr/bin/env bash
#
# Tangerine cases 3 & 4 — use a form / a group offline.
#
#   ./.maestro/run-offline.sh form     # case 3: download a *form*, go offline, submit
#   ./.maestro/run-offline.sh group    # case 4: download a *group*, go offline, submit
#
# Maestro can drive the UI but cannot sever the emulator's network, so the
# phases are orchestrated here:
#
#   1. online  : download (form or group) and assert the Download -> Downloaded badge
#   2. offline : open the cached form, fill and submit it
#   3. online  : boot the form app again so the queued response is uploaded,
#                then assert the server received exactly one more response
#
# Configuration comes from the environment; a gitignored `.maestro/.env` is
# sourced first when present. Defaults target the staging server.
set -uo pipefail

cd "$(dirname "$0")/.."

if [ -f .maestro/.env ]; then
  # shellcheck disable=SC1091
  . ./.maestro/.env
fi

CASE="${1:-form}"
case "$CASE" in
  form|group) ;;
  *) echo "usage: $0 [form|group]" >&2; exit 2 ;;
esac

# ── Configuration ────────────────────────────────────────────────────────────
SERVER_URL="${SERVER_URL:-https://tangy.is-local.host}"
USERNAME="${USERNAME:-appuser}"
PASSWORD="${PASSWORD:-Password1!}"
GROUP_NAME="${GROUP_NAME:-Group X}"
FORM_NAME="${FORM_NAME:-Base Form}"
GROUP_ID="${GROUP_ID:-group-174d2332-5e48-4805-9111-83ea2976d70c}"
FORM_ID="${FORM_ID:-form-4218dfc4-532a-4c39-aeed-1b951cf7c15e}"
GROUP_DB="${GROUP_DB:-$GROUP_ID}"
COUCH_USER="${COUCH_USER:-admin}"
COUCH_PASSWORD="${COUCH_PASSWORD:-password}"

DEVICE="${ADB_DEVICE:-emulator-5554}"
UPLOAD_TIMEOUT="${UPLOAD_TIMEOUT:-90}"

ME=(maestro test
  -e "SERVER_URL=$SERVER_URL" -e "USERNAME=$USERNAME" -e "PASSWORD=$PASSWORD"
  -e "GROUP_NAME=$GROUP_NAME" -e "FORM_NAME=$FORM_NAME"
  -e "GROUP_ID=$GROUP_ID" -e "FORM_ID=$FORM_ID"
  -e "ANSWER=offline-$CASE-$(date +%s)")

PASS=0
FAIL=0

# ── Device helpers ───────────────────────────────────────────────────────────
adb_() { adb -s "$DEVICE" "$@"; }

set_offline() {
  adb_ shell svc wifi disable >/dev/null 2>&1
  adb_ shell svc data disable >/dev/null 2>&1
}

set_online() {
  adb_ shell svc wifi enable >/dev/null 2>&1
  adb_ shell svc data enable >/dev/null 2>&1
}

# Poll until the device reports no active default network.
wait_offline() {
  for _ in $(seq 1 20); do
    if adb_ shell dumpsys connectivity 2>/dev/null | grep -q "Active default network: none"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Poll until the device has a default network again.
wait_online() {
  for _ in $(seq 1 30); do
    if ! adb_ shell dumpsys connectivity 2>/dev/null | grep -q "Active default network: none"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

cleanup() {
  set_online
  # Never leave an overlay covering the shell for the next run.
  adb_ shell am force-stop org.tangerinecentral.tangerine >/dev/null 2>&1
}
trap cleanup EXIT

# ── Server-side oracle (the server's own CouchDB, proxied at <server>/db/) ───
count_responses() {
  local body
  body="$(curl -sk -m 20 -u "$COUCH_USER:$COUCH_PASSWORD" \
    "$SERVER_URL/db/$GROUP_DB/_all_docs?include_docs=true&limit=2000" 2>/dev/null)" || return 1
  printf '%s' "$body" | FORM_ID="$FORM_ID" python3 -c '
import json, os, sys
try:
    rows = json.load(sys.stdin).get("rows", [])
except Exception:
    print(-1); raise SystemExit
fid = os.environ.get("FORM_ID", "")
docs = [r["doc"] for r in rows if r.get("doc")]
res = [d for d in docs if d.get("type") == "response" and (not fid or d.get("formId") == fid)]
print(len(res))
'
}

# ── Reporting ────────────────────────────────────────────────────────────────
step()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()    { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS + 1)); }
bad()   { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL + 1)); }

run_flow() {
  local flow="$1"
  "${ME[@]}" "$flow" 2>&1 | grep -E "^\[(Passed|Failed)\]|COMPLETED|FAILED|Flows (Passed|Failed)" | tail -6
  return "${PIPESTATUS[0]}"
}

# ── Phase 0: preconditions ───────────────────────────────────────────────────
step "Phase 0 — preconditions (device $DEVICE)"
set_online
if ! wait_online; then bad "device never came online"; exit 1; fi
ok "device online"

BASE="$(count_responses)"
if [ -z "$BASE" ] || [ "$BASE" -lt 0 ] 2>/dev/null; then
  bad "could not read responses from $SERVER_URL/db/$GROUP_DB (check GROUP_DB / COUCH_*)"
  exit 1
fi
ok "server holds $BASE response(s) for this form before the run"

# ── Phase 1: download (online) ───────────────────────────────────────────────
step "Phase 1 — download the $CASE (online)"
DOWNLOAD_FLOW=".maestro/flows/012_tangerine_offline_download_form.yaml"
[ "$CASE" = "group" ] && DOWNLOAD_FLOW=".maestro/flows/013_tangerine_offline_download_group.yaml"
if run_flow "$DOWNLOAD_FLOW"; then
  ok "$CASE downloaded and pinned (badge ✓)"
else
  bad "download phase failed"; exit 1
fi

# ── Phase 2: submit (offline) ────────────────────────────────────────────────
step "Phase 2 — fill and submit the cached form (offline)"
set_offline
if wait_offline; then ok "network severed"; else bad "could not sever the network"; fi

if run_flow .maestro/flows/014_tangerine_offline_submit.yaml; then
  ok "form opened from cache, filled and submitted while offline"
else
  bad "offline submit phase failed"; exit 1
fi

if [ "$(count_responses)" = "$BASE" ]; then
  ok "server is still at $BASE responses — the submission was NOT uploaded yet"
else
  bad "server count changed while offline (expected it to stay at $BASE)"
fi

# ── Phase 3: reconnect, flush, verify ────────────────────────────────────────
step "Phase 3 — reconnect and check the server received it"
set_online
if wait_online; then ok "network restored"; else bad "network did not come back"; fi

if run_flow .maestro/flows/015_tangerine_offline_flush.yaml; then
  ok "form app re-opened (its outbox flush has been triggered)"
else
  bad "flush trigger failed"
fi

EXPECTED=$((BASE + 1))
ACTUAL="$BASE"
printf '  waiting up to %ss for the server to reach %s response(s)...\n' "$UPLOAD_TIMEOUT" "$EXPECTED"
for _ in $(seq 1 "$UPLOAD_TIMEOUT"); do
  ACTUAL="$(count_responses)"
  [ "$ACTUAL" = "$EXPECTED" ] && break
  sleep 1
done

if [ "$ACTUAL" = "$EXPECTED" ]; then
  ok "server received the offline submission ($BASE -> $ACTUAL response(s))"
else
  bad "server still holds $ACTUAL response(s), expected $EXPECTED — the offline submission did not reach the server"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
step "Result — case '$CASE'"
printf '  %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
