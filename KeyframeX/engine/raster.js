'use strict';
/**
 * Picture fallback ("rasters") for page parts After Effects can't build natively:
 * ::before/::after, gradients with 3+ colours, mask-image, inset shadows, dashed or
 * per-side borders, outlines, SVG <use>/masks/patterns, exotic filters.
 *
 * Each such element is captured from Chrome on a transparent background (only that
 * element, or only its box / pseudo-elements). Two modes:
 *   static    – its look never changes, only its transform/opacity: ONE capture, and the
 *               motion becomes ordinary position/scale/rotation/opacity keyframes.
 *   sequence  – its look changes: one capture per frame, imported as a PNG sequence.
 */
const G = require('./geometry');

const GEOMETRIC = new Set(['quad', 'cquad', 'pquad', 'vbb', 'ctm', 'op', 'vis', 'mt', 'bbox', 'z', 'blend', 'raster', 'par', '_persp', 'len', 'dashOff']);

function signature(r, withText) {
  if (!r) return null;
  const o = {};
  for (const k of Object.keys(r)) {
    if (GEOMETRIC.has(k)) continue;
    if (k === 'text') {
      if (withText && r.text) o.text = [r.text.raw, r.text.color, r.text.size, r.text.family, r.text.weight];
      continue;
    }
    if (k === 'bw' || k === 'bh' || k === 'w' || k === 'h') { o[k] = Math.round(r[k] * 2) / 2; continue; }
    o[k] = r[k];
  }
  return JSON.stringify(o);
}

function matrixFor(rec, el, f) {
  const r = el.frames[f];
  if (!r) return null;
  if (r.quad) return G.affineFromQuad(r.quad, r.bw, r.bh).m;
  if (r.ctm) {
    const root = rec.elements.get(r.svgRoot);
    const rr = root && root.frames[f];
    if (!rr || !rr.cquad) return null;
    const rootM = G.affineFromQuad(rr.cquad, rr.w || rr.bw, rr.h || rr.bh).m;
    return G.mul(rootM, G.mul(rr.vbm || G.IDENTITY, r.ctm));
  }
  return null;
}

const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol * (i < 4 ? 0.01 : 1));

/** Inflate a viewport box for shadows / filters / pseudo-elements that paint outside it. */
function margin(r, parts) {
  let m = 3;
  if (r.shadow) m = Math.max(m, Math.abs(r.shadow.x) + Math.abs(r.shadow.y) + 2 * r.shadow.blur + Math.abs(r.shadow.spread) + 2);
  if (r.filter && r.filter.blur) m = Math.max(m, r.filter.blur * 3 + 2);
  if (r.filter && r.filter.drop) m = Math.max(m, Math.abs(r.filter.drop.x) + Math.abs(r.filter.drop.y) + 2 * r.filter.drop.blur + 2);
  if (r.outline) m = Math.max(m, 24);
  if (parts.pseudo || parts.subtree) m = Math.max(m, 0.5 * Math.max(r.vbb ? r.vbb[2] : 0, r.vbb ? r.vbb[3] : 0) + 16);
  return m;
}

function unionBox(boxes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    if (!b || !(b[2] > 0 || b[3] > 0)) continue;
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[0] + b[2]); y1 = Math.max(y1, b[1] + b[3]);
  }
  return isFinite(x0) ? [x0, y0, x1 - x0, y1 - y0] : null;
}

function clampBox(b, W, H) {
  const x0 = Math.max(0, Math.floor(b[0])), y0 = Math.max(0, Math.floor(b[1]));
  const x1 = Math.min(W, Math.ceil(b[0] + b[2])), y1 = Math.min(H, Math.ceil(b[1] + b[3]));
  return x1 - x0 >= 1 && y1 - y0 >= 1 ? [x0, y0, x1 - x0, y1 - y0] : null;
}

/**
 * Decide what to capture.
 * @returns {Array<{id, parts, why, span, mode, f0, clip, frames}>}
 */
