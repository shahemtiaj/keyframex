/*
 * KeyframeX — minimal CEP bridge (replaces Adobe's 40 KB CSInterface.js).
 * Works in the panel and the hidden service; falls back to a dev mode in a
 * normal browser so the UI can be developed without After Effects.
 */
(function (root) {
  'use strict';
  var native = root.__adobe_cep__;
  var nodeRequire = typeof root.require === 'function' ? root.require : (typeof root.cep_node !== 'undefined' ? root.cep_node.require : null);

  function extRoot() {
    var p = decodeURIComponent(root.location.pathname);
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1); // Windows: /C:/... → C:/...
    p = p.replace(/\/[^\/]+\/[^\/]+$/, ''); // strip "<dir>/index.html"
    return p;
  }

  var CEP = {
    inHost: !!native,
    hasNode: !!nodeRequire,
    root: extRoot(),
    require: function (rel) {
      if (!nodeRequire) throw new Error('Node.js is not available in this panel.');
      var path = nodeRequire('path');
      return nodeRequire(path.join(CEP.root, rel));
    },
    nodeRequire: nodeRequire,
    evalScript: function (script) {
      return new Promise(function (resolve) {
        if (!native) { resolve(CEP.devEval ? CEP.devEval(script) : 'EvalScript error.'); return; }
        native.evalScript(script, function (r) { resolve(r); });
      });
    },
    hostEnvironment: function () {
      try { return JSON.parse(native.getHostEnvironment()); } catch (e) { return null; }
    },
    openURL: function (url) {
      try {
        if (root.cep && root.cep.util) { root.cep.util.openURLInDefaultBrowser(url); return; }
      } catch (e) { /* fall through */ }
      root.open(url, '_blank');
    },
    /** Reveal a file in Finder / Explorer. */
    reveal: function (file) {
      if (!nodeRequire) return;
      var cp = nodeRequire('child_process');
      if (process.platform === 'darwin') cp.execFile('open', ['-R', file]);
      else if (process.platform === 'win32') cp.execFile('explorer', ['/select,', file.replace(/\//g, '\\')]);
      else cp.execFile('xdg-open', [nodeRequire('path').dirname(file)]);
    },
    openFile: function (file) {
      if (!nodeRequire) return;
      var cp = nodeRequire('child_process');
      if (process.platform === 'darwin') cp.execFile('open', [file]);
      else if (process.platform === 'win32') cp.exec('start "" "' + file + '"');
      else cp.execFile('xdg-open', [file]);
    },
    /** Native file dialog. Returns a path or null. */
    chooseFile: function (title, types) {
      if (!root.cep || !root.cep.fs) return null;
      var r = root.cep.fs.showOpenDialogEx ? root.cep.fs.showOpenDialogEx(false, false, title, '', types || []) : root.cep.fs.showOpenDialog(false, false, title, '', types || []);
      return r && r.data && r.data.length ? r.data[0] : null;
    },
    chooseFolder: function (title) {
      if (!root.cep || !root.cep.fs) return null;
      var r = root.cep.fs.showOpenDialogEx ? root.cep.fs.showOpenDialogEx(false, true, title, '') : root.cep.fs.showOpenDialog(false, true, title, '');
      return r && r.data && r.data.length ? r.data[0] : null;
    },
    on: function (type, fn) {
      if (native && native.addEventListener) native.addEventListener(type, function (e) { fn(e); });
    },
    /** Keep panel colours in step with the After Effects UI brightness. */
    applyTheme: function () {
      var env = CEP.hostEnvironment();
      if (!env || !env.appSkinInfo) return;
      var c = env.appSkinInfo.panelBackgroundColor.color;
      var lum = (0.299 * c.red + 0.587 * c.green + 0.114 * c.blue) / 255;
      document.documentElement.setAttribute('data-host-bg', 'rgb(' + Math.round(c.red) + ',' + Math.round(c.green) + ',' + Math.round(c.blue) + ')');
      document.documentElement.style.setProperty('--host-bg', 'rgb(' + Math.round(c.red) + ',' + Math.round(c.green) + ',' + Math.round(c.blue) + ')');
      document.documentElement.classList.toggle('light', lum > 0.55);
    },
  };
  root.CEP = CEP;
})(window);
