'use strict';
/**
 * Keyframe fitting: turns per-frame samples into a small set of After Effects
 * keyframes with bezier temporal eases.
 *
 * Each moving span is first fitted with ONE eased segment (a CSS-style
 * cubic-bezier progress curve converted to AE speed/influence). If the fitted
 * curve misses any sample by more than the tolerance, the span is split at the
 * worst frame and both halves are fitted again. Static stretches become holds
 * between keys with equal values, so nothing drifts.
 *
 * Output track shape (consumed by the ExtendScript builder):
 *   { value: v }                                  static
 *   { keys: [{ t, v, interp, ei, eo }], spatial } animated
 *     interp: 'bezier' | 'linear' | 'hold'
 *     ei / eo: [[speed, influence%], ...] per AE ease dimension, or null (linear side)
 */

const QUALITY = {
  // tolerance multipliers per quality preset (1 = Balanced)
  light: 3,
  balanced: 1,
  exact: 0.12,
};

/** Base tolerances (Balanced) per property kind, in the property's own units. */
const BASE_TOL = {
  position: 0.35,   // px
  size: 0.35,       // px
  scale: 0.35,      // %
  rotation: 0.15,   // degrees
  opacity: 0.4,     // %
  color: 1.2 / 255, // 0..1 per channel
  generic: 0.35,
  percent: 0.3,     // trim paths etc.
};

function tolerance(kind, quality) {
  return (BASE_TOL[kind] || BASE_TOL.generic) * (QUALITY[quality] || 1);
}

const asVec = (v) => (Array.isArray(v) ? v : [v]);

function dist(a, b, spatial) {
  if (spatial) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) * (a[i] - b[i]);
    return Math.sqrt(s);
  }
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

/** Solve bx(s) = u for a cubic bezier with x control points x1, x2 (monotonic). */
function solveS(u, x1, x2) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  let s = u;
  for (let k = 0; k < 8; k++) {
    const mt = 1 - s;
    const bx = 3 * mt * mt * s * x1 + 3 * mt * s * s * x2 + s * s * s - u;
    const d = 3 * mt * mt * x1 + 6 * mt * s * (x2 - x1) + 3 * s * s * (1 - x2);
    if (Math.abs(bx) < 1e-7) return s;
    if (Math.abs(d) < 1e-6) break;
    s -= bx / d;
    if (s < 0 || s > 1) break;
  }
  // bisection fallback
  let lo = 0, hi = 1;
  s = u;
  for (let k = 0; k < 40; k++) {
    s = (lo + hi) / 2;
    const mt = 1 - s;
    const bx = 3 * mt * mt * s * x1 + 3 * mt * s * s * x2 + s * s * s;
    if (bx < u) lo = s; else hi = s;
  }
  return s;
}

function easeAt(u, c) {
  const s = solveS(u, c[0], c[2]);
  const mt = 1 - s;
  return 3 * mt * mt * s * c[1] + 3 * mt * s * s * c[3] + s * s * s;
}

/** Least-squares y1,y2 for fixed x1,x2. Returns [y1, y2, sse]. */
function fitY(us, ps, x1, x2) {
  let a11 = 0, a12 = 0, a22 = 0, r1 = 0, r2 = 0;
  const B1 = new Array(us.length), B2 = new Array(us.length), S3 = new Array(us.length);
  for (let i = 0; i < us.length; i++) {
    const s = solveS(us[i], x1, x2);
    const mt = 1 - s;
    const b1 = 3 * mt * mt * s, b2 = 3 * mt * s * s, s3 = s * s * s;
    B1[i] = b1; B2[i] = b2; S3[i] = s3;
    const r = ps[i] - s3;
    a11 += b1 * b1; a12 += b1 * b2; a22 += b2 * b2; r1 += b1 * r; r2 += b2 * r;
  }
  const det = a11 * a22 - a12 * a12;
  let y1, y2;
  if (Math.abs(det) < 1e-12) { y1 = x1; y2 = x2; } else { y1 = (r1 * a22 - r2 * a12) / det; y2 = (a11 * r2 - a12 * r1) / det; }
  let sse = 0;
  for (let i = 0; i < us.length; i++) { const e = B1[i] * y1 + B2[i] * y2 + S3[i] - ps[i]; sse += e * e; }
  return [y1, y2, sse];
}

