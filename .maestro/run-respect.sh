#!/usr/bin/env bash
#
# RESPECT cases 1-3 — see docs/ui-test-cases.txt.
#
#   ./.maestro/run-respect.sh r1     # login + add the Tangerine app from a copied link
#   ./.maestro/run-respect.sh r2     # submit a form: app handoff, then webview fallback
#   ./.maestro/run-respect.sh r3     # the same two halves, but offline
#   ./.maestro/run-respect.sh all
#
# The work spans two apps *and* the device itself, which is why it is driven from
# here rather than from a single Maestro flow:
#
#   * the clipboard handoff needs `adb shell input keyevent 279` between the two
#     apps (Maestro has no clipboard API);
#   * the webview-fallback half needs the Tangerine app to be UNINSTALLED, and
#     re-installed afterwards;
#   * the offline half needs the emulator's network severed.
#
# Every phase is asserted on BOTH servers, per the catalogue:
#   * Tangerine — its CouchDB, proxied at <server>/db/<group>/_all_docs, where
#     each graded submission is a doc with type "response";
#   * RESPECT — its xAPI statements, which the launcher forwards to the school's
#     LRS. The server's own /api/school/xapi/statements endpoint is
#     bearer-authenticated, so the observable oracle is the launch chain in
#     logcat plus the LRS POST coming back 200.
#
# Configuration comes from the environment; a gitignored `.maestro/.env` is
# sourced first when present. Defaults target the staging server.
set -uo pipefail

cd "$(dirname "$0")/.."

if [ -f .maestro/.env ]; then
  # shellcheck disable=SC1091
  . ./.maestro/.env
fi

CASE="${1:-all}"
case "$CASE" in
  r1|r2|r3|all) ;;
  *) echo "usage: $0 [r1|r2|r3|all]" >&2; exit 2 ;;
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
TANGY_PKG="${TANGY_PKG:-org.tangerinecentral.tangerine}"
RESPECT_PKG="${RESPECT_PKG:-world.respect.app}"
APK="${APK:-android/app/build/outputs/apk/debug/app-debug.apk}"
LOGCAT_FILE="${LOGCAT_FILE:-/tmp/respect-logcat.txt}"
UPLOAD_TIMEOUT="${UPLOAD_TIMEOUT:-120}"

# xAPI statements reach the school LRS as a POST, so the assertion must match
# POST-specific evidence. A loose "…/api/school/xapi/statements.*200" also matches
# RESPECT's GET reads of the statement collection — an earlier version of this
# check passed that way without a single statement ever being posted.
# "not-cacheable" is only emitted for non-GET responses.
LRS_POST_RE='intercept: POST [^ ]*api/school/xapi/statements'
LRS_POST_OK_RE='not-cacheable\) [^ ]*api/school/xapi/statements.*200 OK'

# Fail fast if any log pattern does not compile. grep exits 2 (error) vs 1 (no
# match), and an error would otherwise be read as "0 matches" - see log_count.
for _re in "$LRS_POST_RE" "$LRS_POST_OK_RE"; do
  printf '' | grep -E "$_re" >/dev/null 2>&1
  _rc=$?
  if [ "$_rc" -gt 1 ]; then
    printf 'FATAL: log pattern does not compile: %s\n' "$_re" >&2
    exit 2
  fi
done
DOWNLOAD_TIMEOUT="${DOWNLOAD_TIMEOUT:-300}"
RUN_ID="$(date +%s)"

ME=(maestro test
  -e "SERVER_URL=$SERVER_URL" -e "USERNAME=$USERNAME" -e "PASSWORD=$PASSWORD"
  -e "GROUP_NAME=$GROUP_NAME" -e "FORM_NAME=$FORM_NAME"
  -e "GROUP_ID=$GROUP_ID" -e "FORM_ID=$FORM_ID")

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

wait_offline() {
  for _ in $(seq 1 20); do
    adb_ shell dumpsys connectivity 2>/dev/null | grep -q "Active default network: none" && return 0
    sleep 1
  done
  return 1
}

