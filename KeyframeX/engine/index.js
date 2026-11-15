'use strict';
/**
 * KeyframeX engine — public API (used by the panel and the CLI).
 *
 *   convert(htmlPath, opts)   HTML motion page → scene folder (scene.json + assets)
 *   loadScene(file)           read + validate a scene.json written by anyone (e.g. an AI)
 *   validateScene(scene)      structural + semantic checks
 *   collectFonts / installFonts
 */
const fs = require('fs');
const path = require('path');
const { capture } = require('./capture');
const { buildScene } = require('./scene');
const { resolveAssets } = require('./assets');
const { validateScene } = require('./validate');
const fonts = require('./fonts');
const browser = require('./browser');

const VERSION = require('../package.json').version;

function outputDirFor(htmlPath) {
  const dir = path.dirname(htmlPath);
  const base = path.basename(htmlPath, path.extname(htmlPath));
  return path.join(dir, base + ' (KeyframeX)');
}

function writeReport(outDir, scene, report, extra) {
  const L = [];
  L.push('# KeyframeX conversion report', '');
  L.push('- Source: `' + scene.source.html + '`');
  L.push('- Comp: ' + scene.comp.width + '×' + scene.comp.height + ', ' + scene.comp.fps + ' fps, ' + scene.comp.duration + ' s (length from: ' + scene.source.durationFrom + ')');
  L.push('- Quality: ' + scene.source.quality);
  L.push('- Layers: ' + report.layers + ' (' + Object.keys(report.byType).map((k) => report.byType[k] + ' ' + k).join(', ') + ')');
  L.push('- Keyframes: ' + report.keyframes);
  L.push('- Converted in ' + (extra.ms / 1000).toFixed(1) + ' s with ' + extra.browser, '');
  if (scene.fonts.length) {
    L.push('## Fonts', '');
    for (const f of scene.fonts) L.push('- ' + f.family + ' ' + f.weight + (f.style === 'italic' ? ' italic' : '') + (f.postScriptName ? ' (`' + f.postScriptName + '`)' : '') + ' — ' + f.layers + ' layer(s)');
    L.push('');
  }
  if (scene.notes.length) {
    L.push('## Notes', '');
    for (const n of scene.notes) L.push('- **' + n.kind + '** ' + n.message + (n.layers && n.layers.length ? ' — ' + n.layers.join(', ') : ''));
    L.push('');
  }
  fs.writeFileSync(path.join(outDir, 'report.md'), L.join('\n'));
}

/**
 * Convert an HTML motion page.
 * @param {string} htmlPath
 * @param {object} opts { fps, duration, width, height, quality, outDir, browserPath, name, onProgress(phase, fraction, msg), signal }
 */
async function convert(htmlPath, opts = {}) {
  const t0 = Date.now();
  const abs = path.resolve(htmlPath);
  const outDir = opts.outDir || outputDirFor(abs);
  const progress = opts.onProgress || (() => {});
  const cap = await capture(abs, Object.assign({}, opts, { onProgress: progress }));
  try {
    progress('fit', 0.9, 'Fitting keyframes');
    const { scene, report } = buildScene(cap.recording, { quality: opts.quality, name: opts.name });
    fs.mkdirSync(outDir, { recursive: true });
    progress('media', 0.94, 'Preparing media');
    const media = await resolveAssets(scene, cap.recording, cap.session, outDir, (f, m) => progress('media', 0.94 + f * 0.05, m));
    scene.source.pageFonts = { fontLinks: cap.recording.fontLinks || [], fontFaces: (cap.recording.fontFaces || []).slice(0, 50) };
    scene.source.converter = 'KeyframeX ' + VERSION;
    const v = sanitizeScene(scene);
    if (!v.ok) throw new Error('Internal error: generated scene is invalid: ' + v.errors.slice(0, 5).join('; '));
    const scenePath = path.join(outDir, 'scene.json');
    fs.writeFileSync(scenePath, JSON.stringify(scene));
    report.ms = Date.now() - t0;
    writeReport(outDir, scene, report, { ms: report.ms, browser: cap.recording.browser });
    progress('done', 1, 'Ready');
    return { scenePath, outDir, scene, report, media, warnings: v.warnings };
  } finally {
    await cap.close();
  }
}

/**
 * Safety net: one unusual element must never fail a whole conversion. Layers that
 * do not validate are removed (with a note naming the exact problem, so it can be
 * fixed in the converter); everything else is built.
 */
function sanitizeScene(scene) {
  let v = validateScene(scene);
  for (let pass = 0; pass < 3 && !v.ok; pass++) {
    const bad = new Map();
    for (const e of v.errors) {
      const m = /^layers\[(\d+)\]/.exec(e);
      if (m && !bad.has(+m[1])) bad.set(+m[1], e);
    }
    if (!bad.size) break; // comp-level problem: report it
    const dropped = new Set();
    scene.layers = scene.layers.filter((L, i) => {
      if (!bad.has(i)) return true;
      dropped.add(L.id);
      scene.notes.push({ kind: 'skip', message: 'Layer skipped (please report): ' + bad.get(i).replace(/^layers\[\d+\]\s*/, ''), layers: [L.name || L.id] });
      return false;
    });
    for (const L of scene.layers) {
      if (L.matte && dropped.has(L.matte)) delete L.matte;
      if (L.parent && dropped.has(L.parent)) delete L.parent;
    }
    v = validateScene(scene);
  }
  return v;
}

/** Read a scene file (JSON) and validate it. Relative asset paths resolve against the file. */
function loadScene(file) {
  const abs = path.resolve(file);
  let scene;
  try { scene = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { throw new Error('Not a valid JSON file: ' + e.message); }
  const v = validateScene(scene);
  const dir = path.dirname(abs);
  for (const a of scene.assets || []) {
    if (a.rel && fs.existsSync(path.join(dir, a.rel))) a.path = path.join(dir, a.rel);
    else if (a.path && !path.isAbsolute(a.path)) a.path = path.join(dir, a.path);
  }
  return { scene, scenePath: abs, validation: v };
}

/** Find what can be opened from a dropped path: an .html, a scene.json, or a folder holding one. */
function resolveInput(p) {
  const abs = path.resolve(p);
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    const scene = path.join(abs, 'scene.json');
    if (fs.existsSync(scene)) return { kind: 'scene', path: scene };
    const htmls = fs.readdirSync(abs).filter((f) => /\.html?$/i.test(f));
    const pick = htmls.find((f) => /^index\.html?$/i.test(f)) || htmls[0];
    if (pick) return { kind: 'html', path: path.join(abs, pick) };
    throw new Error('This folder has no .html file or scene.json.');
  }
  if (/\.html?$/i.test(abs)) return { kind: 'html', path: abs };
  if (/\.json$/i.test(abs)) return { kind: 'scene', path: abs };
  throw new Error('Drop an HTML motion page (.html), a KeyframeX scene.json, or a folder containing one.');
}

module.exports = {
  VERSION,
  convert,
  loadScene,
  resolveInput,
  validateScene,
  sanitizeScene,
  outputDirFor,
  findBrowser: browser.findBrowser,
  collectFonts: fonts.collectFonts,
  installFonts: fonts.installFonts,
};
