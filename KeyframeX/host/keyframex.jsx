/*
 * KeyframeX — After Effects host script (ExtendScript, ES3). Single file on purpose:
 * After Effects loads it from the manifest (ScriptPath) and relative //@include
 * paths are not resolved reliably there, so everything lives in this one file.
 *
 * Every public entry point takes plain strings and returns a JSON string:
 *   { ok: true, ... }  or  { ok: false, error: "message", line: n }
 *
 * Sections: 1. JSON  2. Properties & keyframes  3. Builder  4. Queries  5. Public API
 */

// ==========================================================================
// 1. JSON helpers
// ==========================================================================
/*
 * KeyframeX host — JSON helpers for ExtendScript (ES3, no native JSON).
 */
var KXJSON = (function () {
    function quote(s) {
        var out = '"';
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i), code = s.charCodeAt(i);
            if (c === '"') out += '\\"';
            else if (c === '\\') out += '\\\\';
            else if (c === '\n') out += '\\n';
            else if (c === '\r') out += '\\r';
            else if (c === '\t') out += '\\t';
            else if (code < 32 || code === 0x2028 || code === 0x2029) {
                var h = code.toString(16);
                while (h.length < 4) h = '0' + h;
                out += '\\u' + h;
            } else out += c;
        }
        return out + '"';
    }

    function stringify(v) {
        if (v === null || v === undefined) return 'null';
        var t = typeof v;
        if (t === 'number') return isFinite(v) ? String(v) : 'null';
        if (t === 'boolean') return v ? 'true' : 'false';
        if (t === 'string') return quote(v);
        if (v instanceof Array) {
            var a = [];
            for (var i = 0; i < v.length; i++) a.push(stringify(v[i]));
            return '[' + a.join(',') + ']';
        }
        if (t === 'object') {
            var parts = [];
            for (var k in v) {
                if (v.hasOwnProperty(k) && typeof v[k] !== 'function' && v[k] !== undefined) parts.push(quote(k) + ':' + stringify(v[k]));
            }
            return '{' + parts.join(',') + '}';
        }
        return 'null';
    }

    /**
     * Parse JSON text. Unless `trusted` (already validated by the KeyframeX engine),
     * anything that is not plain JSON is rejected before it is evaluated.
     */
    function parse(text, trusted) {
        var s = String(text);
        if (trusted) return eval('(' + s + ')');
        // json2-style safety check: strip strings/literals, only JSON punctuation may remain.
        var probe = s.replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, '@')
            .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, ']')
            .replace(/(?:^|:|,)(?:\s*\[)+/g, '');
        if (!/^[\],:{}\s]*$/.test(probe)) throw new Error('Invalid JSON');
        return eval('(' + s + ')');
    }

    return { stringify: stringify, parse: parse, quote: quote };
})();

// ==========================================================================
// 2. Properties & keyframes
// ==========================================================================
/*
 * KeyframeX host — applying scene tracks to After Effects properties.
 *
 * A track is { value: v } or { keys: [{ t, v, interp, ei, eo }], spatial }.
 * ei / eo are [[speed, influence], ...] (one entry per AE ease dimension).
 */
var KXProps = (function () {

    function isArr(v) { return v instanceof Array; }

    /** Convert a scene value into what AE expects for this property. */
    function conv(prop, v, kind) {
        if (kind === 'color') {
            if (isArr(v)) return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1];
            return v;
        }
        if (kind === 'shape') return KXProps.makeShape(v);
        return v;
    }

    function makeShape(p) {
        var s = new Shape();
        s.vertices = p.v;
        s.inTangents = p.i;
        s.outTangents = p.o;
        s.closed = !!p.c;
        return s;
    }

    function easeList(list, dims, fallbackSpeed) {
        var out = [];
        for (var d = 0; d < dims; d++) {
            var e = list ? (list[d] || list[list.length - 1]) : null;
            out.push(e ? new KeyframeEase(e[0], Math.max(0.1, Math.min(100, e[1]))) : new KeyframeEase(fallbackSpeed || 0, 16.666667));
        }
        return out;
    }

    function setEase(prop, idx, k) {
        var want = k.ei ? k.ei.length : (k.eo ? k.eo.length : 1);
        var tries = [want, 3, 2, 1];
        for (var i = 0; i < tries.length; i++) {
            try {
                prop.setTemporalEaseAtKey(idx, easeList(k.ei, tries[i]), easeList(k.eo, tries[i]));
                return true;
            } catch (e) { /* wrong dimension count: try the next */ }
        }
        return false;
    }

    /**
     * Apply a track. `kind`: 'color' | 'shape' | 'text' | undefined.
     * `map(v)` optionally transforms every value (and `mapSpeed(s, dim)` every ease speed).
     */
    function apply(prop, track, kind, map, mapSpeed) {
        if (!prop || !track) return;
        if (!prop.canVaryOverTime && track.keys) track = { value: track.keys[0].v };
        if (track.value !== undefined && track.value !== null) {
            prop.setValue(conv(prop, map ? map(track.value) : track.value, kind));
            return;
        }
        var keys = track.keys;
        if (!keys || !keys.length) return;
        while (prop.numKeys > 0) prop.removeKey(1);
        var times = [], vals = [];
        for (var i = 0; i < keys.length; i++) {
            times.push(keys[i].t);
            vals.push(conv(prop, map ? map(keys[i].v) : keys[i].v, kind));
        }
        try {
            prop.setValuesAtTimes(times, vals);
        } catch (e) {
            for (var j = 0; j < keys.length; j++) prop.setValueAtTime(times[j], vals[j]);
        }
        var HOLD = KeyframeInterpolationType.HOLD, LIN = KeyframeInterpolationType.LINEAR, BEZ = KeyframeInterpolationType.BEZIER;
        var spatial = false;
        try { spatial = prop.isSpatial; } catch (e2) { /* ignore */ }
        for (var k = 0; k < keys.length; k++) {
            var key = keys[k];
            var idx = prop.nearestKeyIndex(key.t);
            if (kind === 'text' || kind === 'shape-hold') {
                try { prop.setInterpolationTypeAtKey(idx, HOLD, HOLD); } catch (e3) { /* ignore */ }
                continue;
            }
            var prev = k > 0 ? keys[k - 1] : null;
            var kk = key;
            if (mapSpeed && (key.ei || key.eo)) {
                kk = { ei: scaleEase(key.ei, mapSpeed), eo: scaleEase(key.eo, mapSpeed) };
            }
            if (key.ei || key.eo) setEase(prop, idx, kk);
            var inT = prev && prev.interp === 'hold' ? HOLD : (key.ei ? BEZ : LIN);
            var outT = key.interp === 'hold' ? HOLD : (key.eo ? BEZ : LIN);
            try { prop.setInterpolationTypeAtKey(idx, inT, outT); } catch (e4) { /* ignore */ }
            if (spatial) {
                try {
                    // 2D layers still store Position as [x, y, z]: match the stored dimension.
                    var kv = prop.keyValue(idx);
                    var zero = isArr(kv) && kv.length === 3 ? [0, 0, 0] : [0, 0];
                    prop.setSpatialAutoBezierAtKey(idx, false);
                    prop.setSpatialContinuousAtKey(idx, false);
                    prop.setSpatialTangentsAtKey(idx, zero, zero);
                    prop.setRovingAtKey(idx, false);
                } catch (e5) { /* ignore */ }
            }
        }
    }

    function scaleEase(list, mapSpeed) {
        if (!list) return null;
        var out = [];
        for (var i = 0; i < list.length; i++) out.push([mapSpeed(list[i][0], i), list[i][1]]);
        return out;
    }

    /** Value of a track at its start (static value or first key). */
    function first(track, dflt) {
        if (!track) return dflt;
        if (track.value !== undefined) return track.value;
        if (track.keys && track.keys.length) return track.keys[0].v;
        return dflt;
    }

    function prop(group, matchName) {
        try { return group.property(matchName); } catch (e) { return null; }
    }

    return { apply: apply, makeShape: makeShape, first: first, prop: prop, conv: conv };
})();

