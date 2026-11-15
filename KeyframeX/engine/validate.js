'use strict';
/**
 * Scene validation (dependency-free). Mirrors engine/schema/scene.schema.json
 * and adds semantic checks (unknown matte ids, keys out of order, …).
 * Used by the panel before building and by the CLI, so a hand- or
 * AI-written scene gets precise, actionable errors instead of an AE crash.
 */
const LAYER_TYPES = ['shape', 'text', 'image', 'video', 'audio', 'solid', 'null'];

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function isVec(v, n) { return Array.isArray(v) && (n == null || v.length === n) && v.every(isNum); }

function checkTrack(tr, where, errors, check) {
  if (tr == null) return;
  if (typeof tr !== 'object' || Array.isArray(tr)) { errors.push(where + ': must be { value } or { keys }'); return; }
  if ('value' in tr) { if (check && !check(tr.value)) errors.push(where + '.value has the wrong shape'); return; }
  if (!Array.isArray(tr.keys) || !tr.keys.length) { errors.push(where + ': needs "value" or a non-empty "keys" array'); return; }
  let prev = -Infinity;
  tr.keys.forEach((k, i) => {
    if (!k || !isNum(k.t)) { errors.push(where + '.keys[' + i + '].t must be a number (seconds)'); return; }
    if (k.t < prev) errors.push(where + '.keys[' + i + '] is earlier than the key before it');
    prev = k.t;
    if (check && !check(k.v)) errors.push(where + '.keys[' + i + '].v has the wrong shape');
    if (k.interp && ['bezier', 'linear', 'hold'].indexOf(k.interp) < 0) errors.push(where + '.keys[' + i + '].interp must be bezier, linear or hold');
    for (const side of ['ei', 'eo']) {
      if (k[side] != null && !(Array.isArray(k[side]) && k[side].every((e) => isVec(e, 2) && e[1] >= 0.1 && e[1] <= 100))) {
        errors.push(where + '.keys[' + i + '].' + side + ' must be [[speed, influence 0.1-100], ...]');
      }
    }
  });
}

const vec2 = (v) => isVec(v, 2);
const vec3 = (v) => isVec(v, 3);
const num = (v) => isNum(v);
const str = (v) => typeof v === 'string';
const pathShape = (v) => Array.isArray(v) && v.every((p) => p && Array.isArray(p.v) && Array.isArray(p.i) && Array.isArray(p.o) && p.v.length === p.i.length && p.v.length === p.o.length && p.v.every((x) => isVec(x, 2)));

