# Launching Tangerine from RESPECT (Android App Link verification)

When RESPECT taps **OPEN** on a lesson it fires an implicit `ACTION_VIEW` intent on the lesson
URL with `FLAG_ACTIVITY_REQUIRE_NON_BROWSER`. On Android 11+ (SDK 30+) that flag only resolves to
an app whose intent filter is a **verified Android App Link**. This app is now set up to be that
verified handler (see `android/app/src/main/AndroidManifest.xml`), but **verification has to be
completed on the server side before it takes effect**.

## What is needed

### 1. Tangerine server (mandatory, per lesson-host)

The https host of the Tangerine server that serves the lesson URLs must publish this app's
statement at:

```
https://<host>/.well-known/assetlinks.json
```

Copy `docs/assetlinks.json` there. It currently contains the **debug** signing certificate
fingerprint (`1A:31:9B:63:...`) so debug builds on the emulator verify. For a release build, add
(or replace with) the release keystore's SHA-256 fingerprint.

To get the release fingerprint:

```bash
keytool -list -v -keystore <release.jks> -alias <alias> -storepass <pass> | grep -A1 "SHA256:"
```

Add it as another entry in the `sha256_cert_fingerprints` array.

**HTTPS is required.** Android fetches `assetlinks.json` only over HTTPS and never verifies App
Links over plain `http`. So `http://192.168.1.90:8080` will never verify — the lesson URL host
must be reachable over HTTPS.

### 2. Android manifest (done, one value to fill)

`android/app/src/main/AndroidManifest.xml` now declares a verified App Link intent filter. Replace
the placeholder:

```xml
<data android:host="YOUR-TANGERINE-SERVER-HOST" />
```

with the actual https host from step 1 (e.g. `<data android:host="tangy.example.org" />`). Add more
`<data android:host="..."/>` lines if multiple servers should be able to launch this app.

### 3. Rebuild and verify

```bash
npx cap sync android
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Then confirm Android has verified the link:

```bash
adb shell dumpsys package org.tangerinecentral.tangerine | grep -A2 "androidx.autofill\|links"
# Look for:  verified=true for the host
```

A quicker sanity check that the URL now resolves to Tangerine (instead of the browser):

```bash
adb shell cmd package resolve-activity --brief -a android.intent.action.VIEW \
  -c android.intent.category.BROWSABLE \
  -d "https://<host>/releases/prod/online-survey-apps/<groupId>/<formId>/"
```

You should see `org.tangerinecentral.tangerine/.MainActivity` instead of `com.android.chrome`.

## Behavior once launched

`www/js/app.js` → `handleDeepLink()` now, after restoring the session, opens the launched lesson
inside **Tangerine's own in-app browser** (`views.openFormInWebView()` → the TangyCache cached
WebView) rather than leaving it in RESPECT's WebView.
