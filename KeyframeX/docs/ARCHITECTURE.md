# KeyframeX architecture

```
KeyframeX/
├── CSXS/manifest.xml        the CEP panel (Window → Extensions → KeyframeX)
├── client/                  panel UI (HTML/CSS + small classic scripts, namespace KX)
│   ├── js/cep.js            3 KB CEP helper (replaces Adobe's 40 KB CSInterface.js)
│   ├── js/ui.js             helpers, Node services, activity log
│   ├── js/settings.js       settings sheet
│   └── js/panel.js          drop → convert → review → build, AE connection status
├── engine/                  Node, zero dependencies — the converter (panel and CLI share it)
│   ├── cdp.js               hand-written WebSocket + Chrome DevTools Protocol client
│   ├── browser.js           find + launch Chrome/Edge/Brave/Chromium headless
│   ├── page/timeshim.js     virtual clock injected before page scripts
│   ├── page/sampler.js      per-frame DOM sampler injected after load
│   ├── capture.js           plays the page frame by frame, records every element
│   ├── geometry.js          quads → transforms, SVG paths → AE shapes, clip-path
│   ├── fit.js               keyframe fitting with bezier eases
│   ├── scene.js             recording → scene JSON (layers + tracks)
│   ├── raster.js            picture fallback planning (still + keyframes, or sequence)
│   ├── assets.js            media resolution, downloads, WebP/SVG → PNG, canvas sequences
│   ├── fonts.js             collect / install web fonts
│   ├── validate.js          scene validation (structure + semantics)
│   ├── schema/scene.schema.json
│   └── index.js             public API: convert, loadScene, resolveInput, validateScene…
├── host/keyframex.jsx       ExtendScript (ES3) inside After Effects — ONE file on purpose
│                            (JSON · properties & keys · builder · queries · public API:
│                             $.global.KeyframeX.{ping, build, listComps, inspect, relink, fontCheck})
├── shared/                  Node modules used by the panel
│   ├── settings.js          settings file, data folder, discovery file
│   ├── pipeline.js          serialized host calls, buildInAE()
│   └── authoring-guide.md   rules for HTML that converts well (also used by the skills)
├── cli/keyframex.js         command line
├── tools/                   compare.js (visual check vs. the page) + preview.js (After Effects-style renderer)
├── install/                 install / uninstall / package scripts
├── examples/                hand-written scene
└── tests/                   test runner, strict AE mock, fixtures
```

## Data flow

```
 page.html ──► browser.js (headless Chrome) ──► timeshim: virtual time
                                │                 sampler: DOM state per frame
                                ▼
                      capture.js: recording  (CDP DOM.getBoxModel gives every element's
                                │             fully transformed quad, incl. CSS 3D)
                                ▼
          scene.js + fit.js: scene.json  ──► validate.js
                                │
                                ▼
       shared/pipeline.js ──evalScript──► host/keyframex.jsx ──► AE comp, layers, keys
```

### Why a virtual clock

Real-time screen capture drops frames and depends on machine speed. KeyframeX
replaces `Date`, `performance.now`, `requestAnimationFrame`, timers, Web/CSS
animations (paused and seeked), SMIL and media clocks before any page script runs,
then advances time exactly one frame at a time. Every library that reads time from
the browser (GSAP, anime.js, Motion One, Three.js loops, hand-written rAF) becomes
deterministic. `Math.random` is seeded.

### Why CDP box models

An element's on-screen geometry after all ancestor transforms (including
perspective) is not available to page JavaScript, but Chrome's `DOM.getBoxModel`
returns the transformed border quad. KeyframeX fits an affine transform to that quad
(exact for 2D, least-squares for 3D) and decomposes it into position / scale /
rotation. Sub-pixel sizes come from computed styles. SVG uses `getScreenCTM`
relative to the outer `<svg>` plus the viewBox transform.

### Keyframe fitting (`fit.js`)

1. Static tracks become a single value.
2. Moving spans (between holds) are fitted with ONE cubic-bezier progress curve,
   found by grid search over x₁/x₂ with a closed-form least-squares solve for y₁/y₂.
3. If any frame misses by more than the tolerance (Light ×3, Balanced, Exact ×0.12),
   the span is split — preferably at a turning point — and both halves are refit.
4. The curve converts to AE `KeyframeEase(speed, influence)`; spatial properties get
   linear spatial tangents so paths never overshoot.

### Text

Words are measured with DOM Ranges; their centres are mapped back into the
element's local space with the inverse transform of the frame they were measured
in. Lines are rebuilt, and the AE text anchor is placed on the first baseline at
the justification point (font ascent/descent from canvas metrics). The font
actually rendered (`CSS.getPlatformFontsForNode`) gives the PostScript name AE needs.

### Host contract

Every host entry point takes strings and returns `{ ok, … }` JSON. The Node side
validates and re-serializes each scene before the host reads it, and all host calls
go through one queue (ExtendScript is single-threaded). Builds run inside one undo
group, never overwrite earlier builds, and isolate failures per layer.

### Pictures (raster fallback)

`raster.js` lists every element with a part After Effects can't build, decides per
element whether its look is constant (then ONE capture, motion fitted as keyframes from
the element's transform relative to the captured frame) or changes (PNG sequence), and
the capture pass replays the page on the same virtual clock, isolating the element with
a temporary stylesheet (`__kxIsolate`) on a transparent background.

### Why one host file

After Effects evaluates the panel's `ScriptPath` when the panel opens. Relative
`//@include` paths are not resolved reliably in that context, and when an include
fails the whole host is undefined, so every call returns `EvalScript error.`. The host
is therefore a single file. `shared/pipeline.js` checks for `$.global.KeyframeX` before
each call, loads the file itself with `$.evalFile` if needed, and reports the exact
ExtendScript error and line if loading fails.

## Extending

- **New page feature** → sample it in `page/sampler.js`, map it in `scene.js`, add the
  scene field to `validate.js` + the schema, apply it in the builder section of `host/keyframex.jsx`, add a
  fixture assertion in `tests/run.js`.