function validateScene(scene) {
  const errors = [], warnings = [];
  if (!scene || typeof scene !== 'object') return { ok: false, errors: ['Scene must be a JSON object'], warnings };
  if (scene.format !== 'keyframex.scene') errors.push('format must be "keyframex.scene"');
  if (scene.version !== 1) errors.push('version must be 1');
  const c = scene.comp || {};
  if (!scene.comp) errors.push('comp is required');
  if (!(isNum(c.width) && c.width >= 4 && c.width <= 30000)) errors.push('comp.width must be 4-30000');
  if (!(isNum(c.height) && c.height >= 4 && c.height <= 30000)) errors.push('comp.height must be 4-30000');
  if (!(isNum(c.fps) && c.fps >= 1 && c.fps <= 999)) errors.push('comp.fps must be 1-999');
  if (!(isNum(c.duration) && c.duration > 0 && c.duration <= 10800)) errors.push('comp.duration must be > 0 seconds');
  if (c.bgColor != null && !vec3(c.bgColor)) errors.push('comp.bgColor must be [r,g,b] in 0-1');
  const assets = new Map();
  (scene.assets || []).forEach((a, i) => {
    if (!a || !str(a.id)) errors.push('assets[' + i + '].id is required');
    else assets.set(a.id, a);
    if (a && !a.path && !a.rel && !a.url && !a.missing) warnings.push('assets[' + i + '] has no path');
  });
  if (!Array.isArray(scene.layers)) { errors.push('layers must be an array'); return { ok: !errors.length, errors, warnings }; }
  const ids = new Set();
  scene.layers.forEach((L) => { if (L && L.id) ids.add(L.id); });
  scene.layers.forEach((L, i) => {
    const w = 'layers[' + i + ']' + (L && L.name ? ' "' + L.name + '"' : '');
    if (!L || typeof L !== 'object') { errors.push(w + ' must be an object'); return; }
    if (!str(L.id)) errors.push(w + '.id is required');
    if (LAYER_TYPES.indexOf(L.type) < 0) errors.push(w + '.type must be one of ' + LAYER_TYPES.join(', '));
    if (L.in != null && !isNum(L.in)) errors.push(w + '.in must be seconds');
    if (L.out != null && !isNum(L.out)) errors.push(w + '.out must be seconds');
    if (isNum(L.in) && isNum(L.out) && L.out <= L.in) errors.push(w + ': out must be after in');
    if (L.matte && !ids.has(L.matte)) errors.push(w + '.matte refers to an unknown layer id "' + L.matte + '"');
    if (L.parent && !ids.has(L.parent)) errors.push(w + '.parent refers to an unknown layer id "' + L.parent + '"');
    const t = L.transform || {};
    checkTrack(t.anchor, w + '.transform.anchor', errors, vec2);
    checkTrack(t.position, w + '.transform.position', errors, vec2);
    checkTrack(t.scale, w + '.transform.scale', errors, vec2);
    checkTrack(t.rotation, w + '.transform.rotation', errors, num);
    checkTrack(t.opacity, w + '.transform.opacity', errors, num);
    if (L.type === 'shape') {
      const s = L.shape;
      if (!s || (s.kind !== 'rect' && s.kind !== 'ellipse' && s.kind !== 'path')) errors.push(w + '.shape.kind must be rect, ellipse or path');
      else if (s.kind === 'rect' || s.kind === 'ellipse') { checkTrack(s.size, w + '.shape.size', errors, vec2); checkTrack(s.roundness, w + '.shape.roundness', errors, num); if (!s.size) errors.push(w + '.shape.size is required'); }
      else checkTrack(s.paths, w + '.shape.paths', errors, pathShape);
      if (!L.fill && !L.stroke) warnings.push(w + ' has neither fill nor stroke (invisible)');
      if (L.fill) { checkTrack(L.fill.color, w + '.fill.color', errors, vec3); checkTrack(L.fill.opacity, w + '.fill.opacity', errors, num); }
      if (L.stroke) { checkTrack(L.stroke.color, w + '.stroke.color', errors, vec3); checkTrack(L.stroke.width, w + '.stroke.width', errors, num); checkTrack(L.stroke.opacity, w + '.stroke.opacity', errors, num); }
      if (L.trim) { checkTrack(L.trim.start, w + '.trim.start', errors, num); checkTrack(L.trim.end, w + '.trim.end', errors, num); }
    }
    if (L.type === 'text') {
      const tx = L.text;
      if (!tx) errors.push(w + '.text is required');
      else {
        checkTrack(tx.source, w + '.text.source', errors, str);
        if (!isNum(tx.size) || tx.size <= 0) errors.push(w + '.text.size must be > 0');
        if (tx.color && !vec3(tx.color)) errors.push(w + '.text.color must be [r,g,b] 0-1');
        if (!tx.font || !(tx.font.family || tx.font.postScriptName)) warnings.push(w + '.text.font missing: After Effects default font will be used');
        if (tx.counter) checkTrack(tx.counter.value, w + '.text.counter.value', errors, num);
      }
    }
    if (L.type === 'image' || L.type === 'video' || L.type === 'audio') {
      if (!L.asset) errors.push(w + '.asset is required');
      else if (!assets.has(L.asset)) errors.push(w + '.asset "' + L.asset + '" is not in scene.assets');
    }
    if (L.type === 'solid' && L.color && !vec3(L.color)) errors.push(w + '.color must be [r,g,b] 0-1');
    (L.effects || []).forEach((fx, j) => {
      if (!fx || ['dropShadow', 'blur', 'gradient', 'fill'].indexOf(fx.type) < 0) errors.push(w + '.effects[' + j + '].type must be dropShadow, blur, gradient or fill');
    });
  });
  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { validateScene, LAYER_TYPES };
