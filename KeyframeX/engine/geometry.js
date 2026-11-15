'use strict';
/**
 * Geometry helpers: 2D affine matrices, quad → transform decomposition,
 * SVG path parsing into After Effects shape paths, CSS clip-path shapes.
 *
 * Matrix convention: [a, b, c, d, e, f] maps (x, y) → (a·x + c·y + e, b·x + d·y + f)
 * (same as DOMMatrix / SVGMatrix).
 */

const IDENTITY = [1, 0, 0, 1, 0, 0];

function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function inv(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  return [
    m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

/**
 * Least-squares affine mapping the local rect (0,0)-(w,h) onto a quad
 * [x0,y0, x1,y1, x2,y2, x3,y3] (TL, TR, BR, BL). Exact for parallelograms
 * (any 2D transform); the best 2D fit for a perspective (CSS 3D) quad.
 * Returns { m, perspective } where perspective is the residual in px.
 */
function affineFromQuad(q, w, h) {
  const p = [[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]];
  const cx = (p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4;
  const cy = (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4;
  let a, b, c, d;
  if (w > 1e-6) { a = (p[1][0] + p[2][0] - p[0][0] - p[3][0]) / (2 * w); b = (p[1][1] + p[2][1] - p[0][1] - p[3][1]) / (2 * w); } else { a = 1; b = 0; }
  if (h > 1e-6) { c = (p[2][0] + p[3][0] - p[0][0] - p[1][0]) / (2 * h); d = (p[2][1] + p[3][1] - p[0][1] - p[1][1]) / (2 * h); } else { c = 0; d = 1; }
  if (w <= 1e-6 && h > 1e-6) { a = d; b = -c; }
  if (h <= 1e-6 && w > 1e-6) { c = -b; d = a; }
  const e = cx - a * w / 2 - c * h / 2;
  const f = cy - b * w / 2 - d * h / 2;
  const m = [a, b, c, d, e, f];
  const local = [[0, 0], [w, 0], [w, h], [0, h]];
  let resid = 0;
  for (let i = 0; i < 4; i++) {
    const r = apply(m, local[i][0], local[i][1]);
    resid = Math.max(resid, Math.hypot(r[0] - p[i][0], r[1] - p[i][1]));
  }
  return { m, perspective: resid };
}

/**
 * Decompose the linear part into After Effects-style rotation, scale and skew.
 * m = T · R(rot) · Skew · S(sx, sy). Returns degrees and percent.
 */
function decompose(m) {
  const a = m[0], b = m[1], c = m[2], d = m[3];
  let sx = Math.hypot(a, b);
  const det = a * d - b * c;
  let rot = Math.atan2(b, a);
  let sy = sx > 1e-9 ? det / sx : Math.hypot(c, d);
  let skew = 0;
  const lv = Math.hypot(c, d);
  // Deviation from a right angle between the transformed x and y axes.
  if (sx > 1e-9 && lv > 1e-9) skew = Math.asin(Math.max(-1, Math.min(1, (a * c + b * d) / (sx * lv))));
  if (sx <= 1e-9) { rot = Math.atan2(-c, d); sx = 0; }
  return { rotation: rot * 180 / Math.PI, scaleX: sx * 100, scaleY: sy * 100, skew: skew * 180 / Math.PI, tx: m[4], ty: m[5] };
}

/** Unwrap a sequence of angles (degrees) so consecutive values never jump by more than 180°. */
function unwrapAngles(list) {
  const out = [];
  let prev = null;
  for (const v of list) {
    if (v == null) { out.push(null); continue; }
    if (prev == null) { out.push(v); prev = v; continue; }
    let x = v;
    while (x - prev > 180) x -= 360;
    while (x - prev < -180) x += 360;
    out.push(x);
    prev = x;
  }
  return out;
}

// ---------------------------------------------------------------------------
// SVG path data → cubic bezier contours
// ---------------------------------------------------------------------------

/**
 * Scan SVG path data following the SVG grammar: numbers may run together
 * ("1.5.5", "-1-2", "1e-5"), and the two arc flags are single characters that
 * need no separator ("a5 5 0 0110 0" = flags 0,1 then 10,0).
 * Returns [{ cmd, args: [...] }] with incomplete trailing argument groups removed.
 */
const ARGC = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
function scanPath(d) {
  const out = [];
  const s = String(d || '');
  let i = 0;
  const n = s.length;
  const skipSep = () => { while (i < n && /[\s,]/.test(s[i])) i++; };
  const readNum = () => {
    skipSep();
    const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i, i + 64));
    if (!m) return null;
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const readFlag = () => {
    skipSep();
    if (s[i] === '0' || s[i] === '1') return +s[i++];
    return null;
  };
  while (i < n) {
    skipSep();
    if (i >= n) break;
    const ch = s[i];
    if (!/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) { i++; continue; } // garbage: skip
    i++;
    const C = ch.toUpperCase();
    if (C === 'Z') { out.push({ cmd: ch, args: [] }); continue; }
    let first = true;
    for (;;) {
      const save = i;
      const args = [];
      for (let k = 0; k < ARGC[C]; k++) {
        const v = C === 'A' && (k === 3 || k === 4) ? readFlag() : readNum();
        if (v === null || !isFinite(v)) break;
        args.push(v);
      }
      if (args.length !== ARGC[C]) { i = save; break; }
      // Extra coordinate pairs after M are implicit L.
      out.push({ cmd: first ? ch : (C === 'M' ? (ch === 'm' ? 'l' : 'L') : ch), args });
      first = false;
    }
    // Skip anything up to the next command letter (an incomplete group).
    while (i < n && !/[MmLlHhVvCcSsQqTtAaZz]/.test(s[i])) i++;
  }
  return out;
}

/** Arc (endpoint parameterization) → cubic segments. Returns array of [c1x,c1y,c2x,c2y,x,y]. */
function arcToCubics(x1, y1, rx, ry, phi, fa, fs, x2, y2) {
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
  const sinp = Math.sin(phi * Math.PI / 180), cosp = Math.cos(phi * Math.PI / 180);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosp * dx + sinp * dy, y1p = -sinp * dx + cosp * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = den > 0 ? Math.sqrt(Math.max(0, num / den)) : 0;
  if (fa === fs) co = -co;
  const cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx;
  const cx = cosp * cxp - sinp * cyp + (x1 + x2) / 2;
  const cy = sinp * cxp + cosp * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  let t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI;
  if (fs && dt < 0) dt += 2 * Math.PI;
  const segs = Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9) || 1;
  const step = dt / segs;
  const out = [];
  const k = 4 / 3 * Math.tan(step / 4);
  for (let i = 0; i < segs; i++) {
    const a1 = t1 + i * step, a2 = a1 + step;
    const c1 = Math.cos(a1), s1 = Math.sin(a1), c2 = Math.cos(a2), s2 = Math.sin(a2);
    const p = (x, y) => [cosp * rx * x - sinp * ry * y + cx, sinp * rx * x + cosp * ry * y + cy];
    const q1 = p(c1 - k * s1, s1 + k * c1);
    const q2 = p(c2 + k * s2, s2 - k * c2);
    const e = p(c2, s2);
    out.push([q1[0], q1[1], q2[0], q2[1], e[0], e[1]]);
  }
  return out;
}

/**
 * Parse SVG path data into contours: [{ start:[x,y], segs:[[c1x,c1y,c2x,c2y,x,y]...], closed }].
 */
function parsePath(d) {
  const contours = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  let lastC = null, lastQ = null;
  let cur = null;
  const start = (px, py) => { cur = { start: [px, py], segs: [], closed: false }; contours.push(cur); };
  const seg = (s6) => { if (!cur) start(x, y); cur.segs.push(s6); };
  for (const { cmd, args: a } of scanPath(d)) {
    const rel = cmd !== cmd.toUpperCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (C) {
      case 'Z':
        if (cur) { cur.closed = true; x = sx; y = sy; cur = null; }
        lastC = lastQ = null;
        break;
      case 'M':
        x = sx = a[0] + ox; y = sy = a[1] + oy;
        start(x, y);
        lastC = lastQ = null;
        break;
      case 'L': case 'H': case 'V': {
        const px = C === 'V' ? x : a[0] + ox;
        const py = C === 'H' ? y : (C === 'V' ? a[0] + oy : a[1] + oy);
        seg([x, y, px, py, px, py]);
        x = px; y = py; lastC = lastQ = null;
        break;
      }
      case 'C': {
        const s6 = [a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy, a[4] + ox, a[5] + oy];
        seg(s6);
        lastC = [s6[2], s6[3]]; lastQ = null; x = s6[4]; y = s6[5];
        break;
      }
      case 'S': {
        const c1x = lastC ? 2 * x - lastC[0] : x, c1y = lastC ? 2 * y - lastC[1] : y;
        const s6 = [c1x, c1y, a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy];
        seg(s6);
        lastC = [s6[2], s6[3]]; lastQ = null; x = s6[4]; y = s6[5];
        break;
      }
      case 'Q': case 'T': {
        let qx, qy, px, py;
        if (C === 'Q') { qx = a[0] + ox; qy = a[1] + oy; px = a[2] + ox; py = a[3] + oy; }
        else { qx = lastQ ? 2 * x - lastQ[0] : x; qy = lastQ ? 2 * y - lastQ[1] : y; px = a[0] + ox; py = a[1] + oy; }
        seg([x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), px + 2 / 3 * (qx - px), py + 2 / 3 * (qy - py), px, py]);
        lastQ = [qx, qy]; lastC = null; x = px; y = py;
        break;
      }
      case 'A': {
        const px = a[5] + ox, py = a[6] + oy;
        // Per the SVG spec an arc to its own start point draws nothing.
        if (px !== x || py !== y) {
          if (!cur) start(x, y);
          for (const c of arcToCubics(x, y, a[0], a[1], a[2], !!a[3], !!a[4], px, py)) cur.segs.push(c);
        }
        lastC = lastQ = null; x = px; y = py;
        break;
      }
      default: break;
    }
  }
  // Never hand non-finite numbers to After Effects.
  return contours.filter((c) => (c.segs.length || c.closed) && c.start.every(isFinite) && c.segs.every((sg) => sg.every(isFinite)));
}

const KAPPA = 0.5522847498;

function ellipseContour(cx, cy, rx, ry) {
  const kx = rx * KAPPA, ky = ry * KAPPA;
  return {
    start: [cx, cy - ry], closed: true,
    segs: [
      [cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
      [cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
      [cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
      [cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
    ],
  };
}

function rectContour(x, y, w, h, rx, ry) {
  rx = Math.min(Math.max(0, rx || 0), w / 2); ry = Math.min(Math.max(0, ry || rx || 0), h / 2);
  if (!rx || !ry) {
    return { start: [x, y], closed: true, segs: [[x, y, x + w, y, x + w, y], [x + w, y, x + w, y + h, x + w, y + h], [x + w, y + h, x, y + h, x, y + h], [x, y + h, x, y, x, y]] };
  }
  const kx = rx * KAPPA, ky = ry * KAPPA;
  const L = (a, b) => [a, b, a, b, a, b];
  return {
    start: [x + rx, y], closed: true,
    segs: [
      [x + rx, y, x + w - rx, y, x + w - rx, y],
      [x + w - rx + kx, y, x + w, y + ry - ky, x + w, y + ry],
      [x + w, y + ry, x + w, y + h - ry, x + w, y + h - ry],
      [x + w, y + h - ry + ky, x + w - rx + kx, y + h, x + w - rx, y + h],
      [x + w - rx, y + h, x + rx, y + h, x + rx, y + h],
      [x + rx - kx, y + h, x, y + h - ry + ky, x, y + h - ry],
      [x, y + h - ry, x, y + ry, x, y + ry],
      [x, y + ry - ky, x + rx - kx, y, x + rx, y],
    ].map((s) => (s.length === 6 ? s : L(s[0], s[1]))),
  };
}

function polyContour(pts, closed) {
  if (pts.length < 2) return null;
  const c = { start: [pts[0], pts[1]], closed, segs: [] };
  for (let i = 2; i + 1 < pts.length; i += 2) {
    const px = pts[i - 2], py = pts[i - 1];
    c.segs.push([px, py, pts[i], pts[i + 1], pts[i], pts[i + 1]]);
  }
  return c;
}

/** Geometry record from the sampler → contours. */
function geomToContours(g) {
  if (!g) return [];
  if (g.kind === 'path') return parsePath(g.d);
  if (g.kind === 'rect') return [rectContour(g.x, g.y, g.w, g.h, g.rx, g.ry)];
  if (g.kind === 'ellipse') return [ellipseContour(g.cx, g.cy, g.rx, g.ry)];
  if (g.kind === 'poly') { const c = polyContour(g.pts, g.closed); return c ? [c] : []; }
  return [];
}

/**
 * Contour → After Effects Shape { v, i, o, c } with tangents relative to vertices.
 * Optional matrix bakes a transform into the vertices; optional offset recentres.
 */
function contourToAE(ct, m, round = 3) {
  const P = (x, y) => (m ? apply(m, x, y) : [x, y]);
  const r = (v) => Math.round(v * Math.pow(10, round)) / Math.pow(10, round);
  const verts = [P(ct.start[0], ct.start[1])];
  const ins = [[0, 0]];
  const outs = [];
  for (const s of ct.segs) {
    const prev = verts[verts.length - 1];
    const c1 = P(s[0], s[1]), c2 = P(s[2], s[3]), e = P(s[4], s[5]);
    outs.push([c1[0] - prev[0], c1[1] - prev[1]]);
    verts.push(e);
    ins.push([c2[0] - e[0], c2[1] - e[1]]);
  }
  outs.push([0, 0]);
  // A closed contour whose last vertex repeats the first: merge them.
  if (ct.closed && verts.length > 1) {
    const a = verts[0], b = verts[verts.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-3) {
      ins[0] = ins[ins.length - 1];
      verts.pop(); ins.pop(); outs.pop();
    }
  }
  return {
    v: verts.map((p) => [r(p[0]), r(p[1])]),
    i: ins.map((p) => [r(p[0]), r(p[1])]),
    o: outs.map((p) => [r(p[0]), r(p[1])]),
    c: !!ct.closed,
  };
}

function contoursBBox(contours) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of contours) {
    const pts = [c.start];
    for (const s of c.segs) pts.push([s[4], s[5]], [s[0], s[1]], [s[2], s[3]]);
    for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  }
  if (!isFinite(x0)) return [0, 0, 0, 0];
  return [x0, y0, x1 - x0, y1 - y0];
}

// ---------------------------------------------------------------------------
// CSS clip-path basic shapes → contour in the element's local box
// ---------------------------------------------------------------------------

function lenPx(v, ref) {
  if (v == null) return 0;
  v = String(v).trim();
  if (v.endsWith('%')) return parseFloat(v) / 100 * ref;
  if (v === 'center') return ref / 2;
  if (v === 'left' || v === 'top') return 0;
  if (v === 'right' || v === 'bottom') return ref;
  return parseFloat(v) || 0;
}

function clipPathContour(css, w, h) {
  if (!css || css === 'none') return null;
  const m = /^(inset|circle|ellipse|polygon|path)\((.*)\)/.exec(css.trim());
  if (!m) return { unsupported: css };
  const kind = m[1], body = m[2].trim();
  if (kind === 'inset') {
    const [box, round] = body.split(/\s+round\s+/);
    const v = box.trim().split(/\s+/);
    const t = lenPx(v[0], h), r = lenPx(v[1] != null ? v[1] : v[0], w), b = lenPx(v[2] != null ? v[2] : v[0], h), l = lenPx(v[3] != null ? v[3] : (v[1] != null ? v[1] : v[0]), w);
    const rad = round ? lenPx(round.trim().split(/\s+/)[0], Math.min(w, h)) : 0;
    return rectContour(l, t, Math.max(0, w - l - r), Math.max(0, h - t - b), rad, rad);
  }
  if (kind === 'circle' || kind === 'ellipse') {
    const [radPart, atPart] = body.split(/\s*at\s+/);
    const at = (atPart || 'center center').trim().split(/\s+/);
    const cx = lenPx(at[0], w), cy = lenPx(at[1] != null ? at[1] : 'center', h);
    const rv = (radPart || '').trim().split(/\s+/).filter(Boolean);
    const refR = Math.sqrt(w * w + h * h) / Math.SQRT2;
    const side = (v, ref, isX) => {
      if (!v || v === 'closest-side') return isX ? Math.min(cx, w - cx) : Math.min(cy, h - cy);
      if (v === 'farthest-side') return isX ? Math.max(cx, w - cx) : Math.max(cy, h - cy);
      return lenPx(v, ref);
    };
    if (kind === 'circle') {
      const r = !rv[0] || rv[0] === 'closest-side' ? Math.min(cx, cy, w - cx, h - cy) : rv[0] === 'farthest-side' ? Math.max(cx, cy, w - cx, h - cy) : lenPx(rv[0], refR);
      return ellipseContour(cx, cy, r, r);
    }
    return ellipseContour(cx, cy, side(rv[0], w, true), side(rv[1], h, false));
  }
  if (kind === 'polygon') {
    const parts = body.replace(/^(nonzero|evenodd)\s*,/, '').split(',');
    const pts = [];
    for (const p of parts) { const xy = p.trim().split(/\s+/); pts.push(lenPx(xy[0], w), lenPx(xy[1], h)); }
    return polyContour(pts, true);
  }
  if (kind === 'path') {
    const d = /["']([^"']+)["']/.exec(body);
    const cs = d ? parsePath(d[1]) : [];
    return cs[0] || null;
  }
  return null;
}

module.exports = {
  IDENTITY, mul, inv, apply, affineFromQuad, decompose, unwrapAngles,
  parsePath, geomToContours, contourToAE, contoursBBox, rectContour, ellipseContour, polyContour, clipPathContour, arcToCubics,
};
