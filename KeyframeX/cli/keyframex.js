#!/usr/bin/env node
'use strict';
/**
 * KeyframeX command line — the same engine as the panel, without After Effects.
 * Converts pages into scenes (drop the scene on the panel to build it).
 *
 *   keyframex convert <page.html> [--fps 30] [--duration 8] [--quality balanced] [--out dir] [--json]
 *   keyframex validate <scene.json> [--json]
 *   keyframex browsers
 *   keyframex guide
 *
 */
const fs = require('fs');
const path = require('path');
const engine = require('../engine');
const settings = require('../shared/settings');

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[k] = next; i++; } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function print(obj, asJson) {
  if (asJson) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); return; }
  if (typeof obj === 'string') { process.stdout.write(obj + '\n'); return; }
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function fail(msg, asJson, code) {
  if (asJson) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  else process.stderr.write('keyframex: ' + msg + '\n');
  process.exit(code || 1);
}

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  const json = !!a.json;
  if (!cmd || cmd === 'help' || a.help) {
    print(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 11).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
    return;
  }
  if (cmd === 'convert') {
    const file = a._[1];
    if (!file) fail('convert needs an .html file', json);
    const input = engine.resolveInput(file);
    if (input.kind !== 'html') fail('convert needs an .html file (got a scene)', json);
    let last = '';
    const r = await engine.convert(input.path, {
      fps: a.fps ? +a.fps : undefined,
      duration: a.duration ? +a.duration : undefined,
      quality: a.quality || 'balanced',
      outDir: a.out ? path.resolve(a.out) : undefined,
      browserPath: a.browser || settings.load().browserPath || undefined,
      onProgress: json ? undefined : (phase, f, msg) => {
        const line = Math.round(f * 100) + '% ' + (msg || phase);
        if (line !== last && process.stderr.isTTY) { process.stderr.write('\r' + line.padEnd(60)); last = line; }
      },
    });
    if (!json && process.stderr.isTTY) process.stderr.write('\n');
    print(json ? { ok: true, scenePath: r.scenePath, outDir: r.outDir, report: r.report, notes: r.scene.notes, fonts: r.scene.fonts, media: r.media } :
      'Scene: ' + r.scenePath + '\n' + r.report.layers + ' layers, ' + r.report.keyframes + ' keyframes, ' + r.scene.comp.width + '×' + r.scene.comp.height + ' @ ' + r.scene.comp.fps + ' fps, ' + r.scene.comp.duration + ' s' +
      (r.scene.notes.length ? '\nNotes:\n' + r.scene.notes.map((n) => '  - [' + n.kind + '] ' + n.message).join('\n') : ''), json);
    return;
  }
  if (cmd === 'validate') {
    if (!a._[1]) fail('validate needs a scene.json', json);
    const r = engine.loadScene(a._[1]);
    print(json ? { ok: r.validation.ok, errors: r.validation.errors, warnings: r.validation.warnings } :
      (r.validation.ok ? 'Valid scene: ' + r.scene.layers.length + ' layers' : 'Invalid scene:\n  - ' + r.validation.errors.join('\n  - ')) + (r.validation.warnings.length ? '\nWarnings:\n  - ' + r.validation.warnings.join('\n  - ') : ''), json);
    if (!r.validation.ok) process.exit(2);
    return;
  }
  if (cmd === 'browsers') { const b = engine.findBrowser(a.browser || settings.load().browserPath); print(json ? { ok: !!b, browser: b } : (b || 'No Chromium-family browser found.'), json); return; }
  if (cmd === 'guide') { print(fs.readFileSync(path.join(__dirname, '..', 'shared', 'authoring-guide.md'), 'utf8')); return; }
  fail('Unknown command "' + cmd + '". Try: keyframex help', json);
}

main().catch((e) => fail(e.message, process.argv.includes('--json')));
