# xAPI statement delivery — what happens in each configuration

Who renders a lesson, and who owns delivery of the xAPI statements it produces,
depends on two things: whether the **Tangerine app** (T) is installed and whether
the **RESPECT launcher** (R) is installed. Connectivity then decides *when* those
statements reach the school LRS, not *whether the launcher is used* — the hop to
the launcher is a local Binder call and needs no network.

Terminology used below:

| Term | Meaning |
|---|---|
| **handoff** | RESPECT fires an `org.openeel.action.LAUNCH` intent at the Tangerine app, which opens the lesson in its own cached WebView (`openCachedWebView`) and carries `endpoint` / `auth` / `actor` / `activity_id` / `xapiIpcPackage` in the URL |
| **RESPECT's WebView** | the launcher's own WebView, used when the app is absent ("will fallback to WebView") |
| **the relay** | the host's IPC bridge that hands statements to the launcher: `Capacitor.Plugins.TangyCache` (shell WebView) or an injected `window.TangyCacheBridge` (the app's raw lesson WebView). One implementation: `online-survey-app/src/app/shared/_services/xapi-relay.ts` |
| **native queue** | the app's durable outbox `files/tangy-pending-xapi`, drained by `XapiDeliveryWorker` (WorkManager, `NetworkType.CONNECTED`) |

## The eight combinations

| # | T | R | Net | How the lesson opens | What happens to the statements |
|---|---|---|---|---|---|
| 1 | ✓ | ✓ | online | handoff → app's cached WebView | player relay (`forward`) → bridge → IPC → RESPECT posts to the LRS → app returns the user to RESPECT |
| 2 | ✓ | ✓ | **offline** | handoff (RESPECT parked online first) | relay attempted **anyway**; RESPECT takes them and posts when the network returns. If RESPECT refuses instead, the batch goes to the native queue and WorkManager retries. Nothing is parked in the web outbox |
| 3 | ✓ | ✗ | online | no launcher: app used standalone (its own login/groups) | **no xAPI at all** — no launch params, so no `endpoint`/`auth`/`actor`/`xapiIpcPackage` and the player skips the batch. A batch queued while RESPECT *was* installed can never be delivered: the job retries 12×, then keeps the files for the next app start |
| 4 | ✓ | ✗ | offline | app standalone, form pinned in the app | as 3 (no xAPI config). Form *responses* queue in the app and upload on reconnect |
| 5 | ✗ | ✓ | online | RESPECT's own WebView (no app to hand off to) | no relay in that page → the player falls back to `ADL.XAPIWrapper` → **direct POST to the LRS** (200). No IPC and no WorkManager involved |
| 6 | ✗ | ✓ | offline | RESPECT's own WebView, lesson from RESPECT's cache | the batch goes to RESPECT's WebView `localStorage` outbox and is POSTed directly on reconnect (`[Outbox] Delivered xAPI statements`) |
| 7 | ✗ | ✗ | online | nothing to launch from — release URL in a browser or another host | direct POST to the LRS if the URL carries the launch params; no app, no queue |
| 8 | ✗ | ✗ | offline | as 7 | page-localStorage outbox in whichever browser/WebView is showing it; flushes when that page is alive and online |

## The cells that matter

**Rows 1–2 are what the app is for.** Both use xAPI-IPC. Row 2 used to be broken:
the form player returned early on `navigator.onLine === false` and parked the
batch in its own localStorage outbox, whose flush had no route to the launcher
and (in the app's WebView) could only exit through a Capacitor call that never
exists there — so offline statements were retried forever and delivered never.
The relay is now attempted *before* the offline check.

**Rows 3–4 ("RESPECT uninstalled") are a different product mode, not a degraded
one**: standalone Tangerine has no LRS. Two details:
- RESPECT removed *after* batches were queued leaves them undeliverable; the
  worker gives up after 12 attempts and keeps the files, re-arming on next start
  in case RESPECT returns.
- The queue dies with the app: uninstalling **T** deletes `files/tangy-pending-xapi`.

**Rows 5–6 ("Tangerine uninstalled")** involve no Tangerine code. RESPECT renders
the lesson and the statements go straight to the LRS; the retry owner is RESPECT's
WebView localStorage, not our WorkManager.

## Caveats that cut across the matrix

- **Content that was never downloaded cannot be opened offline.** Row 2 needs the
  lesson pinned in the app (or downloaded in RESPECT) or the WebView has nothing
  to render.
- **iOS differs.** The TangyCache plugin is not compiled into the iOS build, so
  there is no bridge; forms open via InAppBrowser and rows 1–2 behave like rows
  5–6 (direct/ADL path) with no WorkManager queue.
- **Duplicate safety.** Batches are content-addressed in the native queue, so a
  batch offered twice is stored once, and statement ids make an LRS-side repeat
  idempotent.

## Code map

| Behaviour | Where |
|---|---|
| Relay discovery/choice (`forward` vs `queue`) | `online-survey-app/src/app/shared/_services/xapi-relay.ts` |
| Relay preferred over the offline gate | `online-survey-app/.../tangy-forms-player.component.ts` → `sendXapiStatements()` |
| Outbox defers response uploads but not xAPI hand-offs when offline | `online-survey-app/src/app/shared/_services/offline-outbox.service.ts` → `doFlush()` |
| Durable native queue + WorkManager retry | `tangy-cache-plugin/android/.../XapiDelivery.kt` |
| Injected bridge, ADL wrapper, outbox mirror | `tangy-cache-plugin/android/.../TangyCachePlugin.kt` |