wait_online() {
  for _ in $(seq 1 30); do
    adb_ shell dumpsys connectivity 2>/dev/null | grep -q "Active default network: none" || return 0
    sleep 1
  done
  return 1
}

installed() { [ "$(adb_ shell pm list packages 2>/dev/null | grep -c "$TANGY_PKG")" != "0" ]; }

install_tangy() {
  installed && return 0
  [ -f "$APK" ] || { bad "APK not found at $APK (set APK=...)"; return 1; }
  adb_ install -r "$APK" >/dev/null 2>&1 && ok "Tangerine re-installed" || bad "could not re-install Tangerine"
}

# The fallback half needs the app gone; leaving it gone would break later runs.
uninstall_tangy() {
  adb_ uninstall "$TANGY_PKG" >/dev/null 2>&1
  if installed; then bad "could not uninstall Tangerine"; return 1; fi
  return 0
}

# Which path RESPECT took for a launch, read from its own logs.
#
# The device's logcat ring buffer is only 2 MiB, so `adb logcat -d` loses the
# evidence for the early phases of a long run long before the phase that checks
# it (observed: a passing R3 whose final LRS assertion failed purely because the
# POST had rotated away). Capture the stream to a file for the whole run
# instead, and count only the lines each phase produced.
LOGCAT_PID=""
LOGMARK=0

start_logcat_capture() {
  adb_ logcat -c >/dev/null 2>&1
  : > "$LOGCAT_FILE"
  adb_ logcat -v time > "$LOGCAT_FILE" 2>/dev/null &
  LOGCAT_PID=$!
}

stop_logcat_capture() {
  [ -n "$LOGCAT_PID" ] && kill "$LOGCAT_PID" 2>/dev/null
  LOGCAT_PID=""
}

# Snapshot the capture position, so a phase only counts its own evidence.
mark_log() { LOGMARK="$(wc -l < "$LOGCAT_FILE" 2>/dev/null || echo 0)"; }

log_count() {
  local n
  # -E (ERE) is required, not cosmetic: these patterns contain \) and BSD grep
  # rejects that in BRE with "parentheses not balanced", exiting 2 and printing
  # NOTHING. ${n:-0} then turned that into "0 matches", so every LRS assertion
  # reported a false negative no matter what window it used. The compile check
  # below makes an invalid pattern fatal instead of silent.
  n="$(tail -n "+$((LOGMARK + 1))" "$LOGCAT_FILE" 2>/dev/null | grep -cE "$1")"
  echo "${n:-0}"
}

# Poll for the LRS POST instead of sampling once.
#
# RESPECT relays the queued statements on its OWN schedule - when it next becomes
# active - not when the network returns or when we foreground it. Sampling at any
# fixed moment therefore races the relay and reports a false negative: 15 POST
# lines were captured in one run whose point-in-time check found none.
wait_for_lrs_post() {
  local timeout="${1:-$UPLOAD_TIMEOUT}"
  for _ in $(seq 1 "$timeout"); do
    [ "$(log_count "$LRS_POST_OK_RE")" -ge 1 ] && return 0
    sleep 1
  done
  return 1
}

# Poll for a log line instead of sampling once, for events that are driven by the
# device rather than by a step of this script (WorkManager picking a job up when
# the network returns).
wait_for_log() {
  local pattern="$1" timeout="${2:-$UPLOAD_TIMEOUT}"
  for _ in $(seq 1 "$timeout"); do
    [ "$(log_count "$pattern")" -ge 1 ] && return 0
    sleep 1
  done
  return 1
}

cleanup() {
  set_online
  stop_logcat_capture
  # Never leave the app missing or an overlay covering the shell.
  install_tangy || true
  adb_ shell am force-stop "$TANGY_PKG" >/dev/null 2>&1
}
trap cleanup EXIT

