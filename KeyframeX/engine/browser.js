'use strict';
/**
 * Finds and launches a Chromium-family browser (Chrome, Edge, Brave, Chromium)
 * in headless mode with remote debugging, then returns a CDP session for its page.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { CDPSession } = require('./cdp');

function candidatePaths() {
  const p = process.platform;
  if (p === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
      'Chromium.app/Contents/MacOS/Chromium',
      'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ];
    const roots = ['/Applications', path.join(os.homedir(), 'Applications')];
    const out = [];
    for (const r of roots) for (const a of apps) out.push(path.join(r, a));
    return out;
  }
  if (p === 'win32') {
    const bases = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(Boolean);
    const rel = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'Chromium\\Application\\chrome.exe',
    ];
    const out = [];
    for (const b of bases) for (const r of rel) out.push(path.join(b, r));
    return out;
  }
  return [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium',
  ];
}

/** Returns the first browser executable that exists, or null. */
function findBrowser(preferred) {
  const list = [];
  if (preferred) list.push(preferred);
  if (process.env.KEYFRAMEX_BROWSER) list.push(process.env.KEYFRAMEX_BROWSER);
  list.push(...candidatePaths());
  for (const c of list) {
    try { if (c && fs.statSync(c).isFile()) return c; } catch (e) { /* not there */ }
  }
  return null;
}

function getJSON(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Launch a headless browser. Returns { session, close(), executable }.
 * @param {object} opts { executable, width, height, log }
 */
async function launch(opts = {}) {
  const executable = findBrowser(opts.executable);
  if (!executable) {
    const err = new Error('KeyframeX needs Google Chrome, Microsoft Edge, Brave or Chromium. Install one, or set its path in Settings.');
    err.code = 'NO_BROWSER';
    throw err;
  }
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyframex-chrome-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + userDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-domain-reliability',
    '--no-pings',
    '--metrics-recording-only',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=Translate,MediaRouter',
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
    '--hide-scrollbars',
    '--mute-audio',
    '--force-color-profile=srgb',
    '--font-render-hinting=none',
    '--window-size=' + (opts.width || 1920) + ',' + (opts.height || 1080),
  ];
  if (process.platform === 'linux') args.push('--no-sandbox', '--disable-dev-shm-usage');
  args.push('about:blank');

  let session = null;
  const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });

  const close = async () => {
    try { if (session) session.close(); } catch (e) { /* ignore */ }
    try { child.kill(); } catch (e) { /* ignore */ }
    await sleep(150);
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* Chrome may still hold files */ }
  };

  // Chrome writes the chosen port into DevToolsActivePort once it is ready.
  let port = null;
  const portFile = path.join(userDir, 'DevToolsActivePort');
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const txt = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (txt) { port = parseInt(txt, 10); break; }
    } catch (e) { /* not yet */ }
    const m = stderr.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
    if (m) { port = parseInt(m[1], 10); break; }
    await sleep(100);
  }
  if (!port) {
    await close();
    throw new Error('The browser did not start (' + path.basename(executable) + '). ' + stderr.split('\n').slice(-3).join(' ').trim());
  }

  let target = null;
  for (let i = 0; i < 50 && !target; i++) {
    try {
      const list = await getJSON(port, '/json/list');
      target = list.find((t) => t.type === 'page');
    } catch (e) { /* retry */ }
    if (!target) await sleep(100);
  }
  if (!target) { await close(); throw new Error('Could not find the browser page target.'); }

  session = await CDPSession.connect(target.webSocketDebuggerUrl);
  return { session, close, executable };
}

module.exports = { findBrowser, launch, candidatePaths };
