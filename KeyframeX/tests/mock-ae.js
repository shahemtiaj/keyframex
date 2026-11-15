'use strict';
/**
 * A strict, minimal mock of the After Effects scripting DOM, so the ExtendScript
 * builder can be exercised in Node without After Effects.
 *
 * It is NOT After Effects: it checks that the builder only uses property match
 * names that exist, passes values of the right dimension, keeps keys ordered,
 * and wires mattes/effects/text the way the AE API expects. Visual fidelity
 * must still be checked inside After Effects.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// matchName → { dims, spatial, color, kind } for leaf properties; groups list their children.
const LEAF = {
  'ADBE Anchor Point': { dims: 3, spatial: true }, 'ADBE Position': { dims: 3, spatial: true }, 'ADBE Scale': { dims: 3, easeDims: 3 },
  'ADBE Rotate Z': { dims: 1 }, 'ADBE Opacity': { dims: 1 },
  'ADBE Vector Rect Size': { dims: 2, easeDims: 2 }, 'ADBE Vector Rect Position': { dims: 2, spatial: true }, 'ADBE Vector Rect Roundness': { dims: 1 },
  'ADBE Vector Ellipse Size': { dims: 2, easeDims: 2 },
  'ADBE Vector Shape': { kind: 'shape' },
  'ADBE Vector Trim Start': { dims: 1 }, 'ADBE Vector Trim End': { dims: 1 },
  'ADBE Vector Stroke Color': { dims: 4, color: true }, 'ADBE Vector Stroke Opacity': { dims: 1 }, 'ADBE Vector Stroke Width': { dims: 1 },
  'ADBE Vector Stroke Line Cap': { dims: 1, noKeys: true }, 'ADBE Vector Stroke Line Join': { dims: 1, noKeys: true },
  'ADBE Vector Stroke Dash 1': { dims: 1 }, 'ADBE Vector Stroke Gap 1': { dims: 1 }, 'ADBE Vector Stroke Dash 2': { dims: 1 }, 'ADBE Vector Stroke Gap 2': { dims: 1 },
  'ADBE Vector Stroke Dash 3': { dims: 1 }, 'ADBE Vector Stroke Gap 3': { dims: 1 }, 'ADBE Vector Stroke Offset': { dims: 1 },
  'ADBE Vector Fill Color': { dims: 4, color: true }, 'ADBE Vector Fill Opacity': { dims: 1 }, 'ADBE Vector Fill Rule': { dims: 1, noKeys: true },
  'ADBE Mask Shape': { kind: 'shape' },
  'ADBE Text Document': { kind: 'text' },
  'ADBE Time Remapping': { dims: 1 },
  'ADBE Drop Shadow-0001': { dims: 4, color: true }, 'ADBE Drop Shadow-0002': { dims: 1, max: 255 }, 'ADBE Drop Shadow-0003': { dims: 1 }, 'ADBE Drop Shadow-0004': { dims: 1 }, 'ADBE Drop Shadow-0005': { dims: 1 },
  'ADBE Gaussian Blur 2-0001': { dims: 1 }, 'ADBE Gaussian Blur 2-0002': { dims: 1 }, 'ADBE Gaussian Blur 2-0003': { dims: 1 },
  'ADBE Fill-0002': { dims: 4, color: true },
  'ADBE Ramp-0001': { dims: 2, spatial: true }, 'ADBE Ramp-0002': { dims: 4, color: true }, 'ADBE Ramp-0003': { dims: 2, spatial: true }, 'ADBE Ramp-0004': { dims: 4, color: true }, 'ADBE Ramp-0005': { dims: 1 },
  'ADBE Set Matte3-0001': { dims: 1, layerRef: true }, 'ADBE Set Matte3-0002': { dims: 1 },
  'ADBE Slider Control-0001': { dims: 1 },
};
const GROUPS = {
  'ADBE Transform Group': ['ADBE Anchor Point', 'ADBE Position', 'ADBE Scale', 'ADBE Rotate Z', 'ADBE Opacity'],
  'ADBE Vector Group': ['ADBE Vectors Group'],
  'ADBE Vector Shape - Rect': ['ADBE Vector Rect Size', 'ADBE Vector Rect Position', 'ADBE Vector Rect Roundness'],
  'ADBE Vector Shape - Ellipse': ['ADBE Vector Ellipse Size'],
  'ADBE Vector Shape - Group': ['ADBE Vector Shape'],
  'ADBE Vector Filter - Trim': ['ADBE Vector Trim Start', 'ADBE Vector Trim End'],
  'ADBE Vector Graphic - Stroke': ['ADBE Vector Stroke Color', 'ADBE Vector Stroke Opacity', 'ADBE Vector Stroke Width', 'ADBE Vector Stroke Line Cap', 'ADBE Vector Stroke Line Join', 'ADBE Vector Stroke Dashes'],
  'ADBE Vector Stroke Dashes': ['ADBE Vector Stroke Offset'],
  'ADBE Vector Graphic - Fill': ['ADBE Vector Fill Color', 'ADBE Vector Fill Opacity', 'ADBE Vector Fill Rule'],
  'ADBE Mask Atom': ['ADBE Mask Shape'],
  'ADBE Text Properties': ['ADBE Text Document'],
  'ADBE Drop Shadow': ['ADBE Drop Shadow-0001', 'ADBE Drop Shadow-0002', 'ADBE Drop Shadow-0003', 'ADBE Drop Shadow-0004', 'ADBE Drop Shadow-0005'],
  'ADBE Gaussian Blur 2': ['ADBE Gaussian Blur 2-0001', 'ADBE Gaussian Blur 2-0002', 'ADBE Gaussian Blur 2-0003'],
  'ADBE Fill': ['ADBE Fill-0002'],
  'ADBE Ramp': ['ADBE Ramp-0001', 'ADBE Ramp-0002', 'ADBE Ramp-0003', 'ADBE Ramp-0004', 'ADBE Ramp-0005'],
  'ADBE Set Matte3': ['ADBE Set Matte3-0001', 'ADBE Set Matte3-0002'],
  'ADBE Slider Control': ['ADBE Slider Control-0001'],
};
// Groups that accept addProperty(matchName) and which children they accept.
const ADDABLE = {
  'ADBE Root Vectors Group': ['ADBE Vector Group'],
  'ADBE Vectors Group': ['ADBE Vector Shape - Rect', 'ADBE Vector Shape - Ellipse', 'ADBE Vector Shape - Group', 'ADBE Vector Filter - Trim', 'ADBE Vector Graphic - Stroke', 'ADBE Vector Graphic - Fill', 'ADBE Vector Group'],
  'ADBE Effect Parade': ['ADBE Drop Shadow', 'ADBE Gaussian Blur 2', 'ADBE Fill', 'ADBE Ramp', 'ADBE Set Matte3', 'ADBE Slider Control'],
  'ADBE Mask Parade': ['ADBE Mask Atom'],
  'ADBE Vector Stroke Dashes': ['ADBE Vector Stroke Dash 1', 'ADBE Vector Stroke Gap 1', 'ADBE Vector Stroke Dash 2', 'ADBE Vector Stroke Gap 2', 'ADBE Vector Stroke Dash 3', 'ADBE Vector Stroke Gap 3'],
};

/**
 * opts.panelJustification — the Paragraph panel's justification new text layers start with
 *   (default left, 7413).
 * opts.justificationBug — 'same-doc' (default): like real After Effects, a justification
 *   change is dropped when the same TextDocument also changed its text; 'never': the
 *   justification can never be changed (worst case, exercises the anchor fallback);
 *   false: no bug.
 */
