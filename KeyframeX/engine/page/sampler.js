/*
 * KeyframeX DOM sampler — injected after the page loads.
 *
 * `__kxSample(opts)` returns one frame: every rendered element that paints
 * something, with the style values the converter needs. Geometry of HTML
 * boxes (their transformed quads) is fetched separately over CDP, so here we
 * only report sizes in the element's own, untransformed coordinate space.
 *
 * Element ids are stable across frames (data-kx-id attribute).
 */
(function () {
  'use strict';
  if (window.__kxSample) return;

  var SKIP = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, HEAD: 1, TITLE: 1, TEMPLATE: 1, NOSCRIPT: 1, BR: 1, WBR: 1, SOURCE: 1, TRACK: 1, PARAM: 1, IFRAME: 1 };
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var SVG_SHAPES = { path: 1, rect: 1, circle: 1, ellipse: 1, line: 1, polyline: 1, polygon: 1 };
  var SVG_SKIP_TREE = { defs: 1, clipPath: 1, mask: 1, symbol: 1, marker: 1, pattern: 1, linearGradient: 1, radialGradient: 1, filter: 1, style: 1, script: 1, title: 1, desc: 1, metadata: 1, foreignObject: 1 };

  var nextId = 1;
  var meta = new WeakMap(); // el -> { id, textKey, words }
  var canvasCtx = document.createElement('canvas').getContext('2d');

  function idOf(el) {
    var m = meta.get(el);
    if (!m) {
      m = { id: nextId++ };
      meta.set(el, m);
      try { el.setAttribute('data-kx-id', String(m.id)); } catch (e) { /* ignore */ }
    }
    return m;
  }

  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  function parseColor(str) {
    if (!str || str === 'transparent' || str === 'none') return null;
    var m = /rgba?\(([^)]+)\)/.exec(str);
    if (!m) {
      if (str.charAt(0) === '#') {
        var h = str.slice(1);
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
      }
      // Normalize named / other colors through the canvas parser.
      canvasCtx.fillStyle = '#000';
      canvasCtx.fillStyle = str;
      var n = canvasCtx.fillStyle;
      if (n === str) return null;
      return parseColor(n);
    }
    var p = m[1].split(/[\s,\/]+/).filter(Boolean).map(function (x, i) {
      return x.indexOf('%') >= 0 ? (i < 3 ? num(x) * 2.55 : num(x) / 100) : num(x);
    });
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }

  /** Split a CSS list on top-level commas. */
  function splitTop(s) {
    var out = [], depth = 0, cur = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function parseShadow(str) {
    if (!str || str === 'none') return null;
    var first = splitTop(str)[0];
    var color = null;
    var rest = first.replace(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b/i, function (m) { color = parseColor(m); return ''; });
    var inset = /\binset\b/.test(rest);
    var nums = rest.replace('inset', '').trim().split(/\s+/).filter(Boolean).map(num);
    return { x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, spread: nums[3] || 0, color: color || [0, 0, 0, 1], inset: inset, count: splitTop(str).length };
  }

  function parseFilter(str) {
    if (!str || str === 'none') return null;
    var f = {};
    var m = /blur\(([^)]+)\)/.exec(str);
    if (m) f.blur = num(m[1]);
    m = /drop-shadow\((.*)\)/.exec(str);
    if (m) {
      var color = null;
      var rest = m[1].replace(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b/i, function (c) { color = parseColor(c); return ''; });
      var n = rest.trim().split(/\s+/).filter(Boolean).map(num);
      f.drop = { x: n[0] || 0, y: n[1] || 0, blur: n[2] || 0, color: color || [0, 0, 0, 1] };
    }
    if (/brightness|contrast|saturate|grayscale|sepia|hue-rotate|invert/.test(str)) f.other = str;
    return f;
  }

  /** Parse a 2-stop linear/radial gradient; anything else is reported as complex. */
  function parseGradient(str) {
    if (!str || str === 'none') return null;
    var layers = splitTop(str);
    var g = layers[layers.length - 1];
    var m = /^(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/.exec(g);
    if (!m) {
      var u = /url\(["']?([^"')]+)["']?\)/.exec(str);
      return u ? { kind: 'image', url: u[1] } : { kind: 'complex', css: str };
    }
    if (m[1] || m[2] === 'conic' || layers.length > 1) return { kind: 'complex', css: str };
    var parts = splitTop(m[3]);
    var angle = 180, shape = 'circle';
    if (m[2] === 'linear') {
      var p0 = parts[0];
      if (/deg|turn|rad|grad/.test(p0)) {
        angle = /turn/.test(p0) ? num(p0) * 360 : /rad/.test(p0) ? num(p0) * 180 / Math.PI : num(p0);
        parts.shift();
      } else if (/^to /.test(p0)) {
        var dirs = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270, 'to top right': 45, 'to right top': 45, 'to bottom right': 135, 'to right bottom': 135, 'to bottom left': 225, 'to left bottom': 225, 'to top left': 315, 'to left top': 315 };
        angle = dirs[p0] != null ? dirs[p0] : 180;
        parts.shift();
      }
    } else if (!/^(rgba?|#|[a-z]+\s*$)/i.test(parts[0]) || /circle|ellipse|at /.test(parts[0])) {
      shape = /ellipse/.test(parts[0]) ? 'ellipse' : 'circle';
      parts.shift();
    }
    var stops = parts.map(function (p) {
      var color = null;
      var rest = p.replace(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|\b[a-z]+\b/i, function (c) { color = parseColor(c); return ''; });
      var pos = /(-?[\d.]+)%/.exec(rest);
      return { color: color, pos: pos ? num(pos[1]) / 100 : null };
    }).filter(function (s) { return s.color; });
    if (stops.length !== 2) return { kind: 'complex', css: str, stops: stops.length };
    return { kind: m[2], angle: angle, shape: shape, stops: [stops[0].color, stops[1].color], pos: [stops[0].pos == null ? 0 : stops[0].pos, stops[1].pos == null ? 1 : stops[1].pos] };
  }

  function radiusPx(v, w, h, axis) {
    if (!v) return 0;
    var first = v.split(' ')[0];
    if (first.indexOf('%') >= 0) return num(first) / 100 * (axis === 'x' ? w : h);
    return num(first);
  }

  function opacityChain(el) {
    var o = 1;
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var cs = getComputedStyle(n);
      o *= num(cs.opacity === '' ? 1 : cs.opacity);
      if (o <= 0) return 0;
    }
    return o;
  }

  function clipAncestor(el) {
    for (var n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      var cs = getComputedStyle(n);
      if (n.namespaceURI === SVG_NS) continue;
      if ((cs.overflow !== 'visible' && cs.overflow !== '') || (cs.clipPath && cs.clipPath !== 'none')) return n;
    }
    return null;
  }

  function hasDirectText(el) {
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3 && /\S/.test(c.data)) return true;
    }
    return false;
  }

  function fontString(cs) {
    return (cs.fontStyle || 'normal') + ' ' + (cs.fontWeight || '400') + ' ' + cs.fontSize + ' ' + cs.fontFamily;
  }

  function applyTransform(t, mode) {
    if (mode === 'uppercase') return t.toUpperCase();
    if (mode === 'lowercase') return t.toLowerCase();
    if (mode === 'capitalize') return t.replace(/(^|\s)(\S)/g, function (m, a, b) { return a + b.toUpperCase(); });
    return t;
  }

  /** Words of the element's own text nodes with their rendered (viewport) centers. */
  function measureWords(el, cs) {
    var pre = /^pre/.test(cs.whiteSpace);
    var words = [];
    var range = document.createRange();
    canvasCtx.font = fontString(cs);
    var ls = cs.letterSpacing === 'normal' ? 0 : num(cs.letterSpacing);
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 3) continue;
      var data = c.data;
      var re = pre ? /[^\n]+|\n/g : /\S+/g;
      var m;
      while ((m = re.exec(data))) {
        if (m[0] === '\n') { words.push({ nl: true }); continue; }
        range.setStart(c, m.index);
        range.setEnd(c, m.index + m[0].length);
        var rects = range.getClientRects();
        if (!rects.length) continue;
        // A word that wraps (at a hyphen like "Healthcare-focused", or a long word broken
        // with overflow-wrap) spans several lines: split it where the line changes, so every
        // line of the After Effects text matches the page.
        var pieces = [[m.index, m.index + m[0].length]];
        if (rects.length > 1 && Math.abs(rects[rects.length - 1].top - rects[0].top) > num(cs.fontSize) * 0.3) {
          pieces = [];
          var start = m.index, lastTop = null;
          for (var k = m.index; k < m.index + m[0].length; k++) {
            range.setStart(c, k); range.setEnd(c, k + 1);
            var cr = range.getClientRects();
            if (!cr.length) continue;
            if (lastTop !== null && Math.abs(cr[0].top - lastTop) > num(cs.fontSize) * 0.3) { pieces.push([start, k]); start = k; }
            lastTop = cr[0].top;
          }
          pieces.push([start, m.index + m[0].length]);
        }
        for (var q = 0; q < pieces.length; q++) {
          range.setStart(c, pieces[q][0]); range.setEnd(c, pieces[q][1]);
          var pr = range.getClientRects();
          if (!pr.length) continue;
          var r = pr[0];
          var txt = applyTransform(data.slice(pieces[q][0], pieces[q][1]), cs.textTransform);
          words.push({ t: txt, cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: canvasCtx.measureText(txt).width + ls * txt.length });
        }
      }
    }
    return words;
  }

  function fontMetrics(cs) {
    canvasCtx.font = fontString(cs);
    var m = canvasCtx.measureText('Hg');
    var size = num(cs.fontSize);
    var asc = m.fontBoundingBoxAscent != null ? m.fontBoundingBoxAscent : size * 0.8;
    var desc = m.fontBoundingBoxDescent != null ? m.fontBoundingBoxDescent : size * 0.2;
    return { asc: asc, desc: desc };
  }

  function textInfo(el, cs, m) {
    var key = '';
    for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) key += c.data;
    var fs = num(cs.fontSize);
    var info = {
      raw: key,
      size: fs,
      family: cs.fontFamily,
      weight: num(cs.fontWeight) || 400,
      style: cs.fontStyle,
      color: parseColor(cs.color),
      ls: cs.letterSpacing === 'normal' ? 0 : num(cs.letterSpacing),
      lh: cs.lineHeight === 'normal' ? null : num(cs.lineHeight),
      align: cs.textAlign,
      dir: cs.direction,
      strokeW: num(cs.webkitTextStrokeWidth),
      strokeC: parseColor(cs.webkitTextStrokeColor),
      fillC: cs.webkitTextFillColor,
      shadow: parseShadow(cs.textShadow),
      clipText: (cs.webkitBackgroundClip || cs.backgroundClip) === 'text',
    };
    // Word layout is expensive: measure it only when the text or font changes.
    var layoutKey = key + '|' + fontString(cs) + '|' + cs.letterSpacing + '|' + cs.textTransform;
    if (m.textKey !== layoutKey || !m.words) {
      // Scaled to nothing (e.g. a "pop in" from scale 0): word positions can't be mapped
      // back yet. Don't cache; measure again on the first frame where it has a size.
      var br = el.getBoundingClientRect();
      if (br.width < 0.5 || br.height < 0.5) {
        m.words = null;
        info.words = [];
        info.metrics = fontMetrics(cs);
        info.layoutAt = window.__kx ? window.__kx.now : 0;
        return info;
      }
      m.textKey = layoutKey;
      m.words = measureWords(el, cs);
      m.metrics = fontMetrics(cs);
      m.layoutAt = window.__kx ? window.__kx.now : 0;
      info.relayout = true;
    }
    info.words = m.words;
    info.metrics = m.metrics;
    info.layoutAt = m.layoutAt;
    return info;
  }

  function svgPaint(cs, prop) {
    var v = cs[prop];
    if (!v || v === 'none') return null;
    var u = /url\(["']?#([^"')]+)["']?\)/.exec(v);
    if (u) return { ref: u[1] };
    return { color: parseColor(v) };
  }

  function svgGradient(id) {
    var g = document.getElementById(id);
    if (!g) return null;
    // Follow xlink:href chains for stops.
    var stopsEl = g, guard = 0;
    while (stopsEl && !stopsEl.querySelector('stop') && guard++ < 5) {
      var href = stopsEl.getAttribute('href') || stopsEl.getAttribute('xlink:href');
      stopsEl = href ? document.getElementById(href.replace('#', '')) : null;
    }
    var stops = stopsEl ? Array.prototype.slice.call(stopsEl.querySelectorAll('stop')) : [];
    var out = {
      kind: g.tagName === 'radialGradient' ? 'radial' : 'linear',
      units: g.getAttribute('gradientUnits') || 'objectBoundingBox',
      stops: stops.map(function (s) {
        var cs = getComputedStyle(s);
        var c = parseColor(cs.stopColor) || [0, 0, 0, 1];
        c[3] = (c[3] == null ? 1 : c[3]) * num(cs.stopOpacity === '' ? 1 : cs.stopOpacity);
        var off = s.getAttribute('offset') || '0';
        return { color: c, pos: off.indexOf('%') >= 0 ? num(off) / 100 : num(off) };
      }),
    };
    function a(n, d) { var v = g.getAttribute(n); if (v == null) return d; return v.indexOf('%') >= 0 ? num(v) / 100 : num(v); }
    if (out.kind === 'linear') { out.x1 = a('x1', 0); out.y1 = a('y1', 0); out.x2 = a('x2', 1); out.y2 = a('y2', 0); }
    else { out.cx = a('cx', 0.5); out.cy = a('cy', 0.5); out.r = a('r', 0.5); }
    return out;
  }

  function svgFilter(cs) {
    var f = cs.filter;
    if (!f || f === 'none') return null;
    var u = /url\(["']?#([^"')]+)["']?\)/.exec(f);
    if (!u) return parseFilter(f);
    var el = document.getElementById(u[1]);
    if (!el) return null;
    var out = {};
    var blur = el.querySelector('feGaussianBlur');
    var drop = el.querySelector('feDropShadow');
    if (drop) {
      out.drop = { x: num(drop.getAttribute('dx')), y: num(drop.getAttribute('dy')), blur: num(drop.getAttribute('stdDeviation')), color: parseColor(drop.getAttribute('flood-color') || 'black') || [0, 0, 0, 1] };
      var fo = drop.getAttribute('flood-opacity');
      if (fo != null) out.drop.color[3] = num(fo);
    } else if (blur) {
      out.blur = num((blur.getAttribute('stdDeviation') || '0').split(/[\s,]+/)[0]);
      var merge = el.querySelector('feMerge');
      if (merge) { out.glow = true; }
    }
    var exotic = el.querySelector('feTurbulence,feDisplacementMap,feColorMatrix,feConvolveMatrix,feMorphology,feComponentTransfer,feLighting,feSpecularLighting,feDiffuseLighting');
    if (exotic) out.other = exotic.tagName;
    return out;
  }

  function matrixOf(m) { return m ? [m.a, m.b, m.c, m.d, m.e, m.f] : null; }

  function svgGeometry(el) {
    var tag = el.tagName;
    function v(n) { var a = el[n]; return a && a.animVal ? a.animVal.value : num(el.getAttribute(n)); }
    if (tag === 'path') return { kind: 'path', d: el.getAttribute('d') || '' };
    if (tag === 'rect') return { kind: 'rect', x: v('x'), y: v('y'), w: v('width'), h: v('height'), rx: el.hasAttribute('rx') ? v('rx') : (el.hasAttribute('ry') ? v('ry') : 0), ry: el.hasAttribute('ry') ? v('ry') : (el.hasAttribute('rx') ? v('rx') : 0) };
    if (tag === 'circle') return { kind: 'ellipse', cx: v('cx'), cy: v('cy'), rx: v('r'), ry: v('r') };
    if (tag === 'ellipse') return { kind: 'ellipse', cx: v('cx'), cy: v('cy'), rx: v('rx'), ry: v('ry') };
    if (tag === 'line') return { kind: 'poly', closed: false, pts: [v('x1'), v('y1'), v('x2'), v('y2')] };
    var pts = [];
    var list = el.points;
    if (list) for (var i = 0; i < list.numberOfItems; i++) { var p = list.getItem(i); pts.push(p.x, p.y); }
    return { kind: 'poly', closed: tag === 'polygon', pts: pts };
  }

  /** viewBox + preserveAspectRatio → matrix from the svg's user space to its viewport px. */
  function viewBoxMatrix(svg, vw, vh) {
    var vb = svg.viewBox && svg.viewBox.baseVal;
    if (!vb || !vb.width || !vb.height) return [1, 0, 0, 1, 0, 0];
    var par = svg.getAttribute('preserveAspectRatio') || 'xMidYMid meet';
    var sx = vw / vb.width, sy = vh / vb.height;
    if (!/^none/.test(par)) {
      var k = /slice/.test(par) ? Math.max(sx, sy) : Math.min(sx, sy);
      sx = sy = k;
    }
    var tx = -vb.x * sx, ty = -vb.y * sy;
    var align = (par.split(/\s+/)[0] || 'xMidYMid');
    if (align !== 'none') {
      var ax = /xMid/.test(align) ? 0.5 : /xMax/.test(align) ? 1 : 0;
      var ay = /YMid/.test(align) ? 0.5 : /YMax/.test(align) ? 1 : 0;
      tx += (vw - vb.width * sx) * ax;
      ty += (vh - vb.height * sy) * ay;
    }
    return [sx, 0, 0, sy, tx, ty];
  }

  function outerSvg(el) {
    var s = el.ownerSVGElement;
    while (s && s.ownerSVGElement) s = s.ownerSVGElement;
    return s;
  }

  function sampleSvg(el, cs, rec) {
    var tag = el.tagName;
    var root = outerSvg(el);
    rec.svgRoot = root ? idOf(root).id : 0;
    // CTM relative to the outermost <svg> viewport (includes viewBox + nested svg transforms).
    var m = null;
    try {
      var sm = el.getScreenCTM();
      var rm = root.getScreenCTM();
      if (sm && rm) m = rm.inverse().multiply(sm);
    } catch (e) { /* ignore */ }
    if (!m) { try { m = el.getCTM(); } catch (e) { m = null; } }
    rec.ctm = matrixOf(m);
    try { var bb = el.getBBox(); rec.bbox = [bb.x, bb.y, bb.width, bb.height]; } catch (e) { rec.bbox = [0, 0, 0, 0]; }
    if (tag === 'text') {
      rec.kind = 'svgtext';
      var x = el.x && el.x.animVal.numberOfItems ? el.x.animVal.getItem(0).value : 0;
      var y = el.y && el.y.animVal.numberOfItems ? el.y.animVal.getItem(0).value : 0;
      rec.text = {
        raw: el.textContent,
        x: x, y: y,
        anchor: cs.textAnchor,
        size: num(cs.fontSize), family: cs.fontFamily, weight: num(cs.fontWeight) || 400, style: cs.fontStyle,
        ls: cs.letterSpacing === 'normal' ? 0 : num(cs.letterSpacing),
      };
      rec.fill = svgPaint(cs, 'fill');
      rec.stroke = svgPaint(cs, 'stroke');
    } else if (tag === 'image') {
      rec.kind = 'svgimage';
      rec.src = el.href && el.href.animVal ? new URL(el.href.animVal, document.baseURI).href : '';
      rec.geom = { kind: 'rect', x: num(el.getAttribute('x')), y: num(el.getAttribute('y')), w: num(el.getAttribute('width')), h: num(el.getAttribute('height')) };
    } else {
      rec.kind = 'svgshape';
      rec.geom = svgGeometry(el);
      rec.fill = svgPaint(cs, 'fill');
      rec.stroke = svgPaint(cs, 'stroke');
      try { rec.len = el.getTotalLength ? el.getTotalLength() : 0; } catch (e) { rec.len = 0; }
      if (el.hasAttribute('pathLength')) rec.pathLength = num(el.getAttribute('pathLength'));
      rec.fillRule = cs.fillRule;
    }
    rec.fillOp = num(cs.fillOpacity === '' ? 1 : cs.fillOpacity);
    rec.strokeOp = num(cs.strokeOpacity === '' ? 1 : cs.strokeOpacity);
    rec.sw = num(cs.strokeWidth);
    rec.cap = cs.strokeLinecap;
    rec.join = cs.strokeLinejoin;
    rec.dash = cs.strokeDasharray && cs.strokeDasharray !== 'none' ? cs.strokeDasharray.split(/[\s,]+/).map(num) : null;
    rec.dashOff = num(cs.strokeDashoffset);
    if (rec.fill && rec.fill.ref) rec.fill.grad = svgGradient(rec.fill.ref);
    if (rec.stroke && rec.stroke.ref) rec.stroke.grad = svgGradient(rec.stroke.ref);
    rec.filter = svgFilter(cs);
    if (el.hasAttribute('clip-path') || el.hasAttribute('mask') || (cs.clipPath && cs.clipPath !== 'none') || (cs.mask && cs.mask !== 'none')) rec.svgMask = true;
    // Things with no After Effects equivalent come in as a picture of the element.
    var why = [];
    if (rec.svgMask) why.push('SVG clip-path / mask');
    if (rec.filter && rec.filter.other) why.push('SVG filter ' + rec.filter.other);
    if (rec.fill && rec.fill.ref && !rec.fill.grad) why.push('SVG pattern fill');
    if (rec.fill && rec.fill.grad && rec.fill.grad.stops.length > 2) why.push('gradient with ' + rec.fill.grad.stops.length + ' colours');
    if (rec.stroke && rec.stroke.ref && !rec.stroke.grad) why.push('SVG pattern stroke');
    if (why.length) rec.raster = { subtree: true, why: why };
  }

  function isRendered(el, cs) {
    if (cs.display === 'none') return false;
    if (el.namespaceURI !== SVG_NS && !el.getClientRects().length && el.tagName !== 'svg') return false;
    return true;
  }

  var outEls = [];
  function visit(el, out, svgDepth) {
    var tag = el.tagName;
    if (SKIP[tag.toUpperCase()] && el.namespaceURI !== SVG_NS) return;
    var isSvg = el.namespaceURI === SVG_NS;
    if (isSvg && SVG_SKIP_TREE[tag]) return;
    var cs = getComputedStyle(el);
    if (tag === 'AUDIO') {
      // <audio> renders nothing (display:none without controls) but becomes an audio layer.
      var am = idOf(el);
      outEls[out.length] = el;
      out.push({ id: am.id, tag: 'audio', kind: 'audio', vis: true, op: 1,
        src: el.currentSrc || el.src || (el.querySelector('source') ? el.querySelector('source').src : ''),
        start: el.hasAttribute('data-start') ? num(el.getAttribute('data-start')) : (el.__kxPlayAt != null ? el.__kxPlayAt / 1000 : null) });
      return;
    }
    if (cs.display === 'none') return;
    var m = idOf(el);
    var rec = { id: m.id, tag: tag.toLowerCase() };
    if (el.parentElement && el.parentElement !== document.body && el.parentElement !== document.documentElement) rec.par = idOf(el.parentElement).id;
    var vb = el.getBoundingClientRect();
    rec.vbb = [vb.left, vb.top, vb.width, vb.height];
    rec.vis = cs.visibility !== 'hidden' && cs.visibility !== 'collapse' && isRendered(el, cs);
    rec.op = rec.vis ? opacityChain(el) : 0;
    rec.blend = cs.mixBlendMode !== 'normal' ? cs.mixBlendMode : null;
    if (el.id) rec.htmlId = el.id;
    if (typeof el.className === 'string' && el.className) rec.cls = el.className.trim().split(/\s+/).filter(function (c) { return c.indexOf('kx-') !== 0; }).slice(0, 3).join(' ');

    if (isSvg && tag !== 'svg') {
      if (SVG_SHAPES[tag] || tag === 'text' || tag === 'image') {
        sampleSvg(el, cs, rec);
        out.push(rec); outEls[out.length - 1] = el;
        if (tag === 'text') return; // tspans are part of the text
      } else if (tag === 'use') {
        rec.kind = 'raster'; rec.reason = 'SVG <use>';
        rec.raster = { subtree: true, why: ['SVG <use>'] };
        rec.fill = svgPaint(cs, 'fill');
        try { var ubb = el.getBBox(); rec.bbox = [ubb.x, ubb.y, ubb.width, ubb.height]; } catch (e) { rec.bbox = [0, 0, 0, 0]; }
        var uroot = outerSvg(el); rec.svgRoot = uroot ? idOf(uroot).id : 0;
        try { rec.ctm = matrixOf(uroot.getScreenCTM().inverse().multiply(el.getScreenCTM())); } catch (e) { rec.ctm = null; }
        out.push(rec); outEls[out.length - 1] = el;
        return;
      }
      for (var s = el.firstElementChild; s; s = s.nextElementSibling) visit(s, out, svgDepth + 1);
      return;
    }

    // ----- HTML element (or outer <svg>) -----
    rec.w = el.offsetWidth != null ? el.offsetWidth : (el.clientWidth || 0);
    rec.h = el.offsetHeight != null ? el.offsetHeight : (el.clientHeight || 0);
    // offsetWidth is rounded; the computed width keeps sub-pixel precision.
    var cw = parseFloat(cs.width), chh = parseFloat(cs.height);
    if (isFinite(cw) && isFinite(chh) && cs.display !== 'inline') {
      if (cs.boxSizing !== 'border-box') {
        cw += num(cs.paddingLeft) + num(cs.paddingRight) + num(cs.borderLeftWidth) + num(cs.borderRightWidth);
        chh += num(cs.paddingTop) + num(cs.paddingBottom) + num(cs.borderTopWidth) + num(cs.borderBottomWidth);
      }
      if (Math.abs(cw - rec.w) <= 1.01 && Math.abs(chh - rec.h) <= 1.01) { rec.w = cw; rec.h = chh; }
    }
    if (tag === 'svg' || tag === 'SVG') {
      rec.kind = 'svgroot';
      rec.w = el.clientWidth; rec.h = el.clientHeight;
      rec.vbm = viewBoxMatrix(el, rec.w, rec.h);
    } else if (tag === 'IMG') {
      rec.kind = 'img';
      rec.src = el.currentSrc || el.src;
      rec.fit = cs.objectFit;
      rec.nat = [el.naturalWidth, el.naturalHeight];
    } else if (tag === 'VIDEO') {
      rec.kind = 'video';
      rec.src = el.currentSrc || el.src || (el.querySelector('source') ? el.querySelector('source').src : '');
      rec.fit = cs.objectFit;
      rec.mt = window.__kx ? window.__kx.mediaTime(el) : el.currentTime;
      rec.muted = el.muted;
      rec.nat = [el.videoWidth, el.videoHeight];
    } else if (tag === 'CANVAS') {
      rec.kind = 'canvas';
    } else {
      rec.kind = 'box';
    }

    var bw = num(cs.borderTopWidth);
    var uniformBorder = bw === num(cs.borderRightWidth) && bw === num(cs.borderBottomWidth) && bw === num(cs.borderLeftWidth) &&
      cs.borderTopColor === cs.borderRightColor && cs.borderTopColor === cs.borderBottomColor && cs.borderTopColor === cs.borderLeftColor &&
      cs.borderTopStyle === cs.borderRightStyle && cs.borderTopStyle === cs.borderBottomStyle && cs.borderTopStyle === cs.borderLeftStyle;
    rec.bg = parseColor(cs.backgroundColor);
    rec.grad = parseGradient(cs.backgroundImage);
    if (rec.grad && rec.grad.kind === 'image') { rec.bgImg = new URL(rec.grad.url, document.baseURI).href; rec.bgSize = cs.backgroundSize; rec.grad = null; }
    if (bw > 0 && cs.borderTopStyle !== 'none' && cs.borderTopStyle !== 'hidden') {
      rec.border = { w: bw, c: parseColor(cs.borderTopColor), style: cs.borderTopStyle, uniform: uniformBorder };
    } else if (!uniformBorder) {
      var anyW = num(cs.borderRightWidth) + num(cs.borderBottomWidth) + num(cs.borderLeftWidth);
      if (anyW > 0) rec.border = { w: 0, uniform: false };
    }
    if (cs.outlineStyle !== 'none' && num(cs.outlineWidth) > 0) rec.outline = true;
    rec.radius = [radiusPx(cs.borderTopLeftRadius, rec.w, rec.h, 'x'), radiusPx(cs.borderTopRightRadius, rec.w, rec.h, 'x'), radiusPx(cs.borderBottomRightRadius, rec.w, rec.h, 'x'), radiusPx(cs.borderBottomLeftRadius, rec.w, rec.h, 'x')];
    rec.shadow = parseShadow(cs.boxShadow);
    rec.filter = parseFilter(cs.filter);
    if (cs.backdropFilter && cs.backdropFilter !== 'none') rec.backdrop = true;
    if (cs.maskImage && cs.maskImage !== 'none' || cs.webkitMaskImage && cs.webkitMaskImage !== 'none') rec.maskImage = true;
    var ca = clipAncestor(el);
    if (ca) rec.clipBy = idOf(ca).id;
    if ((cs.overflow !== 'visible' && cs.overflow !== '') || (cs.clipPath && cs.clipPath !== 'none')) {
      rec.clips = { overflow: cs.overflow !== 'visible' && cs.overflow !== '', path: cs.clipPath !== 'none' ? cs.clipPath : null };
    }
    var pb = getComputedStyle(el, '::before'), pa = getComputedStyle(el, '::after');
    if ((pb.content && pb.content !== 'none' && pb.content !== 'normal') || (pa.content && pa.content !== 'none' && pa.content !== 'normal')) rec.pseudo = true;
    // Parts with no After Effects equivalent come in as pictures (CodeFlow-style).
    var rb = [], rs = [];
    if (rec.grad && rec.grad.kind === 'complex') rb.push('gradient with 3+ colours, layers or repeats');
    // After Effects' Gradient Ramp is opaque: a glow that fades to transparent would become
    // a solid disc, so it comes in as a picture (gradient text keeps its own handling).
    else if (rec.grad && rec.grad.stops && (cs.webkitBackgroundClip || cs.backgroundClip) !== 'text' &&
      (rec.grad.stops[0][3] < 0.999 || rec.grad.stops[1][3] < 0.999)) rb.push('gradient that fades to transparent');
    if (rec.border && (!rec.border.uniform || (rec.border.style && rec.border.style !== 'solid'))) rb.push(rec.border.uniform ? rec.border.style + ' border' : 'border that differs per side');
    if (rec.outline) rb.push('outline');
    if (rec.shadow && (rec.shadow.inset || rec.shadow.count > 1)) rb.push(rec.shadow.inset ? 'inset shadow' : 'several shadows');
    if (rec.maskImage) rs.push('mask-image');
    if (cs.clipPath && /url\(/.test(cs.clipPath)) rs.push('clip-path: url()');
    if (rec.filter && rec.filter.other) rs.push('filter ' + rec.filter.other);
    var pseudoWhy = rec.pseudo ? ['::before / ::after'] : [];
    if (rs.length) rec.raster = { subtree: true, why: rs.concat(rb, pseudoWhy) };
    else if (rb.length || pseudoWhy.length) rec.raster = { box: rb.length > 0, pseudo: pseudoWhy.length > 0, why: rb.concat(pseudoWhy) };
    if (rec.kind === 'box' && hasDirectText(el)) rec.text = textInfo(el, cs, m);
    rec.z = cs.position !== 'static' && cs.zIndex !== 'auto' ? num(cs.zIndex) : null;
    out.push(rec); outEls[out.length - 1] = el;
    if (rec.kind === 'img' || rec.kind === 'video' || rec.kind === 'canvas') return;
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) visit(c, out, svgDepth);
  }

  /** True when the element starts a CSS stacking context. */
  function createsSC(cs, parentCs) {
    var pos = cs.position;
    if (pos === 'fixed' || pos === 'sticky') return true;
    var flexItem = parentCs && /flex|grid/.test(parentCs.display);
    if (cs.zIndex !== 'auto' && (pos !== 'static' || flexItem)) return true;
    if (num(cs.opacity) < 1) return true;
    if (cs.transform !== 'none' || cs.filter !== 'none' || cs.mixBlendMode !== 'normal' || cs.isolation === 'isolate') return true;
    if ((cs.clipPath && cs.clipPath !== 'none') || (cs.maskImage && cs.maskImage !== 'none') || (cs.webkitMaskImage && cs.webkitMaskImage !== 'none')) return true;
    if (cs.perspective !== 'none' || (cs.backdropFilter && cs.backdropFilter !== 'none') || /transform|opacity/.test(cs.willChange || '')) return true;
    return false;
  }

  /**
   * Paint-order key following CSS painting rules: for every stacking context on the
   * path from the root, the element (or its nearest positioned / stacking ancestor in
   * that context) is ordered by z-index bucket, then tree order. In-flow content paints
   * below positioned content (bucket -0.5), negative z-index below in-flow.
   * Keys are flat arrays of [bucket, docIndex] pairs, compared lexicographically.
   */
  function orderKeys(recs, els) {
    var keys = {};
    var all = document.querySelectorAll('[data-kx-id]');
    var docIndex = new Map();
    for (var i = 0; i < all.length; i++) docIndex.set(all[i], i);
    var csCache = new Map();
    function csOf(n) { var c = csCache.get(n); if (!c) { c = getComputedStyle(n); csCache.set(n, c); } return c; }
    for (var j = 0; j < recs.length; j++) {
      var target = els[j];
      if (!target) continue;
      var path = [];
      var htmlTarget = target;
      while (htmlTarget && htmlTarget.namespaceURI === SVG_NS && htmlTarget.tagName !== 'svg') htmlTarget = htmlTarget.parentElement;
      for (var n = htmlTarget; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement; n = n.parentElement) path.unshift(n);
      var key = [];
      var part = null;
      var lastWasSC = false;
      for (var k = 0; k < path.length; k++) {
        var node = path[k];
        var cs = csOf(node);
        var pcs = node.parentElement ? csOf(node.parentElement) : null;
        var sc = createsSC(cs, pcs);
        var layered = sc || cs.position !== 'static';
        lastWasSC = false;
        if (layered) {
          var flexItem = pcs && /flex|grid/.test(pcs.display);
          var z = cs.zIndex !== 'auto' && (cs.position !== 'static' || flexItem) ? num(cs.zIndex) : 0;
          part = { b: z, d: docIndex.get(node) || 0, el: node };
        }
        if (sc) { key.push(part.b, part.d); part = null; lastWasSC = node === target; }
      }
      var dT = docIndex.get(target) || 0;
      if (part) {
        key.push(part.b, part.d);
        if (part.el !== target) key.push(-1, dT);
      } else if (!lastWasSC) {
        key.push(-0.5, dT);
      }
      keys[recs[j].id] = key;
    }
    return keys;
  }

  window.__kxSample = function (opts) {
    opts = opts || {};
    var out = [];
    outEls = [];
    var root = opts.root ? document.querySelector('[data-kx-id="' + opts.root + '"]') : document.body;
    if (!root) root = document.body;
    if (root === document.body || root === document.documentElement) {
      for (var c = root.firstElementChild; c; c = c.nextElementSibling) visit(c, out, 0);
    } else {
      visit(root, out, 0);
    }
    var res = { t: window.__kx ? window.__kx.now : 0, els: out };
    if (opts.order) res.order = orderKeys(out, outEls);
    if (opts.canvas) {
      res.canvas = {};
      var cvs = document.querySelectorAll('canvas[data-kx-id]');
      for (var k = 0; k < cvs.length; k++) {
        try { res.canvas[cvs[k].getAttribute('data-kx-id')] = cvs[k].toDataURL('image/png'); } catch (e) { res.canvas[cvs[k].getAttribute('data-kx-id')] = null; }
      }
    }
    // HTML elements in document order — matches CDP querySelectorAll order for quad lookup.
    var htmlIds = [];
    var tagged = document.querySelectorAll('[data-kx-id]');
    for (var q = 0; q < tagged.length; q++) htmlIds.push(+tagged[q].getAttribute('data-kx-id'));
    res.docOrder = htmlIds;
    return res;
  };

  /** Find the video "stage": the fixed-size element the page draws into. */
  window.__kxDetectStage = function () {
    var explicit = document.querySelector('[data-kx-stage],[data-stage],#stage,.stage,#canvas-stage,#frame,.frame,#video,.video,#scene,.scene,#composition,#comp,main#app');
    var COMMON = [[1920, 1080], [1080, 1920], [1080, 1080], [1280, 720], [720, 1280], [3840, 2160], [2160, 3840], [1080, 1350], [1200, 1200], [1600, 900], [800, 600], [1440, 1080], [1000, 1000], [1024, 1024], [1080, 1440]];
    function size(el) { return [el.offsetWidth, el.offsetHeight]; }
    if (explicit && explicit.offsetWidth > 50 && explicit.offsetHeight > 50) return { w: explicit.offsetWidth, h: explicit.offsetHeight, id: idOf(explicit).id, how: 'selector' };
    var best = null;
    var els = document.body ? document.body.querySelectorAll('*') : [];
    for (var i = 0; i < els.length && i < 4000; i++) {
      var el = els[i];
      if (el.namespaceURI === SVG_NS && el.tagName !== 'svg') continue;
      var s = size(el);
      for (var j = 0; j < COMMON.length; j++) {
        if (Math.abs(s[0] - COMMON[j][0]) <= 1 && Math.abs(s[1] - COMMON[j][1]) <= 1) {
          if (!best || s[0] * s[1] > best.w * best.h) best = { w: s[0], h: s[1], id: idOf(el).id, how: 'common-size' };
        }
      }
    }
    if (best) return best;
    // Largest element with an explicit pixel size in its own style.
    for (var k = 0; k < els.length && k < 4000; k++) {
      var e = els[k];
      if (e.style && /px$/.test(e.style.width) && /px$/.test(e.style.height)) {
        var z = size(e);
        if (z[0] >= 200 && z[1] >= 200 && (!best || z[0] * z[1] > best.w * best.h)) best = { w: z[0], h: z[1], id: idOf(e).id, how: 'inline-size' };
      }
    }
    return best;
  };

  /** Page metadata: title, explicit duration/fps, GSAP/WAAPI end times, fonts, media. */
  window.__kxMeta = function () {
    function g(name) { try { return (0, eval)('typeof ' + name + " !== 'undefined' ? " + name + ' : undefined'); } catch (e) { return undefined; } }
    var dur = null, how = null;
    var secNames = ['DURATION', 'TOTAL', 'TOTAL_DURATION', 'VIDEO_DURATION', 'LENGTH', 'duration'];
    var msNames = ['DURATION_MS', 'TOTAL_MS', 'TOTAL_DURATION_MS', 'LENGTH_MS'];
    for (var i = 0; i < secNames.length && dur == null; i++) { var v = g(secNames[i]); if (typeof v === 'number' && v > 0 && v < 3600) { dur = v; how = secNames[i]; } }
    for (var j = 0; j < msNames.length && dur == null; j++) { var w = g(msNames[j]); if (typeof w === 'number' && w > 0) { dur = w / 1000; how = msNames[j]; } }
    var attr = document.body && (document.body.getAttribute('data-duration') || document.documentElement.getAttribute('data-duration'));
    var mt = document.querySelector('meta[name="keyframex:duration"],meta[name="duration"]');
    if (dur == null && attr) { dur = num(attr); how = 'data-duration'; }
    if (dur == null && mt) { dur = num(mt.content); how = 'meta'; }
    var fps = g('FPS');
    var gsapEnd = null;
    try {
      if (window.gsap && gsap.globalTimeline) {
        var kids = gsap.globalTimeline.getChildren(false, true, true);
        for (var k = 0; k < kids.length; k++) {
          var c = kids[k];
          if (c.repeat && c.repeat() === -1) { gsapEnd = gsapEnd || 0; continue; }
          var e = c.endTime ? c.endTime() : 0;
          if (isFinite(e)) gsapEnd = Math.max(gsapEnd || 0, e);
        }
      }
    } catch (e2) { /* ignore */ }
    var waEnd = null, waInfinite = false;
    try {
      var anims = document.getAnimations();
      for (var a = 0; a < anims.length; a++) {
        var end = anims[a].effect ? anims[a].effect.getComputedTiming().endTime : 0;
        if (isFinite(end)) waEnd = Math.max(waEnd || 0, end / 1000); else waInfinite = true;
      }
    } catch (e3) { /* ignore */ }
    var fontLinks = Array.prototype.slice.call(document.querySelectorAll('link[rel="stylesheet"][href]')).map(function (l) { return l.href; }).filter(function (h) { return /fonts\.googleapis\.com|fonts\.bunny\.net/.test(h); });
    var faces = [];
    try {
      for (var s = 0; s < document.styleSheets.length; s++) {
        var rules;
        try { rules = document.styleSheets[s].cssRules; } catch (e4) { continue; }
        for (var r = 0; r < rules.length; r++) {
          if (rules[r].type === 5) {
            var st = rules[r].style;
            var srcm = /url\(["']?([^"')]+)["']?\)/.exec(st.getPropertyValue('src'));
            if (srcm) faces.push({ family: st.getPropertyValue('font-family').replace(/["']/g, '').trim(), weight: st.getPropertyValue('font-weight') || '400', style: st.getPropertyValue('font-style') || 'normal', url: new URL(srcm[1], rules[r].parentStyleSheet.href || document.baseURI).href });
          }
        }
      }
    } catch (e5) { /* ignore */ }
    var bodyBg = null;
    try {
      bodyBg = parseColor(getComputedStyle(document.body).backgroundColor) || parseColor(getComputedStyle(document.documentElement).backgroundColor);
    } catch (e6) { /* ignore */ }
    return {
      title: document.title,
      duration: dur, durationFrom: how, fps: typeof fps === 'number' ? fps : null,
      gsapEnd: gsapEnd, waEnd: waEnd, waInfinite: waInfinite,
      fontLinks: fontLinks, fontFaces: faces, bodyBg: bodyBg,
      errors: window.__kx ? window.__kx.errors() : [],
    };
  };

  /**
   * Show only one element (or parts of it) on a transparent page, for a picture
   * capture. parts: { subtree } = element and everything inside it;
   * { box } = its own background/border/shadow (text hidden); { pseudo } = ::before/::after.
   */
  window.__kxIsolate = function (id, parts) {
    var el = document.querySelector('[data-kx-id="' + id + '"]');
    if (!el) return null;
    var sel = '[data-kx-id="' + id + '"]';
    var css = 'html,body{background:transparent!important;background-image:none!important}' +
      '*,*::before,*::after{visibility:hidden!important;caret-color:transparent!important}';
    if (parts.subtree) {
      css += sel + ',' + sel + ' *,' + sel + '::before,' + sel + '::after,' + sel + ' *::before,' + sel + ' *::after{visibility:visible!important}';
      // <use> draws a clone of its target (usually in <defs>): the target must be visible too.
      var uses = el.tagName === 'use' ? [el] : Array.prototype.slice.call(el.querySelectorAll('use'));
      for (var u = 0; u < uses.length; u++) {
        var href = uses[u].getAttribute('href') || uses[u].getAttribute('xlink:href') || '';
        if (href.charAt(0) === '#') {
          var t = '[id="' + href.slice(1).replace(/"/g, '') + '"]';
          css += t + ',' + t + ' *{visibility:visible!important}';
        }
      }
    } else {
      var cb = getComputedStyle(el, '::before'), ca = getComputedStyle(el, '::after');
      if (parts.box) css += sel + '{visibility:visible!important;color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;-webkit-text-stroke-width:0!important;text-decoration-color:transparent!important}';
      if (parts.pseudo) {
        css += sel + '::before{visibility:visible!important;color:' + cb.color + '!important;-webkit-text-fill-color:' + cb.webkitTextFillColor + '!important}';
        css += sel + '::after{visibility:visible!important;color:' + ca.color + '!important;-webkit-text-fill-color:' + ca.webkitTextFillColor + '!important}';
      }
    }
    var st = document.getElementById('kx-isolate');
    if (!st) { st = document.createElement('style'); st.id = 'kx-isolate'; document.documentElement.appendChild(st); }
    st.textContent = css;
    // An ancestor's clip-path or mask (e.g. a circle wipe that is still closed at this
    // frame) would cut the picture; After Effects gets those clips as mattes instead.
    // Neither property affects layout, so lifting them changes nothing else.
    isolatedAncestors = [];
    for (var a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      var acs = getComputedStyle(a);
      var hasMask = (acs.maskImage && acs.maskImage !== 'none') || (acs.webkitMaskImage && acs.webkitMaskImage !== 'none');
      if ((acs.clipPath && acs.clipPath !== 'none') || hasMask) {
        isolatedAncestors.push([a, a.style.getPropertyValue('clip-path'), a.style.getPropertyPriority('clip-path'), a.style.getPropertyValue('-webkit-mask-image'), a.style.getPropertyPriority('-webkit-mask-image'), a.style.getPropertyValue('mask-image'), a.style.getPropertyPriority('mask-image')]);
        a.style.setProperty('clip-path', 'none', 'important');
        a.style.setProperty('-webkit-mask-image', 'none', 'important');
        a.style.setProperty('mask-image', 'none', 'important');
      }
    }
    return true;
  };
  var isolatedAncestors = [];
  window.__kxUnisolate = function () {
    var st = document.getElementById('kx-isolate');
    if (st) st.parentNode.removeChild(st);
    for (var i = 0; i < isolatedAncestors.length; i++) {
      var x = isolatedAncestors[i];
      x[0].style.setProperty('clip-path', x[1], x[2]);
      x[0].style.setProperty('-webkit-mask-image', x[3], x[4]);
      x[0].style.setProperty('mask-image', x[5], x[6]);
    }
    isolatedAncestors = [];
    return true;
  };
  window.__kxBlankPng = function (w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    return c.toDataURL('image/png');
  };

  /** Re-encode an image (by URL or data URL) to PNG via canvas. */
  window.__kxToPng = function (src, maxSide) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth || 512, h = img.naturalHeight || 512;
        var k = maxSide && Math.max(w, h) > maxSide ? maxSide / Math.max(w, h) : (w < 256 && /svg/.test(src) ? 4 : 1);
        var c = document.createElement('canvas');
        c.width = Math.round(w * k); c.height = Math.round(h * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        try { resolve(c.toDataURL('image/png')); } catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  };
})();
