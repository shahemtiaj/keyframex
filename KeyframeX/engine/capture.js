'use strict';
/**
 * Capture: open an HTML motion page in a headless browser, play it frame by
 * frame on the virtual clock and record every element's state per frame.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const browser = require('./browser');
const G = require('./geometry');
const { planRasters } = require('./raster');

const PAGE_DIR = path.join(__dirname, 'page');
const TIMESHIM = fs.readFileSync(path.join(PAGE_DIR, 'timeshim.js'), 'utf8');
const SAMPLER = fs.readFileSync(path.join(PAGE_DIR, 'sampler.js'), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_DURATION = 300; // seconds; hard cap protects against endless pages

async function waitForLoad(s, timeoutMs, net) {
  const end = Date.now() + timeoutMs;
  await s.waitFor('Page.loadEventFired', timeoutMs).catch(() => {});
  // Network quiet: no request in flight for 300 ms (fonts, images, late scripts).
  let quietSince = Date.now();
  while (Date.now() < end) {
    if (net.inflight.size > 0) quietSince = Date.now();
    if (Date.now() - quietSince >= 300) break;
    await sleep(50);
  }
  await s.evaluate('document.fonts ? document.fonts.ready.then(function(){return true}) : true', { timeoutMs: 10000 }).catch(() => {});
  await s.evaluate(`Promise.all(Array.from(document.images).filter(function(i){return !i.complete}).map(function(i){return new Promise(function(r){i.onload=i.onerror=r})})).then(function(){return true})`, { timeoutMs: 10000 }).catch(() => {});
}

async function navigate(s, url, width, height, net) {
  await s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const loaded = waitForLoad(s, 20000, net);
  await s.send('Page.navigate', { url });
  await loaded;
  await s.evaluate(SAMPLER + ';true');
}

/** Map a CDP quad through a matrix. */
function mapQuad(q, m) {
  const out = [];
  for (let i = 0; i < 8; i += 2) { const p = G.apply(m, q[i], q[i + 1]); out.push(p[0], p[1]); }
  return out;
}

/**
 * Measure how long the page runs when no explicit duration exists: play it
 * until nothing changes for a second (or it returns to its first frame).
 */
async function measureDuration(s, fps, onProgress) {
  const sig = 'JSON.stringify(window.__kxSample().els.map(function(e){return [e.id,e.op&&e.op.toFixed(3),e.ctm,e.w,e.h,e.text&&e.text.raw,e.geom&&JSON.stringify(e.geom)]}))';
  const step = 1000 / Math.min(fps, 15);
  let first = null, prev = null, lastChange = 0, changed = false;
  for (let t = 0; t <= 60000; t += step) {
    await s.evaluate(`window.__kx.advance(${t})`);
    // Geometry also changes through CSS transforms, so include the quads of a few elements.
    const v = await s.evaluate(sig + `+JSON.stringify(Array.from(document.querySelectorAll('[data-kx-id]')).slice(0,400).map(function(e){var r=e.getBoundingClientRect();return [r.x|0,r.y|0,r.width|0,r.height|0]}))`);
    if (first == null) first = v;
    if (prev != null && v !== prev) { lastChange = t; changed = true; }
    if (changed && t > 500 && v === first) return { duration: t / 1000, how: 'loop' };
    if (changed && t - lastChange >= 1000) return { duration: Math.min(60, (lastChange + 1000) / 1000), how: 'measured' };
    prev = v;
    if (onProgress && (t % 1000) < step) onProgress(Math.min(0.99, t / 60000));
  }
  return { duration: changed ? (lastChange + 1000) / 1000 : 5, how: changed ? 'measured' : 'default' };
}

/**
 * Second pass for picture fallbacks: replay the page on the same virtual clock (so
 * element ids and states are identical), and at the planned frames capture each
 * element alone on a transparent background.
 */
