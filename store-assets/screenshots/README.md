# Play Store screenshots

Captured from the running app on the Android emulator (`org.tangerinecentral.tangerine`,
demo server / DEMO MODE) at each form factor's viewport.

| File | Device class | Size (px) | Screen shown |
| --- | --- | --- | --- |
| `phone-1-forms-list.png` | Phone (9:16) | 1080 x 1920 | Forms – Demo Forms list |
| `phone-2-form-answers.png` | Phone (9:16) | 1080 x 1920 | Classroom Observation Form (answering) |
| `phone-3-egra-form.png` | Phone (9:16) | 1080 x 1920 | EGRA Form letter grid, item marked incorrect, Submit |
| `phone-4-group-list.png` | Phone (9:16) | 1080 x 1920 | Groups list |
| `tablet-7in-forms-list.png` | 7" tablet, 600x960 dp | 1200 x 1920 | Forms – Demo Forms list |
| `tablet-7in-form-submit.png` | 7" tablet, 600x960 dp | 1200 x 1920 | Classroom Observation Form with Submit |
| `tablet-7in-egra-form.png` | 7" tablet, 600x960 dp | 1200 x 1920 | EGRA Form letter grid, item marked incorrect, Submit |
| `tablet-10in-forms-list.png` | 10" tablet, 800x1280 dp | 1600 x 2560 | Forms – Demo Forms list |
| `tablet-10in-form-submit.png` | 10" tablet, 800x1280 dp | 1600 x 2560 | Classroom Observation Form (all questions + Submit) |
| `tablet-10in-egra-form.png` | 10" tablet, 800x1280 dp | 1600 x 2560 | EGRA Form letter grid, item marked incorrect, Submit |

## Play Console requirements met

- Min 2 phone screenshots (here 4), min 1 per tablet class (here 3 each).
- Every side 320–3840 px.
- Aspect ratio no wider than 2:1 in either direction.
- 24-bit PNG (no alpha channel), no device frames, no added text overlays; raw app UI only.

## Colour theme

The list/group screens use the app's own palette (`www/css/styles.css`). The **form
player** is a separate web app served by the Tangerine server, and a release ships
Angular Material's *default* theme (indigo `#3f51b5` / pink `#ff4081`) — that is what the
first batch of these screenshots showed. `TangyCachePlugin.FORM_THEME_SCRIPT` now injects
the app's palette into every cached form WebView (`--mdc-theme-primary: #3c5b8d`,
`--mdc-theme-secondary: #f26f10`, plus the `--primary-color` / `--accent-color` pair), so
the player matches the rest of the product:

| Element | Before | After |
| --- | --- | --- |
| Section headings, selected radio, marked grid cell | `#3f51b5` indigo | `#3c5b8d` Tangerine blue |
| Submit button | `#ff4081` pink | `#f26f10` Tangerine orange |

The four form screenshots therefore require a build that includes that script: rebuild
and install the debug APK (`cd android && ./gradlew :app:assembleDebug && adb install -r
app/build/outputs/apk/debug/app-debug.apk`) before re-capturing them.

## Regenerating

The emulator's own screen size is overridden so no extra AVD is needed:

```bash
# phone
adb shell wm size 1080x1920 && adb shell wm density 420
# 7" tablet (1200/2 = 600dp, 1920/2 = 960dp)
adb shell wm size 1200x1920 && adb shell wm density 320
# 10" tablet (1600/2 = 800dp, 2560/2 = 1280dp)
adb shell wm size 1600x2560 && adb shell wm density 320

adb exec-out screencap -p > shot.png   # after navigating to the screen you want
adb shell wm size reset && adb shell wm density reset   # always restore afterwards
```

Then flatten to 24-bit PNG before upload:

```python
from PIL import Image
Image.open('shot.png').convert('RGB').save('out.png', 'PNG', optimize=True)
```
