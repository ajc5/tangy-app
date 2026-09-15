# Tangerine app Maestro tests

End-to-end UI tests for the Tangerine Data Collector Android app
(`org.tangerinecentral.tangerine`), which is the Capacitor shell in this repo.

## Prerequisites

1. **A debug build installed on the device/emulator.** The flows declare
   `androidWebViewHierarchy: devtools`, which reads the DOM out of the
   Capacitor WebView over Chrome DevTools. Capacitor only enables WebView
   debugging in debug builds, so a release build will not expose it.
2. A reachable Tangerine server with a valid account.
3. [Maestro](https://maestro.mobile.dev) installed:
   `curl -Ls "https://get.maestro.mobile.dev" | bash`.

> **Do not use BlueStacks.** Its adb bridge breaks Maestro's `dadb` transport
> (`Can't find service: package` / `Broken pipe`), which kills every Maestro
> run regardless of WebView settings. Use a standard AVD or a physical device.

## Environment variables

| Variable | Meaning | Example |
| --- | --- | --- |
| `SERVER_URL` | Base URL of the Tangerine server. **No trailing slash** — the app strips one when saving, so assertions would not match. | `https://tangy.is-local.host` |
| `USERNAME` | Account used to log in. | `admin` |
| `PASSWORD` | Password for that account. | `s3cret` |

The app's built-in demo server (`https://tangy.is-local.host`, user `appuser`)
can be used for a local dev stack.

## Running

A single flow:

```
maestro test \
  -e SERVER_URL=https://school.example.org \
  -e USERNAME=admin \
  -e PASSWORD=s3cret \
  .maestro/flows/001_cold_start_test.yaml
```

The whole suite (flows that do not log in ignore the credential variables):

```
maestro test \
  -e SERVER_URL=https://school.example.org \
  -e USERNAME=admin \
  -e PASSWORD=s3cret \
  .maestro/flows/
```

## Flows

| Flow | Needs credentials | What it covers |
| --- | --- | --- |
| `001_cold_start_test.yaml` | no | Clean launch lands on the server URL screen; login chrome present; demo server is suggested. |
| `002_server_url_validation_test.yaml` | no | Empty and whitespace-only server URLs are rejected. |
| `003_server_url_change_test.yaml` | no | Entering a URL reaches the credentials screen; "Change" returns to step 1 with the URL retained. |
| `004_login_validation_test.yaml` | yes (`USERNAME`) | Empty and username-only submissions are rejected. |
| `005_login_success_test.yaml` | yes | Full login reaches "Groups"; the menu shows the user and actions. |
| `006_logout_test.yaml` | yes | Logout returns to the credentials screen and keeps the server URL. |
| `007_clear_login_history_test.yaml` | yes | "Clear Login History" keeps the current session (does not log you out). |
| `011_tangerine_submit_form.yaml` | yes | T1-2: open, fill and submit a form; the server gains the response. |
| `012_tangerine_offline_download_form.yaml` | yes | T1-3 phase 1: pin a form; badge `Download` -> `Downloaded`. |
| `013_tangerine_offline_download_group.yaml` | yes | T1-4 phase 1: pin a whole group; badge `Download` -> `Downloaded`. |
| `014_tangerine_offline_submit.yaml` | no | T1-3/4 phase 2: open the pinned form, fill and submit it offline. |
| `015_tangerine_offline_flush.yaml` | no | T1-3/4 phase 3: re-open the form app so the queued response uploads. |
| `016_tangerine_cancel_group_download.yaml` | yes | A second tap on a busy badge cancels the group download; nothing is marked cached. |
| `020_r1_respect_remove_app.yaml` | no | RESPECT R1: clear Tangerine from RESPECT's catalog via the tile's 3-dot -> Remove, so the add below is exercised instead of skipped (no-op when already absent). |
| `021_r1_tangerine_copy_link.yaml` | yes | RESPECT R1: copy the manifest link out of the Tangerine menu. |
| `022_r2_submit_via_app.yaml` | no | RESPECT R2: submit the form RESPECT handed off to the app (starts in the overlay). |
| `023_r2_respect_open_form.yaml` | no | RESPECT R2: browse to the form and tap Open (triggers the handoff). |
| `024_r2_webview_open.yaml` | no | RESPECT R2/R3: with the app uninstalled, open, fill and submit in RESPECT's WebView. |
| `025_r1_add_app_enter_link.yaml` | no | RESPECT R1: reach the "Enter link" screen and focus the field (skips the navigation when the app is somehow already added). |
| `026_r1_add_app_confirm.yaml` | no | RESPECT R1: assert the pasted link, confirm the add, and see the app return as a tile on Home. |
| `027_r3_respect_download_form.yaml` | no | RESPECT R3: pin the form from RESPECT's own quick action. |
| `028_r3_respect_open_only.yaml` | no | RESPECT R3: tap Open on a detail screen RESPECT is already parked on (no launch/navigate). |
| `029_r3_webview_submit_only.yaml` | no | RESPECT R3: Open + fill + submit in RESPECT's WebView; no navigation, for the offline half. |
| `030_r3_force_flush_submit.yaml` | yes | RESPECT R3: submit a form to force the queued xAPI statements out (a submission is the trigger; re-opening alone is not). |

## RESPECT cases (two apps + the device)

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

The driver must be pointed at a **debug** APK for the re-install step:

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
  reported success without ever testing the clipboard handoff. `020` clears the
  entry first: tap the 3 vertical dots at the tile's top-right, then `Remove`
  (no confirmation dialog). The 3-dot is a clickable `View` with no text and no
  `contentDescription`, so it must be reached by point (`25%,22%` with one tile
  in the grid on 1080x2400). `026` then asserts `Add to school apps` is present,
  which is only sound because `020` guaranteed an empty catalog.
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

* `subflows/goto_login_step2.yaml` — server URL screen → credentials screen.
* `subflows/login.yaml` — credentials screen → "Groups" home.
* `subflows/logout.yaml` — burger menu → Logout, dismissing the confirmation and
  waiting for the credentials screen.
* `subflows/ensure_logged_out.yaml` — normalises whatever screen the app is on
  into "signed out, login step 1" without wiping app data.

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

* Only `001_cold_start_test` and `002_server_url_validation_test` start with
  `launchApp: { clearState: true }`; both assert a first-run state (001 expects
  no session, 002 needs an empty server field, which is otherwise pre-filled
  from `localStorage.serverUrl`).
* `clearState: true` is `pm clear`: it wipes the WebView `localStorage` cache
  markers *and* the native offline cache. The other flows therefore call
  `subflows/ensure_logged_out.yaml` instead, which preserves app data and keeps
  session-restore / stale-cache behaviour under test.
* The shell UI is hardcoded English (`www/js/views.js` does not use the
  `i18n.js` registry), so text assertions are locale-independent.
* Buttons are rendered uppercase via CSS but their DOM text is mixed case, so
  the flows select buttons by `id` rather than text.
* Focusing the server/username fields opens an absolutely-positioned
  suggestion list that **overlaps the control below it**. The subflows blur the
  field and wait for the list to close before tapping the next control.
* Login is submitted with `pressKey: Enter` (implicit form submission) because
  the soft keyboard covers the Login button and the app's `popstate` handler
  turns a Back press into "return to step 1".
* Flows assume the account can reach at least one group only for the "Groups"
  heading; no group names are asserted, so any server state works.
