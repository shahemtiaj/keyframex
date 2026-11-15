'use strict';
/**
 * Font collection & installation.
 *
 * After Effects can only use fonts installed on the system. For the fonts a
 * converted page uses, KeyframeX can:
 *   - download Google Fonts / Bunny Fonts as TTF (their CSS API returns TTF to
 *     non-browser clients),
 *   - copy local @font-face files (.ttf / .otf),
 * save them next to the scene (fonts/) and install them for the current user.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { fileURLToPath } = require('url');
const { download } = require('./assets');

function fetchText(url, ua) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': ua || 'KeyframeX/1.0' }, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); resolve(fetchText(new URL(res.headers.location, url).href, ua)); return; }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve(d));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('Timed out')); });
  });
}

function parseFontFaces(css) {
  const out = [];
  const re = /@font-face\s*{([^}]*)}/g;
  let m;
  while ((m = re.exec(css))) {
    const body = m[1];
    const g = (k) => { const x = new RegExp(k + '\\s*:\\s*([^;]+)').exec(body); return x ? x[1].trim() : null; };
    const src = /url\(([^)]+)\)\s*format\(['"]?(truetype|opentype)['"]?\)/.exec(body) || /url\(([^)]+\.(?:ttf|otf))\)/.exec(body);
    if (!src) continue;
    out.push({
      family: (g('font-family') || '').replace(/["']/g, ''),
      style: g('font-style') || 'normal',
      weight: g('font-weight') || '400',
      url: src[1].replace(/["']/g, ''),
    });
  }
  return out;
}

function userFontDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Fonts');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts');
  return path.join(os.homedir(), '.local', 'share', 'fonts');
}

function registerWindowsFont(file, name) {
  return new Promise((resolve) => {
    execFile('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', '/v', name + ' (TrueType)', '/t', 'REG_SZ', '/d', file, '/f'], () => resolve());
  });
}

function weightMatches(wanted, spec) {
  const parts = String(spec).split(/\s+/).map(Number).filter((n) => !isNaN(n));
  if (parts.length === 2) return wanted >= parts[0] && wanted <= parts[1];
  return parts[0] === wanted;
}

/**
 * Gather the font files a scene needs.
 * @param {object} scene
 * @param {object} pageFonts { fontLinks: [cssUrl], fontFaces: [{family, weight, style, url}] }
 * @param {string} outDir scene folder (fonts are saved in outDir/fonts)
 */
async function collectFonts(scene, pageFonts, outDir) {
  const wanted = (scene.fonts || []).filter((f) => f.family);
  const fontDir = path.join(outDir, 'fonts');
  const results = [];
  if (!wanted.length) return results;
  const faces = [];
  for (const link of pageFonts.fontLinks || []) {
    try { faces.push.apply(faces, parseFontFaces(await fetchText(link))); } catch (e) { results.push({ family: link, status: 'failed', error: e.message }); }
  }
  for (const f of pageFonts.fontFaces || []) if (/\.(ttf|otf)(\?|$)/i.test(f.url)) faces.push(f);
  const used = new Set();
  for (const w of wanted) {
    const style = w.style === 'italic' ? 'italic' : 'normal';
    const cands = faces.filter((f) => f.family.toLowerCase() === String(w.family).toLowerCase() && (f.style === style || (style === 'normal' && f.style !== 'italic')));
    if (!cands.length) continue;
    const exact = cands.find((f) => weightMatches(w.weight, f.weight)) || cands[0];
    if (used.has(exact.url)) continue;
    used.add(exact.url);
    fs.mkdirSync(fontDir, { recursive: true });
    const isVar = /\s/.test(String(exact.weight).trim());
    const ext = /\.otf(\?|$)/i.test(exact.url) ? '.otf' : '.ttf';
    const fname = (exact.family.replace(/\s+/g, '') + '-' + (isVar ? 'Variable' : exact.weight) + (exact.style === 'italic' ? 'Italic' : '') + ext).replace(/[^\w.\-]/g, '');
    const dest = path.join(fontDir, fname);
    try {
      if (/^file:/.test(exact.url)) fs.copyFileSync(fileURLToPath(exact.url), dest);
      else await download(exact.url, dest, { maxBytes: 30 * 1024 * 1024 });
      results.push({ family: exact.family, weight: exact.weight, style: exact.style, file: dest, status: 'collected' });
    } catch (e) {
      results.push({ family: exact.family, weight: exact.weight, status: 'failed', error: e.message });
    }
  }
  return results;
}

/** Install collected font files for the current user. Never overwrites an existing font file. */
async function installFonts(collected) {
  const dir = userFontDir();
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const c of collected) {
    if (c.status !== 'collected') { out.push(c); continue; }
    const dest = path.join(dir, path.basename(c.file));
    try {
      if (fs.existsSync(dest)) { out.push(Object.assign({}, c, { status: 'already-installed', installed: dest })); continue; }
      fs.copyFileSync(c.file, dest);
      if (process.platform === 'win32') await registerWindowsFont(dest, c.family + ' ' + c.weight);
      out.push(Object.assign({}, c, { status: 'installed', installed: dest }));
    } catch (e) {
      out.push(Object.assign({}, c, { status: 'failed', error: e.message }));
    }
  }
  return out;
}

module.exports = { collectFonts, installFonts, parseFontFaces, userFontDir };
