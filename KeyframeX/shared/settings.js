'use strict';
/**
 * Settings shared by the panel and the CLI.
 * Stored as JSON in the user's application-data folder:
 *   macOS   ~/Library/Application Support/KeyframeX/settings.json
 *   Windows %APPDATA%\KeyframeX\settings.json
 *   Linux   ~/.config/KeyframeX/settings.json
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function dataDir() {
  if (process.env.KEYFRAMEX_HOME) return process.env.KEYFRAMEX_HOME;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'KeyframeX');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'KeyframeX');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'KeyframeX');
}

const DEFAULTS = {
  version: 1,
  convert: { fps: 0, quality: 'balanced', target: 'new', installFonts: true, openComp: true },
  browserPath: '',
  recent: [],
};

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(over)) {
    out[k] = base && typeof base[k] === 'object' && base[k] && !Array.isArray(base[k]) ? merge(base[k], over[k]) : over[k];
  }
  return out;
}

function file() { return path.join(dataDir(), 'settings.json'); }

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch (e) { /* first run or unreadable */ }
  const s = merge(DEFAULTS, saved);
  // Settings of removed features (AI generation, bridge) are dropped on load.
  delete s.providers; delete s.generate; delete s.bridge;
  return s;
}

function save(s) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
  return s;
}

function update(fn) {
  const s = load();
  const r = fn(s) || s;
  return save(r);
}

function addRecent(p) {
  return update((s) => {
    s.recent = [p].concat((s.recent || []).filter((x) => x !== p)).slice(0, 8);
    return s;
  });
}

module.exports = { dataDir, load, save, update, addRecent, DEFAULTS, file };
