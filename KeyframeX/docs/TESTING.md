# Testing KeyframeX

```bash
cd KeyframeX
node tests/run.js                 # 38 tests; no npm install needed
node tools/compare.js page.html   # visual check of any page: page vs. KeyframeX, frame by frame
npm i --no-save acorn && node tests/run.js   # adds the strict ES3 check of the host script
```

The GSAP fixture needs `tests/fixtures/assets/gsap.min.js`, which is not in the repository
(get it with `npm pack gsap` or from the GSAP site); without it that test is skipped. Without a
Chromium browser the integration tests are skipped, not failed.

## What is verified automatically

| Area | How |
|---|---|
| Keyframe fitting | ease curves, sine motion, holds, influence ranges against analytic data |
| Geometry | quad → transform decomposition, SVG path parser (arcs, relative, smooth), clip-path shapes |
| Validation | the error messages an AI-written scene typically needs |
| Conversion | **real headless Chrome** on 3 fixtures: CSS animations, Web Animations, rAF, GSAP timeline + stagger, split text, counters, timers, colour change, `overflow:hidden`, `clip-path` wipe, blend mode, blur, box-shadow, WebP → PNG, video + time remap, audio, canvas sequence, SVG shapes/gradient/text/SMIL, wrapped centred paragraph, source-text change, quality presets |
| Host script | one self-contained file, parsed as ES3; loaded by the panel when AE has not loaded it; unreadable AE answers become clear errors; every scene built against a **strict mock of the After Effects DOM** that rejects unknown match names, wrong value shapes, wrong ease dimensions, out-of-order keys, invalid in/out points, unclosed undo groups; mattes, active-comp placement, error JSON |
| Look | `tools/compare.js` renders the scene the After Effects way (anchors, eases, mattes, baselines, footage scaling) and compares it with the page: < 1% differing pixels required on the test pages |
| Layer order | compared with Chrome's own hit-testing (`elementsFromPoint`) on a page full of stacking edge cases |
| Pictures | every fallback case; static pictures keep motion as keyframes; only changing looks become sequences |
| Panel | rendered in headless Chrome (no console errors); every `$('id')` in the scripts exists in the HTML; manifest paths exist |

## What could NOT be verified (no After Effects in the build environment)

These need a run inside After Effects 2022+ — please check them on first use:

1. The panel loading in CEP (Node require paths, drag & drop from Finder, file dialogs, theme sync).
2. The real ExtendScript behaviour of: `setTemporalEaseAtKey` dimension counts per property,
   Drop Shadow opacity scaling, Gradient Ramp + Set Matte (self) keeping the gradient inside the shape,
   point-text anchor/baseline alignment against the browser, `doc.leading` on your AE version,
   font resolution via `app.fonts` (AE 2024+) and the PostScript-name fallback on older versions,
   `setTrackMatte` (AE 2023+) and the duplicated-matte fallback (AE 2022), time remap on video,
   image sequence import for canvas output.
3. Font installation into the user font folder and After Effects picking the fonts up.

Suggested first check: convert `tests/fixtures/basic.html`, `gsap.html` and `media.html`
in the panel, build each, and compare the comp with the page in Chrome.
