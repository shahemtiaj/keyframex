#!/usr/bin/env node
'use strict';
/**
 * KeyframeX test suite (no dependencies).  Run:  node tests/run.js
 *
 * - unit: keyframe fitting, geometry, validation, AI reply parsing
 * - project: manifest references, host script syntax (ES3 when `acorn` is installed)
 * - integration (needs Chrome/Edge/Chromium): convert the fixtures with the real browser
 * - host: build every converted scene against the strict After Effects mock
 *
 * What this suite cannot do: run inside After Effects. See docs/TESTING.md.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
process.env.KEYFRAMEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-home-'));

const engine = require('../engine');
const { fitTrack, evalTrack, easeAt } = require('../engine/fit');
const G = require('../engine/geometry');
const { validateScene } = require('../engine/validate');
const { createAE, loadHost } = require('./mock-ae');

let passed = 0, failed = 0, skipped = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push('  ok   ' + name); }
  catch (e) {
    if (e && e.skip) { skipped++; results.push('  skip ' + name + ' — ' + e.message); return; }
    failed++; results.push('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e));
  }
}
const skip = (msg) => { const e = new Error(msg); e.skip = true; throw e; };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' expected ' + b + ' ±' + tol + ', got ' + a);

function maxErr(track, times, vals) {
  let m = 0;
  for (let i = 0; i < times.length; i++) {
    const a = [].concat(evalTrack(track, times[i])), b = [].concat(vals[i]);
    for (let d = 0; d < a.length; d++) m = Math.max(m, Math.abs(a[d] - b[d]));
  }
  return m;
}

function mockHost(aeOpts) {
  const ctx = createAE(undefined, aeOpts);
  loadHost(path.join(ROOT, 'host', 'keyframex.jsx'), ctx);
  const evalHost = (script) => {
    try { const r = vm.runInContext(script, ctx); return Promise.resolve(r === undefined ? 'undefined' : String(r)); }
    catch (e) { return Promise.resolve('EvalScript error.'); }
  };
  return { ctx, evalHost };
}

function comps(ctx) {
  const out = [];
  for (let i = 1; i <= ctx.app.project.numItems; i++) { const it = ctx.app.project.item(i); if (it instanceof ctx.CompItem) out.push(it); }
  return out;
}

(async () => {
  // ------------------------------------------------------------------ unit
  await test('fit: ease-in-out move collapses to two keys within tolerance', () => {
    const times = [], vals = [];
    const ease = (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
    for (let f = 0; f <= 30; f++) { times.push(f / 30); vals.push([100 + 400 * ease(f / 30), 50]); }
    const tr = fitTrack(times, vals, { tol: 0.35, spatial: true });
    assert.ok(tr.keys.length <= 3, 'keys: ' + tr.keys.length);
    assert.ok(maxErr(tr, times, vals) <= 0.35);
  });
  await test('fit: static values become a single value', () => {
    const tr = fitTrack([0, 0.1, 0.2], [5, 5, 5.0001], { tol: 0.1 });
    assert.deepStrictEqual(tr, { value: 5 });
  });
  await test('fit: sine motion splits at turning points', () => {
    const times = [], vals = [];
    for (let f = 0; f <= 90; f++) { times.push(f / 30); vals.push(Math.sin(f / 30 * 3) * 80); }
    const tr = fitTrack(times, vals, { tol: 0.35 });
    assert.ok(tr.keys.length <= 14, 'keys: ' + tr.keys.length);
    assert.ok(maxErr(tr, times, vals) <= 0.36);
  });
  await test('fit: hold interpolation for discrete values', () => {
    const tr = fitTrack([0, 1, 2, 3], [0, 0, 1, 1], { tol: 0.1, interp: 'hold' });
    assert.strictEqual(tr.keys.length, 2);
    assert.strictEqual(tr.keys[0].interp, 'hold');
  });
  await test('fit: AE influence always within 0.1–100', () => {
    const times = [], vals = [];
    for (let f = 0; f <= 40; f++) { times.push(f / 30); vals.push(300 * easeAt(f / 40, [0.9, 0, 0.1, 1])); }
    const tr = fitTrack(times, vals, { tol: 0.2 });
    for (const k of tr.keys) for (const e of [].concat(k.ei || [], k.eo || [])) assert.ok(e[1] >= 0.1 && e[1] <= 100);
  });
  await test('geometry: affine from a rotated quad', () => {
    const th = 30 * Math.PI / 180, w = 100, h = 50;
    const m = [Math.cos(th) * 2, Math.sin(th) * 2, -Math.sin(th), Math.cos(th), 10, 20];
    const q = [].concat(G.apply(m, 0, 0), G.apply(m, w, 0), G.apply(m, w, h), G.apply(m, 0, h));
    const d = G.decompose(G.affineFromQuad(q, w, h).m);
    near(d.rotation, 30, 1e-6); near(d.scaleX, 200, 1e-6); near(d.scaleY, 100, 1e-6);
  });
  await test('geometry: SVG path with arcs, relative and smooth commands', () => {
    const cs = G.parsePath('M10 10 h80 v20 a10 10 0 0 1 -10 10 H10 z m100 0 c 10 0 20 10 20 20 s 10 20 20 20 q10 0 10 10 t 10 10 l5 5');
    assert.strictEqual(cs.length, 2);
    assert.ok(cs[0].closed);
    const ae = G.contourToAE(cs[0]);
    assert.strictEqual(ae.v.length, ae.i.length);
    const bb = G.contoursBBox([cs[0]]);
    near(bb[2], 80, 1e-6); near(bb[3], 30, 1e-6);
  });
  await test('geometry: compact SVG syntax from design tools never yields invalid numbers', () => {
    const cases = {
      'M10 10a5 5 0 01 10 0': [[10, 10], [15, 5], [20, 10]], // arc flags without separators
      'M10 10a5 5 0 0110 0z': [[10, 10], [15, 5], [20, 10]],
      'M0 0 10 10 20 0z': [[0, 0], [10, 10], [20, 0]],         // implicit lineto after M
      'M0-1-2-3': [[0, -1], [-2, -3]],                         // numbers running together
      'M1e2 1e-1L.5.5': [[100, 0.1], [0.5, 0.5]],
    };
    for (const d of Object.keys(cases)) {
      const v = G.parsePath(d).map((c) => G.contourToAE(c))[0].v;
      assert.deepStrictEqual(v.map((p) => p.map((x) => Math.round(x * 1000) / 1000)), cases[d], d);
    }
    for (const d of ['M0 0A5 5 0 1 1 0 0', 'M10 10 L', 'M0,0c0,0,0,0', 'M 5', '', 'Mx y']) {
      const json = JSON.stringify(G.parsePath(d).map((c) => G.contourToAE(c)));
      assert.ok(json.indexOf('null') < 0, d + ' → ' + json);
    }
  });
  await test('geometry: CSS clip-path shapes', () => {
    const r = G.clipPathContour('inset(10px 20% 0px 0px round 4px)', 200, 100);
    const bb = G.contoursBBox([r]);
    near(bb[0], 0, 1e-6); near(bb[1], 10, 1e-6); near(bb[2], 160, 1e-6); near(bb[3], 90, 1e-6);
    const c = G.clipPathContour('circle(50% at 50% 50%)', 100, 100);
    near(G.contoursBBox([c])[2], 100 * 0.5 * Math.SQRT2 * 2 / Math.SQRT2, 1e-6);
    assert.ok(G.clipPathContour('polygon(0 0, 100% 0, 50% 100%)', 100, 100).closed);
  });
  await test('validate: catches the mistakes an AI-written scene makes', () => {
    const bad = { format: 'keyframex.scene', version: 1, comp: { name: 'x', width: 100, height: 100, fps: 30, duration: 2 },
      layers: [{ id: 'a', type: 'shape', shape: { kind: 'rect', size: { value: [10] } }, fill: { color: { value: [1, 0, 0] } }, transform: { position: { keys: [{ t: 1, v: [0, 0] }, { t: 0.5, v: [1, 1] }] } }, matte: 'nope' },
        { id: 'b', type: 'image', asset: 'missing' }, { id: 'c', type: 'wobble' }] };
    const v = validateScene(bad);
    assert.ok(!v.ok);
    const all = v.errors.join('\n');
    for (const s of ['size.value', 'earlier than', 'unknown layer id', 'not in scene.assets', 'type must be']) assert.ok(all.indexOf(s) >= 0, 'missing error about ' + s + '\n' + all);
  });
  // ------------------------------------------------------------------ project
  await test('project: manifest and panel references exist', () => {
    const man = fs.readFileSync(path.join(ROOT, 'CSXS', 'manifest.xml'), 'utf8');
    const refs = [...man.matchAll(/<(MainPath|ScriptPath|Icon[^>]*)>\.\/([^<]+)</g)].map((m) => m[2]);
    assert.ok(refs.length >= 5);
    for (const r of refs) assert.ok(fs.existsSync(path.join(ROOT, r)), 'missing ' + r);
    const html = fs.readFileSync(path.join(ROOT, 'client', 'index.html'), 'utf8');
    for (const m of html.matchAll(/(?:src|href)="((?:js|css)\/[^"]+)"/g)) assert.ok(fs.existsSync(path.join(ROOT, 'client', m[1])), 'missing client/' + m[1]);
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    for (const f of fs.readdirSync(path.join(ROOT, 'client', 'js'))) {
      const src = fs.readFileSync(path.join(ROOT, 'client', 'js', f), 'utf8');
      for (const m of src.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)) assert.ok(ids.has(m[1]), f + ' uses missing element #' + m[1]);
    }
  });
  await test('project: host script is one self-contained file (no //@include)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'host', 'keyframex.jsx'), 'utf8');
    assert.ok(!/^\s*(\/\/@|#)include/m.test(src), 'host must not depend on includes');
    assert.ok(!fs.existsSync(path.join(ROOT, 'host', 'lib')), 'host/lib should not exist');
  });
  await test('project: host script is valid ES3 (ExtendScript)', () => {
    let acorn;
    try { acorn = require('acorn'); } catch (e) { skip('install acorn (npm i acorn) for the strict ES3 check'); }
    for (const f of ['keyframex.jsx']) {
      const src = fs.readFileSync(path.join(ROOT, 'host', f), 'utf8');
      const ast = acorn.parse(src, { ecmaVersion: 3, allowReserved: true, locations: true });
      // ExtendScript rejects reserved words as object keys or after a dot ({ in: 1 }, a.default),
      // which modern parsers accept even in ES3 mode — check the AST explicitly.
      const RES = new Set(('break case catch continue default delete do else finally for function if in instanceof new return switch this throw try typeof var void while with ' +
        'abstract boolean byte char class const debugger double enum export extends final float goto implements import int interface long native package private protected public short static super synchronized throws transient volatile').split(' '));
      const bad = [];
      (function walk(n) {
        if (!n || typeof n.type !== 'string') return;
        if (n.type === 'Property' && n.key.type === 'Identifier' && RES.has(n.key.name)) bad.push('line ' + n.loc.start.line + ': key "' + n.key.name + '"');
        if (n.type === 'MemberExpression' && !n.computed && RES.has(n.property.name)) bad.push('line ' + n.loc.start.line + ': .' + n.property.name);
        for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); }
      })(ast);
      assert.deepStrictEqual(bad, [], f + ' uses reserved words ExtendScript rejects');
      assert.ok(!/=>|\blet\s|\bconst\s|\.forEach\(|\.map\(|Array\.isArray|Object\.keys/.test(src), f + ' uses ES5+ features');
    }
  });
  await test('project: skill authoring guide matches the extension copy', () => {
    const a = fs.readFileSync(path.join(ROOT, 'shared', 'authoring-guide.md'), 'utf8');
    const p = path.join(ROOT, '..', 'skills', 'keyframex-html-motion', 'references', 'authoring-guide.md');
    if (!fs.existsSync(p)) skip('skills folder not next to the extension');
    assert.strictEqual(fs.readFileSync(p, 'utf8'), a, 'skills/keyframex-html-motion/references/authoring-guide.md is out of date');
  });

  // ------------------------------------------------------------------ integration
  const browser = engine.findBrowser();
  const fx = path.join(__dirname, 'fixtures');
  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-out-'));
  const converted = {};
  async function conv(name, quality) {
    if (!browser) skip('no Chrome / Edge / Chromium on this machine');
    const r = await engine.convert(path.join(fx, name), { quality: quality || 'balanced', outDir: path.join(tmpOut, name + '-' + (quality || 'balanced')) });
    converted[name] = r;
    return r;
  }
  const layer = (r, name) => r.scene.layers.find((L) => L.name === name);

  await test('convert basic.html: CSS animation, WAAPI, rAF, SVG draw-on', async () => {
    const r = await conv('basic.html');
    assert.strictEqual(r.scene.comp.width, 1280); assert.strictEqual(r.scene.comp.height, 720);
    assert.strictEqual(r.scene.comp.duration, 3);
    const t = layer(r, 'Hello KeyframeX');
    assert.ok(t && t.type === 'text');
    const last = t.transform.position.keys ? t.transform.position.keys[t.transform.position.keys.length - 1].v : t.transform.position.value;
    near(last[0], 100, 1.5, 'text x'); near(last[1], 477, 3, 'baseline y');
    assert.ok(layer(r, 'line').trim, 'draw-on became Trim Paths');
    const card = layer(r, 'card');
    assert.ok(card.transform.rotation.keys && card.transform.rotation.keys.length <= 3);
    assert.ok(card.effects.some((e) => e.type === 'dropShadow'));
    assert.ok(!layer(r, 'dot').shape.paths.keys, 'moving circle became position keys, not path keys');
  });
  await test('convert gsap.html: GSAP timeline, split text, counter, matte, clip-path wipe, WebP', async () => {
    if (!fs.existsSync(path.join(fx, 'assets', 'gsap.min.js'))) skip('put gsap.min.js in tests/fixtures/assets to run this test');
    const r = await conv('gsap.html');
    assert.strictEqual(r.scene.comp.duration, 2);
    const count = r.scene.layers.find((L) => L.text && L.text.counter);
    assert.ok(count, 'counter detected');
    assert.strictEqual(count.text.counter.suffix, '%');
    assert.ok(count.effects && count.effects.some((e) => e.type === 'fill'), 'colour change → Fill effect');
    const bar = layer(r, 'bar');
    assert.ok(bar.matte, 'overflow:hidden content uses a matte');
    assert.ok(layer(r, 'wipe').matte, 'clip-path element uses a matte');
    assert.strictEqual(layer(r, 'blend').blend, 'MULTIPLY');
    const photo = layer(r, 'photo');
    const a = r.scene.assets.find((x) => x.id === photo.asset);
    assert.ok(/\.png$/.test(a.path), 'webp converted to png');
    assert.strictEqual(r.scene.layers.filter((L) => L.type === 'text').length, 7);
  });
  await test('convert media.html: video time remap, audio, canvas sequence, SVG text, source text', async () => {
    const r = await conv('media.html');
    assert.strictEqual(r.scene.comp.width, 1080); assert.strictEqual(r.scene.comp.height, 1920);
    const v = r.scene.layers.find((L) => L.type === 'video');
    assert.ok(v.timeRemap.keys && v.timeRemap.keys[0].v < 0.05, 'video starts at 0 on the virtual clock');
    const au = r.scene.layers.find((L) => L.type === 'audio');
    assert.strictEqual(au.startAt, 0.5);
    assert.ok(r.scene.assets.some((x) => x.kind === 'sequence' && x.frames === 60), 'canvas → png sequence');
    assert.ok(layer(r, 'SVG text').text.justify === 'center');
    assert.deepStrictEqual(layer(r, 'ALPHA').text.source.keys.map((k) => k.v), ['ALPHA', 'BETA']);
    const users = layer(r, 'users');
    assert.ok(users.text.counter && users.text.counter.commas);
    const para = r.scene.layers.find((L) => L.text && /\r/.test(L.text.source.value || ''));
    assert.ok(para && para.text.justify === 'center', 'wrapped paragraph keeps its lines');
  });
  await test('convert edge-cases.html: empty media, font-size 0, scale-0 pop-in never fail the conversion', async () => {
    if (!fs.existsSync(path.join(fx, 'assets', 'gsap.min.js'))) skip('needs tests/fixtures/assets/gsap.min.js');
    const r = await conv('edge-cases.html');
    assert.ok(layer(r, 'Pop in from zero'), 'text that starts at scale 0 is kept');
    const notes = r.scene.notes.map((n) => n.message).join('\n');
    assert.ok(/<img> without a loadable source/.test(notes) && /<video> without a loadable source/.test(notes), notes);
    assert.ok(!/please report/.test(notes), 'no layer needed the safety net:\n' + notes);
    assert.ok(!r.scene.layers.some((L) => L.text && !(L.text.size > 0)), 'no zero-size text layers');
  });
  await test('convert: the safety net drops a broken layer instead of failing', () => {
    const scene = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'hand-written-scene.json'), 'utf8'));
    scene.notes = [];
    scene.layers[0].text.size = 0;
    scene.layers[1].matte = scene.layers[0].id;
    const v = engine.sanitizeScene(scene);
    assert.ok(v.ok, v.errors.join('; '));
    assert.ok(!scene.layers.some((L) => L.id === 'title'));
    assert.ok(!scene.layers[0].matte, 'matte link to the dropped layer removed');
    assert.ok(/please report/.test(scene.notes[0].message));
  });
  await test('convert stacking.html: layer order matches Chrome\'s real paint order', async () => {
    if (!browser) skip('no browser');
    const { capture } = require('../engine/capture');
    const { buildScene } = require('../engine/scene');
    const r = await capture(path.join(fx, 'stacking.html'), {});
    let truth;
    try { truth = await r.session.evaluate("document.elementsFromPoint(400,300).map(function(e){return e.id||e.className}).filter(function(x){return x&&x!=='stage'})"); }
    finally { await r.close(); }
    const mine = buildScene(r.recording, {}).scene.layers.map((L) => L.name).filter((n) => n !== 'Background');
    assert.deepStrictEqual(mine, truth);
  });
  await test('convert pictures.html: unsupported parts come in as pictures, motion kept as keyframes', async () => {
    const r = await conv('pictures.html');
    const pics = r.scene.layers.filter((L) => L.comment.indexOf('(picture:') >= 0);
    assert.strictEqual(pics.length, 7, pics.map((L) => L.name).join(', '));
    assert.ok(layer(r, 'Hello') && layer(r, 'Hello').type === 'text', 'text on a picture-box stays editable');
    assert.ok(layer(r, 'card') && layer(r, 'card').type === 'shape', 'card box stays native when only ::before needs a picture');
    assert.ok(layer(r, 'rainbow').transform.position.keys, 'static picture keeps its motion as keyframes');
    const seq = r.scene.assets.filter((a) => a.kind === 'sequence' && a.origin === 'picture');
    assert.strictEqual(seq.length, 1, 'only the colour-changing gradient needs a sequence');
    assert.ok(!layer(r, 'inside'), 'content inside a mask-image picture is not duplicated');
  });
  await test('convert promo.html: fading glows, gradient text, animated blur, resized images, wipes', async () => {
    const r = await conv('promo.html');
    const glow = layer(r, 'glow');
    assert.ok(glow && glow.type === 'image' && /fades to transparent/.test(glow.comment), 'transparent glow comes in as a picture, not an opaque Gradient Ramp');
    const w2 = layer(r, 'Trusted.');
    assert.ok(w2 && w2.type === 'text', 'gradient text is a text layer');
    const op = w2.transform.opacity;
    assert.ok((op.value != null ? op.value : Math.max.apply(null, op.keys.map((k) => k.v))) > 50, 'gradient text is visible (its transparent colour must not zero the opacity)');
    assert.ok(w2.effects.some((e) => e.type === 'gradient'), 'gradient text keeps its gradient');
    const blur = (L) => (L.effects || []).find((e) => e.type === 'blur');
    const b1 = blur(layer(r, 'Seen.'));
    assert.ok(b1 && b1.amount.keys && b1.amount.keys.length >= 2, 'blur is animated');
    near(b1.amount.keys[b1.amount.keys.length - 1].v, 0, 0.5, 'blur ends sharp');
    const logo = layer(r, 'logo');
    assert.ok(logo.box.value, 'picture size is constant');
    const sk = logo.transform.scale.keys;
    assert.ok(sk && sk.length >= 2, 'resizing became scale keys');
    near(sk[sk.length - 1].v[0] / sk[0].v[0], 0.25, 0.02, 'width 400 → 100 px is scale ×0.25');
    const card = r.scene.layers.find((L) => L.type === 'text' && /approach/.test(L.name));
    const src = card.text.source.value.split('\r');
    assert.deepStrictEqual(src, ['Healthcare-', 'focused', 'approach'], 'a word that wraps at its hyphen keeps the page\'s line breaks');
    near(card.text.leading, 44 * 1.1, 1, 'leading');
    // A picture inside a closed circle wipe must still be captured whole.
    const png = path.join(r.outDir, 'assets', 'picture_' + glow.source + '.png');
    if (fs.existsSync(png)) {
      const buf = fs.readFileSync(png);
      assert.ok(buf.length > 2000, 'glow picture is not empty (' + buf.length + ' bytes)');
    }
  });
  await test('look: KeyframeX renders match the page (visual comparison, < 1% differing pixels)', async () => {
    if (!browser) skip('no browser');
    const { execFileSync } = require('child_process');
    for (const f of ['basic.html', 'pictures.html', 'stacking.html', 'promo.html']) {
      const out = path.join(tmpOut, 'cmp-' + f);
      const res = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'tools', 'compare.js'), path.join(fx, f), '--out', out], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 180000 }).toString());
      for (const fr of res.frames) assert.ok(fr.differing < 1, f + ' at ' + fr.t + 's differs in ' + fr.differing + '% of pixels — see ' + fr.file);
    }
  });
  await test('convert: quality presets change key counts in the right direction', async () => {
    if (!browser) skip('no browser');
    const light = await engine.convert(path.join(fx, 'basic.html'), { quality: 'light', outDir: path.join(tmpOut, 'q-light') });
    const exact = await engine.convert(path.join(fx, 'basic.html'), { quality: 'exact', outDir: path.join(tmpOut, 'q-exact') });
    assert.ok(light.report.keyframes <= exact.report.keyframes, light.report.keyframes + ' vs ' + exact.report.keyframes);
  });

  // ------------------------------------------------------------------ host (mock AE)
  for (const name of ['basic.html', 'gsap.html', 'media.html', 'edge-cases.html', 'pictures.html', 'promo.html']) {
    await test('host: builds ' + name + ' in the After Effects mock without warnings', async () => {
      const r = converted[name];
      if (!r) skip('not converted');
      const { ctx, evalHost } = mockHost();
      const pipeline = require('../shared/pipeline');
      const res = await pipeline.buildInAE(evalHost, r.scenePath, { target: 'new' });
      assert.ok(res.ok);
      assert.deepStrictEqual(res.warnings, []);
      const c = comps(ctx)[0];
      assert.strictEqual(c.numLayers, r.scene.layers.length);
      assert.strictEqual(ctx.app.undoDepth, 0, 'undo group closed');
      for (const L of r.scene.layers.filter((x) => x.matte)) {
        const l = c._layers.find((y) => y.name === L.name);
        assert.ok(l.trackMatteLayer, L.name + ' has its track matte');
      }
    });
  }
  await test('host: an AI-written scene (rect, ellipse, path, text, solid) builds', async () => {
    const scene = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'hand-written-scene.json'), 'utf8'));
    const v = validateScene(scene);
    assert.ok(v.ok, v.errors.join('; '));
    const { ctx, evalHost } = mockHost();
    const res = await require('../shared/pipeline').buildInAE(evalHost, scene, { target: 'new' });
    assert.deepStrictEqual(res.warnings, []);
    assert.strictEqual(comps(ctx)[0].numLayers, scene.layers.length);
  });
  await test('host: build into the active comp places a precomp layer', async () => {
    const r = converted['basic.html'];
    if (!r) skip('not converted');
    const { ctx, evalHost } = mockHost();
    const host = ctx.app.project.items.addComp('Edit', 1920, 1080, 1, 10, 30);
    host.time = 2;
    ctx.app.project.activeItem = host;
    const res = await require('../shared/pipeline').buildInAE(evalHost, r.scenePath, { target: 'active' });
    assert.strictEqual(res.placedInto, 'Edit');
    assert.strictEqual(host.numLayers, 1);
    assert.strictEqual(host.layer(1).startTime, 2);
  });
  await test('host: the panel loads the host script itself when After Effects has not', async () => {
    const ctx = createAE();
    vm.createContext(ctx);
    const evalHost = (script) => { try { const r = vm.runInContext(script, ctx); return Promise.resolve(r === undefined ? 'undefined' : String(r)); } catch (e) { return Promise.resolve('EvalScript error.'); } };
    const r = await require('../shared/pipeline').hostCall(evalHost, 'ping', []);
    assert.ok(r.ok && r.host);
  });
  await test('host: unreadable answers from After Effects become clear errors', () => {
    const { parseHost } = require('../shared/pipeline');
    assert.throws(() => parseHost('EvalScript error.'), /could not run the KeyframeX script/);
    assert.throws(() => parseHost('<html>'), (e) => /not JSON/.test(e.message) && e.raw === '<html>');
    assert.throws(() => parseHost('{"ok":false,"error":"Boom","line":7}'), (e) => e.message === 'Boom' && e.line === 7);
  });
  await test('host: errors come back as JSON, not exceptions', async () => {
    const { evalHost } = mockHost();
    const raw = await evalHost('$.global.KeyframeX.build("/does/not/exist.json", "{}")');
    const r = JSON.parse(raw);
    assert.strictEqual(r.ok, false);
    assert.ok(/not found/i.test(r.error));
  });

  // After Effects can drop a justification set together with the text (real AE bug that
  // shifted centred words right by half their width). The mock reproduces it.
  const alignScene = () => ({
    format: 'keyframex.scene', version: 1, generator: 'tests',
    comp: { name: 'Align', width: 1920, height: 1080, fps: 30, duration: 2 },
    assets: [], fonts: [],
    layers: [
      { id: 'c', type: 'text', name: 'Centre', in: 0, out: 2, transform: { position: { value: [960, 540] }, anchor: { value: [0, 0] } },
        text: { font: { family: 'Arial', postScriptName: 'ArialMT', weight: 400, style: 'normal' }, size: 100, justify: 'center', color: [1, 1, 1], source: { value: 'Trusted.' } } },
      { id: 'k', type: 'text', name: 'Keyed', in: 0, out: 2, transform: { position: { value: [960, 800] }, anchor: { value: [0, 0] } },
        text: { font: { family: 'Arial', postScriptName: 'ArialMT', weight: 400, style: 'normal' }, size: 60, justify: 'right', color: [1, 1, 1], source: { keys: [{ t: 0, v: 'one' }, { t: 1, v: 'two two' }] } } },
      { id: 'l', type: 'text', name: 'Left', in: 0, out: 2, transform: { position: { value: [160, 200] }, anchor: { value: [0, 0] } },
        text: { font: { family: 'Arial', postScriptName: 'ArialMT', weight: 400, style: 'normal' }, size: 60, justify: 'left', color: [1, 1, 1], source: { value: 'Left' } } },
    ],
    notes: [],
  });
  const builtText = (ctx) => {
    const c = comps(ctx).find((x) => x.name === 'Align');
    const by = {};
    for (let i = 1; i <= c.numLayers; i++) { const l = c.layer(i); by[l.name] = l; }
    const tp = (l) => l.property('ADBE Text Properties').property('ADBE Text Document');
    const anchor = (l) => Array.from(l.property('ADBE Transform Group').property('ADBE Anchor Point').value).slice(0, 2);
    return { by, tp, anchor };
  };
  await test('host: text justification survives the After Effects same-document bug', async () => {
    const { ctx, evalHost } = mockHost({ justificationBug: 'same-doc', panelJustification: 7413 });
    const res = await require('../shared/pipeline').buildInAE(evalHost, alignScene(), {});
    assert.ok(res.ok, JSON.stringify(res));
    const { by, tp, anchor } = builtText(ctx);
    assert.strictEqual(tp(by.Centre).value.justification, 7415, 'centre text is centre-justified');
    assert.strictEqual(tp(by.Left).value.justification, 7413);
    const k = tp(by.Keyed);
    for (let i = 1; i <= k.numKeys; i++) assert.strictEqual(k.keyValue(i).justification, 7414, 'keyed text key ' + i);
    assert.deepStrictEqual(anchor(by.Centre), [0, 0], 'no anchor fallback needed');
    assert.ok(!(res.warnings || []).some((w) => /alignment/.test(w)), 'no alignment warning');
  });
  await test('host: text that refuses its justification is lined up with the anchor', async () => {
    const { ctx, evalHost } = mockHost({ justificationBug: 'never', panelJustification: 7413 });
    const res = await require('../shared/pipeline').buildInAE(evalHost, alignScene(), {});
    assert.ok(res.ok, JSON.stringify(res));
    const { by, anchor } = builtText(ctx);
    const r = by.Centre.sourceRectAtTime(0, false);
    assert.ok(Math.abs(anchor(by.Centre)[0] - (r.left + r.width / 2)) < 1e-6 && r.width > 0, 'anchor at text centre');
    assert.deepStrictEqual(anchor(by.Left), [0, 0], 'left text untouched');
    assert.ok((res.warnings || []).some((w) => /anchor point/.test(w)), 'user is told');
  });

  await test('host: text that After Effects draws off its spot is lined up', async () => {
    const { ctx, evalHost } = mockHost({ justificationBug: 'same-doc', textOffset: [1297, 0] });
    const res = await require('../shared/pipeline').buildInAE(evalHost, alignScene(), {});
    assert.ok(res.ok, JSON.stringify(res));
    const { by, anchor } = builtText(ctx);
    for (const n of ['Centre', 'Left', 'Keyed']) near(anchor(by[n])[0], 1297, 0.01, n + ' anchor x');
    assert.ok((res.warnings || []).some((w) => /3 text layer\(s\).*1297 px/.test(w)), JSON.stringify(res.warnings));
  });

  // ------------------------------------------------------------------ report
  console.log('KeyframeX tests' + (browser ? ' (browser: ' + path.basename(browser) + ')' : ' (no browser found)'));
  console.log(results.join('\n'));
  console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
  process.exit(failed ? 1 : 0);
})();
