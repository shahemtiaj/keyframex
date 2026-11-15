#!/usr/bin/env node
'use strict';
/**
 * KeyframeX visual check — converts a page, then compares the real page (Chrome) with
 * the KeyframeX scene rendered the way After Effects builds it (tools/preview.js),
 * frame by frame.
 *
 *   node tools/compare.js page.html [--times 0,1,2.5 | --every 1] [--quality balanced] [--out dir]
 *
 * Writes <out>/compare_<t>.png (page | KeyframeX | difference) and prints a score per
 * frame: the share of pixels that differ visibly. Videos are drawn as grey boxes in the
 * preview, so frames with video always differ there.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const engine = require('../engine');
const browser = require('../engine/browser');

const TIMESHIM = fs.readFileSync(path.join(__dirname, '..', 'engine', 'page', 'timeshim.js'), 'utf8');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : dflt;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shotsOfPage(s, url, w, h, times) {
  const shim = await s.send('Page.addScriptToEvaluateOnNewDocument', { source: 'var __KX_SEED__=1337;' + TIMESHIM });
  await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  const loaded = s.waitFor('Page.loadEventFired', 30000).catch(() => {});
  await s.send('Page.navigate', { url });
  await loaded;
  await sleep(1500);
  await s.evaluate('document.fonts ? document.fonts.ready.then(function(){return true}) : true').catch(() => {});
  await s.evaluate('window.__kx.advance(0)');
  const out = [];
  for (const t of times) {
    await s.evaluate(`window.__kx.advance(${Math.max(5, t * 1000)})`);
    const r = await s.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
    out.push(r.data);
  }
  await s.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: shim.identifier });
  return out;
}

async function shotsOfPreview(s, scene, sceneDir, outDir, times) {
  const c = scene.comp;
  const fonts = (scene.source && scene.source.pageFonts) || {};
  const html = [
    '<!doctype html><html><head><meta charset="utf-8">',
    (fonts.fontLinks || []).map((h) => '<link rel="stylesheet" href="' + h + '">').join(''),
    '<style>html,body{margin:0;background:#000}' + (fonts.fontFaces || []).map((f) => '@font-face{font-family:"' + f.family + '";src:url("' + f.url + '");font-weight:' + f.weight + ';font-style:' + f.style + '}').join('') + '</style>',
    '<script src="' + pathToFileURL(path.join(__dirname, 'preview.js')).href + '"></script>',
    '</head><body></body></html>',
  ].join('');
  const file = path.join(outDir, '_preview.html');
  fs.writeFileSync(file, html);
  await s.send('Emulation.setDeviceMetricsOverride', { width: c.width, height: c.height, deviceScaleFactor: 1, mobile: false });
  const loaded = s.waitFor('Page.loadEventFired', 30000).catch(() => {});
  await s.send('Page.navigate', { url: pathToFileURL(file).href });
  await loaded;
  await s.evaluate('window.__kxPreviewInit(' + JSON.stringify(scene) + ',' + JSON.stringify(pathToFileURL(sceneDir).href + '/') + ')');
  const out = [];
  for (const t of times) {
    await s.evaluate(`window.__kxPreview(${t})`);
    await sleep(60);
    const r = await s.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: c.width, height: c.height, scale: 1 } });
    out.push(r.data);
  }
  return out;
}

/** Diff two PNGs in the browser: returns { score, png } (side by side + heat map). */
async function diff(s, a, b, label) {
  return s.evaluate(`(async function(){
    function load(src){return new Promise(function(r){var i=new Image();i.onload=function(){r(i)};i.src='data:image/png;base64,'+src;});}
    var A=await load(${JSON.stringify(a)}), B=await load(${JSON.stringify(b)});
    var w=A.width,h=A.height;
    function px(img){var c=document.createElement('canvas');c.width=w;c.height=h;var x=c.getContext('2d');x.drawImage(img,0,0);return x.getImageData(0,0,w,h);}
    var pa=px(A),pb=px(B);
    var out=document.createElement('canvas');out.width=w*3;out.height=h+28;var o=out.getContext('2d');
    o.fillStyle='#111';o.fillRect(0,0,out.width,out.height);
    o.drawImage(A,0,28);o.drawImage(B,w,28);
    var hd=o.createImageData(w,h),bad=0;
    for(var i=0;i<pa.data.length;i+=4){var d=Math.abs(pa.data[i]-pb.data[i])+Math.abs(pa.data[i+1]-pb.data[i+1])+Math.abs(pa.data[i+2]-pb.data[i+2]);
      var g=(pa.data[i]+pa.data[i+1]+pa.data[i+2])/12;
      if(d>60){bad++;hd.data[i]=255;hd.data[i+1]=40;hd.data[i+2]=40;}else{hd.data[i]=g;hd.data[i+1]=g;hd.data[i+2]=g;}hd.data[i+3]=255;}
    o.putImageData(hd,w*2,28);
    o.fillStyle='#fff';o.font='16px sans-serif';
    var score=bad/(w*h);
    o.fillText('Page (Chrome)',8,19);o.fillText('KeyframeX (After Effects preview)',w+8,19);o.fillText(${JSON.stringify(label)}+'  —  differing pixels: '+(score*100).toFixed(2)+'%',w*2+8,19);
    return {score:score,png:out.toDataURL('image/png').split(',')[1]};
  })()`, { timeoutMs: 120000 });
}

async function main() {
  const html = path.resolve(process.argv[2] || '');
  if (!fs.existsSync(html)) { console.error('usage: node tools/compare.js page.html [--times 0,1,2] [--every 1] [--quality balanced] [--out dir]'); process.exit(1); }
  const outDir = path.resolve(arg('out', engine.outputDirFor(html) + ' compare'));
  fs.mkdirSync(outDir, { recursive: true });
  process.stderr.write('Converting…\n');
  const conv = await engine.convert(html, { quality: arg('quality', 'balanced'), outDir: path.join(outDir, 'scene') });
  const sc = conv.scene;
  let times;
  if (arg('times')) times = arg('times').split(',').map(Number);
  else {
    const every = Number(arg('every', 0)) || Math.max(0.5, sc.comp.duration / 6);
    times = [];
    for (let t = 0; t < sc.comp.duration; t += every) times.push(Math.round(t * 1000) / 1000);
  }
  const b = await browser.launch({});
  try {
    await b.session.send('Page.enable');
    await b.session.send('Runtime.enable');
    process.stderr.write('Rendering the page…\n');
    const page = await shotsOfPage(b.session, pathToFileURL(html).href, sc.comp.width, sc.comp.height, times);
    process.stderr.write('Rendering the KeyframeX scene…\n');
    const prev = await shotsOfPreview(b.session, sc, path.dirname(conv.scenePath), outDir, times);
    const rows = [];
    for (let i = 0; i < times.length; i++) {
      const d = await diff(b.session, page[i], prev[i], 't = ' + times[i] + 's');
      const f = path.join(outDir, 'compare_' + String(times[i]).replace('.', '_') + 's.png');
      fs.writeFileSync(f, Buffer.from(d.png, 'base64'));
      rows.push({ t: times[i], differing: +(d.score * 100).toFixed(2), file: f });
    }
    const summary = { scene: conv.scenePath, layers: conv.report.layers, keyframes: conv.report.keyframes, frames: rows };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await b.close();
  }
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