function planRasters(rec) {
  const W = rec.viewport ? rec.viewport[0] : rec.width, H = rec.viewport ? rec.viewport[1] : rec.height;
  const N = rec.frameCount;
  // children lists (for subtree checks)
  const kids = new Map();
  for (const el of rec.elements.values()) {
    const p = el.first.par;
    if (p) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(el.id); }
  }
  const descendants = (id) => {
    const out = [];
    const stack = (kids.get(id) || []).slice();
    while (stack.length) { const d = stack.pop(); out.push(d); for (const k of kids.get(d) || []) stack.push(k); }
    return out;
  };
  const jobs = [];
  for (const el of rec.elements.values()) {
    // Union of raster needs over all frames.
    let parts = null, why = new Set();
    for (const r of el.frames) {
      if (!r || !r.raster) continue;
      parts = parts || {};
      if (r.raster.subtree) parts.subtree = true;
      if (r.raster.box) parts.box = true;
      if (r.raster.pseudo) parts.pseudo = true;
      for (const w of r.raster.why || []) why.add(w);
    }
    if (!parts) continue;
    if (parts.subtree) { delete parts.box; delete parts.pseudo; }
    let a = -1, b = -1;
    for (let f = 0; f < N; f++) { const r = el.frames[f]; if (r && r.vis && r.op > 0.0005) { if (a < 0) a = f; b = f; } }
    if (a < 0) continue;
    const desc = parts.subtree ? descendants(el.id).map((id) => rec.elements.get(id)).filter(Boolean) : [];

    // Is the look constant (only transform / opacity change)?
    let isStatic = true;
    const sig0 = signature(el.frames[a], parts.subtree);
    const M0 = matrixFor(rec, el, a);
    if (!M0) isStatic = false;
    const relRef = new Map();
    for (let f = a; f <= b && isStatic; f++) {
      const r = el.frames[f];
      if (!r) continue;
      if (signature(r, parts.subtree) !== sig0) { isStatic = false; break; }
      if (!matrixFor(rec, el, f)) { isStatic = false; break; }
      for (const d of desc) {
        const rd = d.frames[f];
        const Mf = matrixFor(rec, el, f);
        const Md = rd && rd.vis ? matrixFor(rec, d, f) : null;
        const key = d.id;
        const relInv = Mf ? G.inv(Mf) : null;
        const rel = Md && relInv ? G.mul(relInv, Md) : null;
        const s = rd ? signature(rd, true) + '|' + (rd.vis ? Math.round(rd.op / Math.max(r.op, 1e-6) * 100) : 'h') : 'none';
        const cur = { rel, s };
        if (!relRef.has(key)) { relRef.set(key, cur); continue; }
        const ref = relRef.get(key);
        if (ref.s !== cur.s || (!!ref.rel !== !!cur.rel) || (ref.rel && cur.rel && !near(ref.rel, cur.rel, 0.5))) { isStatic = false; break; }
      }
    }

    const boxAt = (f) => {
      const r = el.frames[f];
      if (!r || !r.vbb) return null;
      const boxes = [r.vbb].concat(desc.map((d) => d.frames[f] && d.frames[f].vis ? d.frames[f].vbb : null));
      const u = unionBox(boxes);
      if (!u) return null;
      const m = margin(r, parts);
      return [u[0] - m, u[1] - m, u[2] + 2 * m, u[3] + 2 * m];
    };

    if (isStatic) {
      // Best single frame: most opaque and largest, fully on screen if possible.
      let best = -1, bestScore = -1;
      for (let f = a; f <= b; f++) {
        const r = el.frames[f], bx = boxAt(f);
        if (!r || !bx) continue;
        const inside = bx[0] >= 0 && bx[1] >= 0 && bx[0] + bx[2] <= W && bx[1] + bx[3] <= H;
        // Prefer an upright, unskewed state so the picture is sharp and easy to edit.
        const Mf = matrixFor(rec, el, f);
        const dec = Mf ? G.decompose(Mf) : { rotation: 0, skew: 0 };
        const tilt = Math.abs((((dec.rotation % 360) + 540) % 360) - 180) + Math.abs(dec.skew); // degrees away from upright
        const score = r.op * bx[2] * bx[3] * (inside ? 1e3 : 1) / (1 + tilt);
        if (score > bestScore) { bestScore = score; best = f; }
      }
      const clip = best >= 0 ? clampBox(boxAt(best), W, H) : null;
      if (clip) { jobs.push({ id: el.id, parts, why: Array.from(why), span: [a, b], mode: 'static', f0: best, clip, frames: [best] }); continue; }
    }
    const boxes = [];
    for (let f = a; f <= b; f++) boxes.push(boxAt(f));
    const u = unionBox(boxes);
    const clip = u ? clampBox(u, W, H) : null;
    if (!clip) continue;
    const frames = [];
    for (let f = a; f <= b; f++) frames.push(f);
    jobs.push({ id: el.id, parts, why: Array.from(why), span: [a, b], mode: 'sequence', clip, frames });
  }
  return jobs;
}

/** Elements whose layers are replaced by an ancestor's subtree picture. */
function coveredBySubtree(rec, jobs) {
  const subtreeIds = new Set(jobs.filter((j) => j.parts.subtree).map((j) => j.id));
  const covered = new Set();
  for (const el of rec.elements.values()) {
    let p = el.first.par;
    let guard = 0;
    while (p && guard++ < 200) {
      if (subtreeIds.has(p)) { covered.add(el.id); break; }
      const pe = rec.elements.get(p);
      p = pe ? pe.first.par : null;
    }
  }
  return covered;
}

module.exports = { planRasters, coveredBySubtree, matrixFor };
