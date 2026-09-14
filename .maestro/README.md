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
