/*
 * KeyframeX scene preview — renders a scene at a given time as SVG, following After
 * Effects conventions (layer transform = position · rotation · scale · −anchor; footage
 * anchor defaults to the source centre; point text sits on its first baseline; temporal
 * bezier eases from speed/influence; alpha track mattes). Used by tools/compare.js to
 * check conversions against the real page without After Effects.
 */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';

  // ------------------------------------------------------------ track evaluation (AE semantics)
  function bezierY(u, x1, y1, x2, y2) {
    // solve x(s) = u, return y(s)
    var lo = 0, hi = 1, s = u;
    for (var i = 0; i < 40; i++) {
      s = (lo + hi) / 2;
      var mt = 1 - s, x = 3 * mt * mt * s * x1 + 3 * mt * s * s * x2 + s * s * s;
      if (x < u) lo = s; else hi = s;
    }
    var m = 1 - s;
    return 3 * m * m * s * y1 + 3 * m * s * s * y2 + s * s * s;
  }
  function segValue(a, b, t, spatial) {
    var T = b.t - a.t, u = T > 0 ? (t - a.t) / T : 1;
    if (a.interp === 'hold') return a.v;
    var va = [].concat(a.v), vb = [].concat(b.v);
    if (!a.eo && !b.ei) return lerp(va, vb, u, a.v);
    var dims = va.length;
    function eased(d, mag) {
      var avg = mag / T || 1e-9;
      var o = a.eo ? (a.eo[d] || a.eo[0]) : [avg, 33.333];
      var n = b.ei ? (b.ei[d] || b.ei[0]) : [avg, 33.333];
      var x1 = o[1] / 100, x2 = 1 - n[1] / 100;
      var y1 = o[0] * x1 * T / (mag || 1e-9), y2 = 1 - n[0] * (1 - x2) * T / (mag || 1e-9);
      return bezierY(u, x1, y1, x2, y2);
    }
    if (spatial || dims === 1) {
      var mag = 0;
      for (var k = 0; k < dims; k++) mag += (vb[k] - va[k]) * (vb[k] - va[k]);
      mag = Math.sqrt(mag);
      if (dims === 1) mag = vb[0] - va[0];
      var e = Math.abs(mag) < 1e-9 ? u : eased(0, mag);
      return lerp(va, vb, e, a.v);
    }
    var out = [];
    for (var d = 0; d < dims; d++) {
      var m2 = vb[d] - va[d];
      out.push(Math.abs(m2) < 1e-9 ? va[d] : va[d] + m2 * eased(d, m2));
    }
    return out;
  }
  function lerp(a, b, u, shape) {
    if (!Array.isArray(shape)) return a[0] + (b[0] - a[0]) * u;
    var o = [];
    for (var i = 0; i < a.length; i++) o.push(a[i] + (b[i] - a[i]) * u);
    return o;
  }
  function at(track, t, dflt) {
    if (!track) return dflt;
    if (track.value !== undefined) return track.value;
    var ks = track.keys;
    if (!ks || !ks.length) return dflt;
    if (t <= ks[0].t) return ks[0].v;
    if (t >= ks[ks.length - 1].t) return ks[ks.length - 1].v;
    for (var i = 0; i < ks.length - 1; i++) {
      if (t <= ks[i + 1].t) {
        if (typeof ks[i].v === 'string' || (Array.isArray(ks[i].v) && ks[i].v.length && typeof ks[i].v[0] === 'object')) return ks[i].v; // text / paths: hold
        return segValue(ks[i], ks[i + 1], t, track.spatial);
      }
    }
    return ks[ks.length - 1].v;
  }

  // ------------------------------------------------------------ helpers
  function el(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function rgb(c, a) { return 'rgba(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ',' + (a == null ? 1 : a) + ')'; }
  function pathD(p) {
    if (!p || !p.v || !p.v.length) return '';
    var v = p.v, I = p.i, O = p.o, d = 'M' + v[0][0] + ' ' + v[0][1];
    var n = v.length, last = p.c ? n : n - 1;
    for (var k = 0; k < last; k++) {
      var a = v[k], b = v[(k + 1) % n];
      d += 'C' + (a[0] + O[k][0]) + ' ' + (a[1] + O[k][1]) + ' ' + (b[0] + I[(k + 1) % n][0]) + ' ' + (b[1] + I[(k + 1) % n][1]) + ' ' + b[0] + ' ' + b[1];
    }
    return d + (p.c ? 'Z' : '');
  }
  function rrect(w, h, r) {
    r = Math.max(0, Math.min(r || 0, w / 2, h / 2));
    return { x: -w / 2, y: -h / 2, w: w, h: h, r: r };
  }

  var uid = 0;
  function render(scene, t, assetsBase, sizes) {
    var c = scene.comp;
    var svg = el('svg', { xmlns: NS, width: c.width, height: c.height, viewBox: '0 0 ' + c.width + ' ' + c.height });
    var defs = el('defs', {}, svg);
    el('rect', { x: 0, y: 0, width: c.width, height: c.height, fill: rgb(c.bgColor || [0, 0, 0]) }, svg);
    var assets = {};
    (scene.assets || []).forEach(function (a) { assets[a.id] = a; });
    var byId = {};
    scene.layers.forEach(function (L) { byId[L.id] = L; });
    var groups = {};

    function draw(L, parent) {
      if (L['in'] != null && t < L['in'] - 1e-6) return null;
      if (L.out != null && t >= L.out - 1e-6) return null;
      var tr = L.transform || {};
      var g = el('g', {}, parent);
      var natural = null;
      if ((L.type === 'image' || L.type === 'video') && assets[L.asset]) natural = sizes[L.asset] || [100, 100];
      var anchor = at(tr.anchor, t, natural ? [natural[0] / 2, natural[1] / 2] : [0, 0]);
      var pos = at(tr.position, t, [c.width / 2, c.height / 2]);
      var scl = at(tr.scale, t, [100, 100]);
      var rot = at(tr.rotation, t, 0);
      var op = at(tr.opacity, t, 100);
      var k = [1, 1];
      if (natural) {
        var box = at(L.box, t, natural);
        var kx = box[0] / natural[0], ky = box[1] / natural[1];
        if (L.fit === 'cover') k = [Math.max(kx, ky), Math.max(kx, ky)];
        else if (L.fit === 'contain') k = [Math.min(kx, ky), Math.min(kx, ky)];
        else if (L.fit === 'none') k = [1, 1];
        else k = [kx, ky];
      }
      g.setAttribute('transform', 'translate(' + pos[0] + ' ' + pos[1] + ') rotate(' + rot + ') scale(' + (scl[0] / 100 * k[0]) + ' ' + (scl[1] / 100 * k[1]) + ') translate(' + (-anchor[0]) + ' ' + (-anchor[1]) + ')');
      g.setAttribute('opacity', Math.max(0, Math.min(1, op / 100)));
      if (L.blend) g.style.mixBlendMode = L.blend.toLowerCase().replace('_', '-').replace('add', 'plus-lighter');
      var fx = L.effects || [];
      var fillOverride = null, gradient = null;
      fx.forEach(function (e) { if (e.type === 'fill') fillOverride = at(e.color, t, null); if (e.type === 'gradient') gradient = e; });
      var filters = [];
      fx.forEach(function (e) {
        if (e.type === 'blur') filters.push('<feGaussianBlur stdDeviation="' + (at(e.amount, t, 0) / 2) + '"/>');
        if (e.type === 'dropShadow') {
          var dir = at(e.direction, t, 135) * Math.PI / 180, dist = at(e.distance, t, 5);
          filters.push('<feDropShadow dx="' + (Math.sin(dir) * dist) + '" dy="' + (-Math.cos(dir) * dist) + '" stdDeviation="' + (at(e.softness, t, 0) / 2) + '" flood-color="' + rgb(at(e.color, t, [0, 0, 0])) + '" flood-opacity="' + (at(e.opacity, t, 50) / 100) + '"/>');
        }
      });
      if (filters.length) {
        var fid = 'f' + (uid++);
        var f = el('filter', { id: fid, x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs);
        f.innerHTML = filters.join('');
        g.setAttribute('filter', 'url(#' + fid + ')');
      }
      var gradRef = null;
      if (gradient) {
        var gid = 'g' + (uid++);
        var ge = el(gradient.kind === 'radial' ? 'radialGradient' : 'linearGradient', gradient.kind === 'radial'
          ? { id: gid, gradientUnits: 'userSpaceOnUse', cx: gradient.start[0], cy: gradient.start[1], r: Math.hypot(gradient.end[0] - gradient.start[0], gradient.end[1] - gradient.start[1]) }
          : { id: gid, gradientUnits: 'userSpaceOnUse', x1: gradient.start[0], y1: gradient.start[1], x2: gradient.end[0], y2: gradient.end[1] }, defs);
        el('stop', { offset: 0, 'stop-color': rgb(gradient.colors[0]) }, ge);
        el('stop', { offset: 1, 'stop-color': rgb(gradient.colors[1]) }, ge);
        gradRef = 'url(#' + gid + ')';
      }

      if (L.type === 'solid') el('rect', { x: 0, y: 0, width: c.width, height: c.height, fill: rgb(L.color || [0, 0, 0]) }, g);
      if (L.type === 'shape') {
        var s = L.shape || {};
        var dParts = [];
        if (s.kind === 'rect') {
          var sz = at(s.size, t, [100, 100]), rr = rrect(sz[0], sz[1], at(s.roundness, t, 0));
          dParts.push('M' + (rr.x + rr.r) + ' ' + rr.y + 'h' + (rr.w - 2 * rr.r) + 'a' + rr.r + ' ' + rr.r + ' 0 0 1 ' + rr.r + ' ' + rr.r + 'v' + (rr.h - 2 * rr.r) + 'a' + rr.r + ' ' + rr.r + ' 0 0 1 ' + (-rr.r) + ' ' + rr.r + 'h' + (-(rr.w - 2 * rr.r)) + 'a' + rr.r + ' ' + rr.r + ' 0 0 1 ' + (-rr.r) + ' ' + (-rr.r) + 'v' + (-(rr.h - 2 * rr.r)) + 'a' + rr.r + ' ' + rr.r + ' 0 0 1 ' + rr.r + ' ' + (-rr.r) + 'Z');
        } else if (s.kind === 'ellipse') {
          var es = at(s.size, t, [100, 100]);
          dParts.push('M' + (-es[0] / 2) + ' 0a' + es[0] / 2 + ' ' + es[1] / 2 + ' 0 1 0 ' + es[0] + ' 0a' + es[0] / 2 + ' ' + es[1] / 2 + ' 0 1 0 ' + (-es[0]) + ' 0Z');
        } else {
          var ps = at(s.paths, t, []);
          (ps || []).forEach(function (p) { dParts.push(pathD(p)); });
        }
        var d = dParts.join(' ');
        if (L.fill) {
          var fc = fillOverride || at(L.fill.color, t, [1, 1, 1]);
          el('path', { d: d, fill: gradRef || rgb(fc), 'fill-opacity': at(L.fill.opacity, t, 100) / 100, 'fill-rule': s.fillRule === 'evenodd' ? 'evenodd' : 'nonzero' }, g);
        }
        if (L.stroke) {
          var sa = { d: d, fill: 'none', stroke: rgb(at(L.stroke.color, t, [1, 1, 1])), 'stroke-opacity': at(L.stroke.opacity, t, 100) / 100, 'stroke-width': at(L.stroke.width, t, 1),
            'stroke-linecap': L.stroke.cap === 'square' ? 'square' : L.stroke.cap || 'butt', 'stroke-linejoin': L.stroke.join || 'miter' };
          if (L.trim) {
            var ts = at(L.trim.start, t, 0), te = at(L.trim.end, t, 100);
            sa.pathLength = 100;
            sa['stroke-dasharray'] = Math.max(0, te - ts) + ' 1000';
            sa['stroke-dashoffset'] = -ts;
          } else if (L.stroke.dashes) sa['stroke-dasharray'] = L.stroke.dashes.join(' ');
          el('path', sa, g);
        }
      }
      if (L.type === 'text') {
        var tx = L.text;
        var str = String(at(tx.source, t, ''));
        if (tx.counter) {
          var v = at(tx.counter.value, t, 0), dec = tx.counter.decimals || 0;
          var num = (Math.round(v * Math.pow(10, dec)) / Math.pow(10, dec)).toFixed(dec);
          if (tx.counter.commas) { var pp = num.split('.'); pp[0] = pp[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); num = pp.join('.'); }
          str = (tx.counter.prefix || '') + num + (tx.counter.suffix || '');
        }
        var fc2 = fillOverride || tx.color || [1, 1, 1];
        var te2 = el('text', {
          x: 0, y: 0, 'font-family': (tx.font && (tx.font.family + ', ' + (tx.font.css || ''))) || 'sans-serif', 'font-size': tx.size,
          'font-weight': tx.font ? tx.font.weight : 400, 'font-style': tx.font && tx.font.style === 'italic' ? 'italic' : 'normal',
          'letter-spacing': (tx.tracking || 0) / 1000 * tx.size, 'text-anchor': tx.justify === 'center' ? 'middle' : tx.justify === 'right' ? 'end' : 'start',
          fill: tx.noFill ? 'none' : (gradRef || rgb(fc2)), stroke: tx.stroke ? rgb(tx.stroke.color) : null, 'stroke-width': tx.stroke ? tx.stroke.width : null,
        }, g);
        te2.setAttribute('xml:space', 'preserve');
        str.split('\r').forEach(function (line, i) { var ts2 = el('tspan', { x: 0, dy: i ? tx.leading || tx.size * 1.2 : 0 }, te2); ts2.textContent = line; });
      }
      if ((L.type === 'image' || L.type === 'video') && assets[L.asset]) {
        var a = assets[L.asset];
        var href = assetsBase + (a.rel || a.path);
        if (a.kind === 'sequence') {
          var fr = Math.min((a.frames || 1) - 1, Math.max(0, Math.round(t * (a.fps || c.fps))));
          href = href.replace(/_(\d+)\.png$/, function (m, dgt) { return '_' + String(fr).padStart(dgt.length, '0') + '.png'; });
        }
        if (L.type === 'video') {
          el('rect', { x: 0, y: 0, width: natural[0], height: natural[1], fill: '#808080' }, g);
        } else {
          var im = el('image', { href: href, x: 0, y: 0, width: natural[0], height: natural[1], preserveAspectRatio: 'none' }, g);
          var box2 = at(L.box, t, natural);
          if ((L.fit === 'cover' && (Math.abs(natural[0] * k[0] - box2[0]) > 0.5 || Math.abs(natural[1] * k[1] - box2[1]) > 0.5)) || L.cornerRadius > 0) {
            var cid = 'c' + (uid++);
            var cp = el('clipPath', { id: cid }, defs);
            var mw = box2[0] / k[0], mh = box2[1] / k[1];
            el('rect', { x: natural[0] / 2 - mw / 2, y: natural[1] / 2 - mh / 2, width: mw, height: mh, rx: (L.cornerRadius || 0) / k[0] }, cp);
            im.setAttribute('clip-path', 'url(#' + cid + ')');
          }
        }
      }
      return g;
    }

    // Bottom → top.
    var mattes = {};
    for (var i = scene.layers.length - 1; i >= 0; i--) {
      var L = scene.layers[i];
      if (L.matteSource) {
        var mid = 'm' + (uid++);
        var mk = el('mask', { id: mid, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: c.width, height: c.height, style: 'mask-type:alpha' }, defs);
        draw(L, mk);
        mattes[L.id] = mid;
      }
    }
    for (var j = scene.layers.length - 1; j >= 0; j--) {
      var L2 = scene.layers[j];
      if (L2.matteSource) continue;
      var host = svg;
      if (L2.matte && mattes[L2.matte]) host = el('g', { mask: 'url(#' + mattes[L2.matte] + ')' }, svg);
      draw(L2, host);
    }
    return svg;
  }

  /** Load footage sizes first (After Effects uses the source size for the default anchor). */
  window.__kxPreviewInit = function (scene, assetsBase) {
    var sizes = {};
    var list = (scene.assets || []).filter(function (a) { return a.kind === 'image' || a.kind === 'sequence' || a.kind === 'video'; });
    return Promise.all(list.map(function (a) {
      return new Promise(function (res) {
        if (a.kind === 'video') {
          var v = document.createElement('video');
          v.onloadedmetadata = function () { sizes[a.id] = [v.videoWidth, v.videoHeight]; res(); };
          v.onerror = function () { sizes[a.id] = [100, 100]; res(); };
          v.src = assetsBase + (a.rel || a.path);
          return;
        }
        var im = new Image();
        im.onload = function () { sizes[a.id] = [im.naturalWidth, im.naturalHeight]; res(); };
        im.onerror = function () { sizes[a.id] = [100, 100]; res(); };
        im.src = assetsBase + (a.rel || a.path);
      });
    })).then(function () {
      window.__kxPreview = function (t) {
        document.body.innerHTML = '';
        document.body.appendChild(render(scene, t, assetsBase, sizes));
        return document.fonts ? document.fonts.ready.then(function () { return true; }) : true;
      };
      return true;
    });
  };
})();