// ==========================================================================
// 3. Builder
// ==========================================================================
/*
 * KeyframeX host — builds a KeyframeX scene (keyframex.scene v1) as an
 * After Effects composition with native layers and keyframes.
 */
var KXBuild = (function () {
    var P = KXProps;
    var KAPPA = 0.5522847498;

    function isArr(v) { return v instanceof Array; }
    function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

    function projectItems() {
        var out = [];
        for (var i = 1; i <= app.project.numItems; i++) out.push(app.project.item(i));
        return out;
    }

    function findFolder(name, parent) {
        var items = projectItems();
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it instanceof FolderItem && it.name === name && it.parentFolder === parent) return it;
        }
        return null;
    }

    function uniqueName(base) {
        var items = projectItems();
        var used = {};
        for (var i = 0; i < items.length; i++) used[items[i].name] = true;
        if (!used[base]) return base;
        for (var n = 2; n < 1000; n++) if (!used[base + ' ' + n]) return base + ' ' + n;
        return base + ' ' + (new Date().getTime());
    }

    function fileFor(asset, sceneDir) {
        if (asset.rel && sceneDir) {
            var f = new File(sceneDir + '/' + asset.rel);
            if (f.exists) return f;
        }
        if (asset.path) {
            var g = new File(asset.path);
            if (g.exists) return g;
        }
        return null;
    }

    // ------------------------------------------------------------------ assets
    function importAssets(scene, sceneDir, folder, ctx) {
        var map = {};
        var assets = scene.assets || [];
        for (var i = 0; i < assets.length; i++) {
            var a = assets[i];
            var f = fileFor(a, sceneDir);
            var item = null;
            if (f) {
                try {
                    var io = new ImportOptions(f);
                    if (a.kind === 'sequence') { io.sequence = true; io.forceAlphabetical = true; }
                    item = app.project.importFile(io);
                    if (a.kind === 'sequence') { try { item.mainSource.conformFrameRate = a.fps || scene.comp.fps; } catch (e0) { /* ignore */ } }
                    if (a.origin && a.origin.indexOf('http') === 0) item.comment = 'KeyframeX online media: ' + a.origin;
                } catch (e) {
                    ctx.warn('Could not import ' + f.fsName + ': ' + e.toString());
                    item = null;
                }
            }
            if (!item && a.kind !== 'audio') {
                // Placeholder with the right size; the layer keeps its animation.
                var size = placeholderSize(scene, a.id);
                item = app.project.importPlaceholder(shortName(a), size[0], size[1], scene.comp.fps, scene.comp.duration);
                item.comment = 'KeyframeX placeholder for ' + (a.origin || a.url || a.path || a.id);
                ctx.placeholders.push({ id: a.id, name: item.name, origin: a.origin || a.url || a.path || '', saveAs: a.saveAs || a.path || '' });
            }
            if (item) { item.parentFolder = folder; map[a.id] = item; }
        }
        return map;
    }

    function shortName(a) {
        var s = String(a.saveAs || a.path || a.origin || a.url || a.id);
        s = s.replace(/[\\\/]+$/, '');
        var k = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
        return k >= 0 ? s.substring(k + 1) : s;
    }

    function placeholderSize(scene, assetId) {
        for (var i = 0; i < scene.layers.length; i++) {
            var L = scene.layers[i];
            if (L.asset === assetId && L.box) {
                var b = P.first(L.box, [512, 512]);
                return [Math.max(4, Math.round(b[0])), Math.max(4, Math.round(b[1]))];
            }
        }
        return [512, 512];
    }

    // ------------------------------------------------------------------ helpers
    function setLayerTiming(layer, L, comp) {
        try { if (L['in'] !== undefined) layer.inPoint = clamp(L['in'], 0, comp.duration); } catch (e1) { /* ignore */ }
        try { if (L.out !== undefined) layer.outPoint = clamp(L.out, layer.inPoint + comp.frameDuration, comp.duration); } catch (e2) { /* ignore */ }
    }

    function applyTransform(layer, L, scaleFactor) {
        var t = L.transform || {};
        var tg = layer.property('ADBE Transform Group');
        if (t.anchor) P.apply(tg.property('ADBE Anchor Point'), t.anchor);
        if (t.position) P.apply(tg.property('ADBE Position'), t.position);
        if (t.scale) {
            if (scaleFactor) {
                P.apply(tg.property('ADBE Scale'), t.scale,
                    undefined,
                    function (v) { return [v[0] * scaleFactor[0], v[1] * scaleFactor[1]]; },
                    function (s, d) { return s * scaleFactor[d === 1 ? 1 : 0]; });
            } else P.apply(tg.property('ADBE Scale'), t.scale);
        } else if (scaleFactor) {
            tg.property('ADBE Scale').setValue([100 * scaleFactor[0], 100 * scaleFactor[1]]);
        }
        if (t.rotation) P.apply(tg.property('ADBE Rotate Z'), t.rotation);
        if (t.opacity) P.apply(tg.property('ADBE Opacity'), t.opacity);
    }

    function blend(layer, L) {
        if (!L.blend) return;
        try { layer.blendingMode = BlendingMode[L.blend]; } catch (e) { /* ignore */ }
    }

    function roundedRectShape(w, h, r, cx, cy) {
        r = Math.min(Math.max(0, r || 0), w / 2, h / 2);
        var x0 = cx - w / 2, y0 = cy - h / 2, x1 = cx + w / 2, y1 = cy + h / 2;
        var s = new Shape();
        if (r <= 0.01) {
            s.vertices = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
            s.inTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
            s.outTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
        } else {
            var k = r * KAPPA;
            s.vertices = [[x0 + r, y0], [x1 - r, y0], [x1, y0 + r], [x1, y1 - r], [x1 - r, y1], [x0 + r, y1], [x0, y1 - r], [x0, y0 + r]];
            s.inTangents = [[-k, 0], [0, 0], [0, -k], [0, 0], [k, 0], [0, 0], [0, k], [0, 0]];
            s.outTangents = [[0, 0], [k, 0], [0, 0], [0, k], [0, 0], [-k, 0], [0, 0], [0, -k]];
        }
        s.closed = true;
        return s;
    }

    function capValue(c) { return c === 'round' ? 2 : (c === 'square' ? 3 : 1); }
    function joinValue(j) { return j === 'round' ? 2 : (j === 'bevel' ? 3 : 1); }

    // ------------------------------------------------------------------ effects
    function scaledOpacity(prop, pct) {
        var max = 100;
        try { if (prop.hasMax) max = prop.maxValue; } catch (e) { /* ignore */ }
        return pct * (max > 100 ? max / 100 : 1);
    }

    function addEffects(layer, L, ctx) {
        var fx = L.effects || [];
        if (!fx.length) return;
        var parade = layer.property('ADBE Effect Parade');
        for (var i = 0; i < fx.length; i++) {
            var e = fx[i];
            try {
                if (e.type === 'dropShadow') {
                    var d = parade.addProperty('ADBE Drop Shadow');
                    P.apply(d.property('ADBE Drop Shadow-0001'), e.color, 'color');
                    var op = d.property('ADBE Drop Shadow-0002');
                    P.apply(op, e.opacity, undefined, function (v) { return scaledOpacity(op, v); });
                    P.apply(d.property('ADBE Drop Shadow-0003'), e.direction);
                    P.apply(d.property('ADBE Drop Shadow-0004'), e.distance);
                    P.apply(d.property('ADBE Drop Shadow-0005'), e.softness);
                } else if (e.type === 'blur') {
                    var b = parade.addProperty('ADBE Gaussian Blur 2');
                    P.apply(b.property('ADBE Gaussian Blur 2-0001'), e.amount);
                } else if (e.type === 'fill') {
                    var f = parade.addProperty('ADBE Fill');
                    P.apply(f.property('ADBE Fill-0002'), e.color, 'color');
                } else if (e.type === 'gradient') {
                    addGradient(layer, parade, e);
                }
            } catch (err) {
                ctx.warn(L.name + ': effect "' + e.type + '" failed: ' + err.toString());
            }
        }
    }

    /** Gradient Ramp + Set Matte (self, alpha) keeps the gradient inside the layer's own shape. */
    function addGradient(layer, parade, e) {
        var map = function (p) { return p; };
        try {
            var r = layer.sourceRectAtTime(layer.inPoint, false);
            var box = e.box || [0, 0, 100, 100];
            if (r.width > 0 && r.height > 0 && box[2] > 0 && box[3] > 0) {
                map = function (p) {
                    return [r.left + (p[0] - box[0]) / box[2] * r.width, r.top + (p[1] - box[1]) / box[3] * r.height];
                };
            }
        } catch (e0) { /* ignore */ }
        var g = parade.addProperty('ADBE Ramp');
        g.property('ADBE Ramp-0001').setValue(map(e.start));
        g.property('ADBE Ramp-0002').setValue([e.colors[0][0], e.colors[0][1], e.colors[0][2], 1]);
        g.property('ADBE Ramp-0003').setValue(map(e.end));
        g.property('ADBE Ramp-0004').setValue([e.colors[1][0], e.colors[1][1], e.colors[1][2], 1]);
        g.property('ADBE Ramp-0005').setValue(e.kind === 'radial' ? 2 : 1);
        var sm = parade.addProperty('ADBE Set Matte3');
        sm.property('ADBE Set Matte3-0001').setValue(layer.index);
        sm.property('ADBE Set Matte3-0002').setValue(4); // use alpha channel
    }

    // ------------------------------------------------------------------ layer types
    function buildShape(comp, L, ctx) {
        var layer = comp.layers.addShape();
        var root = layer.property('ADBE Root Vectors Group');
        var grp = root.addProperty('ADBE Vector Group');
        grp.name = L.name;
        var vecs = grp.property('ADBE Vectors Group');
        var s = L.shape || { kind: 'rect', size: { value: [100, 100] } };
        if (s.kind === 'rect') {
            var rect = vecs.addProperty('ADBE Vector Shape - Rect');
            P.apply(rect.property('ADBE Vector Rect Size'), s.size);
            if (s.roundness) P.apply(rect.property('ADBE Vector Rect Roundness'), s.roundness);
        } else if (s.kind === 'ellipse') {
            var el = vecs.addProperty('ADBE Vector Shape - Ellipse');
            P.apply(el.property('ADBE Vector Ellipse Size'), s.size);
        } else {
            var pt = s.paths || { value: [] };
            var count = 0;
            if (pt.value !== undefined) count = pt.value.length;
            else for (var k = 0; k < pt.keys.length; k++) count = Math.max(count, pt.keys[k].v.length);
            for (var c = 0; c < count; c++) {
                var pg = vecs.addProperty('ADBE Vector Shape - Group');
                var pp = pg.property('ADBE Vector Shape');
                if (pt.value !== undefined) {
                    pp.setValue(P.makeShape(pt.value[c]));
                } else {
                    var keys = [];
                    for (var q = 0; q < pt.keys.length; q++) {
                        var contour = pt.keys[q].v[c] || pt.keys[q].v[pt.keys[q].v.length - 1];
                        keys.push({ t: pt.keys[q].t, v: contour, interp: pt.keys[q].interp });
                    }
                    P.apply(pp, { keys: keys }, 'shape');
                }
            }
        }
        if (L.trim) {
            var trim = vecs.addProperty('ADBE Vector Filter - Trim');
            P.apply(trim.property('ADBE Vector Trim Start'), L.trim.start);
            P.apply(trim.property('ADBE Vector Trim End'), L.trim.end);
        }
        if (L.stroke) {
            var st = vecs.addProperty('ADBE Vector Graphic - Stroke');
            P.apply(st.property('ADBE Vector Stroke Color'), L.stroke.color, 'color');
            if (L.stroke.opacity) P.apply(st.property('ADBE Vector Stroke Opacity'), L.stroke.opacity);
            P.apply(st.property('ADBE Vector Stroke Width'), L.stroke.width);
            try { st.property('ADBE Vector Stroke Line Cap').setValue(capValue(L.stroke.cap)); } catch (e1) { /* ignore */ }
            try { st.property('ADBE Vector Stroke Line Join').setValue(joinValue(L.stroke.join)); } catch (e2) { /* ignore */ }
            if (L.stroke.dashes && L.stroke.dashes.length) {
                try {
                    var dashes = st.property('ADBE Vector Stroke Dashes');
                    for (var di = 0; di < L.stroke.dashes.length && di < 6; di++) {
                        var nm = (di % 2 === 0) ? 'ADBE Vector Stroke Dash ' + (di / 2 + 1) : 'ADBE Vector Stroke Gap ' + ((di + 1) / 2);
                        dashes.addProperty(nm).setValue(L.stroke.dashes[di]);
                    }
                    if (L.stroke.dashOffset) P.apply(dashes.property('ADBE Vector Stroke Offset'), L.stroke.dashOffset, undefined, function (v) { return -v; }, function (s) { return -s; });
                } catch (e3) { ctx.warn(L.name + ': dashes could not be set'); }
            }
        }
        if (L.fill) {
            var fl = vecs.addProperty('ADBE Vector Graphic - Fill');
            P.apply(fl.property('ADBE Vector Fill Color'), L.fill.color, 'color');
            if (L.fill.opacity) P.apply(fl.property('ADBE Vector Fill Opacity'), L.fill.opacity);
            if (s.fillRule === 'evenodd') { try { fl.property('ADBE Vector Fill Rule').setValue(2); } catch (e4) { /* ignore */ } }
        }
        return layer;
    }

    function weightStyleName(weight, italic) {
        var names = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
        var w = Math.round((weight || 400) / 100) * 100;
        if (w < 100) w = 100;
        if (w > 900) w = 900;
        var n = names[w];
        if (italic) return w === 400 ? 'Italic' : n + ' Italic';
        return n;
    }

    function fontExists(ps) {
        try {
            if (app.fonts && app.fonts.getFontsByPostScriptName) {
                var list = app.fonts.getFontsByPostScriptName(ps);
                return list && list.length > 0;
            }
        } catch (e) { /* ignore */ }
        return null; // unknown (AE < 24)
    }

    /** Resolve a scene font to an installed PostScript name. Cached per build. */
    function resolveFont(font, ctx) {
        if (!font) return null;
        var key = (font.postScriptName || '') + '|' + font.family + '|' + font.weight + '|' + font.style;
        if (ctx.fontCache[key] !== undefined) return ctx.fontCache[key];
        var italic = font.style === 'italic';
        var style = weightStyleName(font.weight, italic);
        var result = null;
        if (font.postScriptName && fontExists(font.postScriptName) !== false) result = font.postScriptName;
        if (!result) {
            try {
                if (app.fonts && app.fonts.getFontsByFamilyNameAndStyleName) {
                    var tries = [style, style.replace('SemiBold', 'Semibold').replace('ExtraBold', 'Extrabold'), style.replace('SemiBold', 'Semi Bold').replace('ExtraBold', 'Extra Bold').replace('ExtraLight', 'Extra Light'), italic ? 'Italic' : 'Regular'];
                    for (var i = 0; i < tries.length && !result; i++) {
                        var f = app.fonts.getFontsByFamilyNameAndStyleName(font.family, tries[i]);
                        if (f && f.length) result = f[0].postScriptName;
                    }
                }
            } catch (e) { /* AE < 24 */ }
        }
        if (!result) {
            var guess = String(font.family).replace(/\s+/g, '') + '-' + style.replace(/\s+/g, '');
            var ex = fontExists(guess);
            if (ex === true || ex === null) result = guess;
        }
        ctx.fontCache[key] = result;
        return result;
    }

    function styleDoc(doc, L, ctx, text) {
        var t = L.text;
        // Only assign the text when it really changes: After Effects drops a justification
        // change made in the same TextDocument as a text change (known AE bug).
        if (text !== undefined && doc.text !== text) doc.text = text;
        try { doc.resetCharStyle(); } catch (e0) { /* ignore */ }
        // New text layers inherit the Paragraph panel (indents, space before/after,
        // justification). Start from clean paragraph settings so nothing shifts the text.
        try { doc.resetParagraphStyle(); } catch (e00) { /* ignore */ }
        var zero = ['startIndent', 'endIndent', 'firstLineIndent', 'spaceBefore', 'spaceAfter'];
        for (var z = 0; z < zero.length; z++) {
            try { if (doc[zero[z]] !== undefined && doc[zero[z]] !== 0) doc[zero[z]] = 0; } catch (e01) { /* read-only in this version */ }
        }
        var ps = resolveFont(t.font, ctx);
        if (ps) { try { doc.font = ps; } catch (e) { /* ignore */ } }
        doc.fontSize = t.size;
        var noFill = !!t.noFill;
        doc.applyFill = !noFill;
        if (!noFill) doc.fillColor = t.color || [1, 1, 1];
        if (t.stroke) {
            doc.applyStroke = true;
            doc.strokeColor = t.stroke.color;
            doc.strokeWidth = t.stroke.width;
            try { doc.strokeOverFill = true; } catch (e1) { /* ignore */ }
        } else doc.applyStroke = false;
        if (t.tracking) doc.tracking = t.tracking;
        doc.justification = wantJustification(t);
        if (t.leading) {
            try { doc.autoLeading = false; doc.leading = t.leading; } catch (e2) { /* read-only before AE 2022 */ }
        }
        return ps;
    }

    function wantJustification(t) {
        var J = ParagraphJustification;
        return t.justify === 'center' ? J.CENTER_JUSTIFY : (t.justify === 'right' ? J.RIGHT_JUSTIFY : J.LEFT_JUSTIFY);
    }

    /**
     * Make sure the paragraph justification really stuck. After Effects can silently keep
     * the Paragraph panel's justification when the text and the justification change in
     * the same setValue, which shifts centred text sideways by half its width. Setting it
     * again on a fresh copy of the document (text unchanged) is the documented workaround.
     */
    function ensureJustification(tp, want) {
        for (var tries = 0; tries < 2; tries++) {
            var d = tp.value;
            if (d.justification === want) return true;
            d.justification = want;
            tp.setValue(d);
        }
        return tp.value.justification === want;
    }

    /** Same check for every Source Text keyframe. */
    function ensureKeyJustification(tp, want) {
        var ok = true;
        for (var k = 1; k <= tp.numKeys; k++) {
            var d = tp.keyValue(k);
            if (d.justification === want) continue;
            try { d.justification = want; tp.setValueAtKey(k, d); } catch (e) { /* checked below */ }
            if (tp.keyValue(k).justification !== want) ok = false;
        }
        return ok;
    }

    /** Paragraph settings that can move text, for the build log. */
    function paragraphInfo(doc) {
        var out = [];
        var keys = ['justification', 'startIndent', 'endIndent', 'firstLineIndent', 'spaceBefore', 'baselineShift', 'boxText'];
        for (var k = 0; k < keys.length; k++) {
            try { if (doc[keys[k]] !== undefined) out.push(keys[k] + '=' + doc[keys[k]]); } catch (e) { /* ignore */ }
        }
        return out.join(', ');
    }

    /**
     * Check where After Effects actually drew the text and line it up with the page.
     * The page measured each text layer with its alignment point (left edge, centre or
     * right edge of the first baseline) on the layer origin. If After Effects lays it out
     * somewhere else (ignored justification, inherited paragraph indents, other
     * Paragraph-panel settings), the anchor point is moved by the difference. Side
     * bearings of the glyphs are well inside the tolerance, so correct text is untouched.
     */
    function lineUpText(layer, L, ctx) {
        var tg = layer.property('ADBE Transform Group');
        var ap = tg.property('ADBE Anchor Point');
        if (ap.numKeys > 0) return;
        var r = layer.sourceRectAtTime(0, false);
        if (!(r.width > 0) || !(r.height > 0)) return;
        var size = L.text.size || 20;
        var tol = Math.max(3, 0.35 * size);
        var j = L.text.justify;
        var ref = j === 'center' ? r.left + r.width / 2 : (j === 'right' ? r.left + r.width : r.left);
        var dx = Math.abs(ref) > tol ? ref : 0;
        // First-line glyph tops sit between the ascender (about -size) and a full stop (about 0).
        var dy = (r.top > 0.3 * size || r.top < -1.6 * size) ? r.top + 0.72 * size : 0;
        if (!dx && !dy) return;
        var a = ap.value;
        ap.setValue(a.length > 2 ? [a[0] + dx, a[1] + dy, a[2]] : [a[0] + dx, a[1] + dy]);
        ctx.linedUp = (ctx.linedUp || 0) + 1;
        var off = Math.round(Math.sqrt(dx * dx + dy * dy));
        if (!ctx.linedUpMax || off > ctx.linedUpMax) ctx.linedUpMax = off;
        if (!ctx.linedUpInfo) {
            try { ctx.linedUpInfo = L.name + ': ' + paragraphInfo(layer.property('ADBE Text Properties').property('ADBE Text Document').value); } catch (e) { ctx.linedUpInfo = L.name; }
        }
    }

    function counterExpression(c) {
        var dec = c.decimals || 0;
        var lines = [
            'var v = effect("Counter")("ADBE Slider Control-0001").value;',
            'var s = (Math.round(v * ' + Math.pow(10, dec) + ') / ' + Math.pow(10, dec) + ').toFixed(' + dec + ');'
        ];
        if (c.commas) lines.push('var p = s.split("."); p[0] = p[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ","); s = p.join(".");');
        lines.push(KXJSON.quote(c.prefix || '') + ' + s + ' + KXJSON.quote(c.suffix || '') + ';');
        return lines.join('\n');
    }

    function buildText(comp, L, ctx) {
        var t = L.text;
        var src = t.source || { value: '' };
        var firstText = src.value !== undefined ? src.value : (src.keys && src.keys.length ? src.keys[0].v : '');
        var layer = comp.layers.addText(String(firstText));
        var tp = layer.property('ADBE Text Properties').property('ADBE Text Document');
        var doc = tp.value;
        var ps = styleDoc(doc, L, ctx, String(firstText));
        tp.setValue(doc);
        var want = wantJustification(t);
        var justOk = ensureJustification(tp, want);
        // Did AE accept the font?
        try {
            var got = tp.value.font;
            if (!ps || (got && ps && got !== ps)) {
                var nm = (t.font && t.font.family ? t.font.family : '?') + ' ' + (t.font && t.font.weight ? t.font.weight : '');
                ctx.missingFont(nm, t.font);
            }
        } catch (e) { /* ignore */ }
        if (src.keys && src.keys.length > 1) {
            var keys = [];
            for (var i = 0; i < src.keys.length; i++) {
                var d = tp.value;
                d.text = String(src.keys[i].v);
                d.justification = want;
                keys.push({ t: src.keys[i].t, v: d, interp: 'hold' });
            }
            P.apply(tp, { keys: keys }, 'text');
            justOk = ensureKeyJustification(tp, want) && justOk;
        }
        if (!justOk) ctx.justRefused = (ctx.justRefused || 0) + 1;
        if (t.counter) {
            var parade = layer.property('ADBE Effect Parade');
            var sl = parade.addProperty('ADBE Slider Control');
            sl.name = 'Counter';
            P.apply(sl.property('ADBE Slider Control-0001'), t.counter.value);
            try { tp.expression = counterExpression(t.counter); } catch (e2) { ctx.warn(L.name + ': counter expression failed: ' + e2.toString()); }
        }
        return layer;
    }

    function fitFactor(box, item, fit) {
        var w = item.width || box[0], h = item.height || box[1];
        if (!w || !h) return [1, 1];
        var kx = box[0] / w, ky = box[1] / h;
        if (fit === 'cover') { var m = Math.max(kx, ky); return [m, m]; }
        if (fit === 'contain') { var n = Math.min(kx, ky); return [n, n]; }
        if (fit === 'none') return [1, 1];
        return [kx, ky];
    }

    function buildFootage(comp, L, ctx) {
        var item = ctx.assets[L.asset];
        if (!item) { ctx.warn(L.name + ': media "' + L.asset + '" is missing'); return null; }
        var layer = comp.layers.add(item);
        if (L.type === 'audio') return layer;
        var box = P.first(L.box, [item.width, item.height]);
        if (L.box && L.box.keys && L.box.keys.length > 1) ctx.warn(L.name + ': animated picture size is approximated by its first size');
        var k = fitFactor(box, item, L.fit);
        ctx.lastScale = k;
        // Crop for object-fit: cover and rounded corners.
        var needCrop = (L.fit === 'cover' && (Math.abs(item.width * k[0] - box[0]) > 0.5 || Math.abs(item.height * k[1] - box[1]) > 0.5)) || L.cornerRadius > 0;
        if (needCrop) {
            var mw = box[0] / k[0], mh = box[1] / k[1];
            var mask = layer.property('ADBE Mask Parade').addProperty('ADBE Mask Atom');
            mask.name = 'Frame';
            mask.property('ADBE Mask Shape').setValue(roundedRectShape(mw, mh, (L.cornerRadius || 0) / k[0], item.width / 2, item.height / 2));
        }
        if (L.type === 'video') {
            if (L.muted) { try { layer.audioEnabled = false; } catch (e) { /* no audio */ } }
            if (L.timeRemap && layer.canSetTimeRemapEnabled) {
                try {
                    layer.timeRemapEnabled = true;
                    var tr = layer.property('ADBE Time Remapping');
                    P.apply(tr, L.timeRemap);
                } catch (e2) { ctx.warn(L.name + ': time remap failed: ' + e2.toString()); }
            }
        }
        return layer;
    }

    // ------------------------------------------------------------------ mattes
    function applyMattes(comp, scene, made, ctx) {
        var modern = false;
        for (var i = 0; i < scene.layers.length; i++) {
            var L = scene.layers[i];
            if (!L.matte || !made[L.id] || !made[L.matte]) continue;
            var layer = made[L.id], matte = made[L.matte];
            if (typeof layer.setTrackMatte === 'function') {
                try { layer.setTrackMatte(matte, TrackMatteType.ALPHA); modern = true; continue; } catch (e) { /* fall through */ }
            }
            // AE before 2023: the matte must sit directly above, one copy per layer.
            try {
                var dup = matte.duplicate();
                dup.moveBefore(layer);
                dup.enabled = false;
                layer.trackMatteType = TrackMatteType.ALPHA;
                ctx.legacyMattes = true;
            } catch (e2) { ctx.warn(L.name + ': matte could not be applied: ' + e2.toString()); }
        }
        for (var id in made) {
            if (!made.hasOwnProperty(id)) continue;
            var src = null;
            for (var j = 0; j < scene.layers.length; j++) if (scene.layers[j].id === id) src = scene.layers[j];
            if (src && src.matteSource) {
                try {
                    made[id].enabled = false;
                    if (ctx.legacyMattes && !modern) made[id].remove();
                } catch (e3) { /* ignore */ }
            }
        }
    }

    // ------------------------------------------------------------------ main
    /**
     * @param {Object} scene parsed scene
     * @param {String} sceneDir folder of the scene file (for relative asset paths)
     * @param {Object} opts { target: 'new' | 'active', open: true }
     */
    function build(scene, sceneDir, opts) {
        opts = opts || {};
        var started = new Date().getTime();
        var warnings = [];
        var missingFonts = {};
        var ctx = {
            fontCache: {},
            placeholders: [],
            warn: function (m) { if (warnings.length < 200) warnings.push(m); },
            missingFont: function (name, font) { missingFonts[name] = font || true; }
        };
        if (!app.project) app.newProject();
        var hostComp = null;
        if (opts.target === 'active') {
            hostComp = app.project.activeItem;
            if (!(hostComp instanceof CompItem)) throw new Error('Open a composition first (Build into: Active comp).');
        }
        app.beginUndoGroup('KeyframeX: Build ' + scene.comp.name);
        var comp;
        try {
            var root = findFolder('KeyframeX', app.project.rootFolder) || app.project.items.addFolder('KeyframeX');
            var compName = uniqueName(scene.comp.name);
            var folder = app.project.items.addFolder(compName);
            folder.parentFolder = root;
            var footFolder = app.project.items.addFolder('Footage');
            footFolder.parentFolder = folder;
            var c = scene.comp;
            comp = app.project.items.addComp(compName, Math.round(c.width), Math.round(c.height), 1, c.duration, c.fps);
            comp.parentFolder = folder;
            if (c.bgColor) comp.bgColor = c.bgColor;
            ctx.assets = importAssets(scene, sceneDir, footFolder, ctx);

            var made = {};
            var counts = { shape: 0, text: 0, image: 0, video: 0, audio: 0, solid: 0, 'null': 0 };
            // Scene lists layers top → bottom; AE adds each new layer on top, so build bottom-up.
            for (var i = scene.layers.length - 1; i >= 0; i--) {
                var L = scene.layers[i];
                var layer = null;
                ctx.lastScale = null;
                try {
                    if (L.type === 'shape') layer = buildShape(comp, L, ctx);
                    else if (L.type === 'text') layer = buildText(comp, L, ctx);
                    else if (L.type === 'image' || L.type === 'video' || L.type === 'audio') layer = buildFootage(comp, L, ctx);
                    else if (L.type === 'solid') {
                        layer = comp.layers.addSolid(L.color || [0, 0, 0], L.name || 'Solid', comp.width, comp.height, 1, comp.duration);
                        try { layer.source.parentFolder = footFolder; } catch (e0) { /* ignore */ }
                    } else if (L.type === 'null') layer = comp.layers.addNull(comp.duration);
                    if (!layer) continue;
                    layer.name = L.name || layer.name;
                    if (L.comment) layer.comment = L.comment;
                    if (L.type !== 'audio') applyTransform(layer, L, ctx.lastScale);
                    if (L.type === 'text') {
                        try { lineUpText(layer, L, ctx); } catch (eT) { ctx.warn(L.name + ': text position check failed: ' + eT.toString()); }
                    }
                    blend(layer, L);
                    if (L.type !== 'audio' && L.type !== 'null') addEffects(layer, L, ctx);
                    if (L.type === 'audio') { try { layer.startTime = L.startAt || 0; } catch (eA) { /* ignore */ } } else setLayerTiming(layer, L, comp);
                    made[L.id] = layer;
                    counts[L.type] = (counts[L.type] || 0) + 1;
                } catch (err) {
                    ctx.warn((L.name || L.id) + ': ' + err.toString() + (err.line ? ' (line ' + err.line + ')' : ''));
                    try { if (layer) layer.remove(); } catch (e1) { /* ignore */ }
                }
            }
            // Parents after all layers exist.
            for (var p = 0; p < scene.layers.length; p++) {
                var PL = scene.layers[p];
                if (PL.parent && made[PL.id] && made[PL.parent]) { try { made[PL.id].parent = made[PL.parent]; } catch (e2) { ctx.warn(PL.name + ': parent failed'); } }
            }
            if (ctx.linedUp) ctx.warn('After Effects placed ' + ctx.linedUp + ' text layer(s) away from their spot (up to ' + ctx.linedUpMax + ' px); they were lined up by moving their anchor point. [' + ctx.linedUpInfo + ']' + (ctx.justRefused ? ' Alignment refused on ' + ctx.justRefused + ' layer(s).' : ''));
            applyMattes(comp, scene, made, ctx);
            if (ctx.legacyMattes) ctx.warn('Mattes were duplicated per layer (After Effects older than 2023).');

            var placed = null;
            if (hostComp) {
                placed = hostComp.layers.add(comp);
                placed.startTime = hostComp.time;
            }
            if (opts.open !== false) { try { (hostComp || comp).openInViewer(); } catch (e3) { /* ignore */ } }
            var mf = [];
            for (var k in missingFonts) if (missingFonts.hasOwnProperty(k)) mf.push(k);
            return {
                ok: true,
                comp: comp.name,
                compId: comp.id,
                folder: folder.name,
                layers: comp.numLayers,
                counts: counts,
                placedInto: hostComp ? hostComp.name : null,
                warnings: warnings,
                missingFonts: mf,
                placeholders: ctx.placeholders,
                ms: new Date().getTime() - started
            };
        } finally {
            app.endUndoGroup();
        }
    }

    return { build: build, resolveFont: resolveFont, weightStyleName: weightStyleName };
})();

