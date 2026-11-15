---
name: keyframex-troubleshoot
description: Diagnose and fix KeyframeX problems — panel missing from Window → Extensions, "After Effects could not run the KeyframeX script", "needs Chrome or Edge", wrong length or size, missing fonts, placeholders instead of media, parts that came in as pictures or differ from the browser. Use whenever a KeyframeX conversion or build did not do what the user expected.
---

# Troubleshoot KeyframeX

## Inputs
- What the user saw (message text, screenshot), the HTML/scene path, the conversion
  `report.md` in `<Name> (KeyframeX)/`, and the panel's Activity log if available.

## Output
- The cause in one or two sentences and the concrete fix (edit to the HTML, a setting, or an install step).

## Steps
1. Read `report.md` next to `scene.json` first: it lists comp size, length source,
   fonts and every note (approximations, skipped features, page errors, failed loads).
2. Match the symptom:

| Symptom | Cause → fix |
|---|---|
| KeyframeX not in Window → Extensions | Not installed in the CEP extensions folder, or unsigned without debug mode. Re-run `install/install-mac.sh` / `install-windows.cmd`, restart AE. |
| "needs Google Chrome, Microsoft Edge…" | No Chromium browser found. Install Chrome/Edge or set the path in Settings. |
| Comp has the wrong size | No fixed-size stage. Add `id="stage"` with pixel width/height. |
| Wrong length | No `DURATION`. Add `const DURATION = n;` or set Length in the panel and Analyze again. |
| Starts mid-animation / jumps | Animation waits for a click or for `load` + long timers; make it autoplay. |
| Text in the wrong font | Font not installed for AE. Tick "Install the page's web fonts" (or install manually), restart AE if still missing. |
| Colour-bar placeholders | Media could not be downloaded/found. See `ONLINE MEDIA.txt` (or the Online media card); save the files there and click **Relink in AE**. |
| A part is a picture | Canvas/WebGL, complex gradients, etc. (see notes). Rebuild that part from plain elements for editability. |
| 3D looks flat | CSS 3D is flattened to 2D in this version (note shows the corner error). |
| Content not clipped (AE 2022) | Track mattes need AE 2023+ for shared mattes; older AE gets one matte copy per layer (still clipped). If clipping is missing, check the build warnings in the panel. |
| `page-error` notes | The page threw JS errors in Chrome. Open the HTML in Chrome DevTools and fix them. |
| Red dot / "could not run the KeyframeX script" / "unexpected answer" | The host script is not loaded. Click the reload button next to the dot; the Activity log then shows the exact ExtendScript error and line. Make sure only ONE KeyframeX folder exists in the CEP extensions folder (an older copy can be loaded instead). Restart After Effects. |

3. After a fix, convert again (KeyframeX writes a fresh scene; earlier comps are never overwritten).
4. If nothing matches, collect: AE version, OS, the panel Activity log and `report.md`.