/** Fit a cubic-bezier progress curve to (u, p) samples. Returns [x1, y1, x2, y2]. */
function fitCurve(us, ps) {
  // Subsample long spans for the search, keep endpoints.
  let su = us, sp = ps;
  if (us.length > 48) {
    su = []; sp = [];
    for (let k = 0; k < 48; k++) { const i = Math.round(k * (us.length - 1) / 47); su.push(us[i]); sp.push(ps[i]); }
  }
  let best = null;
  const tryXY = (x1, x2) => {
    x1 = Math.min(1, Math.max(0.005, x1));
    x2 = Math.min(0.995, Math.max(0, x2));
    const [y1, y2, sse] = fitY(su, sp, x1, x2);
    if (!best || sse < best[4]) best = [x1, y1, x2, y2, sse];
  };
  for (let a = 0; a <= 10; a++) for (let b = 0; b <= 10; b++) tryXY(a / 10, b / 10);
  for (let step of [0.025, 0.006]) {
    const cx1 = best[0], cx2 = best[2];
    for (let a = -4; a <= 4; a++) for (let b = -4; b <= 4; b++) tryXY(cx1 + a * step, cx2 + b * step);
  }
  return best.slice(0, 4);
}

function fillNulls(vals) {
  const out = vals.slice();
  let last = null;
  for (let i = 0; i < out.length; i++) { if (out[i] == null) out[i] = last; else last = out[i]; }
  let next = null;
  for (let i = out.length - 1; i >= 0; i--) { if (out[i] == null) out[i] = next; else next = out[i]; }
  return out;
}

/**
 * Fit one property track.
 * @param {number[]} times seconds
 * @param {Array<number|number[]>} values samples (null = unknown, filled from neighbours)
 * @param {object} o { tol, spatial, interp: 'ease'|'linear'|'hold', round }
 */
function fitTrack(times, values, o) {
  const tol = o.tol;
  const spatial = !!o.spatial;
  const interp = o.interp || 'ease';
  const round = o.round != null ? o.round : 3;
  const filled = fillNulls(values);
  if (filled[0] == null) return null;
  const scalar = !Array.isArray(filled[0]);
  const V = filled.map(asVec);
  const n = V.length;
  const dims = V[0].length;
  const R = (v) => {
    const p = Math.pow(10, round);
    const r = v.map((x) => Math.round(x * p) / p);
    return scalar ? r[0] : r;
  };

  let isStatic = true;
  for (let i = 1; i < n && isStatic; i++) if (dist(V[i], V[0], spatial) > tol) isStatic = false;
  if (isStatic) return { value: R(V[0]) };

  const keys = new Map();
  const key = (i) => {
    if (!keys.has(i)) keys.set(i, { t: +times[i].toFixed(6), v: R(V[i]), interp: interp === 'hold' ? 'hold' : 'linear', ei: null, eo: null });
    return keys.get(i);
  };

  if (interp === 'hold') {
    key(0);
    for (let i = 1; i < n; i++) if (dist(V[i], V[i - 1], spatial) > tol * 0.5) key(i);
    return finish();
  }

  // Turning points of any dimension.
  const extrema = new Array(n).fill(false);
  for (let k = 1; k < n - 1; k++) {
    for (let d = 0; d < dims; d++) {
      const d1 = V[k][d] - V[k - 1][d], d2 = V[k + 1][d] - V[k][d];
      if ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) { extrema[k] = true; break; }
    }
  }
  // Motion spans: runs of frames where the value changes.
  const still = tol * 0.02;
  key(0); key(n - 1);
  let i = 0;
  while (i < n - 1) {
    if (dist(V[i + 1], V[i], spatial) <= still) { i++; continue; }
    let j = i + 1;
    while (j < n - 1 && dist(V[j + 1], V[j], spatial) > still) j++;
    fitSpan(i, j);
    i = j;
  }
  return finish();

  function linearErr(a, b) {
    let worst = -1, err = 0;
    const T = times[b] - times[a];
    for (let k = a + 1; k < b; k++) {
      const u = (times[k] - times[a]) / T;
      const m = V[a].map((x, d) => x + (V[b][d] - x) * u);
      const e = dist(m, V[k], spatial);
      if (e > err) { err = e; worst = k; }
    }
    return { err, worst };
  }

  function fitSpan(a, b) {
    if (b - a <= 1) { key(a); key(b); return; }
    if (interp === 'linear') {
      const r = linearErr(a, b);
      if (r.err <= tol || r.worst < 0) { key(a); key(b); return; }
      fitSpan(a, r.worst); fitSpan(r.worst, b);
      return;
    }
    const T = times[b] - times[a];
    const delta = V[b].map((x, d) => x - V[a][d]);
    const L2 = delta.reduce((s, x) => s + x * x, 0);
    if (L2 < 1e-12) {
      // Goes out and comes back: split at the farthest point.
      let worst = a + 1, far = -1;
      for (let k = a + 1; k < b; k++) { const e = dist(V[k], V[a], spatial); if (e > far) { far = e; worst = k; } }
      fitSpan(a, worst); fitSpan(worst, b);
      return;
    }
    const us = [], ps = [];
    for (let k = a; k <= b; k++) {
      us.push((times[k] - times[a]) / T);
      let dot = 0;
      for (let d = 0; d < dims; d++) dot += (V[k][d] - V[a][d]) * delta[d];
      ps.push(dot / L2);
    }
    const c = fitCurve(us, ps);
    if (spatial) { c[1] = Math.max(0, c[1]); c[3] = Math.min(1, c[3]); } // AE spatial speed can't be negative
    let worst = -1, err = 0;
    for (let k = a + 1; k < b; k++) {
      const e = easeAt(us[k - a], c);
      const m = V[a].map((x, d) => x + delta[d] * e);
      const ek = dist(m, V[k], spatial);
      if (ek > err) { err = ek; worst = k; }
    }
    if (err <= tol || worst < 0) {
      const ka = key(a), kb = key(b);
      const x1 = c[0], y1 = c[1], x2 = c[2], y2 = c[3];
      const outF = y1 / x1, inF = (1 - y2) / (1 - x2);
      const inflOut = Math.min(100, Math.max(0.1, x1 * 100));
      const inflIn = Math.min(100, Math.max(0.1, (1 - x2) * 100));
      if (spatial || dims === 1) {
        const avg = (spatial ? Math.sqrt(L2) : delta[0]) / T;
        ka.eo = [[avg * outF, inflOut]];
        kb.ei = [[avg * inF, inflIn]];
      } else {
        ka.eo = delta.map((dd) => [dd / T * outF, inflOut]);
        kb.ei = delta.map((dd) => [dd / T * inF, inflIn]);
      }
      ka.interp = kb.interp = 'bezier';
      return;
    }
    const m = splitPoint(a, b, worst);
    fitSpan(a, m); fitSpan(m, b);
  }

  /** Prefer splitting at a turning point (local extremum) near the worst frame: eases fit between them. */
  function splitPoint(a, b, worst) {
    let best = -1, bestD = Infinity;
    for (let k = a + 1; k < b; k++) {
      if (!extrema[k]) continue;
      const d = Math.abs(k - worst);
      if (d < bestD) { bestD = d; best = k; }
    }
    return best > a && best < b ? best : worst;
  }

  function finish() {
    const list = Array.from(keys.entries()).sort((x, y) => x[0] - y[0]).map((e) => e[1]);
    // Drop redundant keys: same value as both neighbours with no easing involved.
    const out = [];
    for (let k = 0; k < list.length; k++) {
      const prev = out[out.length - 1], next = list[k + 1], cur = list[k];
      if (prev && next && !cur.ei && !cur.eo && JSON.stringify(prev.v) === JSON.stringify(cur.v) && JSON.stringify(next.v) === JSON.stringify(cur.v)) continue;
      out.push(cur);
    }
    // Holds before the first change / after the last change need no key.
    const same = (a, b) => JSON.stringify(a.v) === JSON.stringify(b.v);
    while (out.length > 2 && same(out[0], out[1]) && !out[0].eo) out.shift();
    while (out.length > 2 && same(out[out.length - 1], out[out.length - 2]) && !out[out.length - 1].ei) out.pop();
    for (const k of out) {
      const r2 = (e) => (e ? e.map((p) => [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 100) / 100]) : null);
      k.ei = r2(k.ei); k.eo = r2(k.eo);
      if (!k.ei) delete k.ei;
      if (!k.eo) delete k.eo;
      if (k.interp === 'linear') delete k.interp;
    }
    return { keys: out, spatial: spatial || undefined };
  }
}