// ==========================================================================
// 4. Queries
// ==========================================================================
/*
 * KeyframeX host — read-only queries and small project utilities used by the
 * panel.
 */
var KXQuery = (function () {

    function layerType(l) {
        if (l instanceof TextLayer) return 'text';
        if (l instanceof ShapeLayer) return 'shape';
        if (l instanceof CameraLayer) return 'camera';
        if (l instanceof LightLayer) return 'light';
        if (l.nullLayer) return 'null';
        if (l.source instanceof CompItem) return 'precomp';
        if (l.source && l.source.mainSource instanceof SolidSource) return 'solid';
        if (l.hasVideo === false && l.hasAudio) return 'audio';
        return 'footage';
    }

    function countKeys(group, depth) {
        var n = 0;
        if (depth > 6) return 0;
        for (var i = 1; i <= group.numProperties; i++) {
            var p = group.property(i);
            if (p.propertyType === PropertyType.PROPERTY) { if (p.numKeys) n += p.numKeys; }
            else n += countKeys(p, depth + 1);
        }
        return n;
    }

    function animatedProps(layer) {
        var out = [];
        var tg = layer.property('ADBE Transform Group');
        for (var i = 1; i <= tg.numProperties; i++) {
            var p = tg.property(i);
            if (p.numKeys > 0) out.push(p.name + ' (' + p.numKeys + ')');
        }
        return out;
    }

    function compInfo(c, withLayers) {
        var o = { id: c.id, name: c.name, width: c.width, height: c.height, fps: c.frameRate, duration: c.duration, layers: c.numLayers, time: c.time };
        if (withLayers) {
            o.layerList = [];
            for (var i = 1; i <= c.numLayers && i <= 500; i++) {
                var l = c.layer(i);
                var info = { index: i, name: l.name, type: layerType(l), 'in': l.inPoint, 'out': l.outPoint, enabled: l.enabled, keys: 0, animated: [] };
                try { info.keys = countKeys(l, 0); info.animated = animatedProps(l); } catch (e) { /* ignore */ }
                if (l instanceof TextLayer) {
                    try { var d = l.property('ADBE Text Properties').property('ADBE Text Document').value; info.text = d.text; info.font = d.font; info.size = d.fontSize; } catch (e2) { /* ignore */ }
                }
                if (l.parent) info.parent = l.parent.index;
                if (l.comment) info.comment = l.comment;
                o.layerList.push(info);
            }
        }
        return o;
    }

    function ping() {
        return {
            ok: true,
            app: 'After Effects',
            version: app.version,
            build: app.buildNumber,
            project: app.project && app.project.file ? app.project.file.fsName : null,
            activeComp: app.project && app.project.activeItem instanceof CompItem ? app.project.activeItem.name : null,
            fontsApi: !!(app.fonts && app.fonts.getFontsByPostScriptName),
            trackMatteApi: (function () { try { return typeof AVLayer.prototype.setTrackMatte === 'function'; } catch (e) { return false; } })()
        };
    }

    function listComps() {
        var out = [];
        if (!app.project) return out;
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof CompItem) out.push(compInfo(it, false));
        }
        return out;
    }

    function findComp(id) {
        if (id === undefined || id === null || id === '') {
            var a = app.project.activeItem;
            return a instanceof CompItem ? a : null;
        }
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof CompItem && (it.id === id || it.name === id)) return it;
        }
        return null;
    }

    function inspect(id) {
        var c = findComp(id);
        if (!c) throw new Error(id ? 'No composition "' + id + '"' : 'No active composition');
        return compInfo(c, true);
    }

    /** Replace KeyframeX placeholders with real files: map { placeholderName: absolutePath }. */
    function relink(map) {
        var done = [], failed = [];
        app.beginUndoGroup('KeyframeX: Relink media');
        try {
            for (var i = 1; i <= app.project.numItems; i++) {
                var it = app.project.item(i);
                if (!(it instanceof FootageItem) || !(it.mainSource instanceof PlaceholderSource)) continue;
                var target = map[it.name];
                if (!target) continue;
                var f = new File(target);
                if (!f.exists) { failed.push(it.name + ': file not found'); continue; }
                try { it.replace(f); done.push(it.name); } catch (e) { failed.push(it.name + ': ' + e.toString()); }
            }
        } finally { app.endUndoGroup(); }
        return { ok: true, relinked: done, failed: failed };
    }

    function fontCheck(list) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var ps = KXBuild.resolveFont(list[i], { fontCache: {} });
            var exists = null;
            try { if (app.fonts && app.fonts.getFontsByPostScriptName && ps) exists = app.fonts.getFontsByPostScriptName(ps).length > 0; } catch (e) { /* ignore */ }
            out.push({ family: list[i].family, weight: list[i].weight, postScriptName: ps, installed: exists });
        }
        return out;
    }

    return { ping: ping, listComps: listComps, inspect: inspect, relink: relink, fontCheck: fontCheck };
})();

