/* KeyframeX panel — shared helpers and Node services (namespace KX). */
(function (root) {
  'use strict';
  var KX = root.KX = root.KX || {};

  KX.$ = function (id) { return document.getElementById(id); };
  KX.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  KX.show = function (el, on) { (typeof el === 'string' ? KX.$(el) : el).classList.toggle('hidden', on === false); };
  KX.hide = function (el) { KX.show(el, false); };

  // ----- Node services (null when the page is opened in a normal browser) -----
  KX.node = null;
  if (CEP.hasNode) {
    try {
      KX.node = {
        path: CEP.nodeRequire('path'),
        fs: CEP.nodeRequire('fs'),
        os: CEP.nodeRequire('os'),
        engine: CEP.require('engine/index.js'),
        pipeline: CEP.require('shared/pipeline.js'),
        settings: CEP.require('shared/settings.js'),
      };
    } catch (e) {
      root.__kxBootError = e;
    }
  }

  var FALLBACK = { convert: { fps: 0, quality: 'balanced', target: 'new', installFonts: true }, browserPath: '', recent: [] };
  KX.settings = function () {
    if (KX.node) return KX.node.settings.load();
    try { return JSON.parse(localStorage.getItem('kx-settings')) || FALLBACK; } catch (e) { return FALLBACK; }
  };
  KX.updateSettings = function (fn) {
    if (KX.node) return KX.node.settings.update(fn);
    var s = KX.settings(); fn(s); localStorage.setItem('kx-settings', JSON.stringify(s)); return s;
  };

  // ----- activity log (newest at the bottom) -----
  KX.log = function (msg, level) {
    var el = KX.$('log');
    var t = new Date();
    var h = t.getHours(), ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    var stamp = '[' + h + ':' + ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2) + ' ' + ap + ']';
    var line = document.createElement('div');
    if (level) line.className = level;
    line.textContent = stamp + ' ' + (level === 'err' ? '[ERROR] ' : level === 'warn' ? '[WARN] ' : level === 'ok' ? '[OK] ' : '') + msg;
    el.appendChild(line);
    while (el.childNodes.length > 400) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
    if (root.console) console.log('[KeyframeX] ' + msg);
  };

  var toastTimer = null;
  KX.toast = function (msg, kind) {
    var el = KX.$('toast');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, kind === 'bad' ? 7000 : 3500);
  };

  /** Segmented control. */
  KX.seg = function (id, value, onChange) {
    var el = KX.$(id);
    function set(v) {
      Array.prototype.forEach.call(el.querySelectorAll('button'), function (b) { b.classList.toggle('on', b.getAttribute('data-v') === v); });
      el.setAttribute('data-value', v);
    }
    set(value);
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      set(b.getAttribute('data-v'));
      if (onChange) onChange(b.getAttribute('data-v'));
    });
    return { get: function () { return el.getAttribute('data-value'); }, set: set };
  };

  KX.fmtDur = function (s) { return s >= 60 ? Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's' : (Math.round(s * 10) / 10) + 's'; };
  KX.shortPath = function (p) {
    if (!p) return '';
    var home = KX.node ? KX.node.os.homedir() : '';
    return home && p.indexOf(home) === 0 ? '~' + p.slice(home.length) : p;
  };

  /** Call the After Effects host script (rejects with a readable error). */
  KX.host = function (fn, args) {
    if (!KX.node) return Promise.reject(new Error('Not running inside After Effects.'));
    return KX.node.pipeline.hostCall(CEP.evalScript, fn, args || []);
  };
})(window);
