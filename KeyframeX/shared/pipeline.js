'use strict';
/**
 * Pipeline glue shared by the panel and the CLI tests:
 * talking to the ExtendScript host and building scenes in After Effects.
 *
 * `evalHost(script) → Promise<string>` is injected (CEP's evalScript in the
 * panel/service, a mock in tests), so this module has no CEP dependency.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('../engine');

const HOST_FILE = path.join(__dirname, '..', 'host', 'keyframex.jsx');
const LS = new RegExp(String.fromCharCode(0x2028, 124, 0x2029), 'g'); // line/paragraph separators
const lit = (s) => JSON.stringify(String(s)).replace(LS, (c) => (c.charCodeAt(0) === 0x2028 ? '\\u2028' : '\\u2029'));

/** Serialize host calls: ExtendScript is single-threaded and evalScript calls must not interleave. */
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function parseHost(raw) {
  if (raw === 'EvalScript error.' || raw == null || raw === 'undefined') {
    const e = new Error('After Effects could not run the KeyframeX script. Click the reload button at the top of the panel; if it keeps happening, restart After Effects.');
    e.raw = raw;
    throw e;
  }
  let r;
  try { r = JSON.parse(raw); } catch (err) {
    const e = new Error('After Effects returned an unexpected answer (not JSON).');
    e.raw = String(raw).slice(0, 500);
    throw e;
  }
  if (!r || typeof r !== 'object') { const e = new Error('After Effects returned an empty answer.'); e.raw = raw; throw e; }
  if (!r.ok) { const err = new Error(r.error || 'After Effects reported an error'); err.line = r.line; throw err; }
  return r;
}

/** Make sure $.global.KeyframeX exists (loaded by the manifest; reloaded here if AE dropped it or it failed to load). */
async function ensureHost(evalHost) {
  const t = await evalHost('typeof $.global.KeyframeX');
  if (t === 'object') return;
  const file = HOST_FILE.split(path.sep).join('/');
  const r = await evalHost('(function(){try{$.evalFile(' + lit(file) + ');return typeof $.global.KeyframeX;}catch(e){return "ERR:"+e.toString()+(e.line?" (line "+e.line+")":"");}})()');
  if (r !== 'object') {
    throw new Error('Could not load the KeyframeX script into After Effects' + (r && r.indexOf('ERR:') === 0 ? ': ' + r.slice(4) : ' (' + r + ')') + '. File: ' + file);
  }
}

function hostCall(evalHost, fn, args) {
  return serial(async () => {
    await ensureHost(evalHost);
    const a = (args || []).map(lit).join(',');
    return parseHost(await evalHost('$.global.KeyframeX.' + fn + '(' + a + ')'));
  });
}

/**
 * Validate and build a scene in After Effects.
 * @param {object|string} input scene object or path to a scene.json
 * @param {object} opts { target: 'new'|'active', open, sceneDir }
 */
async function buildInAE(evalHost, input, opts = {}) {
  let scene, sceneDir = opts.sceneDir || null, validation;
  if (typeof input === 'string') {
    const loaded = engine.loadScene(input);
    scene = loaded.scene; validation = loaded.validation;
    sceneDir = sceneDir || path.dirname(loaded.scenePath);
  } else {
    scene = input;
    validation = engine.validateScene(scene);
  }
  if (!validation.ok) {
    const e = new Error('The scene is not valid: ' + validation.errors.slice(0, 5).join('; '));
    e.validation = validation;
    throw e;
  }
  // Absolute asset paths so the host never depends on the working folder.
  if (sceneDir) {
    for (const a of scene.assets || []) {
      if (a.rel && !a.path) a.path = path.join(sceneDir, a.rel);
      else if (a.rel && !fs.existsSync(a.path || '') && fs.existsSync(path.join(sceneDir, a.rel))) a.path = path.join(sceneDir, a.rel);
    }
  }
  // The host parses the scene as trusted JSON, so it always receives our own serialization.
  const tmp = path.join(os.tmpdir(), 'keyframex-build-' + process.pid + '-' + Date.now() + '.json');
  fs.writeFileSync(tmp, JSON.stringify(scene));
  try {
    const res = await hostCall(evalHost, 'build', [tmp.split(path.sep).join('/'), JSON.stringify({ target: opts.target || 'new', open: opts.open !== false, sceneDir: sceneDir ? sceneDir.split(path.sep).join('/') : null })]);
    res.validationWarnings = validation.warnings;
    return res;
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
}

module.exports = { hostCall, buildInAE, ensureHost, parseHost, HOST_FILE };
