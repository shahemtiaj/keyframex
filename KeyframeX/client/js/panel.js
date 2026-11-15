/* KeyframeX panel — drop → convert → review → build. */
(function (root) {
  'use strict';
  var KX = root.KX;
  var $ = KX.$;
  var st = { input: null, scene: null, scenePath: null, media: null, convertedQuality: null, busy: false, abort: null, placeholders: [] };
  var target, quality;

  var HINT_TARGET = { 'new': 'own folder in the Project panel', active: 'one layer in the open comp, at the playhead' };
  var HINT_QUALITY = { light: 'fewest keys, easiest to edit', balanced: 'clean and close', exact: 'to the pixel' };

  // ------------------------------------------------------------ views
  function view(name) {
    KX.show('emptyCard', name === 'empty');
    KX.show('convCard', name === 'converting');
    var loaded = name === 'loaded';
    KX.show('fileCard', loaded);
    KX.show('setCard', loaded);
    KX.show('buildBox', loaded);
    KX.show('mediaCard', loaded && st.media && st.media.online && st.media.online.length > 0);
    if (!loaded) KX.hide('result');
  }

  function setBusy(b) {
    st.busy = b;
    $('btnBuild').disabled = b;
    $('relenGo').disabled = b;
    $('btnChoose').disabled = b;
  }

  function renderRecent() {
    var list = (KX.settings().recent || []).filter(function (p) { return !KX.node || KX.node.fs.existsSync(p); }).slice(0, 5);
    KX.show('recentLab', list.length > 0);
    $('recent').innerHTML = list.map(function (p) {
      var name = KX.node ? KX.node.path.basename(p) : p;
      var dir = KX.node ? KX.shortPath(KX.node.path.dirname(p)) : '';
      return '<a data-p="' + KX.esc(p) + '" title="' + KX.esc(p) + '"><span>' + KX.esc(name) + '</span><small>' + KX.esc(dir) + '</small></a>';
    }).join('');
  }

  // ------------------------------------------------------------ open / convert
  function open(p) {
    if (!KX.node) { KX.toast('Open the panel inside After Effects to convert files.', 'bad'); return; }
    if (st.busy) return;
    var input;
    try { input = KX.node.engine.resolveInput(p); } catch (e) { KX.toast(e.message, 'bad'); KX.log(e.message, 'err'); return; }
    st.input = input; st.scene = null; st.scenePath = null; st.media = null;
    KX.node.settings.addRecent(input.path);
    KX.log('Loading file: ' + KX.node.path.basename(input.path));
    if (input.kind === 'scene') loadScene(input.path); else convert();
  }

  function loadScene(p) {
    try {
      var r = KX.node.engine.loadScene(p);
      if (!r.validation.ok) {
        r.validation.errors.slice(0, 20).forEach(function (m) { KX.log(m, 'err'); });
        KX.toast('This scene.json has errors — see Activity.', 'bad');
        view('empty');
        return;
      }
      r.validation.warnings.forEach(function (w) { KX.log(w, 'warn'); });
      st.scene = r.scene; st.scenePath = r.scenePath; st.convertedQuality = r.scene.source && r.scene.source.quality;
      var keys = 0;
      JSON.stringify(r.scene, function (k, v) { if (k === 'keys' && Array.isArray(v)) keys += v.length; return v; });
      renderLoaded({ layers: r.scene.layers.length, keyframes: keys });
      KX.log('Scene loaded: ' + r.scene.comp.name + ' (' + r.scene.layers.length + ' layers, ' + keys + ' keyframes)', 'ok');
    } catch (e) { KX.toast(e.message, 'bad'); KX.log(e.message, 'err'); }
  }

  var STEP = { launch: 'load', load: 'load', measure: 'load', frames: 'frames', raster: 'frames', fit: 'fit', media: 'media', done: 'media' };
  function progress(phase, f, msg) {
    var pct = Math.max(0, Math.min(100, Math.round(f * 100)));
    $('convBar').style.width = pct + '%';
    $('convPct').textContent = pct + '%';
    $('convStage').textContent = msg || phase;
    var cur = STEP[phase] || 'load', before = true;
    Array.prototype.forEach.call($('convSteps').children, function (s) {
      var k = s.getAttribute('data-s');
      if (phase === 'done') { s.className = 'done'; return; }
      s.className = k === cur ? 'on' : (before ? 'done' : '');
      if (k === cur) before = false;
    });
  }

  function convert(duration) {
    if (!st.input || st.input.kind !== 'html' || st.busy) return;
    var s = KX.settings();
    st.abort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    setBusy(true);
    $('convName').textContent = KX.node.path.basename(st.input.path);
    progress('launch', 0, 'Starting the browser');
    view('converting');
    var t0 = Date.now();
    var q = quality.get();
    KX.node.engine.convert(st.input.path, {
      fps: s.convert.fps || undefined,
      duration: duration || undefined,
      quality: q,
      browserPath: s.browserPath || undefined,
      onProgress: progress,
      signal: st.abort ? st.abort.signal : undefined,
    }).then(function (r) {
      st.scene = r.scene; st.scenePath = r.scenePath; st.media = r.media; st.convertedQuality = q;
      KX.log('Converted ' + r.scene.comp.name + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's: ' + r.report.layers + ' layers, ' + r.report.keyframes + ' keyframes', 'ok');
      (r.warnings || []).forEach(function (w) { KX.log(w, 'warn'); });
      r.scene.notes.filter(function (n) { return n.kind === 'page-error' || n.kind === 'missing'; }).forEach(function (n) { KX.log(n.message, 'warn'); });
      renderLoaded(r.report);
    }).catch(function (e) {
      KX.log('Conversion failed: ' + e.message, 'err');
      KX.toast(e.code === 'NO_BROWSER' ? e.message : 'Conversion failed: ' + e.message, 'bad');
      view(st.scene ? 'loaded' : 'empty');
    }).then(function () { setBusy(false); st.abort = null; });
  }

  // ------------------------------------------------------------ loaded file
  function renderLoaded(report) {
    var sc = st.scene, c = sc.comp, src = sc.source || {};
    $('fname').textContent = KX.node.path.basename(st.input.path);
    $('fdir').textContent = KX.shortPath(KX.node.path.dirname(st.input.path));
    $('sLayers').textContent = report.layers;
    $('sKeys').textContent = report.keyframes;
    $('sDur').textContent = KX.fmtDur(c.duration);
    $('sSize').textContent = c.width + '×' + c.height;
    var from = { DURATION: 'DURATION in the page', gsap: 'GSAP timeline', animations: 'CSS / Web animations', measured: 'measured by playing', loop: 'one loop', override: 'set by you', 'default': 'default' };
    $('srcText').innerHTML = c.fps + ' fps · length: <b>' + KX.esc(from[src.durationFrom] || src.durationFrom || 'scene') + '</b>';
    KX.show('lenEdit', st.input.kind === 'html');
    KX.hide('lenBox');
    $('relen').value = c.duration;

    // fonts
    var fonts = sc.fonts || [];
    $('fontsText').innerHTML = fonts.length ? 'Fonts: ' + fonts.map(function (f, i) {
      return '<b data-fi="' + i + '">' + KX.esc(f.family) + ' ' + f.weight + (f.style === 'italic' ? ' italic' : '') + '</b>';
    }).join(', ') : 'No text layers.';
    checkFonts(fonts);

    // notes
    var notes = (sc.notes || []).filter(function (n) { return n.kind !== 'info'; });
    KX.show('notesRow', notes.length > 0);
    $('notesToggle').textContent = notes.length + ' note' + (notes.length === 1 ? '' : 's') + ' on parts that are approximated or skipped';
    var tag = { approx: 'warn', skip: 'warn', raster: '', missing: 'bad', 'page-error': 'bad', warn: 'bad' };
    $('notesList').innerHTML = notes.map(function (n) {
      return '<div class="note"><span class="k ' + (tag[n.kind] || '') + '">' + KX.esc(n.kind) + '</span>' + KX.esc(n.message) + (n.layers && n.layers.length ? '<small>' + KX.esc(n.layers.join(', ')) + '</small>' : '') + '</div>';
    }).join('');
    KX.show('notesList', notes.some(function (n) { return tag[n.kind] === 'bad'; }));

    // online media
    var online = st.media && st.media.online ? st.media.online : [];
    var missing = online.filter(function (m) { return m.status !== 'downloaded'; }).length;
    $('mediaSub').textContent = online.length + ' file' + (online.length === 1 ? '' : 's') + ' loaded from the web';
    $('mediaPill').textContent = missing ? missing + ' needed' : 'All saved';
    $('mediaPill').className = 'pill ' + (missing ? 'wait' : 'ok');
    $('mediaList').innerHTML = online.map(function (m) {
      var ok = m.status === 'downloaded';
      return '<div class="mrow"><span class="st ' + (ok ? 'ok' : 'bad') + '">' + (ok ? 'SAVED' : 'NEEDED') + '</span><a class="url" data-url="' + KX.esc(m.url) + '">' + KX.esc(m.url) + '</a>' +
        '<div class="path">' + KX.esc(KX.shortPath(m.saveAs)) + (m.error ? ' — ' + KX.esc(m.error) : '') + '</div></div>';
    }).join('');

    syncReconv();
    view('loaded');
  }

  function checkFonts(fonts) {
    if (!fonts.length || !CEP.inHost) return;
    KX.host('fontCheck', [JSON.stringify(fonts)]).then(function (r) {
      var missing = [];
      r.fonts.forEach(function (f, i) {
        var el = document.querySelector('#fontsText [data-fi="' + i + '"]');
        if (el && f.installed === false) { el.className = 'font-miss'; el.title = 'Not installed for After Effects'; missing.push(fonts[i].family); }
      });
      if (missing.length) KX.log('Fonts not installed: ' + missing.join(', ') + ' (tick "Install the web fonts" or install them yourself)', 'warn');
    }).catch(function () { /* After Effects before 2024 has no font list */ });
  }

  function syncReconv() {
    var changed = st.scene && st.input && st.input.kind === 'html' && st.convertedQuality && st.convertedQuality !== quality.get();
    KX.show('reconv', !!changed);
    if (changed) $('reconvWas').textContent = st.convertedQuality.charAt(0).toUpperCase() + st.convertedQuality.slice(1);
  }

  // ------------------------------------------------------------ build
  function installFonts() {
    var fonts = (st.scene.fonts || []).filter(function (f) { return f.custom; });
    if (!$('optFonts').checked || !fonts.length) return Promise.resolve(null);
    KX.log('Installing web fonts…');
    return KX.node.engine.collectFonts(st.scene, st.scene.source.pageFonts || {}, KX.node.path.dirname(st.scenePath))
      .then(function (c) { return KX.node.engine.installFonts(c); })
      .then(function (r) {
        r.forEach(function (f) { KX.log('Font ' + f.family + ' ' + (f.weight || '') + ': ' + f.status + (f.error ? ' (' + f.error + ')' : ''), f.status === 'failed' ? 'warn' : ''); });
        return r;
      }).catch(function (e) { KX.log('Fonts not installed: ' + e.message, 'warn'); return null; });
  }

  function build() {
    if (!st.scenePath || st.busy) return;
    if (!CEP.inHost) { KX.toast('Building needs After Effects.', 'bad'); return; }
    setBusy(true);
    $('btnBuild').querySelector('span').textContent = 'Building…';
    KX.hide('result');
    var fontsInstalled = null;
    var t0 = Date.now();
    installFonts().then(function (f) {
      fontsInstalled = f;
      KX.log('Building in After Effects: ' + st.scene.comp.name + '…');
      return KX.node.pipeline.buildInAE(CEP.evalScript, st.scenePath, { target: target.get(), open: true });
    }).then(function (r) {
      st.placeholders = r.placeholders || [];
      var list = [];
      (r.missingFonts || []).forEach(function (f) {
        list.push('Missing font: ' + KX.esc(f) + (fontsInstalled && fontsInstalled.some(function (x) { return x.status === 'installed'; }) ? ' — restart After Effects to use the fonts just installed' : ''));
      });
      st.placeholders.forEach(function (p) { list.push('Placeholder for ' + KX.esc(p.origin || p.name)); });
      (r.warnings || []).forEach(function (w) { list.push(KX.esc(w)); });
      var el = $('result');
      el.className = 'result';
      el.innerHTML = '<b>Built “' + KX.esc(r.comp) + '”</b> — ' + r.layers + ' layers in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's' + (r.placedInto ? ', placed in “' + KX.esc(r.placedInto) + '”' : '') + '.' +
        (list.length ? '<ul><li>' + list.slice(0, 12).join('</li><li>') + '</li></ul>' : '');
      KX.show(el);
      KX.log('Built ' + r.comp + ' (' + r.layers + ' layers)', 'ok');
      (r.warnings || []).forEach(function (w) { KX.log(w, 'warn'); });
      (r.missingFonts || []).forEach(function (f) { KX.log('Missing font in After Effects: ' + f, 'warn'); });
    }).catch(function (e) {
      var el = $('result');
      el.className = 'result bad';
      el.innerHTML = '<b>Build failed.</b> ' + KX.esc(e.message) + (e.raw ? '<ul><li>After Effects answered: ' + KX.esc(String(e.raw).slice(0, 200)) + '</li></ul>' : '');
      KX.show(el);
      KX.log('Build failed: ' + e.message + (e.line ? ' (host line ' + e.line + ')' : ''), 'err');
      checkHost();
    }).then(function () {
      setBusy(false);
      $('btnBuild').querySelector('span').textContent = 'Build in After Effects';
    });
  }

  /** Swap placeholders for downloaded / saved files. */
  function relink() {
    var map = {}, n = 0;
    var online = st.media && st.media.online ? st.media.online : [];
    st.placeholders.forEach(function (p) { if (p.saveAs && KX.node.fs.existsSync(p.saveAs)) { map[p.name] = p.saveAs; n++; } });
    online.forEach(function (m) { if (m.saveAs && KX.node.fs.existsSync(m.saveAs)) { map[KX.node.path.basename(m.saveAs)] = m.saveAs; n++; } });
    if (!n) { KX.toast('Save the missing files at the paths shown, then relink.', 'bad'); return; }
    KX.host('relink', [JSON.stringify(map)]).then(function (r) {
      KX.toast(r.relinked.length ? 'Relinked ' + r.relinked.length + ' file(s)' : 'Nothing to relink in this project', r.failed.length ? 'bad' : 'ok');
      r.failed.forEach(function (f) { KX.log('Relink: ' + f, 'warn'); });
    }).catch(function (e) { KX.toast(e.message, 'bad'); KX.log(e.message, 'err'); });
  }

  function close() {
    if (st.abort) st.abort.abort();
    st.input = null; st.scene = null; st.scenePath = null; st.media = null;
    renderRecent();
    view('empty');
  }

  // ------------------------------------------------------------ After Effects connection
  function checkHost() {
    var dot = $('hostDot');
    if (!CEP.inHost) { dot.className = 'dot'; dot.title = 'Preview mode (not inside After Effects)'; return Promise.resolve(); }
    return KX.host('ping', []).then(function (r) {
      dot.className = 'dot ok';
      dot.title = 'After Effects ' + r.version + ' connected';
    }).catch(function (e) {
      dot.className = 'dot bad';
      dot.title = e.message;
      KX.log('After Effects connection: ' + e.message, 'err');
    });
  }

  function pathFromDrop(e) {
    var dt = e.dataTransfer;
    if (!dt) return null;
    if (dt.files && dt.files.length && dt.files[0].path) return dt.files[0].path;
    var uri = dt.getData('text/uri-list') || dt.getData('text/plain') || '';
    uri = uri.split(/\r?\n/).filter(function (l) { return l && l.charAt(0) !== '#'; })[0];
    if (!uri) return null;
    if (/^file:\/\//.test(uri)) {
      var p = decodeURIComponent(uri.replace(/^file:\/\/(localhost)?/, ''));
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
      return p;
    }
    return /^(\/|[A-Za-z]:\\)/.test(uri) ? uri : null;
  }

  // ------------------------------------------------------------ boot
  function boot() {
    if (root.__kxBootError) {
      KX.log('KeyframeX could not load its engine: ' + root.__kxBootError.message, 'err');
      KX.toast('Engine failed to load: ' + root.__kxBootError.message, 'bad');
    }
    if (KX.node) $('ver').textContent = KX.node.engine.VERSION;
    var s = KX.settings();
    target = KX.seg('optTarget', s.convert.target || 'new', function (v) { $('hintTarget').textContent = '— ' + HINT_TARGET[v]; KX.updateSettings(function (x) { x.convert.target = v; }); });
    quality = KX.seg('optQuality', s.convert.quality || 'balanced', function (v) { $('hintQuality').textContent = '— ' + HINT_QUALITY[v]; KX.updateSettings(function (x) { x.convert.quality = v; }); syncReconv(); });
    $('hintTarget').textContent = '— ' + HINT_TARGET[target.get()];
    $('hintQuality').textContent = '— ' + HINT_QUALITY[quality.get()];
    $('optFonts').checked = s.convert.installFonts !== false;
    $('optFonts').addEventListener('change', function () { var v = $('optFonts').checked; KX.updateSettings(function (x) { x.convert.installFonts = v; }); });

    var drop = $('drop');
    ['dragenter', 'dragover'].forEach(function (t) { document.addEventListener(t, function (e) { e.preventDefault(); if (!st.busy) drop.classList.add('hot'); }); });
    document.addEventListener('dragleave', function (e) { if (!e.relatedTarget) drop.classList.remove('hot'); });
    document.addEventListener('drop', function (e) {
      e.preventDefault(); drop.classList.remove('hot');
      if (st.busy) return;
      var p = pathFromDrop(e);
      if (p) open(p); else KX.toast('Drop a file from Finder / Explorer.', 'bad');
    });
    $('btnChoose').addEventListener('click', function () { var p = CEP.chooseFile('Choose an HTML video or a KeyframeX scene', ['html', 'htm', 'json']); if (p) open(p); });
    $('recent').addEventListener('click', function (e) { var a = e.target.closest('a'); if (a) open(a.getAttribute('data-p')); });
    $('btnCancel').addEventListener('click', function () { if (st.abort) { st.abort.abort(); KX.log('Cancelled', 'warn'); } });
    $('btnClose').addEventListener('click', close);
    $('btnPreview').addEventListener('click', function () { if (st.input) CEP.openFile(st.input.path); });
    $('fwhere').addEventListener('click', function () { if (st.input) CEP.reveal(st.input.path); });
    $('lenEdit').addEventListener('click', function () { KX.show('lenBox', $('lenBox').classList.contains('hidden')); $('relen').focus(); });
    $('relenGo').addEventListener('click', function () {
      var d = parseFloat($('relen').value);
      if (!(d > 0)) { KX.toast('Type the length in seconds.', 'bad'); return; }
      convert(d);
    });
    $('reconvGo').addEventListener('click', function () { convert(st.scene && st.scene.source && st.scene.source.durationFrom === 'override' ? st.scene.comp.duration : undefined); });
    $('notesToggle').addEventListener('click', function () { KX.show('notesList', $('notesList').classList.contains('hidden')); });
    $('btnBuild').addEventListener('click', build);
    $('btnRelink').addEventListener('click', relink);
    $('btnMediaFolder').addEventListener('click', function () { if (st.scenePath) CEP.openFile(KX.node.path.join(KX.node.path.dirname(st.scenePath), 'assets')); });
    $('mediaList').addEventListener('click', function (e) { var a = e.target.closest('a[data-url]'); if (a) CEP.openURL(a.getAttribute('data-url')); });
    $('btnClearLog').addEventListener('click', function () { $('log').innerHTML = ''; });
    $('btnReload').addEventListener('click', function () {
      if (!CEP.inHost) return;
      // Force a fresh load of the host script, then check the connection.
      CEP.evalScript('$.global.KeyframeX = undefined; "ok"').then(checkHost).then(function () { KX.toast('Reconnected to After Effects', 'ok'); });
    });
    KX.settingsView.init();
    renderRecent();
    view('empty');
    checkHost();
    if (KX.node && !KX.node.engine.findBrowser(s.browserPath)) KX.log('No Chrome / Edge / Brave / Chromium found. Install one, or set its path in Settings.', 'warn');
    KX.log('Ready. Drop an HTML video or a scene.json to start.');
  }

  KX.panel = { open: open, checkHost: checkHost };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(window);
