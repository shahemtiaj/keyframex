'use strict';
/**
 * Recording → KeyframeX Scene (format "keyframex.scene", version 1).
 *
 * The scene is a plain JSON description of one After Effects composition:
 * layers listed top → bottom, each with fitted property tracks. It is the
 * single contract between the capture engine, the ExtendScript builder, the
 * CLI and hand- or AI-written scenes (a scene can be written directly).
 * See engine/schema/scene.schema.json and docs/SCENE_FORMAT.md.
 */
const path = require('path');
const G = require('./geometry');
const { fitTrack, tolerance, countKeys } = require('./fit');
const { coveredBySubtree, matrixFor } = require('./raster');

const FORMAT = 'keyframex.scene';
const VERSION = 1;

const BLEND = {
  multiply: 'MULTIPLY', screen: 'SCREEN', overlay: 'OVERLAY', darken: 'DARKEN', lighten: 'LIGHTEN',
  'color-dodge': 'COLOR_DODGE', 'color-burn': 'COLOR_BURN', 'hard-light': 'HARD_LIGHT', 'soft-light': 'SOFT_LIGHT',
  difference: 'DIFFERENCE', exclusion: 'EXCLUSION', hue: 'HUE', saturation: 'SATURATION', color: 'COLOR',
  luminosity: 'LUMINOSITY', 'plus-lighter': 'ADD',
};

const rgb = (c) => (c ? [c[0] / 255, c[1] / 255, c[2] / 255] : [0, 0, 0]);
const alpha = (c) => (c ? (c[3] == null ? 1 : c[3]) : 0);
const round = (v, d = 3) => Math.round(v * Math.pow(10, d)) / Math.pow(10, d);

function genericFontName(stack) {
  return String(stack || '').split(',')[0].replace(/["']/g, '').trim();
}

function primaryText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 32) || 'Text';
}

/**
 * @param {object} rec recording from capture()
 * @param {object} opts { quality: 'light'|'balanced'|'exact', name }
 */
