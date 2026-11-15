/*
 * KeyframeX virtual clock — injected before any page script runs.
 *
 * Replaces the page's notion of time so every frame can be rendered
 * deterministically, independent of how fast the machine is:
 *   - Date / Date.now / performance.now
 *   - requestAnimationFrame / cancelAnimationFrame
 *   - setTimeout / setInterval / clear*
 *   - CSS animations, CSS transitions and Web Animations (paused + seeked)
 *   - SVG SMIL (<animate>) via pauseAnimations / setCurrentTime
 *   - <video>/<audio> playback (logical clock; the media itself is not decoded)
 *   - Math.random (seeded)
 *
 * The capture engine drives it with `await window.__kx.advance(ms)`.
 */
(function () {
  'use strict';
  if (window.__kx) return;

  var SEED = typeof __KX_SEED__ === 'number' ? __KX_SEED__ : 1337;
  var EPOCH = 1735689600000; // fixed wall clock (2025-01-01T00:00:00Z) for determinism

  var RealDate = Date;
  var realSetTimeout = window.setTimeout.bind(window);
  var realClearTimeout = window.clearTimeout.bind(window);
  var origPause = Animation.prototype.pause;
  var origPlay = Animation.prototype.play;
  var origFinish = Animation.prototype.finish;
  var origAnimate = Element.prototype.animate;
  var origMediaPlay = HTMLMediaElement.prototype.play;
  var origMediaPause = HTMLMediaElement.prototype.pause;

  var vnow = 0; // virtual milliseconds since start

  // ---------- Date / performance ----------
  function KXDate() {
    var a = Array.prototype.slice.call(arguments);
    if (!(this instanceof KXDate)) return new RealDate(EPOCH + vnow).toString();
    if (a.length === 0) return new RealDate(EPOCH + vnow);
    return new (Function.prototype.bind.apply(RealDate, [null].concat(a)))();
  }
  KXDate.prototype = RealDate.prototype;
  KXDate.now = function () { return EPOCH + Math.floor(vnow); };
  KXDate.parse = RealDate.parse;
  KXDate.UTC = RealDate.UTC;
  window.Date = KXDate;
  try { performance.now = function () { return vnow; }; } catch (e) { /* ignore */ }

  // ---------- seeded Math.random (mulberry32) ----------
  var rs = SEED >>> 0;
  Math.random = function () {
    rs = (rs + 0x6D2B79F5) >>> 0;
    var t = rs;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // ---------- requestAnimationFrame ----------
  var rafSeq = 0;
  var rafQueue = new Map();
  window.requestAnimationFrame = function (cb) { var id = ++rafSeq; rafQueue.set(id, cb); return id; };
  window.cancelAnimationFrame = function (id) { rafQueue.delete(id); };

  // ---------- timers ----------
  var timerSeq = 0;
  var timers = new Map();
  function toFn(cb) { return typeof cb === 'function' ? cb : new Function(String(cb)); }
  window.setTimeout = function (cb, ms) {
    var id = ++timerSeq;
    timers.set(id, { due: vnow + Math.max(0, Number(ms) || 0), fn: toFn(cb), args: Array.prototype.slice.call(arguments, 2), every: 0, seq: id });
    return id;
  };
  window.setInterval = function (cb, ms) {
    var id = ++timerSeq;
    var every = Math.max(1, Number(ms) || 0);
    timers.set(id, { due: vnow + every, fn: toFn(cb), args: Array.prototype.slice.call(arguments, 2), every: every, seq: id });
    return id;
  };
  window.clearTimeout = window.clearInterval = function (id) { timers.delete(id); };

  // ---------- Web Animations / CSS animations / transitions ----------
  var animState = new WeakMap(); // Animation -> { born, userPaused, done }
  function stateOf(a) {
    var s = animState.get(a);
    if (!s) {
      // Real time may have passed while the page loaded; the animation starts now on the virtual clock.
      s = { born: vnow, userPaused: false, done: false };
      animState.set(a, s);
      try { origPause.call(a); } catch (e) { /* ignore */ }
    }
    return s;
  }
  Animation.prototype.pause = function () { var s = stateOf(this); s.userPaused = true; return origPause.call(this); };
  Animation.prototype.play = function () {
    var s = stateOf(this);
    var ct = this.currentTime || 0;
    var rate = this.playbackRate || 1;
    var end = 0;
    try { end = this.effect ? this.effect.getComputedTiming().endTime : 0; } catch (e) { /* ignore */ }
    if (s.done || (rate > 0 && ct >= end && isFinite(end))) ct = 0;
    s.userPaused = false;
    s.done = false;
    s.born = vnow - ct / rate;
    origPlay.call(this);
    origPause.call(this);
    this.currentTime = ct;
  };
  Element.prototype.animate = function () {
    var a = origAnimate.apply(this, arguments);
    stateOf(a);
    return a;
  };
  function syncAnimations() {
    if (!document.getAnimations) return;
    var list = document.getAnimations();
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var s = stateOf(a);
      if (s.userPaused || s.done) continue;
      var rate = a.playbackRate || 1;
      var local = (vnow - s.born) * rate;
      var end = Infinity;
      try { end = a.effect ? a.effect.getComputedTiming().endTime : Infinity; } catch (e) { /* ignore */ }
      if (rate > 0 && isFinite(end) && local >= end) {
        s.done = true;
        try { origFinish.call(a); } catch (e) { a.currentTime = end; }
      } else {
        if (a.playState !== 'paused') { try { origPause.call(a); } catch (e) { /* ignore */ } }
        a.currentTime = Math.max(0, local);
      }
    }
  }

  // ---------- SVG SMIL ----------
  function syncSMIL() {
    var svgs = document.getElementsByTagName('svg');
    for (var i = 0; i < svgs.length; i++) {
      var s = svgs[i];
      if (s.ownerSVGElement || !s.pauseAnimations) continue;
      try { s.pauseAnimations(); s.setCurrentTime(vnow / 1000); } catch (e) { /* ignore */ }
    }
  }

  // ---------- media (logical clock) ----------
  var media = new Set();
  HTMLMediaElement.prototype.play = function () {
    media.add(this);
    this.__kxPlaying = true;
    this.__kxPlayAt = vnow;
    this.__kxFrom = this.currentTime || 0;
    try { origMediaPause.call(this); } catch (e) { /* ignore */ }
    try { this.dispatchEvent(new Event('play')); this.dispatchEvent(new Event('playing')); } catch (e) { /* ignore */ }
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function () {
    if (this.__kxPlaying) this.__kxFrom = mediaTime(this);
    this.__kxPlaying = false;
    try { origMediaPause.call(this); } catch (e) { /* ignore */ }
  };
  function mediaTime(m) {
    if (!m.__kxPlaying) return m.__kxFrom != null ? m.__kxFrom : (m.currentTime || 0);
    var t = m.__kxFrom + (vnow - m.__kxPlayAt) / 1000 * (m.playbackRate || 1);
    if (isFinite(m.duration) && m.duration > 0) {
      if (m.loop) t = t % m.duration; else t = Math.min(t, m.duration);
    }
    return t;
  }
  function syncMedia() {
    var els = document.querySelectorAll('video,audio');
    for (var i = 0; i < els.length; i++) {
      var m = els[i];
      if (!media.has(m)) {
        media.add(m);
        // Autoplay may have advanced in real time while the page loaded: restart on the virtual clock.
        m.__kxFrom = m.autoplay ? 0 : (m.currentTime || 0);
        m.__kxPlaying = !!m.autoplay;
        m.__kxPlayAt = vnow;
        try { origMediaPause.call(m); } catch (e) { /* ignore */ }
      }
    }
  }

  // ---------- the driver ----------
  function runDueTimers(target) {
    var guard = 0;
    for (;;) {
      var next = null;
      timers.forEach(function (t, id) {
        if (t.due <= target && (!next || t.due < next.t.due || (t.due === next.t.due && t.seq < next.t.seq))) next = { id: id, t: t };
      });
      if (!next) return;
      if (++guard > 20000) throw new Error('Timer loop: more than 20000 timers fired in one frame');
      vnow = Math.max(vnow, next.t.due);
      if (next.t.every) { next.t.due += next.t.every; next.t.seq = ++timerSeq; } else timers.delete(next.id);
      try { next.t.fn.apply(window, next.t.args); } catch (e) { reportError(e); }
    }
  }
  function reportError(e) {
    try { (window.__kxErrors || (window.__kxErrors = [])).push(String(e && e.stack || e).slice(0, 400)); } catch (x) { /* ignore */ }
  }
  window.addEventListener('error', function (ev) { reportError(ev.error || ev.message); });

  function flushMicrotasks() { return new Promise(function (r) { realSetTimeout(r, 0); }); }

  window.__kx = {
    get now() { return vnow; },
    /** Advance virtual time to `target` ms and render that moment. */
    advance: async function (target) {
      if (target < vnow) target = vnow;
      // Fire timers in order, letting promise chains settle between them.
      for (var pass = 0; pass < 50; pass++) {
        var before = timers.size;
        runDueTimers(target);
        await flushMicrotasks();
        var pending = false;
        timers.forEach(function (t) { if (t.due <= target) pending = true; });
        if (!pending && timers.size === before) break;
        if (!pending) break;
      }
      vnow = target;
      var cbs = Array.from(rafQueue.values());
      rafQueue.clear();
      for (var i = 0; i < cbs.length; i++) { try { cbs[i](vnow); } catch (e) { reportError(e); } }
      await flushMicrotasks();
      syncMedia();
      syncAnimations();
      syncSMIL();
      return vnow;
    },
    mediaTime: mediaTime,
    errors: function () { return (window.__kxErrors || []).slice(); },
    realSetTimeout: realSetTimeout,
    realClearTimeout: realClearTimeout,
  };
})();