# ── Tangerine server oracle (its own CouchDB, proxied at <server>/db/) ────────
# The optional marker must appear in the response doc, which proves the counted
# doc is the submission this phase just made rather than a pre-existing one.
count_responses() {
  local body marker="${1:-}"
  body="$(curl -sk -m 20 -u "$COUCH_USER:$COUCH_PASSWORD" \
    "$SERVER_URL/db/$GROUP_DB/_all_docs?include_docs=true&limit=2000" 2>/dev/null)" || return 1
  printf '%s' "$body" | FORM_ID="$FORM_ID" MARKER="$marker" python3 -c '
import json, os, sys
try:
    rows = json.load(sys.stdin).get("rows", [])
except Exception:
    print(-1); raise SystemExit
fid, marker = os.environ.get("FORM_ID", ""), os.environ.get("MARKER", "")
docs = [r["doc"] for r in rows if r.get("doc")]
res = [d for d in docs if d.get("type") == "response" and (not fid or d.get("formId") == fid)]
if marker:
    res = [d for d in res if marker in json.dumps(d)]
print(len(res))
'
}

# ── Reporting ────────────────────────────────────────────────────────────────
# Timestamped on purpose: the assertions are made against the captured logcat, so
# without a timestamp here there is no way to tell WHICH phase a captured line
# belongs to. That gap made several RESPECT-side assertions impossible to reason
# about (the evidence was in the log, but unattributable to a window).
step() { printf '\n\033[1m== [%s] %s\033[0m\n' "$(date '+%H:%M:%S')" "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL + 1)); }

run_flow() {
  local flow="$1" answer="${2:-$RUN_ID}"
  "${ME[@]}" -e "ANSWER=$answer" "$flow" 2>&1 \
    | grep -E "^\[(Passed|Failed)\]|COMPLETED|FAILED|Flows (Passed|Failed)|Assertion" | tail -8
  return "${PIPESTATUS[0]}"
}

# Poll the Tangerine oracle until it holds $1 matching responses.
wait_for_responses() {
  local want="$1" marker="$2" timeout="${3:-$UPLOAD_TIMEOUT}" got=""
  for _ in $(seq 1 "$timeout"); do
    got="$(count_responses "$marker")"
    [ "$got" = "$want" ] && { echo "$got"; return 0; }
    sleep 1
  done
  echo "$got"
  return 1
}

baseline() { count_responses ""; }

# ── Phase 0: preconditions ───────────────────────────────────────────────────
step "Phase 0 — preconditions (device $DEVICE)"
set_online
wait_online && ok "device online" || { bad "device never came online"; exit 1; }

# The Tangerine app must exist and hold a session: R1 copies its link, and both
# submit phases hand off to it.
install_tangy || exit 1
adb_ shell am force-stop "$TANGY_PKG" >/dev/null 2>&1
adb_ shell am start -n "$TANGY_PKG/.MainActivity" >/dev/null 2>&1
sleep 3
adb_ shell dumpsys window 2>/dev/null | grep -q "$TANGY_PKG" \
  && ok "Tangerine launched" || bad "Tangerine did not come to the front"

BASE="$(baseline)"
if [ -z "$BASE" ] || [ "$BASE" -lt 0 ] 2>/dev/null; then
  bad "could not read responses from $SERVER_URL/db/$GROUP_DB (check GROUP_DB / COUCH_*)"
  exit 1
fi
ok "Tangerine server holds $BASE response(s) for this form before the run"
echo "  (run id $RUN_ID; every assertion below matches on that marker)"

# Start capturing device logs for the whole run (see log_count).
start_logcat_capture
ok "capturing device logs to $LOGCAT_FILE"

# ── R1: login + add the app from the copied link ─────────────────────────────
if [ "$CASE" = "r1" ] || [ "$CASE" = "all" ]; then
  step "R1 — copy the RESPECT manifest link, then add the app in RESPECT"

  # 1. Tangerine copies its own manifest link (must exercise the app's feature).
  if run_flow .maestro/flows/021_r1_tangerine_copy_link.yaml; then
    ok "Tangerine copied the RESPECT manifest link to the clipboard"
  else
    bad "copy-link phase failed"
  fi

  # 2. Clear the catalog, paste the link into RESPECT, confirm the add.
  #
  # Steps 2-4 are retried as a unit because RESPECT gets killed on this
  # emulator: a delayed KeyEvent ANRs its main thread ("Input dispatching timed
  # out ... Waited 5076ms for KeyEvent"), the system then logs "Force finishing
  # activity world.respect.app" and leaves the launcher on screen — so 026 fails
  # on its very first assertion with the app under test blameless. Every attempt
  # clears the catalog first (020) so the add is always genuine, and the final
  # failure is reported as what it actually is, not as a rejected link.
  mark_log
  ADDED=false
  for attempt in 1 2; do
    # RESPECT persists the apps added to a school, and 025 short-circuits when
    # Tangerine is already in the catalog - so on every run after the first the
    # add was skipped and R1 stopped testing the clipboard handoff at all while
    # still reporting success. Clear the entry first so the add is real. The
    # overflow menu is reached by point: its 3-dot carries no text and no
    # contentDescription, and RESPECT drops taps that land mid-transition.
    if run_flow .maestro/flows/020_r1_respect_remove_app.yaml; then
      ok "Tangerine cleared from RESPECT's catalog - the add below is exercised for real"
    else
      printf '  \033[33mNOTE\033[0m clear-catalog attempt %s failed; retrying\n' "$attempt"
      continue
    fi

    # 025's navigate branch only runs when Tangerine is absent from the catalog,
    # which the line above has just guaranteed - so reaching "Enter link" here is
    # a real navigation rather than a skipped flow.
    if ! run_flow .maestro/flows/025_r1_add_app_enter_link.yaml; then
      printf '  \033[33mNOTE\033[0m Enter-link attempt %s failed; retrying\n' "$attempt"
      continue
    fi
    ok "RESPECT navigated to its Enter link screen"

    # The handoff itself: Maestro cannot paste, so the device does it. This is
    # the step that proves the clipboard really carries the link.
    adb_ shell input keyevent 279 >/dev/null 2>&1

    # 026 asserts the field holds respect-app-manifest/v2?respectToken=…, that
    # RESPECT parses the manifest (app title + its groups), that
    # "Add to school apps" is present (020 guaranteed an empty catalog, so that
    # is now a real assertion) and that the app comes back as a tile on Home.
    if run_flow .maestro/flows/026_r1_add_app_confirm.yaml; then
      ADDED=true
      ok "pasted link accepted; manifest parsed and Tangerine re-added as a tile"
      break
    fi
    printf '  \033[33mNOTE\033[0m add-app attempt %s failed; retrying\n' "$attempt"
  done

  if ! $ADDED; then
    # Separate "RESPECT died" from "the link was rejected": reporting the second
    # for the first is how a device hiccup gets mistaken for a product defect.
    if [ "$(log_count 'Force finishing activity world.respect.app')" -ge 1 ] \
    || [ "$(log_count 'ANR in world.respect.app')" -ge 1 ]; then
      bad "RESPECT was killed by the system during the add (ANR / force-finish in the log); the app under test is not implicated - rerun"
    else
      bad "add-app confirm failed (clipboard handoff or manifest rejected)"
    fi
  fi
fi

# ── R2: submit a form, app handoff then webview fallback ─────────────────────
if [ "$CASE" = "r2" ] || [ "$CASE" = "all" ]; then
  R2_APP="respect-r2-app-$RUN_ID"
  R2_WEB="respect-r2-web-$RUN_ID"

  step "R2 phase 1 — RESPECT opens the form in the Tangerine app; submit"
  install_tangy || exit 1
  mark_log
  # Retried once: RESPECT sometimes drops the tap right after a screen change,
  # and a missed tap makes the whole subflow time out (observed: assertion
  # "Lessons" failed after a full 60s wait, with the app otherwise healthy).
  OPENED=false
  for attempt in 1 2; do
    if run_flow .maestro/flows/023_r2_respect_open_form.yaml; then
      OPENED=true
      break
    fi
    printf '  \033[33mNOTE\033[0m navigate+Open attempt %s failed; retrying\n' "$attempt"
  done
  if $OPENED; then
    ok "RESPECT navigated to the form and tapped Open"
  else
    bad "could not reach/tap Open in RESPECT"
  fi

  if [ "$(log_count 'launched native app using intent')" -ge 1 ]; then
    ok "RESPECT launched the lesson via ACTION_VIEW (handed off to the app)"
  else
    bad "RESPECT did not log a native-app launch — it did not hand off"
  fi

  # The direct proof that it opened IN THE APP (rather than in RESPECT's own
  # WebView): the other package owns the focused window. The log line above says
  # RESPECT *tried* the handoff; this says the app actually came to the front.
  APP_FOCUSED=false
  for _ in $(seq 1 15); do
    if adb_ shell dumpsys window 2>/dev/null | grep -q "mCurrentFocus=.*$TANGY_PKG"; then
      APP_FOCUSED=true
      break
    fi
    sleep 1
  done
  if $APP_FOCUSED; then
    ok "the Tangerine app is the focused window — the lesson opened in it"
  else
    bad "the Tangerine app is not focused; the lesson did not open in the app"
  fi

  if run_flow .maestro/flows/022_r2_submit_via_app.yaml "$R2_APP"; then
    ok "form filled and submitted inside the Tangerine app"
  else
    bad "submit-in-app phase failed"
  fi

  if GOT="$(wait_for_responses 1 "$R2_APP")"; then
    ok "Tangerine server received it ($GOT matching response)"
  else
    bad "Tangerine server never showed the in-app submission (saw '$GOT')"
  fi

  # mCurrentFocus specifically, not just "the package appears in dumpsys": the
  # loose form also matches background windows and passed even when RESPECT was
  # not actually in front.
  if adb_ shell dumpsys window 2>/dev/null | grep -q "mCurrentFocus=.*$RESPECT_PKG"; then
    ok "focus returned to RESPECT after submitting (hand-back works)"
  else
    bad "focus did not return to RESPECT after submitting"
  fi

  printf '  waiting up to %ss for RESPECT to relay the statements...\n' "$UPLOAD_TIMEOUT"
  if wait_for_lrs_post; then
    ok "RESPECT side: xAPI statements POSTed to the school LRS (HTTP 200)"
  else
    bad "RESPECT side: no xAPI POST/200 captured"
  fi

  step "R2 phase 2 — app removed, so RESPECT must fall back to its WebView"
  if uninstall_tangy; then ok "Tangerine uninstalled"; else exit 1; fi
  mark_log
  if run_flow .maestro/flows/024_r2_webview_open.yaml "$R2_WEB"; then
    ok "form opened, filled and submitted inside RESPECT's WebView"
  else
    bad "webview-fallback phase failed"
  fi

  if [ "$(log_count 'will fallback to WebView')" -ge 1 ]; then
    ok "RESPECT logged the WebView fallback path"
  else
    bad "RESPECT did not log the fallback — the webview path was not taken"
  fi

  if GOT="$(wait_for_responses 1 "$R2_WEB")"; then
    ok "Tangerine server received it ($GOT matching response)"
  else
    bad "Tangerine server never showed the webview submission (saw '$GOT')"
  fi

  # Poll, not sample: the statements POST ~45s after the submission is accepted,
  # so a single sample taken right after the response lands misses them. Measured
  # in one run: response accepted, then all 3 POSTs at 15:55:05 - inside the
  # phase window, but after the sample.
  printf '  waiting up to %ss for RESPECT to relay the statements...\n' "$UPLOAD_TIMEOUT"
  if wait_for_lrs_post; then
    ok "RESPECT side: xAPI statements POSTed to the school LRS (HTTP 200)"
  else
    bad "RESPECT side: no xAPI POST/200 captured"
  fi
fi

# ── R3: use the form offline, both halves ────────────────────────────────────
# Order follows docs/ui-test-cases.txt case 3, which checks BOTH servers after
# the app-side offline submission and *before* uninstalling the app:
#   download (online) -> offline: hand off to app + submit + check both servers
#   -> offline again: uninstall, webview fallback + submit -> reconnect + check.
# Checking before the uninstall is what makes the app-side result verifiable at
# all: the offline response lives in the Tangerine app's own outbox, and
# `pm uninstall` deletes app data, so an uninstall beforehand would destroy it
# before it could ever be uploaded.
if [ "$CASE" = "r3" ] || [ "$CASE" = "all" ]; then
  R3_APP="respect-r3-app-$RUN_ID"
  R3_WEB="respect-r3-web-$RUN_ID"

  step "R3 phase 1 — download the form in RESPECT (online)"
  set_online
  wait_online || bad "device did not come online for the download"
  install_tangy || exit 1
  # Retried: the flow starts by navigating RESPECT, whose cold start can land on the
  # previous screen instead of Home (see the park phases). Without the pinned copy the
  # later offline phases have nothing to work with - phase 6 renders the lesson in
  # RESPECT's OWN WebView, so it needs this run's download, not the Tangerine app's.
  PINNED=false
  for attempt in 1 2 3; do
    if run_flow .maestro/flows/027_r3_respect_download_form.yaml; then
      PINNED=true
      break
    fi
    printf '  \033[33mNOTE\033[0m download attempt %s failed; retrying\n' "$attempt"
  done
  if $PINNED; then
    ok "form pinned in RESPECT (quick action reached 'Downloaded')"
  else
    bad "could not download the form in RESPECT"
  fi

  step "R3 phase 2 — park RESPECT on the form detail (online)"
  # Park RESPECT on the learning-unit detail WHILE ONLINE, then disconnect, then
  # only tap Open. Navigating offline is not viable: a RESPECT cold start blocks
  # on network during startup and the system kills it ("ANR in
  # world.respect.app ... failed to complete startup"). This also matches the case
  # wording - the user has the app open, then disconnects.
  # Retried like phase 5: a cold start can come back on the previous screen
  # instead of Home (the "Apps" tab then never appears) or still be loading its
  # catalog past the flow's wait.
  PARKED=false
  for attempt in 1 2 3; do
    if run_flow .maestro/subflows/respect_goto_base_form.yaml; then
      PARKED=true
      break
    fi
    printf '  \033[33mNOTE\033[0m park attempt %s failed; retrying\n' "$attempt"
  done
  if $PARKED; then
    ok "RESPECT parked on the Base Form detail"
  else
    bad "could not reach the form detail in RESPECT"
    exit 1
  fi

  step "R3 phase 3 — disconnect, then open the form from RESPECT"
  set_offline
  wait_offline && ok "network severed" || bad "could not sever the network"
  mark_log
  if run_flow .maestro/flows/028_r3_respect_open_only.yaml; then
    ok "RESPECT tapped Open while offline"
  else
    bad "offline Open failed in RESPECT"
  fi

  if [ "$(log_count 'launched native app using intent')" -ge 1 ]; then
    ok "offline handoff to the Tangerine app"
  else
    bad "offline launch did not hand off to the app"
  fi

  if run_flow .maestro/flows/022_r2_submit_via_app.yaml "$R3_APP"; then
    ok "form filled and submitted inside the app while offline"
  else
    bad "offline submit-in-app phase failed"
  fi

  if [ "$(count_responses "$R3_APP")" = "0" ]; then
    ok "Tangerine server unchanged — the offline submission was queued, not sent"
  else
    bad "server already holds the offline submission (it should not have been uploaded)"
  fi

  # The xAPI batch has to leave the lesson WebView while it is still open, and go to
  # RESPECT over IPC even with no network: the Binder hop to the launcher is local,
  # only the launcher's onward POST to the LRS needs connectivity. Assert the whole
  # chain here, while the offline phase is still attributable.
  if [ "$(log_count 'Handed a queued xAPI batch to the native delivery queue')" -ge 1 ]; then
    ok "lesson WebView handed the offline xAPI batch to the native queue"
  else
    bad "offline xAPI batch was left in the WebView outbox (native queue never saw it)"
  fi

  if [ "$(log_count 'Queued xAPI batch [0-9a-f]+ for delivery via')" -ge 1 ]; then
    ok "xAPI batch persisted natively with a connectivity-gated retry armed"
  else
    bad "no native xAPI batch was persisted"
  fi

  if [ "$(log_count 'XapiStatementsResourceIpcClient: post')" -ge 1 ]; then
    ok "app used xAPI-IPC to hand the statements to RESPECT while offline"
  else
    bad "the app never attempted xAPI-IPC while offline"
  fi

  step "R3 phase 4 — reconnect: check both servers for the app-side result"
  # NOTE: no mark_log here on purpose. The offline submit phase (3) already took
  # a mark, and RESPECT relays the queued statements when it is next brought
  # forward rather than at the exact moment of reconnect - so re-marking here
  # narrowed the window past the very evidence being asserted and reported a
  # false "no xAPI POST/200" even though the POSTs were there.
  set_online
  wait_online && ok "network restored" || bad "network did not come back"

  # The offline batch was handed to the native queue in phase 3 with a
  # connectivity-constrained WorkManager job attached, so the network returning is by
  # itself enough to deliver it - no user action and no new submission involved. This
  # is the assertion that the offline statements are not simply lost.
  printf '  waiting up to %ss for the WorkManager job to drain the xAPI queue...\n' "$UPLOAD_TIMEOUT"
  if wait_for_log 'xAPI delivery queue drained'; then
    ok "WorkManager delivered the offline xAPI batch once connectivity returned"
  else
    bad "the offline xAPI batch was never delivered by the WorkManager job"
  fi

  # Re-open the form app so the Tangerine outbox flushes its queued response.
  run_flow .maestro/flows/015_tangerine_offline_flush.yaml "$R3_APP" >/dev/null 2>&1 \
    && ok "Tangerine form app re-opened (outbox flush triggered)" \
    || printf '  \033[33mNOTE\033[0m flush trigger flow did not complete cleanly\n'

  printf '  waiting up to %ss for the app-side offline submission to upload...\n' "$UPLOAD_TIMEOUT"
  if GOT="$(wait_for_responses 1 "$R3_APP" "$UPLOAD_TIMEOUT")"; then
    ok "Tangerine server received the offline in-app submission after reconnect"
  else
    bad "offline in-app submission never reached the server (saw '$GOT')"
  fi

  # The RESPECT-side result is asserted in phase 5 instead, AFTER RESPECT has been
  # brought back to the foreground. RESPECT relays the queued statements when it
  # next becomes active rather than at the instant the network returns, so
  # checking here always found an empty window even when the POSTs did happen.
  # Phase 3's mark is left in place so that window is still covered.

  step "R3 phase 5 — park RESPECT again (online), then check the RESPECT side"
  # Same reason as phase 2: the app must already be up before the network goes.
  # Retried like phase 2: a cold start can come back on the previous screen
  # instead of Home, or stall right after a reconnect.
  PARKED=false
  for attempt in 1 2 3; do
    if run_flow .maestro/subflows/respect_goto_base_form.yaml; then
      PARKED=true
      break
    fi
    printf '  \033[33mNOTE\033[0m park attempt %s failed; retrying\n' "$attempt"
  done
  if $PARKED; then
    ok "RESPECT parked on the Base Form detail"
  else
    bad "could not reach the form detail in RESPECT"
    exit 1
  fi

  # Force the queue out. RESPECT hands statements to Android WorkManager, and
  # WorkManager runs on a TRIGGER. Submitting from a STANDALONE launch of the
  # Tangerine app is not a trigger: the app is started without the launcher's
  # xapiIpcPackage, so the injected relay never fires (measured on a run driven
  # that way: 0 "Relaying xAPI statements to launcher", 0 IPC deliveries, 0 LRS
  # POSTs, while the standalone app happily sent its own outbox over HTTP). The
  # trigger is RESPECT opening the app and the form being submitted through that
  # handoff - the new statements arrive over IPC, and that flush sends the WHOLE
  # queue, the statements queued during the offline phase included.
  if run_flow .maestro/flows/028_r3_respect_open_only.yaml; then
    ok "RESPECT opened the form while online (handoff)"
  else
    printf '  \033[33mNOTE\033[0m online Open/handoff did not complete cleanly\n'
  fi
  if run_flow .maestro/flows/022_r2_submit_via_app.yaml "$R3_APP-kick" >/dev/null 2>&1; then
    ok "form submitted through the handoff (the WorkManager trigger)"
  else
    printf '  \033[33mNOTE\033[0m handoff submit did not complete cleanly\n'
  fi

  # Attribute the relay before blaming the LRS: the statements have to reach
  # RESPECT over IPC for a POST to be possible at all. Without this, "no POST"
  # cannot be told apart from "the trigger never fired", which is the confusion
  # that produced a reported product defect out of a test-driver mistake.
  if [ "$(log_count 'Delivered [0-9]+ xAPI statements')" -ge 1 ]; then
    ok "the app relayed statements to RESPECT over IPC — the flush trigger fired"
  else
    bad "the app never relayed statements to RESPECT over IPC; the trigger did not fire"
  fi

  printf '  waiting up to %ss for RESPECT to relay the statements...\n' "$UPLOAD_TIMEOUT"
  if wait_for_lrs_post; then
    ok "RESPECT side: xAPI statements POSTed to the school LRS (HTTP 200)"
  else
    bad "RESPECT side: no xAPI POST/200 captured for the app-side submission"
  fi

  step "R3 phase 6 — offline, app removed: open in the webview and submit"
  set_offline
  wait_offline && ok "network severed again" || bad "could not sever the network"
  if uninstall_tangy; then ok "Tangerine uninstalled"; else exit 1; fi
  mark_log
  if run_flow .maestro/flows/029_r3_webview_submit_only.yaml "$R3_WEB"; then
    ok "form opened, filled and submitted inside RESPECT's WebView while offline"
  else
    bad "offline webview-fallback phase failed"
  fi

  if [ "$(log_count 'will fallback to WebView')" -ge 1 ]; then
    ok "RESPECT logged the WebView fallback path"
  else
    bad "RESPECT did not log the fallback offline"
  fi

  if [ "$(count_responses "$R3_WEB")" = "0" ]; then
    ok "Tangerine server still unchanged — nothing leaked through while offline"
  else
    bad "the offline webview submission reached the server before reconnect"
  fi

  step "R3 phase 7 — reconnect: check both servers for the webview result"
  # No mark_log here either - phase 6's mark covers the offline submit and the
  # relay that follows it (see the note in phase 4).
  set_online
  wait_online && ok "network restored" || bad "network did not come back"
  install_tangy || exit 1

  printf '  waiting up to %ss for the webview-side offline submission to upload...\n' "$UPLOAD_TIMEOUT"
  if GOT="$(wait_for_responses 1 "$R3_WEB" "$UPLOAD_TIMEOUT")"; then
    ok "Tangerine server received the offline webview submission after reconnect"
  else
    bad "offline webview submission never reached the server (saw '$GOT')"
  fi

  # Same flush trigger as phase 5: a submission is what actually relays the
  # queued statements.
  if run_flow .maestro/flows/030_r3_force_flush_submit.yaml "$R3_WEB-kick" >/dev/null 2>&1; then
    ok "submitted another form to force the queued xAPI statements out"
  else
    printf '  \033[33mNOTE\033[0m flush-kick submit did not complete cleanly\n'
  fi

  printf '  waiting up to %ss for RESPECT to relay the statements...\n' "$UPLOAD_TIMEOUT"
  if wait_for_lrs_post; then
    ok "RESPECT side: xAPI statements POSTed to the school LRS (HTTP 200)"
  else
    bad "RESPECT side: no xAPI POST/200 captured for the webview submission"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────
step "Result — case '$CASE'"
printf '  %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