function buildScene(rec, opts = {}) {
  const quality = opts.quality || 'balanced';
  const fps = rec.fps;
  const times = rec.times;
  const N = rec.frameCount;
  const notes = [];
  const noteSet = new Set();
  const note = (kind, msg, layer) => {
    const k = kind + '|' + msg;
    if (noteSet.has(k)) { const n = notes.find((x) => x.kind + '|' + x.message === k); if (n && layer && n.layers.length < 12 && n.layers.indexOf(layer) < 0) n.layers.push(layer); return; }
    noteSet.add(k);
    notes.push({ kind, message: msg, layers: layer ? [layer] : [] });
  };
  const assets = new Map(); // url -> asset
  const assetFor = (url, kind) => {
    if (!url) return null;
    if (!assets.has(url)) assets.set(url, { id: 'a' + (assets.size + 1), kind, url });
    return assets.get(url).id;
  };
  const fontsUsed = new Map();
  const names = new Map();
  const uniqueName = (base) => {
    base = String(base || 'Layer').slice(0, 60);
    const n = (names.get(base) || 0) + 1;
    names.set(base, n);
    return n === 1 ? base : base + ' ' + n;
  };
  let layerSeq = 0;
  const newId = () => 'L' + (++layerSeq);

  /** Fit a per-frame value list over the layer's visible span. */
  function track(vals, kind, extra = {}) {
    const span = extra.span;
    const ts = span ? times.slice(span[0], span[1] + 1) : times;
    const vs = span ? vals.slice(span[0], span[1] + 1) : vals;
    return fitTrack(ts, vs, Object.assign({ tol: tolerance(kind, quality) }, extra));
  }

  const elements = Array.from(rec.elements.values());
  // Paint order (ascending): keys are [bucket, docIndex] pairs from the sampler, compared
  // lexicographically; a shorter key that is a prefix paints first (ancestor below descendant).
  elements.sort((a, b) => {
    const ka = a.order || [-0.5, a.id], kb = b.order || [-0.5, b.id];
    const n = Math.max(ka.length, kb.length);
    for (let i = 0; i < n; i++) {
      const x = ka[i] == null ? -Infinity : ka[i];
      const y = kb[i] == null ? -Infinity : kb[i];
      if (x !== y) return x - y;
    }
    return a.id - b.id;
  });

  const byId = rec.elements;
  const layersBottomUp = [];
  const mattes = new Map(); // element id -> matte layer id
  const pendingMattes = [];
  let skippedHidden = 0;
  let maxPerspective = 0;

  // Frame-wise HTML matrix (local box px → comp px).
  function htmlMatrix(r) {
    if (!r || !r.quad) return null;
    const a = G.affineFromQuad(r.quad, r.bw, r.bh);
    if (a.perspective > maxPerspective) maxPerspective = a.perspective;
    r._persp = a.perspective;
    return a.m;
  }

  // Frame-wise SVG matrix (element user space → comp px).
  function svgMatrix(r, f) {
    if (!r || !r.ctm) return null;
    const root = byId.get(r.svgRoot);
    const rr = root && root.frames[f];
    if (!rr || !rr.cquad) return null;
    const rootM = G.affineFromQuad(rr.cquad, rr.w || rr.bw, rr.h || rr.bh).m;
    return G.mul(rootM, G.mul(rr.vbm || G.IDENTITY, r.ctm));
  }

  function visibleSpan(el, isSvg) {
    let a = -1, b = -1;
    for (let f = 0; f < N; f++) {
      const r = el.frames[f];
      const ok = r && r.vis && r.op > 0.0005 && (isSvg ? !!r.ctm : (r.kind === 'audio' || !!r.quad));
      if (ok) { if (a < 0) a = f; b = f; }
    }
    return a < 0 ? null : [a, b];
  }

  /** Transform tracks for a layer anchored at a local point. */
  function transformTracks(el, span, mats, anchorLocal, extraScale, opacityExtra) {
    const pos = [], scl = [], rot = [], op = [];
    let skewWarn = false;
    for (let f = span[0]; f <= span[1]; f++) {
      const m = mats[f];
      const r = el.frames[f];
      if (!m || !r || !r.vis) { pos[f] = scl[f] = rot[f] = null; op[f] = 0; continue; }
      const P = typeof anchorLocal === 'function' ? anchorLocal(f, r) : anchorLocal;
      pos[f] = G.apply(m, P[0], P[1]);
      const d = G.decompose(m);
      if (Math.abs(d.skew) > 1.5) skewWarn = true;
      const k = extraScale ? (typeof extraScale === 'function' ? extraScale(f, r) : extraScale) : [1, 1];
      scl[f] = [d.scaleX * k[0], d.scaleY * k[1]];
      rot[f] = d.rotation;
      op[f] = Math.max(0, Math.min(100, r.op * 100 * (opacityExtra ? opacityExtra(f, r) : 1)));
    }
    const rotU = G.unwrapAngles(rot.slice(span[0], span[1] + 1));
    for (let i = 0; i < rotU.length; i++) rot[span[0] + i] = rotU[i];
    return {
      skewWarn,
      tracks: {
        position: track(pos, 'position', { span, spatial: true }),
        scale: track(scl, 'scale', { span }),
        rotation: track(rot, 'rotation', { span }),
        opacity: track(op, 'opacity', { span }),
      },
    };
  }

  function baseLayer(el, type, name, span) {
    const r0 = el.frames[span[0]];
    const sel = r0.tag + (r0.htmlId ? '#' + r0.htmlId : '') + (r0.cls ? '.' + r0.cls.split(' ').join('.') : '');
    const L = {
      id: newId(),
      type,
      name: uniqueName(name),
      comment: 'KeyframeX: <' + sel + '>',
      in: round(times[span[0]], 6),
      out: round(Math.min(rec.duration, (span[1] + 1) / fps), 6),
      source: el.id,
    };
    if (r0.blend && BLEND[r0.blend]) L.blend = BLEND[r0.blend];
    else if (r0.blend) note('approx', 'Blend mode "' + r0.blend + '" has no After Effects match; Normal used.', L.name);
    return L;
  }

  function nameFor(r, fallback) {
    if (r.htmlId) return r.htmlId;
    if (r.cls) return r.cls.split(' ')[0];
    return fallback || r.tag;
  }

  /**
   * CSS blur of an element at frame f, including blur inherited from blurred ancestors
   * (blurs compose like Gaussians: the variances add).
   */
  function blurAt(el, f) {
    let v = 0, e = el, guard = 0;
    while (e && guard++ < 64) {
      const r = e.frames[f];
      if (!r) break;
      if (r.filter && r.filter.blur) v += r.filter.blur * r.filter.blur;
      e = r.par != null ? rec.elements.get(r.par) : null;
    }
    return Math.sqrt(v);
  }

  /**
   * Replace the static blur from the first frame with the real, animated one. `baked` is
   * the blur already inside a captured picture (the frame it was taken at).
   */
  function applyBlurTrack(L, el, span, baked) {
    if (!L || L.type === 'audio' || !span) return;
    const vals = [];
    let any = false;
    for (let f = span[0]; f <= span[1]; f++) {
      const b = Math.sqrt(Math.max(0, Math.pow(blurAt(el, f), 2) - baked * baked));
      vals[f] = round(b * 2, 2);
      if (vals[f] > 0.05) any = true;
    }
    const rest = (L.effects || []).filter((e) => e.type !== 'blur');
    if (any) rest.unshift({ type: 'blur', amount: track(vals, 'generic', { span }) });
    if (rest.length) L.effects = rest; else delete L.effects;
  }

  function effectsFromStyle(r, Lname) {
    const fx = [];
    if (r.shadow && !r.shadow.inset) {
      const s = r.shadow;
      fx.push(dropShadow(s.x, s.y, s.blur, s.color));
      if (s.count > 1) note('approx', 'Only the first of several box-shadows is converted.', Lname);
      if (s.spread) note('approx', 'Box-shadow spread is not converted.', Lname);
    } else if (r.shadow && r.shadow.inset) {
      note('skip', 'Inset shadows are not converted.', Lname);
    }
    if (r.filter) {
      if (r.filter.blur) fx.push({ type: 'blur', amount: { value: round(r.filter.blur * 2, 2) } });
      if (r.filter.drop) fx.push(dropShadow(r.filter.drop.x, r.filter.drop.y, r.filter.drop.blur, r.filter.drop.color));
      if (r.filter.glow) note('approx', 'SVG glow converted as a blur.', Lname);
      if (r.filter.other) note('skip', 'Filter "' + r.filter.other + '" is not converted.', Lname);
    }
    return fx;
  }

  function dropShadow(x, y, blur, color) {
    const dir = ((Math.atan2(x, -y) * 180 / Math.PI) + 360) % 360;
    return {
      type: 'dropShadow',
      color: { value: rgb(color) },
      opacity: { value: round(alpha(color) * 100, 2) },
      direction: { value: round(dir, 2) },
      distance: { value: round(Math.hypot(x, y), 2) },
      softness: { value: round(blur, 2) },
    };
  }

  /** Gradient ramp effect from a parsed CSS gradient over a w×h box (local px). */
  function cssGradientEffect(g, w, h, Lname) {
    if (!g) return null;
    let stops = g.stops;
    if (g.kind === 'complex') {
      note('approx', 'Complex gradient (' + String(g.css || '').slice(0, 40) + '…) approximated.', Lname);
      return null;
    }
    const cx = w / 2, cy = h / 2;
    let start, end;
    if (g.kind === 'linear') {
      const th = g.angle * Math.PI / 180;
      const L = Math.abs(w * Math.sin(th)) + Math.abs(h * Math.cos(th));
      const d = [Math.sin(th), -Math.cos(th)];
      const s0 = [cx - d[0] * L / 2, cy - d[1] * L / 2];
      const s1 = [cx + d[0] * L / 2, cy + d[1] * L / 2];
      start = [s0[0] + (s1[0] - s0[0]) * g.pos[0], s0[1] + (s1[1] - s0[1]) * g.pos[0]];
      end = [s0[0] + (s1[0] - s0[0]) * g.pos[1], s0[1] + (s1[1] - s0[1]) * g.pos[1]];
    } else {
      const R = Math.hypot(w, h) / 2;
      start = [cx, cy];
      end = [cx + R * g.pos[1], cy];
      if (g.shape === 'ellipse') note('approx', 'Elliptical radial gradient converted as circular.', Lname);
    }
    if (alpha(stops[0]) < 0.999 || alpha(stops[1]) < 0.999) note('approx', 'Gradient transparency is not carried over (Gradient Ramp is opaque).', Lname);
    return {
      type: 'gradient', kind: g.kind === 'radial' ? 'radial' : 'linear',
      start: [round(start[0], 2), round(start[1], 2)], end: [round(end[0], 2), round(end[1], 2)],
      colors: [rgb(stops[0]), rgb(stops[1])], box: [0, 0, w, h],
    };
  }

  function svgGradientEffect(grad, bbox, Lname) {
    if (!grad || !grad.stops || grad.stops.length < 2) return null;
    if (grad.stops.length > 2) note('approx', 'SVG gradient with ' + grad.stops.length + ' stops uses its first and last colour.', Lname);
    const s0 = grad.stops[0], s1 = grad.stops[grad.stops.length - 1];
    const obb = grad.units !== 'userSpaceOnUse';
    const P = (x, y) => (obb ? [bbox[0] + x * bbox[2], bbox[1] + y * bbox[3]] : [x, y]);
    let start, end;
    if (grad.kind === 'linear') { start = P(grad.x1, grad.y1); end = P(grad.x2, grad.y2); }
    else { start = P(grad.cx, grad.cy); const e = P(grad.cx + grad.r, grad.cy); end = e; }
    return {
      type: 'gradient', kind: grad.kind, start: start.map((v) => round(v, 2)), end: end.map((v) => round(v, 2)),
      colors: [rgb(s0.color), rgb(s1.color)], box: bbox.map((v) => round(v, 2)),
    };
  }

  function constantOver(el, span, fn) {
    const v0 = JSON.stringify(fn(el.frames[span[0]]));
    for (let f = span[0] + 1; f <= span[1]; f++) { const r = el.frames[f]; if (r && JSON.stringify(fn(r)) !== v0) return false; }
    return true;
  }

  function colorTrack(el, span, fn) {
    const vals = [];
    for (let f = 0; f < N; f++) { const r = el.frames[f]; const c = r ? fn(r) : null; vals[f] = c ? rgb(c) : null; }
    return track(vals, 'color', { span, interp: 'linear' });
  }

  function mattePlan(el, span, mats) {
    // Overflow/clip-path containers become matte layers for their content.
    const r0 = el.frames[span[0]];
    if (!r0.clips) return null;
    if (el.id === rec.stageId) return null;
    // A container covering the whole frame axis-aligned clips nothing the comp would show.
    const q = r0.quad;
    if (q && Math.abs(q[0]) < 1 && Math.abs(q[1]) < 1 && Math.abs(q[4] - rec.width) < 1 && Math.abs(q[5] - rec.height) < 1 && !r0.clips.path) return null;
    return { el, span, mats };
  }

  function buildMatte(plan) {
    const { el, span, mats } = plan;
    const r0 = el.frames[span[0]];
    const paths = [];
    let unsupported = null;
    for (let f = 0; f < N; f++) {
      const r = el.frames[f];
      if (!r || !r.quad || f < span[0] || f > span[1]) { paths[f] = null; continue; }
      const w = r.bw, h = r.bh;
      let ct;
      if (r.clips && r.clips.path) {
        ct = G.clipPathContour(r.clips.path, w, h);
        if (ct && ct.unsupported) { unsupported = ct.unsupported; ct = null; }
      }
      if (!ct) ct = G.rectContour(0, 0, w, h, Math.max.apply(null, r.radius || [0]), Math.max.apply(null, r.radius || [0]));
      const ae = G.contourToAE(ct, [1, 0, 0, 1, -w / 2, -h / 2], 2);
      paths[f] = ae;
    }
    if (unsupported) note('approx', 'clip-path "' + unsupported.slice(0, 30) + '" not supported; the box is used.', nameFor(r0));
    const L = baseLayer(el, 'shape', nameFor(r0) + ' matte', span);
    L.matteSource = true;
    L.comment += ' (clip area)';
    const center = (f, r) => [r.bw / 2, r.bh / 2];
    const T = transformTracks(el, span, mats, center, null, () => 1);
    L.transform = T.tracks;
    L.transform.opacity = { value: 100 };
    L.shape = { kind: 'path', paths: pathTrack(paths, span) };
    L.fill = { color: { value: [1, 1, 1] }, opacity: { value: 100 } };
    return L;
  }

  function pathTrack(paths, span) {
    // paths: per-frame AE path object (single contour) or array of them
    const norm = paths.map((p) => (p == null ? null : Array.isArray(p) ? p : [p]));
    const sig = (ps) => ps.map((p) => p.v.length + (p.c ? 'c' : 'o')).join(',');
    const first = norm[span[0]];
    if (!first) return { value: [] };
    let sameTopology = true, allSame = true;
    const s0 = sig(first), j0 = JSON.stringify(first);
    for (let f = span[0]; f <= span[1]; f++) {
      if (!norm[f]) continue;
      if (sig(norm[f]) !== s0) sameTopology = false;
      if (JSON.stringify(norm[f]) !== j0) allSame = false;
    }
    if (allSame) return { value: first };
    const keys = [];
    if (sameTopology) {
      // Fit linearly on the flattened vertex/tangent vector, then rebuild path objects.
      const flat = norm.map((ps) => (ps ? [].concat.apply([], ps.map((p) => [].concat.apply([], p.v.concat(p.i, p.o)))) : null));
      const tr = track(flat, 'position', { span, interp: 'linear', spatial: false, round: 2 });
      const unflat = (vec) => {
        let k = 0;
        return first.map((p) => {
          const n = p.v.length;
          const take = () => { const out = []; for (let i = 0; i < n; i++) { out.push([vec[k], vec[k + 1]]); k += 2; } return out; };
          const v = take(), i2 = take(), o = take();
          return { v, i: i2, o, c: p.c };
        });
      };
      if (!tr.keys) return { value: first };
      for (const k of tr.keys) keys.push({ t: k.t, v: unflat(k.v) });
      return { keys };
    }
    let prev = null;
    for (let f = span[0]; f <= span[1]; f++) {
      if (!norm[f]) continue;
      const j = JSON.stringify(norm[f]);
      if (j !== prev) { keys.push({ t: round(times[f], 6), v: norm[f] }); prev = j; }
    }
    return { keys };
  }

  // ---------------------------------------------------------------- text
  /** Layout of an HTML text element in its local box: lines + anchor point (first baseline). */
  function htmlTextLayout(r, m) {
    const ti = r.text;
    const im = G.inv(m);
    if (!im || !ti.words || !ti.words.length) return null;
    const size = ti.size || 16;
    const met = ti.metrics || { asc: size * 0.8, desc: size * 0.2 };
    const words = [];
    let lineBreaks = 0;
    for (const w of ti.words) {
      if (w.nl) { lineBreaks++; words.push({ nl: true }); continue; }
      const p = G.apply(im, w.cx, w.cy);
      words.push({ t: w.t, x: p[0], y: p[1], w: w.w });
    }
    const lines = [];
    let cur = null;
    for (const w of words) {
      if (w.nl) { cur = null; continue; }
      if (!cur || Math.abs(w.y - cur.y) > size * 0.45 || w.x < cur.right - size * 0.2) {
        cur = { y: w.y, words: [], left: Infinity, right: -Infinity };
        lines.push(cur);
      }
      cur.words.push(w.t);
      cur.left = Math.min(cur.left, w.x - w.w / 2);
      cur.right = Math.max(cur.right, w.x + w.w / 2);
    }
    void lineBreaks;
    if (!lines.length) return null;
    const baseline = (ln) => ln.y - (met.asc + met.desc) / 2 + met.asc;
    const align = ti.align === 'center' ? 'center' : (ti.align === 'right' || ti.align === 'end') ? 'right' : 'left';
    const l0 = lines[0];
    const ax = align === 'center' ? (l0.left + l0.right) / 2 : align === 'right' ? l0.right : l0.left;
    const leading = lines.length > 1 ? baseline(lines[1]) - baseline(lines[0]) : (ti.lh || size * 1.2);
    return {
      text: lines.map((l) => l.words.join(' ')).join('\r'),
      anchor: [ax, baseline(l0)],
      leading: round(leading, 2),
      justify: align,
      lines: lines.length,
    };
  }

  function detectCounter(strings) {
    const re = /^(\D*?)(-?\d[\d,]*(?:\.\d+)?)(\D*)$/;
    const parts = strings.map((s) => re.exec(s));
    if (parts.some((p) => !p)) return null;
    const pre = parts[0][1], suf = parts[0][3];
    if (parts.some((p) => p[1] !== pre || p[3] !== suf)) return null;
    const vals = parts.map((p) => parseFloat(p[2].replace(/,/g, '')));
    if (new Set(vals).size < 3) return null;
    const decimals = Math.max.apply(null, parts.map((p) => (p[2].split('.')[1] || '').length));
    const commas = parts.some((p) => p[2].indexOf(',') >= 0);
    return { prefix: pre, suffix: suf, decimals, commas, values: vals };
  }

  function fontInfo(el, r, ti) {
    const pf = rec.fonts.get(el.id);
    const family = pf ? pf.familyName : genericFontName(ti.family);
    const info = {
      family,
      postScriptName: pf && pf.postScriptName ? pf.postScriptName : null,
      weight: ti.weight || 400,
      style: ti.style === 'italic' || ti.style === 'oblique' ? 'italic' : 'normal',
      css: ti.family,
      custom: pf ? !!pf.isCustomFont : false,
    };
    const key = info.postScriptName || (info.family + '|' + info.weight + '|' + info.style);
    if (!fontsUsed.has(key)) fontsUsed.set(key, Object.assign({ layers: 0 }, info));
    fontsUsed.get(key).layers++;
    return info;
  }

  function textLayer(el, span, mats, opts2) {
    const r0 = el.frames[span[0]];
    const ti0 = r0.text;
    // Layout per frame (re-measured when the text changes).
    const layouts = [];
    let last = null, lastAt = null;
    for (let f = span[0]; f <= span[1]; f++) {
      const r = el.frames[f];
      if (!r || !r.text || !mats[f]) { layouts[f] = last; continue; }
      if (!last || r.text.relayout || r.text.layoutAt !== lastAt) {
        // Words were measured at r.text.layoutAt: invert THAT frame's matrix.
        const lf = Math.max(0, Math.min(N - 1, Math.round((r.text.layoutAt || 0) / 1000 * fps)));
        const lay = htmlTextLayout(r, mats[lf] || mats[f]);
        if (lay) { last = lay; lastAt = r.text.layoutAt; }
      }
      layouts[f] = last;
    }
    if (!last) return null;
    if (!(ti0.size > 0)) return null; // font-size 0: nothing is drawn
    const firstLay = layouts.find((x) => x) || last;
    const L = baseLayer(el, 'text', primaryText(firstLay.text), span);
    const T = transformTracks(el, span, mats, (f) => (layouts[f] || firstLay).anchor, null,
      // Gradient text (background-clip: text) has a transparent colour by design: its look
      // comes from the gradient, so the colour's alpha must not hide the layer.
      (f, r) => (opts2 && opts2.gradient ? 1 : alpha(r.text && r.text.color)));
    if (T.skewWarn) note('approx', 'Skewed text is converted without skew.', L.name);
    L.transform = T.tracks;
    const strings = [];
    for (let f = span[0]; f <= span[1]; f++) strings.push((layouts[f] || firstLay).text);
    const font = fontInfo(el, r0, ti0);
    L.text = {
      font,
      size: round(ti0.size, 2),
      tracking: round(ti0.ls / (ti0.size || 16) * 1000, 1),
      leading: firstLay.leading,
      justify: firstLay.justify,
      color: rgb(ti0.color),
      source: { value: firstLay.text },
    };
    const distinct = Array.from(new Set(strings));
    if (distinct.length > 1) {
      const counter = detectCounter(strings);
      if (counter) {
        const vals = new Array(N).fill(null);
        for (let i = 0; i < strings.length; i++) vals[span[0] + i] = counter.values[i];
        const tol = 0.6 * Math.pow(10, -counter.decimals); // samples are already rounded for display
        L.text.counter = {
          prefix: counter.prefix, suffix: counter.suffix, decimals: counter.decimals, commas: counter.commas,
          value: fitTrack(times.slice(span[0], span[1] + 1), vals.slice(span[0], span[1] + 1), { tol }),
        };
        L.text.source = { value: counter.prefix + counter.values[0] + counter.suffix };
        if (r0.htmlId || r0.cls) { names.set(L.name, (names.get(L.name) || 1) - 1); L.name = uniqueName(nameFor(r0)); }
      } else {
        const keys = [];
        let prev = null;
        for (let i = 0; i < strings.length; i++) {
          if (strings[i] !== prev) { keys.push({ t: round(times[span[0] + i], 6), v: strings[i], interp: 'hold' }); prev = strings[i]; }
        }
        L.text.source = { keys };
      }
    }
    if (!constantOver(el, span, (r) => r.text && r.text.color && r.text.color.slice(0, 3))) {
      L.effects = (L.effects || []).concat([{ type: 'fill', color: colorTrack(el, span, (r) => r.text && r.text.color) }]);
    }
    if (ti0.strokeW > 0 && ti0.strokeC) L.text.stroke = { color: rgb(ti0.strokeC), width: round(ti0.strokeW, 2) };
    if (ti0.fillC && /rgba\(0, 0, 0, 0\)|transparent/.test(ti0.fillC)) L.text.noFill = true;
    if (ti0.shadow) L.effects = (L.effects || []).concat([dropShadow(ti0.shadow.x, ti0.shadow.y, ti0.shadow.blur, ti0.shadow.color)]);
    if (opts2 && opts2.gradient) {
      L.text.color = [1, 1, 1];
      L.effects = (L.effects || []).concat([opts2.gradient]);
      L.text.noFill = false;
    }
    return L;
  }

  function svgTextLayer(el, span, mats) {
    const r0 = el.frames[span[0]];
    const t = r0.text;
    if (!(t.size > 0) || !String(t.raw || '').trim()) return null; // nothing is drawn
    const just = t.anchor === 'middle' ? 'center' : t.anchor === 'end' ? 'right' : 'left';
    const L = baseLayer(el, 'text', primaryText(t.raw), span);
    const fillA = (r) => (r.fill && r.fill.color ? alpha(r.fill.color) * r.fillOp : 1);
    const T = transformTracks(el, span, mats, (f, r) => [r.text.x, r.text.y], null, fillA);
    L.transform = T.tracks;
    const font = fontInfo(el, r0, t);
    L.text = {
      font, size: round(t.size, 2), tracking: round(t.ls / (t.size || 16) * 1000, 1), leading: round(t.size * 1.2, 2), justify: just,
      color: rgb(r0.fill && r0.fill.color), source: { value: String(t.raw || '').replace(/\s+/g, ' ').trim() },
    };
    const strings = [];
    for (let f = span[0]; f <= span[1]; f++) { const r = el.frames[f]; strings.push(r ? String(r.text.raw || '').replace(/\s+/g, ' ').trim() : strings[strings.length - 1]); }
    if (new Set(strings).size > 1) {
      const counter = detectCounter(strings);
      if (counter) {
        const vals = new Array(N).fill(null);
        for (let i = 0; i < strings.length; i++) vals[span[0] + i] = counter.values[i];
        L.text.counter = { prefix: counter.prefix, suffix: counter.suffix, decimals: counter.decimals, commas: counter.commas, value: fitTrack(times.slice(span[0], span[1] + 1), vals.slice(span[0], span[1] + 1), { tol: 0.6 * Math.pow(10, -counter.decimals) }) };
      } else {
        const keys = []; let prev = null;
        strings.forEach((s, i) => { if (s !== prev) { keys.push({ t: round(times[span[0] + i], 6), v: s, interp: 'hold' }); prev = s; } });
        L.text.source = { keys };
      }
    }
    if (r0.stroke && r0.stroke.color && r0.sw > 0) L.text.stroke = { color: rgb(r0.stroke.color), width: round(r0.sw, 2) };
    if (r0.fill && r0.fill.grad) {
      const fx = svgGradientEffect(r0.fill.grad, r0.bbox, L.name);
      if (fx) L.effects = [fx];
    }
    if (!r0.fill) L.text.noFill = true;
    return L;
  }

  // ---------------------------------------------------------------- pictures
  const jobs = rec.rasterJobs || [];
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const covered = coveredBySubtree(rec, jobs);
  const toComp = rec.toComp || G.IDENTITY;

  /** Picture layer for a raster job: still + keyframed motion, or a PNG sequence. */
  function rasterLayer(el, job, suffix) {
    if (job.mode === 'static' ? !job.images || !job.images[job.f0] : !job.images || !Object.keys(job.images).length) {
      note('skip', 'Could not capture a picture of this element' + (job.error ? ' (' + job.error + ')' : '') + '.', nameFor(el.frames[job.span[0]]));
      return null;
    }
    const span = job.span;
    const r0 = el.frames[span[0]];
    const L = baseLayer(el, 'image', nameFor(r0) + (suffix || ''), span);
    L.asset = 'raster:' + el.id;
    L.fit = 'none';
    L.box = { value: [job.clip[2], job.clip[3]] };
    L.comment += ' (picture: ' + job.why.join(', ') + ')';
    // Blur already in the picture: the frame it was taken at, or every frame of a sequence.
    L._picture = { span, baked: job.mode === 'static' ? blurAt(el, job.f0) : 1e9 };
    const c = G.apply(toComp, job.clip[0] + job.clip[2] / 2, job.clip[1] + job.clip[3] / 2);
    const tl = [toComp[0], toComp[1], toComp[2], toComp[3], 0, 0];
    note('raster', 'Comes in as a picture' + (job.mode === 'sequence' ? ' sequence' : ' (motion kept as keyframes)') + ': ' + job.why.join(', ') + '.', L.name);
    if (job.mode === 'static') {
      const M0 = matrixFor(rec, el, job.f0);
      const M0i = M0 ? G.inv(M0) : null;
      const op0 = Math.max(1e-6, el.frames[job.f0].op);
      const pos = [], scl = [], rot = [], op = [];
      for (let f = span[0]; f <= span[1]; f++) {
        const r = el.frames[f];
        const Mf = r ? matrixFor(rec, el, f) : null;
        if (!Mf || !M0i || !r.vis) { pos[f] = scl[f] = rot[f] = null; op[f] = 0; continue; }
        const R = G.mul(Mf, M0i);
        pos[f] = G.apply(R, c[0], c[1]);
        const d = G.decompose(G.mul([R[0], R[1], R[2], R[3], 0, 0], tl));
        scl[f] = [d.scaleX, d.scaleY];
        rot[f] = d.rotation;
        op[f] = Math.max(0, Math.min(100, r.op / op0 * 100));
      }
      const ru = G.unwrapAngles(rot.slice(span[0], span[1] + 1));
      for (let i = 0; i < ru.length; i++) rot[span[0] + i] = ru[i];
      L.transform = {
        position: track(pos, 'position', { span, spatial: true }),
        scale: track(scl, 'scale', { span }),
        rotation: track(rot, 'rotation', { span }),
        opacity: track(op, 'opacity', { span }),
      };
    } else {
      const d = G.decompose(tl);
      L.transform = { position: { value: [round(c[0], 3), round(c[1], 3)] }, scale: { value: [round(d.scaleX, 3), round(d.scaleY, 3)] }, rotation: { value: round(d.rotation, 3) }, opacity: { value: 100 } };
    }
    return L;
  }

  // ---------------------------------------------------------------- per element
  for (const el of elements) {
    const r0 = el.first;
    if (covered.has(el.id)) continue; // painted inside an ancestor's picture
    const job = jobById.get(el.id);
    if (job && job.parts.subtree) {
      const L = rasterLayer(el, job);
      if (L) {
        applyBlurTrack(L, el, L._picture.span, L._picture.baked);
        delete L._picture;
        L._el = el; layersBottomUp.push(L);
      }
      continue;
    }
    const isSvg = r0.kind === 'svgshape' || r0.kind === 'svgtext' || r0.kind === 'svgimage';
    const span = visibleSpan(el, isSvg);
    if (!span) { if (r0.kind !== 'svgroot') skippedHidden++; continue; }
    const rs = el.frames[span[0]];
    const mats = [];
    for (let f = 0; f < N; f++) mats[f] = isSvg ? svgMatrix(el.frames[f], f) : htmlMatrix(el.frames[f]);
    const myLayers = []; // bottom → top within this element
    const label = nameFor(rs);

    if (rs.kind === 'audio') {
      const L = { id: newId(), type: 'audio', name: uniqueName(path.basename(decodeURIComponent((rs.src || 'audio').split('?')[0]))), comment: 'KeyframeX: <audio>', in: 0, out: rec.duration, source: el.id };
      L.asset = assetFor(rs.src, 'audio');
      L.startAt = rs.start != null ? rs.start : 0;
      if (!rs.src) { note('skip', 'An <audio> element without a source was skipped.'); continue; }
      layersBottomUp.push(L);
      continue;
    }

    if (rs.kind === 'raster') { note('skip', rs.reason + ' could not be captured.', label); continue; }
    if (rs.backdrop) note('skip', 'Backdrop blur (frosted glass) is not converted.', label);

    const isBoxy = rs.kind === 'box' || rs.kind === 'svgroot' || rs.kind === 'img' || rs.kind === 'video' || rs.kind === 'canvas';

    if (isBoxy) {
      const center = (f, r) => [r.bw / 2, r.bh / 2];
      const hasGrad = rs.grad && rs.grad.kind !== 'image';
      const textClip = rs.text && rs.text.clipText && hasGrad;
      const boxPicture = job && job.parts.box;
      const paints = !boxPicture && ((rs.bg && alpha(rs.bg) > 0) || (hasGrad && !textClip) || (rs.border && rs.border.w > 0) || (rs.shadow && !rs.shadow.inset));

      // --- box (shape layer) ---
      if (paints && rs.kind !== 'img' && rs.kind !== 'video') {
        const L = baseLayer(el, 'shape', label, span);
        const T = transformTracks(el, span, mats, center);
        if (T.skewWarn) note('approx', 'Skew is not supported on layers; converted without skew.', L.name);
        L.transform = T.tracks;
        const size = [], rnd = [];
        for (let f = 0; f < N; f++) {
          const r = el.frames[f];
          if (!r || !r.quad) { size[f] = null; rnd[f] = null; continue; }
          const bw = r.border && r.border.w ? r.border.w : 0;
          size[f] = [Math.max(0, r.bw - bw), Math.max(0, r.bh - bw)];
          const rr = r.radius || [0, 0, 0, 0];
          rnd[f] = Math.max(0, Math.min(Math.max.apply(null, rr), Math.min(r.bw, r.bh) / 2) - bw / 2);
        }
        if (rs.radius && new Set(rs.radius.map((v) => Math.round(v))).size > 1) note('approx', 'Different radius per corner: the largest is used.', L.name);
        L.shape = { kind: 'rect', size: track(size, 'size', { span }), roundness: track(rnd, 'size', { span }) };
        if (hasGrad && !textClip) {
          const fx = cssGradientEffect(rs.grad, rs.bw, rs.bh, L.name);
          L.fill = { color: { value: fx ? [1, 1, 1] : rgb((rs.grad.stops && rs.grad.stops[0]) || rs.bg || [128, 128, 128, 1]) }, opacity: { value: 100 } };
          if (fx) { fx.box = [-rs.bw / 2, -rs.bh / 2, rs.bw, rs.bh]; fx.start = [fx.start[0] - rs.bw / 2, fx.start[1] - rs.bh / 2]; fx.end = [fx.end[0] - rs.bw / 2, fx.end[1] - rs.bh / 2]; L.effects = [fx]; }
        } else if (rs.bg && alpha(rs.bg) > 0) {
          const op = [];
          for (let f = 0; f < N; f++) { const r = el.frames[f]; op[f] = r && r.bg ? alpha(r.bg) * 100 : (r ? 0 : null); }
          L.fill = { color: colorTrack(el, span, (r) => r.bg || [0, 0, 0, 0]), opacity: track(op, 'opacity', { span }) };
        }
        if (rs.border && rs.border.w > 0 && rs.border.c) {
          const bwv = [], bop = [];
          for (let f = 0; f < N; f++) { const r = el.frames[f]; bwv[f] = r && r.border ? r.border.w : (r ? 0 : null); bop[f] = r && r.border && r.border.c ? alpha(r.border.c) * 100 : (r ? 0 : null); }
          L.stroke = { color: colorTrack(el, span, (r) => (r.border && r.border.c) || [0, 0, 0, 0]), width: track(bwv, 'size', { span }), opacity: track(bop, 'opacity', { span }), join: 'miter', cap: 'butt' };
        }
        const fx = effectsFromStyle(rs, L.name);
        if (fx.length) L.effects = (L.effects || []).concat(fx);
        if (el.id === rec.stageId) L.name = names.get('Background') ? L.name : (names.set('Background', 1), 'Background');
        myLayers.push(L);
      }

      // --- picture of the box and/or ::before/::after ---
      if (job && (job.parts.box || job.parts.pseudo)) {
        const P = rasterLayer(el, job, job.parts.box ? '' : ' decoration');
        if (P) myLayers.push(P);
      }

      // --- background-image ---
      if (rs.bgImg && !boxPicture) {
        const L = baseLayer(el, 'image', label + ' image', span);
        L.asset = assetFor(rs.bgImg, 'image');
        L.fit = /cover/.test(rs.bgSize) ? 'cover' : /contain/.test(rs.bgSize) ? 'contain' : 'fill';
        L.box = { value: [rs.bw, rs.bh] };
        L.transform = transformTracks(el, span, mats, center).tracks;
        if (L.fit !== 'fill' || !/100%/.test(rs.bgSize || '')) note('approx', 'Background image positioned as "' + L.fit + '" (background-size: ' + rs.bgSize + ').', L.name);
        myLayers.push(L);
      }

      // --- img / video / canvas ---
      const noSource = (rs.kind === 'img' || rs.kind === 'video') && (!rs.src || /^(blob:|about:)/.test(rs.src));
      if (noSource) note('skip', 'A <' + rs.tag + '> without a loadable source was skipped' + (rs.src ? ' (' + rs.src.slice(0, 40) + ')' : '') + '.', label);
      if ((rs.kind === 'img' || rs.kind === 'video' || rs.kind === 'canvas') && !noSource) {
        const L = baseLayer(el, rs.kind === 'video' ? 'video' : 'image', label, span);
        if (rs.kind === 'canvas') {
          L.asset = 'canvas:' + el.id;
          L.fit = 'fill';
        } else {
          L.asset = assetFor(rs.src, rs.kind === 'video' ? 'video' : 'image');
          L.fit = rs.fit === 'cover' ? 'cover' : rs.fit === 'contain' ? 'contain' : rs.fit === 'none' ? 'none' : 'fill';
        }
        // A resized picture (width/height animated) becomes scale keys on top of the
        // transform: After Effects scales footage, it has no animated "box".
        const b0 = [rs.bw || 1, rs.bh || 1];
        const boxScale = (f, r) => [r.bw > 0 ? r.bw / b0[0] : 1, r.bh > 0 ? r.bh / b0[1] : 1];
        const T = transformTracks(el, span, mats, center, boxScale);
        L.transform = T.tracks;
        L.box = { value: [round(b0[0], 3), round(b0[1], 3)] };
        if (rs.radius && Math.max.apply(null, rs.radius) > 0) L.cornerRadius = round(Math.max.apply(null, rs.radius), 2);
        if (rs.kind === 'video') {
          const mt = [];
          for (let f = 0; f < N; f++) { const r = el.frames[f]; mt[f] = r && r.mt != null ? r.mt : null; }
          L.timeRemap = track(mt, 'generic', { span, interp: 'linear', tol: 0.5 / fps });
          L.muted = !!rs.muted;
          if (/\.webm(\?|$)/i.test(rs.src || '')) note('warn', 'WebM video cannot be opened by After Effects; use H.264 MP4.', L.name);
        }
        const fx = effectsFromStyle(rs, L.name);
        if (fx.length) L.effects = fx;
        myLayers.push(L);
      }

      // --- text ---
      if (rs.text) {
        const g = textClip ? cssGradientEffect(rs.grad, rs.bw, rs.bh, label) : null;
        const L = textLayer(el, span, mats, { gradient: g });
        if (L) {
          if (g) {
            // Gradient box is in the element's local px; the builder maps it onto the text bounds.
            g.box = [0, 0, rs.bw, rs.bh];
          }
          myLayers.push(L);
        }
      }

      const mp = mattePlan(el, span, mats);
      if (mp) pendingMattes.push(mp);
    } else if (rs.kind === 'svgshape') {
      const contours = [];
      let bbox = null;
      const paths = [];
      for (let f = 0; f < N; f++) {
        const r = el.frames[f];
        if (!r || !r.geom) { paths[f] = null; continue; }
        const cs = G.geomToContours(r.geom);
        if (f === span[0]) { contours.push.apply(contours, cs); bbox = G.contoursBBox(cs); }
        paths[f] = cs.map((c) => G.contourToAE(c, null, 2));
      }
      if (!contours.length) continue;
      const anchor = [bbox[0] + bbox[2] / 2, bbox[1] + bbox[3] / 2];
      // Geometry that only moves (e.g. an animated circle cx/cy) becomes position keys, not path keys.
      const centers = [];
      let translateOnly = true;
      const norm = (ps, c) => JSON.stringify(ps.map((p) => ({ v: p.v.map((q) => [Math.round((q[0] - c[0]) * 50), Math.round((q[1] - c[1]) * 50)]), i: p.i, o: p.o })));
      const ref = paths[span[0]] ? norm(paths[span[0]], anchor) : null;
      for (let f = span[0]; f <= span[1] && translateOnly; f++) {
        if (!paths[f]) { centers[f] = null; continue; }
        const r = el.frames[f];
        const bb = G.contoursBBox(G.geomToContours(r.geom));
        centers[f] = [bb[0] + bb[2] / 2, bb[1] + bb[3] / 2];
        if (norm(paths[f], centers[f]) !== ref) translateOnly = false;
      }
      const L = baseLayer(el, 'shape', label, span);
      // Skewed SVG transforms are baked into the path instead of approximated.
      let skew = false;
      for (let f = span[0]; f <= span[1]; f++) if (mats[f] && Math.abs(G.decompose(mats[f]).skew) > 1.5) skew = true;
      if (skew) {
        for (let f = 0; f < N; f++) {
          const r = el.frames[f];
          paths[f] = r && r.geom && mats[f] ? G.geomToContours(r.geom).map((c) => G.contourToAE(c, mats[f], 2)) : null;
        }
        L.transform = { anchor: { value: [0, 0] }, position: { value: [0, 0] }, opacity: transformTracks(el, span, mats, [0, 0]).tracks.opacity };
      } else if (translateOnly) {
        for (let f = 0; f < N; f++) if (paths[f]) paths[f] = paths[span[0]];
        L.transform = transformTracks(el, span, mats, (f) => centers[f] || anchor).tracks;
        L.transform.anchor = { value: anchor.map((v) => round(v, 3)) };
      } else {
        L.transform = transformTracks(el, span, mats, anchor).tracks;
        L.transform.anchor = { value: anchor.map((v) => round(v, 3)) };
      }
      L.shape = { kind: 'path', paths: pathTrack(paths, span), fillRule: rs.fillRule === 'evenodd' ? 'evenodd' : 'nonzero', bbox: bbox.map((v) => round(v, 2)) };
      if (rs.fill) {
        if (rs.fill.color) {
          const fop = [];
          for (let f = 0; f < N; f++) { const r = el.frames[f]; fop[f] = r ? (r.fill && r.fill.color ? alpha(r.fill.color) * r.fillOp * 100 : 0) : null; }
          L.fill = { color: colorTrack(el, span, (r) => (r.fill && r.fill.color) || [0, 0, 0, 0]), opacity: track(fop, 'opacity', { span }) };
        } else if (rs.fill.grad) {
          L.fill = { color: { value: [1, 1, 1] }, opacity: { value: round(rs.fillOp * 100, 2) } };
          const fx = svgGradientEffect(rs.fill.grad, bbox, L.name);
          if (fx) L.effects = [fx];
        }
      }
      if (rs.stroke && rs.sw > 0) {
        const swv = [], sop = [];
        for (let f = 0; f < N; f++) { const r = el.frames[f]; swv[f] = r ? r.sw : null; sop[f] = r ? (r.stroke && r.stroke.color ? alpha(r.stroke.color) * r.strokeOp * 100 : (r.stroke ? r.strokeOp * 100 : 0)) : null; }
        L.stroke = {
          color: rs.stroke.color ? colorTrack(el, span, (r) => (r.stroke && r.stroke.color) || [0, 0, 0, 0]) : { value: rs.stroke.grad && rs.stroke.grad.stops[0] ? rgb(rs.stroke.grad.stops[0].color) : [1, 1, 1] },
          width: track(swv, 'size', { span }), opacity: track(sop, 'opacity', { span }),
          cap: rs.cap === 'round' ? 'round' : rs.cap === 'square' ? 'square' : 'butt',
          join: rs.join === 'round' ? 'round' : rs.join === 'bevel' ? 'bevel' : 'miter',
        };
        if (rs.stroke.grad) note('approx', 'Gradient strokes use a single colour.', L.name);
        // Draw-on (dash = path length, animated offset) → Trim Paths.
        const len = rs.pathLength || rs.len;
        if (rs.dash && len > 0 && (rs.dash.length === 1 || (rs.dash.length === 2 && Math.abs(rs.dash[0] - rs.dash[1]) < 1) || (rs.dash.length === 2 && rs.dash[1] >= len * 0.95)) && rs.dash[0] >= len * 0.95) {
          const ts = [], te = [];
          for (let f = 0; f < N; f++) {
            const r = el.frames[f];
            if (!r) { ts[f] = te[f] = null; continue; }
            const L2 = r.pathLength || r.len || len;
            const o = r.dashOff / L2;
            if (o >= 0) { ts[f] = 0; te[f] = Math.max(0, Math.min(100, (1 - o) * 100)); } else { ts[f] = Math.max(0, Math.min(100, -o * 100)); te[f] = 100; }
          }
          const tS = track(ts, 'percent', { span }), tE = track(te, 'percent', { span });
          if (tS.keys || tE.keys || tS.value !== 0 || tE.value !== 100) L.trim = { start: tS, end: tE };
        } else if (rs.dash && rs.dash.some((d) => d > 0)) {
          L.stroke.dashes = rs.dash.slice(0, 6).map((d) => round(d, 2));
          const off = [];
          for (let f = 0; f < N; f++) { const r = el.frames[f]; off[f] = r ? r.dashOff : null; }
          L.stroke.dashOffset = track(off, 'size', { span });
        }
      }
      if (!L.fill && !L.stroke) continue;
      const fx = effectsFromStyle(rs, L.name);
      if (fx.length) L.effects = (L.effects || []).concat(fx);
      myLayers.push(L);
    } else if (rs.kind === 'svgtext') {
      const L = svgTextLayer(el, span, mats);
      if (L) myLayers.push(L);
    } else if (rs.kind === 'svgimage' && rs.src) {
      const g = rs.geom;
      const L = baseLayer(el, 'image', label, span);
      L.asset = assetFor(rs.src, 'image');
      L.fit = 'fill';
      L.transform = transformTracks(el, span, mats, [g.x + g.w / 2, g.y + g.h / 2]).tracks;
      L.box = { value: [g.w, g.h] };
      myLayers.push(L);
    }

    for (const L of myLayers) {
      if (L._picture) { applyBlurTrack(L, el, L._picture.span, L._picture.baked); delete L._picture; }
      else applyBlurTrack(L, el, span, 0);
      // Shape and text content sits on the layer origin. Footage keeps After Effects'
      // default anchor (the centre of the source), which its position refers to.
      if (L.transform && !L.transform.anchor && (L.type === 'shape' || L.type === 'text')) L.transform.anchor = { value: [0, 0] };
      L._el = el;
      layersBottomUp.push(L);
    }
  }

  // ---------------------------------------------------------------- mattes
  const sceneLayers = layersBottomUp.slice();
  for (const plan of pendingMattes) {
    const clipped = sceneLayers.filter((L) => {
      if (!L._el) return false;
      const r = L._el.frames.find((x) => x);
      const selfClip = L._el === plan.el && plan.el.frames[plan.span[0]].clips.path;
      return selfClip || (r && r.clipBy === plan.el.id);
    });
    if (!clipped.length) continue;
    const M = buildMatte(plan);
    mattes.set(plan.el.id, M.id);
    for (const L of clipped) L.matte = M.id;
    sceneLayers.push(M);
  }

  // Background solid when the page has a body colour and nothing covers the frame.
  const ordered = sceneLayers.reverse();
  const hasStageLayer = ordered.some((L) => L.source === rec.stageId && L.type === 'shape');
  let bgColor = rec.bodyBg && alpha(rec.bodyBg) > 0 ? rgb(rec.bodyBg) : [0, 0, 0];
  if (!hasStageLayer && rec.bodyBg && alpha(rec.bodyBg) > 0) {
    ordered.push({ id: newId(), type: 'solid', name: uniqueName('Background'), comment: 'KeyframeX: page background', in: 0, out: rec.duration, color: bgColor });
  }

  // Strip private fields, count keys.
  let keyCount = 0;
  const countIn = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(countIn); return; }
    if (o.keys && Array.isArray(o.keys)) keyCount += o.keys.length;
    for (const k of Object.keys(o)) if (k !== 'keys') countIn(o[k]);
  };
  for (const L of ordered) { delete L._el; countIn(L); }
  if (maxPerspective > 1.5) note('approx', 'CSS 3D perspective is flattened to 2D (up to ' + Math.round(maxPerspective) + ' px off at the corners).');
  if (skippedHidden) note('info', skippedHidden + ' element(s) never visible were skipped.');
  for (const e of rec.errors || []) note('page-error', e);
  for (const u of rec.failedRequests || []) note('missing', 'Could not load ' + u);

  const scene = {
    format: FORMAT,
    version: VERSION,
    generator: 'KeyframeX',
    comp: {
      name: opts.name || rec.title || 'KeyframeX',
      width: rec.width, height: rec.height, fps, duration: round(rec.duration, 6),
      bgColor,
    },
    source: { html: rec.source, durationFrom: rec.durationFrom, stage: rec.stageHow, quality },
    assets: Array.from(assets.values()),
    fonts: Array.from(fontsUsed.values()),
    layers: ordered,
    notes,
  };
  const byType = {};
  for (const L of ordered) byType[L.type] = (byType[L.type] || 0) + 1;
  const report = { layers: ordered.length, keyframes: keyCount, byType, notes: notes.length };
  return { scene, report };
}

module.exports = { buildScene, FORMAT, VERSION, countKeys };