async function captureRasters(s, url, viewport, net, fps, frameCount, jobs, progress, signal) {
  const need = new Map(); // frame -> jobs
  let total = 0;
  for (const j of jobs) {
    j.images = {};
    for (const f of j.frames) { if (!need.has(f)) need.set(f, []); need.get(f).push(j); total++; }
  }
  const last = Math.max.apply(null, Array.from(need.keys()));
  progress('raster', 0.9, 'Capturing pictures');
  await navigate(s, url, viewport[0], viewport[1], net);
  await s.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  try {
    await s.evaluate('window.__kx.advance(0)');
    let done = 0;
    for (let f = 0; f <= last; f++) {
      if (signal && signal.aborted) throw new Error('Cancelled');
      const vt = f === 0 ? Math.min(5, 500 / fps) : (f / fps) * 1000;
      await s.evaluate(`window.__kx.advance(${vt.toFixed(4)})`);
      await s.evaluate('window.__kxSample({}) && true'); // assigns the same element ids as the first pass
      const list = need.get(f);
      if (!list) continue;
      for (const j of list) {
        const ok = await s.evaluate(`window.__kxIsolate(${j.id}, ${JSON.stringify(j.parts)})`);
        if (ok) {
          try {
            const shot = await s.send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: { x: j.clip[0], y: j.clip[1], width: j.clip[2], height: j.clip[3], scale: 1 } });
            j.images[f] = shot.data;
          } catch (e) { j.error = e.message; }
          await s.evaluate('window.__kxUnisolate()');
        }
        done++;
        if (done % 5 === 0 || done === total) progress('raster', 0.9 + 0.04 * (done / total), 'Capturing pictures ' + done + ' / ' + total);
      }
    }
  } finally {
    await s.send('Emulation.setDefaultBackgroundColorOverride', {}).catch(() => {});
  }
}

/**
 * @param {string} htmlPath absolute path to the HTML file
 * @param {object} opts { fps, duration, width, height, browserPath, seed, onProgress(phase, fraction, message), signal }
 * @returns {Promise<{recording, session, close}>} browser stays open for asset processing; caller must close().
 */
