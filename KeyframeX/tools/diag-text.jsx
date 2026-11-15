// KeyframeX diagnostics: where After Effects puts the text layers of the active comp
// (anchor, position, drawn bounds, paragraph settings). Run with File > Scripts >
// Run Script File...; writes diag-text.txt next to this file. It also loads this
// checkout's host script, so an open KeyframeX panel builds with it.
(function () {
    var out = [];
    function safe(fn) { try { return String(fn()); } catch (e) { return 'ERR(' + e.toString() + ')'; } }
    out.push('AE ' + app.version);
    var comp = app.project.activeItem instanceof CompItem ? app.project.activeItem : null;
    out.push('comp ' + (comp ? comp.name + ' (' + comp.numLayers + ' layers)' : 'none active'));
    if (comp) {
        for (var l = 1; l <= comp.numLayers; l++) {
            var L = comp.layer(l);
            if (!(L instanceof TextLayer)) continue;
            var line = L.name;
            try {
                var tp = L.property('ADBE Text Properties').property('ADBE Text Document');
                var d = tp.value;
                var tg = L.property('ADBE Transform Group');
                var t = L.inPoint + Math.min(1, (L.outPoint - L.inPoint) / 2);
                line += ' | in=' + safe(function () { return L.inPoint; }) + ' t=' + t;
                line += ' anchor=' + safe(function () { return tg.property('ADBE Anchor Point').value; });
                line += ' pos=' + safe(function () { return tg.property('ADBE Position').valueAtTime(t, false); });
                line += ' scale=' + safe(function () { return tg.property('ADBE Scale').valueAtTime(t, false); });
                line += ' rect=' + safe(function () { var r = L.sourceRectAtTime(t, false); return [r.left, r.top, r.width, r.height].join(','); });
                var keys = ['justification', 'startIndent', 'endIndent', 'firstLineIndent', 'spaceBefore', 'spaceAfter', 'boxText', 'pointText', 'font', 'fontSize', 'tracking', 'baselineShift', 'direction', 'horizontalScale', 'composerEngine', 'leading', 'autoLeading', 'baselineLocs'];
                for (var k = 0; k < keys.length; k++) {
                    (function (key) { line += ' ' + key + '=' + safe(function () { return d[key]; }); })(keys[k]);
                }
            } catch (e) { line += ' ERR ' + e.toString(); }
            out.push(line);
        }
    }
    // Load the KeyframeX host script from this checkout, so the open panel builds with it.
    try {
        $.evalFile(new File(File($.fileName).parent.parent.fsName + '/host/keyframex.jsx'));
        out.push('host loaded: ' + $.global.KeyframeX.ping());
    } catch (eH) { out.push('host load failed: ' + eH.toString() + ' line ' + eH.line); }
    var f = new File(File($.fileName).parent.fsName + '/diag-text.txt');
    f.encoding = 'UTF-8';
    f.open('w');
    f.write(out.join('\n'));
    f.close();
})();
