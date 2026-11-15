# Changelog

## 1.2.3
- **Fixed: words that wrap at a hyphen.** A word the page breaks across lines (e.g.
  "Healthcare-focused" in a narrow card) came in on one line with double line spacing. Such
  words are now split where the page breaks them, so the lines and leading match.
- Verified in After Effects 2024 (24.0) on a 43-second promo page: after a fresh build with
  1.2.2+, text layers sit exactly where the page puts them (checked with
  `tools/diag-text.jsx`, which reports anchor, position, drawn bounds and paragraph settings
  of every text layer in the active comp).

## 1.2.2
- **Fixed: left-aligned text built far to the right.** In a user's After Effects 2024 every
  left-aligned text layer came in about 1300 px right of its spot (centred text was
  right), so headlines, chip labels and card text sat off the comp or on top of other
  layers. New text layers inherit the Paragraph panel; KeyframeX now resets paragraph
  settings (indents, space before / after) before styling the text. After building, it
  also measures where After Effects actually drew each text layer and, if it is off its
  spot, lines it up by moving the anchor point, whatever the cause. The build log says
  how many layers were lined up, by how much, and which paragraph settings After Effects
  reported, so a cause on another machine can be traced.

## 1.2.1
Fixes found by converting a real 43-second promo page and comparing it frame by frame.
- **Fixed: centred and right-aligned text built too far to the right.** After Effects can
  silently ignore a paragraph alignment that is set together with the text (an After Effects
  bug); the text then fell back to the Paragraph panel's alignment and centred headlines
  slid right by half their width, past the edge of the comp. The alignment is now set on its
  own, read back and verified, also for Source Text keyframes. If After Effects still
  refuses, the text is lined up by moving its anchor point, and the build says so.
- **Fixed: glows became solid discs.** Gradients that fade to transparent (soft glows, light
  leaks, fading lines) were built with Gradient Ramp, which is opaque. They now come in as
  pictures, motion kept as keyframes.
- **Fixed: gradient text was invisible.** Text with a gradient fill (`background-clip: text`)
  has a transparent colour by design; that transparency was applied to the whole layer.
- **Fixed: blur was frozen.** CSS blur (e.g. words that come in sharp from a blur) was taken
  from the first frame only, so layers stayed blurred. Blur is now animated, includes blur
  inherited from blurred parents, and pictures only get the blur they don't already contain.
- **Fixed: pictures resized with width/height kept their first size.** Animated width /
  height of images now becomes scale keyframes.
- **Fixed: pictures captured empty inside a closed wipe.** A parent's `clip-path` (circle
  wipes) is lifted while a picture is captured; After Effects gets the wipe as a matte.
- Test mock now reproduces the After Effects alignment bug; new `promo.html` fixture.
  37 automated tests.

## 1.2.0
- **Missing layers → pictures.** Parts After Effects can't build natively now come in as
  pictures instead of being skipped: `::before`/`::after`, gradients with 3+ colours / layers /
  repeats, `mask-image`, inset or multiple shadows, dashed / per-side borders, outlines,
  `clip-path: url()`, exotic filters, SVG `<use>`, SVG masks / clip-paths / patterns and
  SVG gradients with 3+ stops. Each element is captured alone on a transparent background.
  If only its position / scale / rotation / opacity change, it is captured once and its
  motion becomes keyframes; if its look changes, it becomes a PNG sequence. Only the
  unsupported part becomes a picture (a card's 3-colour background becomes a picture, its
  text stays an editable text layer).
- **Fixed: pictures and videos were offset by half their size.** Footage layers were given
  anchor point [0,0] while their position referred to their centre.
- **Fixed: layer order.** Stacking now follows the browser's painting rules (stacking
  contexts, z-index, positioned vs. in-flow content, opacity / transform contexts). Before,
  in-flow content (e.g. flex layouts) could cover positioned elements. Verified against
  Chrome's own hit-testing.
- **New: visual comparison tool** `node tools/compare.js page.html` renders the scene the way
  After Effects builds it and compares it with the page frame by frame (side-by-side images
  + score). The test suite now requires < 1% differing pixels on the test pages.
- 33 automated tests.

## 1.1.2
- **Fixed: "shape.paths.value has the wrong shape"** on SVG paths exported by design tools.
  The path reader now follows the SVG grammar exactly: arc flags written without
  separators (`a5 5 0 0110 0`), numbers running together (`M0-1-2-3`, `.5.5`), implicit
  lineto after moveto, arcs that end where they start (skipped, as the spec says) and
  truncated commands. Paths can no longer contain invalid numbers.

## 1.1.1
- **Fixed: "Could not load the KeyframeX script … Illegal use of reserved word (line 831)".**
  The host script used `in` as an object key, which ExtendScript rejects. The test suite now
  checks the whole host script for reserved words used as keys or after a dot.
- **Fixed: "Conversion failed: Internal error: generated scene is invalid".** Text with
  `font-size: 0` and `<img>` / `<video>` elements without a loadable source produced invalid
  layers; they are now skipped with a note. As a safety net, any single layer that still fails
  validation is dropped with a note instead of failing the whole conversion.
- **Fixed: text that starts at scale 0** (a delayed "pop in") disappeared, because its words
  were measured while it had no size. Words are now measured on the first frame with a size.
- New test page `tests/fixtures/edge-cases.html` (28 tests in total).

## 1.1.0
- **Removed the AI features** for now: the Generate tab (AI providers) and the Bridge tab /
  background service for AI agents. The panel is conversion-only. The skills for writing
  HTML that converts cleanly are kept (they don't need anything in the panel).
- **New panel layout** in the style of the old extension: one column of navy cards — drop
  zone → converting card with % and steps → file card with stats, *Change length*, fonts and
  notes → online media → build settings → **Build in After Effects** → activity log with Clear.
- **Host script is now one self-contained file.** After Effects loads the panel's script at
  startup; relative `//@include` files are not resolved reliably there, which leaves the host
  undefined and makes every call fail. If the host is missing, the panel now loads it itself
  and reports the exact ExtendScript error and line when loading fails.
- Clearer errors for unreadable answers from After Effects (what AE returned is shown).
- **Installer fix:** reinstalling used to leave the previous copy in the CEP extensions folder
  (renamed `KeyframeX.old-…`), so After Effects could load two KeyframeX panels. The installers
  now move the previous copy — and any other folder whose manifest mentions KeyframeX — to
  the Trash (Windows: delete it).

## 1.0.0
- First version.
