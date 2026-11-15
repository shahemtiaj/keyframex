/* KeyframeX panel — Settings sheet (browser, default frame rate, data folder). */
(function (root) {
  'use strict';
  var KX = root.KX;
  var $ = KX.$;

  function open() {
    var s = KX.settings();
    var found = KX.node ? KX.node.engine.findBrowser(s.browserPath) : null;
    $('setBrowserFound').textContent = found ? 'Using: ' + found : 'No Chrome / Edge / Brave / Chromium found. Install one, or choose its program file.';
    $('setBrowser').value = s.browserPath || '';
    $('setFps').value = String(s.convert.fps || 0);
    $('setDataDir').textContent = KX.node ? KX.shortPath(KX.node.settings.dataDir()) : 'browser storage';
    KX.show('settings');
  }

  function save() {
    var browser = $('setBrowser').value.trim();
    if (browser && KX.node && !KX.node.fs.existsSync(browser)) { KX.toast('That browser path does not exist.', 'bad'); return; }
    KX.updateSettings(function (s) {
      s.browserPath = browser;
      s.convert.fps = parseFloat($('setFps').value) || 0;
    });
    KX.hide('settings');
    KX.toast('Settings saved', 'ok');
    KX.log('Settings saved');
  }

  KX.settingsView = {
    open: open,
    init: function () {
      $('btnSettings').addEventListener('click', open);
      $('btnSettingsClose').addEventListener('click', function () { KX.hide('settings'); });
      $('btnSettingsCancel').addEventListener('click', function () { KX.hide('settings'); });
      $('btnSettingsSave').addEventListener('click', save);
      $('settings').addEventListener('click', function (e) { if (e.target.id === 'settings') KX.hide('settings'); });
      $('btnSetBrowser').addEventListener('click', function () { var p = CEP.chooseFile('Choose the Chrome / Edge program'); if (p) $('setBrowser').value = p; });
      $('setDataDir').addEventListener('click', function () { if (KX.node) CEP.openFile(KX.node.settings.dataDir()); });
    },
  };
})(window);