function createAE(log, opts) {
  opts = opts || {};
  const panelJust = opts.panelJustification || 7413;
  const bug = opts.justificationBug === undefined ? 'same-doc' : opts.justificationBug;
  // opts.textOffset: [dx, dy] every text layer is drawn away from its origin (what a user's
  // After Effects did: left-aligned text came in ~1300 px to the right).
  const textOffset = opts.textOffset || [0, 0];
  const g = {};
  const calls = log || [];
  class KeyframeEase { constructor(speed, influence) { if (!(influence >= 0.1 && influence <= 100)) throw new Error('KeyframeEase influence out of range: ' + influence); this.speed = speed; this.influence = influence; } }
  class Shape { constructor() { this.vertices = []; this.inTangents = []; this.outTangents = []; this.closed = true; } }
  class TextDocument {
    constructor(t) { this._text = t; this._textChanged = false; this.font = 'ArialMT'; this.fontSize = 36; this.fillColor = [1, 1, 1]; this.applyFill = true; this.applyStroke = false; this.tracking = 0; this.justification = panelJust; }
    get text() { return this._text; }
    set text(v) { this._text = String(v); this._textChanged = true; }
    resetCharStyle() {}
    resetParagraphStyle() { this.justification = 7413; }
    _copy() { const d = new TextDocument(this._text); for (const k of Object.keys(this)) if (k !== '_text' && k !== '_textChanged') d[k] = Array.isArray(this[k]) ? this[k].slice() : this[k]; return d; }
  }
  // What AE stores when a TextDocument is set over an old one (old may be undefined).
  function storeDoc(old, v) {
    const d = v._copy();
    if (old && (bug === 'never' || (bug === 'same-doc' && v._textChanged))) d.justification = old.justification;
    return d;
  }
  const PropertyType = { PROPERTY: 6812, INDEXED_GROUP: 6813, NAMED_GROUP: 6814 };

  class Property {
    constructor(matchName, parent) {
      this.matchName = matchName; this.parentProperty = parent; this.name = matchName;
      this.spec = LEAF[matchName];
      if (!this.spec) throw new Error('Mock AE: unknown property ' + matchName);
      this.propertyType = PropertyType.PROPERTY;
      this.keys = []; this._value = null; this.expression = '';
      this.isSpatial = !!this.spec.spatial;
      this.canVaryOverTime = !this.spec.noKeys;
      if (this.spec.max) { this.hasMax = true; this.maxValue = this.spec.max; } else this.hasMax = false;
    }
    _check(v) {
      const s = this.spec;
      if (s.kind === 'shape') { if (!(v instanceof Shape)) throw new Error(this.matchName + ': expected a Shape'); if (v.vertices.length !== v.inTangents.length || v.vertices.length !== v.outTangents.length) throw new Error(this.matchName + ': vertex/tangent count mismatch'); return; }
      if (s.kind === 'text') { if (!(v instanceof TextDocument)) throw new Error(this.matchName + ': expected a TextDocument'); return; }
      if (s.dims === 1) { if (typeof v !== 'number' || !isFinite(v)) throw new Error(this.matchName + ': expected a number, got ' + JSON.stringify(v)); return; }
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'number' || !isFinite(x))) throw new Error(this.matchName + ': expected a number array, got ' + JSON.stringify(v));
      if (s.color && v.length !== 4 && v.length !== 3) throw new Error(this.matchName + ': colour needs 3 or 4 values');
      if (!s.color && s.dims >= 2 && v.length < 2) throw new Error(this.matchName + ': needs at least 2 values');
    }
    get value() { return this._value instanceof TextDocument ? this._value._copy() : this._value; }
    get numKeys() { return this.keys.length; }
    _store(old, v) { return v instanceof TextDocument ? storeDoc(old, v) : v; }
    setValue(v) { if (this.keys.length) throw new Error(this.matchName + ': setValue on a keyed property'); this._check(v); this._value = this._store(this._value, v); calls.push(['setValue', this.matchName]); }
    setValueAtTime(t, v) {
      if (!this.canVaryOverTime) throw new Error(this.matchName + ' cannot be keyed');
      this._check(v);
      const i = this.keys.findIndex((k) => Math.abs(k.t - t) < 1e-9);
      const old = i >= 0 ? this.keys[i].v : this._value;
      if (i >= 0) this.keys[i].v = this._store(old, v); else { this.keys.push({ t, v: this._store(old, v) }); this.keys.sort((a, b) => a.t - b.t); }
      this._value = this.keys[0].v;
    }
    setValueAtKey(i, v) { const k = this._key(i); this._check(v); k.v = this._store(k.v, v); this._value = this.keys[0].v; }
    setValuesAtTimes(ts, vs) { if (ts.length !== vs.length) throw new Error('setValuesAtTimes length mismatch'); for (let i = 0; i < ts.length; i++) this.setValueAtTime(ts[i], vs[i]); }
    removeKey(i) { this.keys.splice(i - 1, 1); }
    nearestKeyIndex(t) { let b = 1, d = Infinity; this.keys.forEach((k, i) => { const x = Math.abs(k.t - t); if (x < d) { d = x; b = i + 1; } }); return b; }
    keyValue(i) { const v = this._key(i).v; if (v instanceof TextDocument) return v._copy(); return this.spec.dims === 3 && Array.isArray(v) && v.length === 2 ? [v[0], v[1], 0] : v; }
    _key(i) { if (i < 1 || i > this.keys.length) throw new Error(this.matchName + ': key index ' + i + ' out of range'); return this.keys[i - 1]; }
    setTemporalEaseAtKey(i, inE, outE) {
      const k = this._key(i);
      const want = this.isSpatial ? 1 : (this.spec.easeDims || 1);
      if (inE.length !== want || outE.length !== want) throw new Error(this.matchName + ': ease needs ' + want + ' KeyframeEase objects');
      if (!inE.every((e) => e instanceof KeyframeEase) || !outE.every((e) => e instanceof KeyframeEase)) throw new Error('ease entries must be KeyframeEase');
      k.ein = inE; k.eout = outE;
    }
    setInterpolationTypeAtKey(i, a, b) { const k = this._key(i); if (![6612, 6613, 6614].includes(a) || ![6612, 6613, 6614].includes(b)) throw new Error('bad interpolation type'); k.inT = a; k.outT = b; }
    setSpatialAutoBezierAtKey(i) { if (!this.isSpatial) throw new Error('not spatial'); this._key(i); }
    setSpatialContinuousAtKey(i) { if (!this.isSpatial) throw new Error('not spatial'); this._key(i); }
    setSpatialTangentsAtKey(i, a, b) { if (!this.isSpatial) throw new Error('not spatial'); const n = this.keyValue(i).length; if (a.length !== n || b.length !== n) throw new Error(this.matchName + ': tangents need ' + n + ' values'); }
    setRovingAtKey(i) { if (!this.isSpatial) throw new Error('not spatial'); this._key(i); }
  }

  class Group {
    constructor(matchName, parent, layer) {
      this.matchName = matchName; this.parentProperty = parent; this.layer = layer; this.name = matchName;
      this.propertyType = PropertyType.NAMED_GROUP;
      this.children = [];
      for (const c of GROUPS[matchName] || []) this.children.push(make(c, this, layer));
    }
    get numProperties() { return this.children.length; }
    property(k) {
      if (typeof k === 'number') return this.children[k - 1] || null;
      const c = this.children.find((x) => x.matchName === k || x.name === k);
      if (!c) throw new Error('Mock AE: ' + this.matchName + ' has no property "' + k + '"');
      return c;
    }
    addProperty(mn) {
      const ok = ADDABLE[this.matchName];
      if (!ok || ok.indexOf(mn) < 0) throw new Error('Mock AE: cannot add ' + mn + ' to ' + this.matchName);
      const c = make(mn, this, this.layer);
      this.children.push(c);
      calls.push(['addProperty', this.matchName, mn]);
      return c;
    }
  }
  function make(mn, parent, layer) {
    if (LEAF[mn]) return new Property(mn, parent);
    return new Group(mn, parent, layer);
  }

  class FolderItem { constructor(name) { this.name = name; this.parentFolder = null; this.id = ++ids; } }
  class FootageItem { constructor(name, w, h, src) { this.name = name; this.width = w; this.height = h; this.mainSource = src || {}; this.id = ++ids; this.parentFolder = null; this.duration = 10; } replace(f) { this.mainSource = {}; this.file = f; } }
  class PlaceholderSource {}
  class SolidSource {}
  let ids = 0;

  class Layer {
    constructor(comp, kind, source) {
      this.containingComp = comp; this.kind = kind; this.source = source || null; this.name = kind + ' layer'; this.comment = '';
      this.enabled = true; this.startTime = 0; this._in = 0; this._out = comp.duration; this.parent = null;
      this.groups = { 'ADBE Transform Group': new Group('ADBE Transform Group', null, this), 'ADBE Effect Parade': new Group('ADBE Effect Parade', null, this), 'ADBE Mask Parade': new Group('ADBE Mask Parade', null, this) };
      if (kind === 'shape') this.groups['ADBE Root Vectors Group'] = new Group('ADBE Root Vectors Group', null, this);
      if (kind === 'text') this.groups['ADBE Text Properties'] = new Group('ADBE Text Properties', null, this);
      if (kind === 'footage') { this.groups['ADBE Time Remapping'] = new Property('ADBE Time Remapping', null); this.canSetTimeRemapEnabled = true; }
      this.trackMatteLayer = null; this.trackMatteType = 0;
    }
    get index() { return this.containingComp._layers.indexOf(this) + 1; }
    get inPoint() { return this._in; }
    set inPoint(v) { if (v < 0) throw new Error('inPoint < 0'); this._in = v; }
    get outPoint() { return this._out; }
    set outPoint(v) { if (v <= this._in) throw new Error('outPoint must be after inPoint'); this._out = v; }
    property(mn) { const g = this.groups[mn]; if (!g) throw new Error('Mock AE: layer has no ' + mn); return g; }
    sourceRectAtTime() {
      if (this instanceof TextLayer) { // rough point-text box around the layer origin
        const d = this.groups['ADBE Text Properties'].property('ADBE Text Document')._value;
        const w = d._text.length * d.fontSize * 0.55, h = d.fontSize;
        const left = d.justification === 7415 ? -w / 2 : (d.justification === 7414 ? -w : 0);
        return { left: left + textOffset[0], top: -h * 0.75 + textOffset[1], width: w, height: h };
      }
      return { left: -50, top: -50, width: 100, height: 100 };
    }
    setTrackMatte(m, type) { if (!(m instanceof Layer)) throw new Error('setTrackMatte needs a layer'); if (m === this) throw new Error('matte cannot be itself'); this.trackMatteLayer = m; this.trackMatteType = type; }
    remove() { const L = this.containingComp._layers; L.splice(L.indexOf(this), 1); }
    duplicate() { const d = new Layer(this.containingComp, this.kind, this.source); this.containingComp._layers.splice(this.index - 1, 0, d); return d; }
    moveBefore(l) { const L = this.containingComp._layers; L.splice(L.indexOf(this), 1); L.splice(L.indexOf(l), 0, this); }
    set timeRemapEnabled(v) { if (v) { const tr = this.groups['ADBE Time Remapping']; tr.keys = [{ t: 0, v: 0 }, { t: 1, v: 1 }]; } }
  }
  class TextLayer extends Layer {}
  class ShapeLayer extends Layer {}
  class AVLayer extends Layer {}
  class CameraLayer {} class LightLayer {}

  class CompItem {
    constructor(name, w, h, par, dur, fps) {
      if (!(w >= 4 && h >= 4 && dur > 0 && fps > 0)) throw new Error('addComp: bad arguments');
      if (w !== Math.round(w) || h !== Math.round(h)) throw new Error('addComp: width/height must be integers');
      this.name = name; this.width = w; this.height = h; this.duration = dur; this.frameRate = fps; this.frameDuration = 1 / fps; this.id = ++ids; this._layers = []; this.time = 0; this.parentFolder = null;
      const self = this;
      this.layers = {
        addShape() { const l = new ShapeLayer(self, 'shape'); self._layers.unshift(l); return l; },
        addText(t) { if (typeof t !== 'string') throw new Error('addText needs a string'); const l = new TextLayer(self, 'text'); l.groups['ADBE Text Properties'].property('ADBE Text Document')._value = new TextDocument(t); self._layers.unshift(l); return l; },
        addSolid(c, n, w, h) { if (c.length !== 3) throw new Error('addSolid colour needs 3 values'); const l = new AVLayer(self, 'solid', new FootageItem(n, w, h, new SolidSource())); self._layers.unshift(l); return l; },
        addNull() { const l = new AVLayer(self, 'null'); l.nullLayer = true; self._layers.unshift(l); return l; },
        add(item) { if (!item) throw new Error('layers.add needs an item'); const l = new AVLayer(self, 'footage', item); self._layers.unshift(l); return l; },
      };
    }
    get numLayers() { return this._layers.length; }
    layer(i) { return this._layers[i - 1]; }
    openInViewer() {}
  }

  const items = [];
  const project = {
    rootFolder: new FolderItem('Root'),
    get numItems() { return items.length; },
    item(i) { return items[i - 1]; },
    items: {
      addFolder(n) { const f = new FolderItem(n); items.push(f); return f; },
      addComp(...a) { const c = new CompItem(...a); items.push(c); return c; },
    },
    importFile(io) { if (!io.file.exists) throw new Error('import: missing file'); const it = new FootageItem(path.basename(io.file.fsName), 400, 300); items.push(it); return it; },
    importPlaceholder(n, w, h) { const it = new FootageItem(n, w, h, new PlaceholderSource()); items.push(it); return it; },
    activeItem: null,
    file: null,
  };
  class File {
    constructor(p) { this.fsName = p; this.encoding = 'UTF-8'; }
    get exists() { return fs.existsSync(this.fsName); }
    get parent() { return { fsName: path.dirname(this.fsName) }; }
    open() { return this.exists; }
    read() { return fs.readFileSync(this.fsName, 'utf8'); }
    close() {}
  }
  class ImportOptions { constructor(f) { this.file = f; } }
  let undoDepth = 0;
  const app = {
    project, version: '24.0x00', buildNumber: 0,
    beginUndoGroup() { undoDepth++; }, endUndoGroup() { undoDepth--; },
    newProject() {},
    fonts: { getFontsByPostScriptName(ps) { return /^(LiberationSans|LiberationSerif|ArialMT|Arial)/.test(ps) ? [{ postScriptName: ps }] : []; }, getFontsByFamilyNameAndStyleName() { return []; } },
    get undoDepth() { return undoDepth; },
  };
  Object.assign(g, {
    app, File, ImportOptions, Shape, KeyframeEase, TextDocument, PropertyType,
    FolderItem, FootageItem, CompItem, PlaceholderSource, SolidSource,
    Layer, AVLayer, TextLayer, ShapeLayer, CameraLayer, LightLayer,
    KeyframeInterpolationType: { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 },
    ParagraphJustification: { LEFT_JUSTIFY: 7413, RIGHT_JUSTIFY: 7414, CENTER_JUSTIFY: 7415 },
    BlendingMode: { NORMAL: 5212, MULTIPLY: 5216, SCREEN: 5219, OVERLAY: 5222, DARKEN: 5215, LIGHTEN: 5218, COLOR_DODGE: 5220, COLOR_BURN: 5217, HARD_LIGHT: 5224, SOFT_LIGHT: 5223, DIFFERENCE: 5226, EXCLUSION: 5227, HUE: 5228, SATURATION: 5229, COLOR: 5230, LUMINOSITY: 5231, ADD: 5213 },
    TrackMatteType: { ALPHA: 5013, ALPHA_INVERTED: 5014, LUMA: 5015, LUMA_INVERTED: 5016, NO_TRACK_MATTE: 5012 },
    calls,
  });
  g.$ = { global: g, fileName: '', evalFile(f) { vm.runInContext(fs.readFileSync(f, 'utf8'), g, { filename: f }); } };
  return g;
}

/** Load the host script (resolving //@include) into a fresh mock context. */
function loadHost(hostFile, ctx) {
  const dir = path.dirname(hostFile);
  const src = fs.readFileSync(hostFile, 'utf8').replace(/^\/\/@include\s+"([^"]+)"/gm, (m, f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: hostFile });
  return ctx.KeyframeX;
}

module.exports = { createAE, loadHost };
