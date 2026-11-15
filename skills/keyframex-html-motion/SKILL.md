---
name: keyframex-html-motion
description: Write HTML motion videos (promos, explainers, kinetic type, logo reveals, UI animations, social reels, charts) that the KeyframeX After Effects extension converts into native, editable After Effects layers and keyframes. Use when the user asks for an animation "for KeyframeX", "editable in After Effects", "as an .aep / AE comp", or wants an HTML/CSS/GSAP/SVG motion piece they will finish in After Effects. Also use to check whether an existing HTML animation will convert cleanly.
---

# KeyframeX: HTML motion → editable After Effects

KeyframeX plays an HTML page frame by frame in headless Chrome/Edge on a virtual
clock, then rebuilds every element as an After Effects layer with fitted bezier
keyframes. Your job is to write the page; the user (or another skill) converts it.

This skill does not dictate the look. Design what the user asked for, with the
techniques you would normally use (GSAP, CSS animations, Web Animations, SVG,
requestAnimationFrame). Follow the rules in `references/authoring-guide.md`
so the result stays editable.

## Inputs
- A brief: subject, mood/style, format (16:9, 9:16, 1:1…), length in seconds.
- Optional: brand colours, fonts, copy, media files (put them in `assets/`).

## Output
- One folder per video: `<Name>/<Name>.html` (+ `assets/`).
- A short message with the **absolute path** of the HTML, how to preview it,
  how to convert it, and which parts (if any) will come in as pictures.

## Steps
1. Read `references/authoring-guide.md` (the conversion rules — authoritative).
   `references/template.html` is a working starting point.
2. Decide the stage size and the length. Write `<div id="stage">` at that pixel
   size and `const DURATION = <seconds>;` at the top level of a script.
3. Build the animation. Rules of thumb:
   - one element per moving thing, with an `id` or class (it becomes the layer name);
   - motion with `transform` and `opacity`; any easing is fine;
   - real text only; split text into `<span>`s if letters/words animate separately;
   - a counting number lives in ONE element whose text changes;
   - 2-colour gradients, border-radius, box-shadow, blur, blend modes, `overflow:hidden`,
     `clip-path` wipes and SVG draw-on (`stroke-dasharray` + `stroke-dashoffset`) all convert natively.
4. Media: H.264 `.mp4` in `<video muted>`, audio as `<audio src="assets/x.mp3" data-start="1.0">`.
   Fonts: Google Fonts `<link>` or `@font-face` with `.ttf`/`.otf` (KeyframeX can install them).
5. Self-check before delivering (open in a browser if you can: no console errors, plays on load,
   stage size right, nothing missing). If Node and the KeyframeX CLI are available, run the
   `keyframex-convert-build` skill to convert and read the notes.
6. Deliver: path, preview (double-click → Chrome/Edge), convert (After Effects →
   Window → Extensions → **KeyframeX** → drop the HTML → **Build**), and the
   list of parts that will be approximated or pictures.

## Edge cases
- The user wants a part editable that would rasterize (canvas, 3+ stop gradient,
  `::before`, CSS 3D): rebuild it from plain elements or say clearly what changes.
- Infinite loops: still set `DURATION` to one loop (or the length wanted).
- Interactions (hover/click) never run: the timeline must play by itself.
- Very long pieces (> 60 s) convert slowly; suggest splitting into scenes.
- No network on the user's machine: avoid CDNs; inline the library or ship it in `assets/`.
