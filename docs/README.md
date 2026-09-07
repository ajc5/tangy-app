# Launching Tangerine lessons from RESPECT (Open Educational Experience Launcher)

RESPECT lets a user launch a lesson from a compatible app (like Tangerine) directly in that app's
own UI. Because the Tangerine app can connect to any Tangerine server (the server is chosen at
runtime, so lesson URLs are **not** verified App Links), RESPECT launches it with a custom intent
action rather than relying on Android App Links.

## How it works

RESPECT (`LaunchAppUseCaseAndroid`) fires an implicit intent with the lesson URL as its data:

```kotlin
val intent = Intent("org.openeel.action.LAUNCH").also {
    it.flags = Intent.FLAG_ACTIVITY_NEW_TASK
    it.data = <lesson URL with xAPI launch params>.toUri()
    it.addCategory(Intent.CATEGORY_BROWSABLE)
}
```

Because the action is a custom action (not `ACTION_VIEW`), it does **not** require a verified App
Link — so it works for any lesson host, including dynamically selected Tangerine servers.

Tangerine handles it in three places:

1. `android/app/src/main/AndroidManifest.xml` — the `org.openeel.action.LAUNCH` intent filter on
   `MainActivity` (schemes `https`/`http`), which lets RESPECT detect and launch the app.
2. `MainActivity.kt` (`onNewIntent`) — forwards the incoming lesson URL into the web layer on
   **warm** starts. Cold starts are already covered by Capacitor's `App.getLaunchUrl()` (the Bridge
   captures the intent data regardless of action).
3. `www/js/app.js` (`handleDeepLink`) — restores the session and opens the lesson in **Tangerine's
   own in-app browser** (`views.openFormInWebView` → the TangyCache cached WebView).

## Rebuild and verify

```bash
npx cap sync android
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Confirm the LAUNCH intent resolves to Tangerine (not a browser):

```bash
adb shell cmd package query-activities --brief \
  -a org.openeel.action.LAUNCH -c android.intent.category.BROWSABLE \
  -d "https://<any-host>/releases/prod/online-survey-apps/<groupId>/<formId>/"
```

You should see `org.tangerinecentral.tangerine/.MainActivity`.

Watch the log when RESPECT opens a lesson:

```bash
adb logcat -s MainActivity
# expect: OpenEel LAUNCH intent received: ...
#         Forwarding deep link to JS: ...
```

## Note on verified App Links (optional)

For hosts you control that can serve `https://<host>/.well-known/assetlinks.json`, a verified App
Link filter is an alternative/additional mechanism — but it is **not** required for this
integration and does not support dynamically selected servers.