// ==========================================================================
// 5. Public API
// ==========================================================================
$.global.KeyframeX = (function () {
    var VERSION = '1.2.3';

    function wrap(fn) {
        try {
            var r = fn();
            if (r && r.ok === undefined) r = { ok: true, result: r };
            return KXJSON.stringify(r);
        } catch (e) {
            return KXJSON.stringify({ ok: false, error: e.toString().replace(/^Error:\s*/, ''), line: e.line || null });
        }
    }

    function readText(path) {
        var f = new File(path);
        if (!f.exists) throw new Error('File not found: ' + path);
        f.encoding = 'UTF-8';
        if (!f.open('r')) throw new Error('Cannot open ' + path);
        var s = f.read();
        f.close();
        return s;
    }

    function parseArg(s) {
        if (s === undefined || s === null || s === '') return {};
        return KXJSON.parse(s, false);
    }

    return {
        version: VERSION,
        ping: function () { return wrap(function () { var p = KXQuery.ping(); p.host = VERSION; return p; }); },
        /** Build a scene file. The engine writes a normalized copy (JSON.stringify), so it is parsed as trusted. */
        build: function (scenePath, optsJson) {
            return wrap(function () {
                var scene = KXJSON.parse(readText(scenePath), true);
                if (!scene || scene.format !== 'keyframex.scene') throw new Error('Not a KeyframeX scene');
                var opts = parseArg(optsJson);
                var dir = opts.sceneDir || new File(scenePath).parent.fsName;
                return KXBuild.build(scene, dir, opts);
            });
        },
        listComps: function () { return wrap(function () { return { ok: true, comps: KXQuery.listComps() }; }); },
        inspect: function (compId) { return wrap(function () { return { ok: true, comp: KXQuery.inspect(compId) }; }); },
        relink: function (mapJson) { return wrap(function () { return KXQuery.relink(parseArg(mapJson)); }); },
        fontCheck: function (listJson) { return wrap(function () { return { ok: true, fonts: KXQuery.fontCheck(parseArg(listJson)) }; }); }
    };
})();