/** Evaluate a fitted track at time t (used by tests to verify fits). */
function evalTrack(track, t) {
  if (!track) return null;
  if (!track.keys) return track.value;
  const ks = track.keys;
  if (t <= ks[0].t) return ks[0].v;
  if (t >= ks[ks.length - 1].t) return ks[ks.length - 1].v;
  let i = 0;
  while (i < ks.length - 1 && ks[i + 1].t < t) i++;
  const a = ks[i], b = ks[i + 1];
  const va = asVec(a.v), vb = asVec(b.v);
  const T = b.t - a.t;
  const u = (t - a.t) / T;
  if (a.interp === 'hold') return a.v;
  let e = u;
  if (a.eo || b.ei) {
    const delta = vb.map((x, d) => x - va[d]);
    const mag = track.spatial ? Math.hypot.apply(null, delta) : delta[0];
    const outE = a.eo ? a.eo[0] : [mag / T, 0.1];
    const inE = b.ei ? b.ei[0] : [mag / T, 0.1];
    const x1 = outE[1] / 100, x2 = 1 - inE[1] / 100;
    const avg = mag / T || 1;
    const y1 = (outE[0] / avg) * x1, y2 = 1 - (inE[0] / avg) * (1 - x2);
    e = easeAt(u, [x1, y1, x2, y2]);
  }
  const r = va.map((x, d) => x + (vb[d] - x) * e);
  return Array.isArray(a.v) ? r : r[0];
}

function countKeys(track) { return track && track.keys ? track.keys.length : 0; }

module.exports = { fitTrack, evalTrack, tolerance, countKeys, QUALITY, easeAt, fitCurve };
