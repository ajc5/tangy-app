# RESPECT ↔ Tangerine Maestro tests

End-to-end UI tests spanning two apps: the **RESPECT** launcher
(`world.respect.app`) and the **Tangerine Data Collector** Android app
(`org.tangerinecentral.tangerine`), the Capacitor shell in this repo.

Every selector is an **accessibility id or accessible name**, so the suite runs
against **production builds**.

## Prerequisites

1. **The app installed on the device/emulator.** These tests target a
   **production build**: each selector is a resource id (`id:`) or an accessible
   name (`text:`) exposed through the Android accessibility bridge.
2. A reachable RESPECT server whose school already has the Tangerine app added
   (see [RESPECT cases](#respect-cases-two-apps--the-device)).
3. [Maestro](https://maestro.mobile.dev) installed:
   `curl -Ls "https://get.maestro.mobile.dev" | bash`.

> **Do not use BlueStacks.** Its adb bridge breaks Maestro's `dadb` transport
> (`Can't find service: package` / `Broken pipe`), which kills every Maestro
> run. Use a standard AVD or a physical device.

## Environment variables

| Variable | Meaning | Example |
| --- | --- | --- |
| `SERVER_URL` | Base URL of the Tangerine server. **No trailing slash** — the app strips one when saving, so assertions would not match. | `https://tangy.is-local.host` |
| `USERNAME` | Tangerine account used to log in. | `appuser` |
| `PASSWORD` | Password for that account. | `Password1!` |
| `GROUP_NAME` | Group whose form(s) the flow opens. | `Group X` |
| `FORM_NAME` | Form opened by the submit / offline flows. | `Base Form` |
| `ANSWER` | Text typed into the form's first question. | `test answer` |
| `GROUP_DB` | CouchDB database used by `011` to count responses. | `group-8f2c…` |
| `COUCH_USER` / `COUCH_PASSWORD` | Credentials for that CouchDB count. | `admin` / `secret` |
| `FORM_ID` | Optional — narrows `011`'s count to one form. | `abc123` |
| `RESPECT_ADMIN_ACCOUNT` | Display name on RESPECT's Accounts screen (used by `020`). | `admin` |
| `ASSIGNMENT_NAME` | Existing RESPECT assignment whose single task is the Tangerine form (used by `040`/`041`). | `My assignment` |
| `ASSIGNMENT_STUDENT_COUNT` | Number of students `041` expects to see completed. Defaults to `1`. | `1` |

The app's built-in demo server (`https://tangy.is-local.host`, user `appuser`) can
be used for a local dev stack.

Two prefills come with it, and flows have to clear rather than prepend:

- **Step 1** shows the demo URL when no server is remembered. Nothing is
  validated or saved until Connect is tapped, but the header pill follows the
  *field*, so it reads `DEMO MODE` while the demo URL is in it and disappears
  when the field is emptied.
- **Step 2** fills `appuser` / `Password1!` when the server is the demo server and
  both fields are still empty.

The header shows a centred `DEMO MODE` pill on every screen while the demo server is
the one being used (on step 1: the one in the field; everywhere else: the connected one).

Every login field has a clear (X) button on its right edge, shown only while the
field has text. Tapping the rightmost ~5 % of a field therefore *empties* it (and
keeps it focused) when it has a value, and just focuses it when it does not — which
is why flows tap `point: "95%,50%"` before typing. Clearing focuses the field, so a
suggestion list may open and overlap the button below: blur it (tap the heading or
the read-only server line) and wait for the list to close before tapping on.

## Running

A single flow:

```
maestro test \
  -e SERVER_URL=https://tangy.is-local.host \
  -e USERNAME=appuser \
  -e PASSWORD='Password1!' \
  .maestro/flows/005_login_success_test.yaml
```

The whole suite (each flow ignores variables it does not need):

```
maestro test \
  -e SERVER_URL=https://tangy.is-local.host \
  -e USERNAME=appuser \
  -e PASSWORD='Password1!' \
  -e GROUP_NAME='Group X' \
  -e FORM_NAME='Base Form' \
  -e ANSWER='test answer' \
  -e GROUP_DB=group-8f2c… \
  -e COUCH_USER=admin \
  -e COUCH_PASSWORD=secret \
  -e RESPECT_ADMIN_ACCOUNT=admin \
  -e ASSIGNMENT_NAME='My assignment' \
  .maestro/flows/
```

## Flows

| Flow | Env | What it covers |
| --- | --- | --- |
| `001_cold_start_test.yaml` | — | Clean launch lands on the server URL screen; login chrome present; demo URL prefilled and flagged `DEMO MODE` until the field is cleared. |
| `002_server_url_validation_test.yaml` | — | Empty, whitespace-only, malformed and unreachable server URLs are rejected on step 1. |
| `003_server_url_change_test.yaml` | `SERVER_URL` | Entering a URL reaches the credentials screen; "Change" returns to step 1 with the URL retained. |
| `004_login_validation_test.yaml` | `SERVER_URL`, `USERNAME` | Empty and username-only submissions are rejected. |
| `005_login_success_test.yaml` | login | Full login reaches "Groups"; the account menu shows the user and its actions. |
| `006_logout_test.yaml` | login | Logout returns to the credentials screen and keeps the server URL. |
| `007_clear_login_history_test.yaml` | login | "Clear Login History" keeps the current session (does not log you out). |
| `008_server_tangerine_version_test.yaml` | internet | A URL whose `/respect-app-manifest` answers 404 (example.com) is rejected with the "correct version of Tangerine" message. |
| `011_tangerine_submit_form.yaml` | login + `GROUP_NAME`, `FORM_NAME`, `ANSWER`, `GROUP_DB`, `COUCH_USER`, `COUCH_PASSWORD` | Open, fill and submit a form; the server gains exactly one response. |
| `012_tangerine_offline_download_form.yaml` | login + `GROUP_NAME`, `FORM_NAME` | Pin a form; badge `Download` -> `Downloaded`. |
| `013_tangerine_offline_download_group.yaml` | login + `GROUP_NAME` | Pin a whole group; badge `Download` -> `Downloaded`. |
| `014_tangerine_offline_submit.yaml` | `GROUP_NAME`, `FORM_NAME`, `ANSWER` | Open the pinned form, fill and submit it offline. |
| `015_tangerine_offline_flush.yaml` | `GROUP_NAME`, `FORM_NAME` | Re-open the form so the queued response uploads. |
| `016_tangerine_cancel_group_download.yaml` | `GROUP_NAME` | A second tap on a busy badge cancels the group download; nothing is marked cached. |
| `020_r1_respect_open_apps.yaml` | `RESPECT_ADMIN_ACCOUNT` | RESPECT R1: cold start onto Home, where the app tile (and its 3-dot) lives. |
| `020_r1_respect_remove_app.yaml` | — | RESPECT R1: tap `Remove` in the tile menu the driver opened, so the add below is exercised instead of skipped. |
| `021_r1_tangerine_copy_link.yaml` | login | RESPECT R1: copy the manifest link out of the Tangerine menu. |
| `022_r2_submit_via_app.yaml` | `ANSWER` | RESPECT R2: submit the form RESPECT handed off to the app (starts in the overlay). |
| `023_r2_respect_open_form.yaml` | — | RESPECT R2: browse to the Tangerine form and tap `Open` (triggers the handoff to the app). |
| `024_r2_webview_open.yaml` | `ANSWER` | RESPECT R2/R3: with the app uninstalled, open, fill and submit in RESPECT's WebView. |
| `025_r1_add_app_enter_link.yaml` | — | RESPECT R1: reach the "Enter link" screen and focus the field (FAB by `id: floating_action_button`, field by its `Link*` label; skips the navigation when the app is somehow already added). |
| `026_r1_add_app_confirm.yaml` | — | RESPECT R1: assert the pasted link, confirm the add, and see the app return as a tile on Home. |
| `027_r3_respect_download_form.yaml` | — | RESPECT R3: pin the form from RESPECT's own quick action. |
| `028_r3_respect_open_only.yaml` | — | RESPECT R3: tap `Open` on a detail screen RESPECT is already parked on (no launch/navigate). |
| `029_r3_webview_submit_only.yaml` | `ANSWER` | RESPECT R3: Open + fill + submit in RESPECT's WebView; no navigation, for the offline half. |
| `030_r3_force_flush_submit.yaml` | login + `GROUP_NAME`, `FORM_NAME`, `ANSWER` | RESPECT R3: submit a form to force the queued xAPI statements out (a submission is the trigger; re-opening alone is not). |
| `040_r4_open_assignment_task.yaml` | `ASSIGNMENT_NAME` | RESPECT R4: open an existing assignment and launch its Tangerine form task. |
| `041_r4_assert_assignment_completed.yaml` | `ASSIGNMENT_NAME`, `ASSIGNMENT_STUDENT_COUNT` | RESPECT R4: the assignment reports the task as completed (`Completed (N)`). |

`login` = `SERVER_URL`, `USERNAME`, `PASSWORD`.

## RESPECT cases (two apps + the device)

### Selector policy: accessibility ids, never coordinates

Every RESPECT-side interaction selects its target from the accessibility tree — a
`testTag` (`id:`) or an accessible name (`text:`). No flow taps a coordinate, and
the same flow set runs against a **production build**.

Where RESPECT exposes nothing to select, the target is *derived from the tree*
rather than hard-coded: that is only true of the app tile's 3-dot overflow, and
`.maestro/scripts/tile_overflow_point.py` does it (see the gotchas below).

R1-R3 live in `docs/ui-test-cases.txt` and span two apps *and* device state, so
they are driven by a shell script that interleaves Maestro flows with `adb`:

```
./.maestro/run-respect.sh [r1|r2|r3|all]
```

Why a driver: the clipboard handoff needs `adb shell input keyevent 279` between
the apps (Maestro has no clipboard API); the fallback half needs the Tangerine app
*uninstalled* and re-installed afterwards; the offline half needs the emulator's
network severed. Every phase is asserted on **both** servers — Tangerine's CouchDB
(`<server>/db/<group>/_all_docs`) and RESPECT's xAPI statements, which surface in
logcat as the launcher forwarding them to the school LRS with HTTP 200.

The driver re-installs the app as part of the fallback half, so point it at the
APK to use (it defaults to the debug build):

```
APK=android/app/build/outputs/apk/debug/app-debug.apk ./.maestro/run-respect.sh all
```

### RESPECT gotchas these cases hit

* **RESPECT cannot cold-start offline.** Its startup blocks on network and the
  system kills it (`ANR in world.respect.app … failed to complete startup`, ~20s
  after launch), leaving the launcher on screen. R3 therefore parks RESPECT on the
  form detail **while online**, severs the network, and only then taps Open (028 /
  029). `respect_goto_base_form.yaml` is online-only for this reason.
* **RESPECT drops taps** right after a screen change; a missed tap otherwise burns
  a full 60s assertion. The navigate+Open and park steps retry once.
* **A submission is what relays queued xAPI statements.** Re-opening the form app
  flushes the queued *response*, but the queued *statements* only leave when the
  app next submits — hence 030. Polling for the LRS POST after merely resuming
  times out even though the relay is healthy.
* **Assertions are polled, never sampled once.** The statements are POSTed tens of
  seconds after the response is accepted, so a single check taken right after the
  response lands reports a false negative.
* **Phase output is timestamped** so captured logcat can be attributed to a phase.
* **RESPECT persists added apps, so R1 must un-add first.** RESPECT stores the
  apps added to a school, and `025` short-circuits when Tangerine is already in
  the catalog — so every run after the first silently skipped the add and R1
  reported success without ever testing the clipboard handoff. The catalog entry
  is cleared first, in three steps: `020_r1_respect_open_apps.yaml` parks RESPECT
  on Home, the driver taps the tile's overflow, `020_r1_respect_remove_app.yaml`
  taps `Remove` (no confirmation dialog).
* **The tile 3-dot has no accessibility node at all.** It is a Compose
  `IconButton` whose `Icon` has `contentDescription = ""` and no `testTag`, so the
  tree exposes a clickable node with no id, text or description — nothing a
  selector can match, and Maestro's relative selectors all need a named node to
  anchor on. `pm clear` cannot substitute either: the catalog lives on RESPECT's
  server, so only this menu's `Remove` un-adds an app. The driver therefore
  *derives* the point from the accessibility tree
  (`.maestro/scripts/tile_overflow_point.py`: title -> enclosing clickable tile ->
  smallest clickable node inside it) instead of hard-coding a percentage.
* **Anchor assertions on a screen-unique label.** RESPECT's App detail screen
  shows the app title, so a bare `assertVisible: "Tangerine"` is satisfied before
  the app is ever added. `020`/`026` assert `Bookmarks` (Home's tab bar) to pin
  the screen. The App detail back button is labelled `Back`, **not** `Navigate up`
  (the latter is RESPECT's own WebView toolbar), and adding an app does not pop
  the stack — back out of `App detail -> Enter link -> Select app`.
* **RESPECT gets killed mid-flow on this emulator.** A delayed key event ANRs its
  main thread — `Input dispatching timed out … Waited 5076ms for KeyEvent` — and
  the system follows with `Force finishing activity world.respect.app`, leaving
  the launcher on screen. `026` then fails on its first assertion with the app
  under test blameless. Steps 2-4 of R1 are retried as a unit, each attempt
  re-clearing the catalog via `020` so the add stays genuine, and a final failure
  consults the log to report "RESPECT was killed by the system" instead of the
  misleading "the link was rejected".
* LRS evidence is matched with `grep -cE`, **never** plain `grep -c`: BSD grep
  rejects `\)` in a BRE with "parentheses not balanced", exits 2 and prints
  nothing, which a `$(…)` capture turns into "0 matches". The driver now fails
  fast if a log pattern does not compile.

## Shared subflows

* `subflows/ensure_logged_out.yaml` — normalises whatever screen the app is on
  into "signed out, login step 1" without wiping app data.
* `subflows/ensure_logged_in.yaml` — ensures the app is running and signed in
  without clearing state (keeps the downloaded cache and stored session).
* `subflows/goto_login_step2.yaml` — server URL screen → credentials screen.
* `subflows/login.yaml` — credentials screen → "Groups" home.
* `subflows/logout.yaml` — burger menu → Logout, dismissing the confirmation and
  waiting for the credentials screen.
* `subflows/open_form.yaml` — Groups screen → group → form, waiting until the
  player is interactive.
* `subflows/fill_and_submit_form.yaml` — fill the open form's first question and
  submit it.
* `subflows/respect_goto_base_form.yaml` — RESPECT Home → the Tangerine
  "Base Form" learning-unit detail. Shared by the R2 submit and R3 offline
  cases, which then tap `Open` to hand the lesson off to the app.

## Device support

* **Android 8.0 (API 26)** is the floor: that is the app's `minSdkVersion` in
  `android/variables.gradle` (Capacitor's own default is 24, so raising it is a
  one-line change). Everything in these flows works back to that level.
* The header uses `env(safe-area-inset-*)`, which needs WebView ≥ Chrome 69. The
  CSS declares plain `padding`/`height` fallbacks first, so an un-updated WebView
  on an old device keeps the original 56px header instead of a broken one.
* Android 15+ (API 35+) forces edge-to-edge rendering; that is what the safe-area
  insets compensate for. On older releases the insets resolve to 0 and the plain
  fallbacks apply.
* iOS: deployment target 15.0 (`ios/App/App.xcodeproj`). The WebView inset fixes
  are Android-specific; iOS forms open in `SFSafariViewController`.

## Notes and gotchas

* Flows that only need an existing session call `subflows/ensure_logged_out.yaml`
  (which normalises whatever screen the app is on into "signed out, step 1")
  rather than `clearState: true` — that is `pm clear` and would destroy the
  WebView `localStorage` cache markers *and* the native offline cache. Only `001`
  and `002` keep `clearState: true`, because both assert a genuine first-run
  state.
* The shell UI is hardcoded English (`www/js/views.js` does not use the
  `i18n.js` registry), so text assertions are locale-independent.
* The WebView exposes DOM `id` attributes as Android `resource-id`, so the flows
  select controls by `id:` (`server-url`, `connect-btn`, `login-btn`, …) wherever
  one exists — more robust than text, which CSS uppercases (`CONNECT`). Values
  that have no DOM id (e.g. a list row) are matched by their text.
* Focusing the server/username fields opens an absolutely-positioned
  suggestion list that **overlaps the control below it**. The subflows blur the
  field and wait for the list to close before tapping the next control.
* Login is submitted with `pressKey: Enter` (implicit form submission) because
  the soft keyboard covers the Login button and the app's `popstate` handler
  turns a Back press into "return to step 1".
* Flows that open a form (`011`, `014`-`016`, `022`, `030`) need a server the
  account can reach with the configured `GROUP_NAME`/`FORM_NAME`; the offline
  cases additionally require the form/group to be pinned first.
