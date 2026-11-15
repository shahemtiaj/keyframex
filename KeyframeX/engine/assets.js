'use strict';
/**
 * Asset resolution: turns the URLs found on the page into files After Effects
 * can import, inside the output folder.
 *   - local files are referenced in place (formats AE can't read are converted)
 *   - web images / clips are downloaded (failures become placeholders + a note)
 *   - WebP / AVIF / SVG pictures are re-encoded to PNG through the browser
 *   - <canvas> drawings become a PNG still or a PNG sequence
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { fileURLToPath } = require('url');

const AE_IMAGE = /\.(png|jpe?g|psd|tiff?|gif|bmp|tga|exr|ai|eps|pdf)$/i;
const AE_VIDEO = /\.(mp4|mov|m4v|avi|mxf|mpg|mpeg)$/i;
const AE_AUDIO = /\.(mp3|wav|aiff?|m4a|aac)$/i;
const CONVERT = /\.(webp|avif|svg|ico|jfif)$/i;

function safeName(s) {
  return String(s || 'file').replace(/[^\w.\-]+/g, '_').replace(/^_+/, '').slice(-80) || 'file';
}

function download(url, dest, { maxBytes = 512 * 1024 * 1024, timeoutMs = 30000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 KeyframeX', Accept: '*/*' }, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).href, dest, { maxBytes, timeoutMs, redirects: redirects - 1 }));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      let size = 0;
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.on('data', (d) => { size += d.length; if (size > maxBytes) { req.destroy(new Error('File too large')); } });
      res.pipe(out);
      out.on('finish', () => { out.close(() => { fs.renameSync(tmp, dest); resolve({ path: dest, bytes: size, type: res.headers['content-type'] || '' }); }); });
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
  });
}

function extFromType(type) {
  if (/png/.test(type)) return '.png';
  if (/jpe?g/.test(type)) return '.jpg';
  if (/webp/.test(type)) return '.webp';
  if (/svg/.test(type)) return '.svg';
  if (/gif/.test(type)) return '.gif';
  if (/avif/.test(type)) return '.avif';
  if (/mp4/.test(type)) return '.mp4';
  if (/quicktime/.test(type)) return '.mov';
  if (/mpeg/.test(type) && /audio/.test(type)) return '.mp3';
  if (/wav/.test(type)) return '.wav';
  return '';
}

async function toPng(session, srcUrlOrData, dest) {
  const data = await session.evaluate('window.__kxToPng(' + JSON.stringify(srcUrlOrData) + ', 4096)', { timeoutMs: 30000 });
  if (!data) return null;
  fs.writeFileSync(dest, Buffer.from(data.split(',')[1], 'base64'));
  return dest;
}

/**
 * Resolve every asset of a scene in place.
 * @returns {Promise<{online: Array, missing: Array}>}
 */
