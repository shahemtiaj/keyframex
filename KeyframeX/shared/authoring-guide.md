# KeyframeX authoring guide — HTML motion pages that convert cleanly

KeyframeX opens an HTML page in a headless Chromium browser, plays it frame by
frame on a virtual clock, and rebuilds every element as a native After Effects
layer with fitted bezier keyframes. Anything that plays in Chrome plays in
KeyframeX; these rules decide how *editable* the result is in After Effects.

## Required

1. **One HTML file.** Put pictures, clips, sounds and font files in an `assets/`
   folder next to it and reference them with relative paths. Libraries (GSAP,
   anime.js, Motion One, Lottie-free code) and Google Fonts from a CDN are fine.
2. **A fixed-size stage in pixels**, e.g. `<div id="stage" style="width:1920px;height:1080px">`.
   Mark it with `id="stage"` or `data-kx-stage`. Its size becomes the comp size.
   Scaling the stage to fit the window is fine: KeyframeX measures the real size.
3. **Declare the length**: `const DURATION = 8;` (seconds) at the top level of a
   script. Optional: `const FPS = 30;`. Without `DURATION`, KeyframeX uses the GSAP
   timeline or CSS animation end, or plays the page until it stops moving.
4. **Autoplay and determinism.** The animation starts on page load (no click).
   `Math.random()` is seeded by KeyframeX, so random layouts are reproducible.
5. **Real text.** Words must be HTML text or SVG `<text>`, never images or outlined
   paths, so they stay editable text layers in the right font.

## Becomes native, editable After Effects layers

| In the page | In After Effects |
|---|---|
| `div` with background colour, border, border-radius | Shape layer (rectangle, fill, stroke, roundness) |
| `translate` / `scale` / `rotate`, `opacity` (CSS, GSAP, Web Animations) | Position / Scale / Rotation / Opacity keyframes with eases |
| Text elements (each `<span>` of a split text is its own layer) | Text layers in the font actually rendered, tracking, leading, alignment |
| A number that counts inside ONE element (`0%` → `87%`) | One text layer driven by a **Counter** slider |
| A word that changes inside one element | Source Text hold keyframes |
| Colour animations | Fill / colour keyframes (text colour via a Fill effect) |
| `box-shadow`, `filter: drop-shadow()` | Drop Shadow effect |
| `filter: blur()` | Gaussian Blur effect |
| 2-colour `linear-gradient` / `radial-gradient` | Gradient Ramp effect |
| `mix-blend-mode` | Layer blending mode |
| `overflow: hidden` containers, `clip-path: inset/circle/ellipse/polygon` (animated too) | Shape matte + track matte |
| SVG `path` / `rect` / `circle` / `ellipse` / `line` / `polyline` / `polygon` | Shape layers with bezier paths (animated `d` → path keyframes) |
| SVG stroke draw-on (`stroke-dasharray` = length + animated `stroke-dashoffset`) | Trim Paths keyframes |
| SVG `<text>` | Text layer |
| `<img>`, CSS `background-image: url()` | Footage layer (fit: fill / cover / contain); WebP/AVIF/SVG converted to PNG |
| `<video src="assets/clip.mp4" muted>` (H.264 MP4) | Footage layer with Time Remap |
| `<audio src="assets/voice.mp3" data-start="0.5">` | Audio layer starting at 0.5 s |
| `<canvas>` / WebGL | PNG still or PNG sequence (not editable) |

## Come in as pictures (still in place, motion kept as keyframes)

No After Effects equivalent, so these are captured as pictures of just that part. If
only their position / scale / rotation / opacity change, the motion stays keyframes; if
their look changes, they become a PNG sequence:

- `::before` / `::after` decorations,
- gradients with 3+ colours, conic, repeating or layered backgrounds, and gradients that
  fade to transparent (soft glows),
- `mask-image`, `clip-path: url()`, exotic filters (brightness, hue-rotate, SVG turbulence …),
- inset or multiple shadows, dashed / dotted / per-side borders, outlines,
- SVG `<use>`, SVG masks / clip-paths / patterns, SVG gradients with 3+ stops.

## Approximated or skipped

- CSS 3D (`perspective`, `rotateX/Y`) → flattened to the closest 2D transform.
- `backdrop-filter` (frosted glass) is not converted.
- Nested clipping: only the nearest clipping container is applied.

Use plain elements instead when the user wants a part editable.

## Good structure

- One element per moving thing; give it an `id` or a class — it becomes the layer name.
- Keep the background as its own element (or the stage background).
- Prefer `transform` + `opacity` for motion; use eases freely (all are fitted).
- Fonts: Google Fonts `<link>` or `@font-face` with a `.ttf`/`.otf` in `assets/`
  (KeyframeX can install these for After Effects).
- Total length 3–60 s; 1920×1080, 1080×1920 or 1080×1080 are typical.

## Output contract (for generators)

Reply with exactly one complete HTML document inside a single ```html code block.
No explanations outside the block are required.