async function capture(htmlPath, opts = {}) {
  const progress = opts.onProgress || (() => {});
  const abs = path.resolve(htmlPath);
  if (!fs.existsSync(abs)) throw new Error('File not found: ' + abs);
  const url = pathToFileURL(abs).href;
  const seed = opts.seed != null ? opts.seed : 1337;

  progress('launch', 0, 'Starting the browser');
  const b = await browser.launch({ executable: opts.browserPath, width: 1920, height: 1080 });
  const s = b.session;
  try {
    await s.send('Page.enable');
    await s.send('Runtime.enable');
    await s.send('DOM.enable');
    await s.send('CSS.enable');
    const consoleErrors = [];
    s.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      consoleErrors.push(((d.exception && d.exception.description) || d.text || 'Script error').split('\n')[0]);
    });
    const failedRequests = [];
    const net = { inflight: new Set() };
    const requestUrls = new Map();
    await s.send('Network.enable').catch(() => {});
    s.on('Network.requestWillBeSent', (p) => { requestUrls.set(p.requestId, p.request.url); if (!/^data:/.test(p.request.url)) net.inflight.add(p.requestId); });
    s.on('Network.loadingFinished', (p) => { net.inflight.delete(p.requestId); });
    s.on('Network.loadingFailed', (p) => {
      net.inflight.delete(p.requestId);
      const u = requestUrls.get(p.requestId);
      if (u && !p.canceled) failedRequests.push(u);
    });

    await s.send('Page.addScriptToEvaluateOnNewDocument', { source: 'var __KX_SEED__=' + JSON.stringify(seed) + ';' + TIMESHIM });

    progress('load', 0.1, 'Loading the page');
    let width = opts.width || 1920, height = opts.height || 1080;
    let viewport = [width, height];
    await navigate(s, url, width, height, net);

    // ----- stage -----
    let stage = await s.evaluate('window.__kxDetectStage()');
    if (!opts.width && stage && (stage.w !== width || stage.h !== height)) {
      width = Math.round(stage.w); height = Math.round(stage.h);
      progress('load', 0.2, 'Reloading at ' + width + '×' + height);
      viewport = [width, height];
      await navigate(s, url, width, height, net);
      stage = await s.evaluate('window.__kxDetectStage()');
    }
    const meta = await s.evaluate('window.__kxMeta()');

    // ----- timing -----
    const fps = opts.fps || meta.fps || 30;
    let duration = opts.duration, durationFrom = opts.duration ? 'override' : null;
    if (!duration && meta.duration) { duration = meta.duration; durationFrom = meta.durationFrom; }
    if (!duration && meta.gsapEnd) { duration = meta.gsapEnd; durationFrom = 'gsap'; }
    if (!duration && meta.waEnd && !meta.waInfinite) { duration = meta.waEnd; durationFrom = 'animations'; }
    if (!duration) {
      progress('measure', 0.2, 'Measuring the length');
      const m = await measureDuration(s, fps, (f) => progress('measure', 0.2 + f * 0.1, 'Measuring the length'));
      duration = m.duration; durationFrom = m.how;
      await navigate(s, url, width, height, net); // restart from t = 0
    }
    duration = Math.min(MAX_DURATION, Math.max(1 / fps, duration));
    const frameCount = Math.max(1, Math.round(duration * fps));

    // ----- stage mapping (viewport → comp), fixed from frame 0 -----
    const doc = await s.send('DOM.getDocument', { depth: 0 });
    const rootNode = doc.root.nodeId;
    let toComp = G.IDENTITY;
    let stageId = null;
    if (stage && stage.id) {
      stageId = stage.id;
      const q = await s.send('DOM.querySelector', { nodeId: rootNode, selector: '[data-kx-id="' + stage.id + '"]' });
      if (q.nodeId) {
        try {
          const bm = await s.send('DOM.getBoxModel', { nodeId: q.nodeId });
          const aff = G.affineFromQuad(bm.model.border, stage.w, stage.h).m;
          toComp = G.inv(aff) || G.IDENTITY;
          width = Math.round(stage.w); height = Math.round(stage.h);
        } catch (e) { /* keep identity */ }
      }
    }

    // ----- frames -----
    const times = [];
    const elements = new Map(); // id -> { first, frames: [] }
    const nodeIds = new Map();  // kx id -> CDP nodeId (refreshed when DOM changes)
    const fonts = new Map();    // kx id -> platform font info
    const hasCanvas = await s.evaluate('document.querySelectorAll("canvas").length > 0');
    const canvasFrames = new Map(); // kx id -> [dataURL per frame]

    await s.evaluate('window.__kx.advance(0)'); // CSS / Web Animations are born at t = 0
    for (let f = 0; f < frameCount; f++) {
      if (opts.signal && opts.signal.aborted) throw new Error('Cancelled');
      const t = f / fps;
      times.push(t);
      // Frame 0 is read a few ms in: libraries such as GSAP only render their first
      // state on the first ticker frame with elapsed time > 0 (as in a real browser).
      const vt = f === 0 ? Math.min(5, 500 / fps) : t * 1000;
      await s.evaluate(`window.__kx.advance(${vt.toFixed(4)})`);
      const sample = await s.evaluate(`window.__kxSample(${JSON.stringify({ order: true, canvas: hasCanvas })})`, { timeoutMs: 120000 });

      // CDP node ids for all tagged elements, in the same document order the sampler reported.
      const known = sample.docOrder.every((id) => nodeIds.has(id));
      if (!known) {
        const qa = await s.send('DOM.querySelectorAll', { nodeId: rootNode, selector: '[data-kx-id]' });
        if (qa.nodeIds.length === sample.docOrder.length) {
          for (let i = 0; i < qa.nodeIds.length; i++) nodeIds.set(sample.docOrder[i], qa.nodeIds[i]);
        } else {
          // Document changed between the two calls — map by attribute instead.
          for (const nid of qa.nodeIds) {
            const at = await s.send('DOM.getAttributes', { nodeId: nid });
            const k = at.attributes.indexOf('data-kx-id');
            if (k >= 0) nodeIds.set(+at.attributes[k + 1], nid);
          }
        }
      }

      // Pipelined box-model requests for HTML elements (SVG children use their CTM).
      const needQuad = sample.els.filter((e) => e.kind !== 'svgshape' && e.kind !== 'svgtext' && e.kind !== 'svgimage' && e.kind !== 'audio' && e.vis);
      const quads = await Promise.all(needQuad.map((e) => {
        const nid = nodeIds.get(e.id);
        if (!nid) return null;
        return s.send('DOM.getBoxModel', { nodeId: nid }).then((r) => r.model, () => null);
      }));
      const quadById = new Map();
      needQuad.forEach((e, i) => { if (quads[i]) quadById.set(e.id, quads[i]); });

      for (const rec of sample.els) {
        let el = elements.get(rec.id);
        if (!el) {
          el = { id: rec.id, first: rec, firstFrame: f, frames: new Array(frameCount).fill(null), order: null };
          elements.set(rec.id, el);
        }
        // Paint order as of the first frame the element is visible (opacity fades can
        // change stacking contexts while invisible).
        const visNow = rec.vis && rec.op > 0.0005;
        if (sample.order && sample.order[rec.id] && (!el.order || (!el.orderVis && visNow))) { el.order = sample.order[rec.id]; el.orderVis = visNow; }
        const qm = quadById.get(rec.id);
        if (qm) {
          rec.quad = mapQuad(qm.border, toComp);
          rec.cquad = mapQuad(qm.content, toComp);
          rec.pquad = mapQuad(qm.padding, toComp);
          // Prefer the sampler's sub-pixel size when it agrees with the (rounded) box model.
          rec.bw = rec.kind !== 'svgroot' && Math.abs((rec.w || 0) - qm.width) <= 1.01 ? rec.w : qm.width;
          rec.bh = rec.kind !== 'svgroot' && Math.abs((rec.h || 0) - qm.height) <= 1.01 ? rec.h : qm.height;
        }
        el.frames[f] = rec;
        // Font actually used for text: ask once, on first visible frame.
        if ((rec.text || rec.kind === 'svgtext') && rec.vis && !fonts.has(rec.id)) {
          const nid = nodeIds.get(rec.id);
          if (nid) {
            fonts.set(rec.id, null);
            try {
              const pf = await s.send('CSS.getPlatformFontsForNode', { nodeId: nid });
              const list = (pf.fonts || []).slice().sort((a, b) => b.glyphCount - a.glyphCount);
              if (list.length) fonts.set(rec.id, list[0]);
            } catch (e) { /* ignore */ }
          }
        }
      }
      if (sample.canvas) {
        for (const id of Object.keys(sample.canvas)) {
          if (!canvasFrames.has(+id)) canvasFrames.set(+id, new Array(frameCount).fill(null));
          canvasFrames.get(+id)[f] = sample.canvas[id];
        }
      }
      progress('frames', 0.3 + 0.6 * ((f + 1) / frameCount), 'Reading frame ' + (f + 1) + ' / ' + frameCount);
    }

    const finalMeta = await s.evaluate('window.__kxMeta()');
    const partial = { elements, frameCount, width, height, viewport };
    const rasterJobs = planRasters(partial);
    if (rasterJobs.length) await captureRasters(s, url, viewport, net, fps, frameCount, rasterJobs, progress, opts.signal);
    const recording = {
      source: abs,
      url,
      title: meta.title || path.basename(abs, path.extname(abs)),
      width, height, fps, duration: frameCount / fps, frameCount, durationFrom,
      stageId, stageHow: stage ? stage.how : 'viewport',
      bodyBg: meta.bodyBg,
      fontLinks: meta.fontLinks, fontFaces: meta.fontFaces,
      times, elements, fonts, canvasFrames,
      viewport, toComp, rasterJobs,
      errors: Array.from(new Set(consoleErrors.concat(finalMeta.errors || []))).slice(0, 20),
      failedRequests: Array.from(new Set(failedRequests.filter((u) => /^(https?|file):/.test(u)))).slice(0, 50),
      browser: path.basename(b.executable),
    };
    return { recording, session: s, close: b.close };
  } catch (e) {
    await b.close();
    throw e;
  }
}

module.exports = { capture };