async function resolveAssets(scene, rec, session, outDir, onProgress) {
  const assetDir = path.join(outDir, 'assets');
  fs.mkdirSync(assetDir, { recursive: true });
  const online = [], missing = [];
  const rel = (p) => path.relative(outDir, p).split(path.sep).join('/');
  let i = 0;
  for (const a of scene.assets) {
    i++;
    if (onProgress) onProgress(i / Math.max(1, scene.assets.length), 'Preparing media ' + i + ' / ' + scene.assets.length);
    try {
      if (/^data:/.test(a.url)) {
        const m = /^data:([^;,]+)(;base64)?,(.*)$/.exec(a.url);
        const type = m ? m[1] : 'image/png';
        const buf = m && m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m ? m[3] : ''), 'utf8');
        const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 10);
        let dest = path.join(assetDir, 'embedded_' + hash + (extFromType(type) || '.bin'));
        fs.writeFileSync(dest, buf);
        if (CONVERT.test(dest)) dest = (await toPng(session, a.url, dest.replace(/\.\w+$/, '.png'))) || dest;
        a.path = dest; a.rel = rel(dest);
        delete a.url; a.origin = 'embedded';
        continue;
      }
      if (/^file:/.test(a.url)) {
        const p = fileURLToPath(a.url.split('#')[0].split('?')[0]);
        if (!fs.existsSync(p)) { a.missing = true; missing.push({ id: a.id, url: a.url, reason: 'File not found' }); continue; }
        if (CONVERT.test(p) && a.kind === 'image') {
          const dest = path.join(assetDir, safeName(path.basename(p).replace(/\.\w+$/, '')) + '.png');
          const done = await toPng(session, a.url, dest);
          if (done) { a.path = done; a.rel = rel(done); a.convertedFrom = path.basename(p); } else { a.path = p; a.missing = true; missing.push({ id: a.id, url: a.url, reason: 'Could not convert to PNG' }); }
        } else {
          a.path = p;
          a.rel = path.relative(outDir, p).split(path.sep).join('/');
        }
        continue;
      }
      if (/^https?:/.test(a.url)) {
        const base = safeName(decodeURIComponent(new URL(a.url).pathname.split('/').pop() || a.id));
        let dest = path.join(assetDir, base);
        const info = { id: a.id, url: a.url, saveAs: dest };
        online.push(info);
        try {
          const r = await download(a.url, dest);
          if (!path.extname(dest) || !(AE_IMAGE.test(dest) || AE_VIDEO.test(dest) || AE_AUDIO.test(dest) || CONVERT.test(dest))) {
            const ext = extFromType(r.type);
            if (ext) { fs.renameSync(dest, dest + ext); dest += ext; }
          }
          if (CONVERT.test(dest) && a.kind === 'image') {
            const b64 = 'data:' + (r.type || 'image/png') + ';base64,' + fs.readFileSync(dest).toString('base64');
            const png = await toPng(session, b64, dest.replace(/\.\w+$/, '') + '.png');
            if (png) dest = png;
          }
          a.path = dest; a.rel = rel(dest); a.origin = a.url;
          info.status = 'downloaded'; info.saveAs = dest;
        } catch (e) {
          a.missing = true; a.origin = a.url; a.saveAs = dest; a.rel = rel(dest);
          info.status = 'failed'; info.error = e.message;
          missing.push({ id: a.id, url: a.url, reason: e.message, saveAs: dest });
        }
        continue;
      }
      a.missing = true;
      missing.push({ id: a.id, url: a.url, reason: 'Unsupported URL' });
    } catch (e) {
      a.missing = true;
      missing.push({ id: a.id, url: a.url, reason: e.message });
    }
  }

  // Canvas drawings → still or sequence.
  for (const L of scene.layers) {
    if (typeof L.asset !== 'string' || L.asset.indexOf('canvas:') !== 0) continue;
    const id = +L.asset.slice(7);
    const frames = rec.canvasFrames.get(id) || [];
    const hashes = frames.map((d) => (d ? crypto.createHash('md5').update(d).digest('hex') : null));
    const valid = hashes.filter(Boolean);
    const aid = 'cv' + id;
    if (!valid.length) {
      scene.notes.push({ kind: 'skip', message: 'A <canvas> could not be read (cross-origin pictures make it unreadable).', layers: [L.name] });
      L.asset = null; L.skip = true;
      continue;
    }
    const still = new Set(valid).size === 1;
    if (still) {
      const dest = path.join(assetDir, 'canvas_' + id + '.png');
      fs.writeFileSync(dest, Buffer.from(frames.find(Boolean).split(',')[1], 'base64'));
      scene.assets.push({ id: aid, kind: 'image', path: dest, rel: rel(dest), origin: 'canvas' });
    } else {
      const dir = path.join(assetDir, 'canvas_' + id);
      fs.mkdirSync(dir, { recursive: true });
      let lastData = frames.find(Boolean);
      frames.forEach((d, f) => {
        if (d) lastData = d;
        fs.writeFileSync(path.join(dir, 'canvas_' + id + '_' + String(f).padStart(5, '0') + '.png'), Buffer.from(lastData.split(',')[1], 'base64'));
      });
      const first = path.join(dir, 'canvas_' + id + '_00000.png');
      scene.assets.push({ id: aid, kind: 'sequence', path: first, rel: rel(first), frames: frames.length, fps: scene.comp.fps, origin: 'canvas' });
      scene.notes.push({ kind: 'raster', message: 'Canvas drawing comes in as a PNG sequence (' + frames.length + ' frames).', layers: [L.name] });
    }
    L.asset = aid;
  }
  // Element pictures (raster fallbacks) → still or sequence.
  const jobs = new Map((rec.rasterJobs || []).map((j) => [j.id, j]));
  const N = rec.frameCount;
  for (const L of scene.layers) {
    if (typeof L.asset !== 'string' || L.asset.indexOf('raster:') !== 0) continue;
    const id = +L.asset.slice(7);
    const j = jobs.get(id);
    const aid = 'px' + id;
    if (!j) { L.skip = true; continue; }
    if (j.mode === 'static') {
      const dest = path.join(assetDir, 'picture_' + id + '.png');
      fs.writeFileSync(dest, Buffer.from(j.images[j.f0], 'base64'));
      scene.assets.push({ id: aid, kind: 'image', path: dest, rel: rel(dest), origin: 'picture' });
    } else {
      const dir = path.join(assetDir, 'picture_' + id);
      fs.mkdirSync(dir, { recursive: true });
      const blankData = await session.evaluate('window.__kxBlankPng(' + j.clip[2] + ',' + j.clip[3] + ')');
      const blank = path.join(dir, '_blank.png');
      fs.writeFileSync(blank, Buffer.from(blankData.split(',')[1], 'base64'));
      const name = (f) => path.join(dir, 'picture_' + id + '_' + String(f).padStart(5, '0') + '.png');
      for (let f = 0; f < N; f++) {
        if (j.images[f]) fs.writeFileSync(name(f), Buffer.from(j.images[f], 'base64'));
        else fs.copyFileSync(blank, name(f));
      }
      fs.unlinkSync(blank);
      scene.assets.push({ id: aid, kind: 'sequence', path: name(0), rel: rel(name(0)), frames: N, fps: scene.comp.fps, origin: 'picture' });
    }
    L.asset = aid;
  }
  scene.layers = scene.layers.filter((L) => !L.skip);
  if (online.length) {
    const lines = ['KeyframeX — online media', '', 'Each file below was loaded from the web by the HTML page.', 'If a download failed, save the file at the path shown, then use "Relink media" in the panel.', ''];
    for (const o of online) lines.push((o.status === 'downloaded' ? '[ok]     ' : '[needed] ') + o.url, '         → ' + o.saveAs + (o.error ? '   (' + o.error + ')' : ''), '');
    fs.writeFileSync(path.join(outDir, 'ONLINE MEDIA.txt'), lines.join('\n'));
  }
  return { online, missing };
}

module.exports = { resolveAssets, download };
