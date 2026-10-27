'use strict';
/*
 * Meld Hall — the save document and the game's own options. Pure (no storage,
 * no platform): the engine client (native/platform.ts) and the node tests
 * share it.
 *
 * The save is the progress document session.js keeps (DEFAULT_PROGRESS:
 * journey unlock and clears, mastery count, dailies, achievements, career
 * counters) — exactly what the browser build kept in localStorage under
 * meldhall.save.v1 (inside a checksummed envelope) and mirrored to the cloud
 * slot game:<slug> as plain JSON (the JS SDK's saveJSON). mergeProgress is
 * the browser build's conflict merge (src/platform.js), readForeign reads the
 * old cloud slot's text, wrap/unwrap are session.js's localStorage envelope.
 *
 * The game's own options (captions, haptics, colour palette, left-handed tray)
 * and the finished lessons (tutorialSeen) were session.js settings mirrored
 * into the account's settings KV; the engine keeps them as its settings
 * (same keys). The rest of those settings (volumes, mute, graphics, reduced
 * motion, high contrast, larger text, bindings, language) are the runtime's
 * Options now, and their KV keys are removed.
 * UMD: module.exports in Node, globalThis.MeldStore for loadClassic.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MeldStore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {

  const DEFAULT_PROGRESS = {
    journeyUnlocked: 1, journeyCleared: {}, masteryCleared: 0,
    dailiesPlayed: {}, achievements: {},
    career: { melds: 0, rounds: 0, winStreak: 0, bestStreak: 0 },
    lastDailySeed: null,
  };
  const clone = function (x) { return JSON.parse(JSON.stringify(x)); };
  const obj = function (v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; };
  function num(x) { return typeof x === 'number' && isFinite(x) ? x : 0; }
  function union(a, b) { return Object.assign({}, b || {}, a || {}); }

  /** A progress document from anything (missing fields from the defaults). */
  function normalize(raw) {
    const p = Object.assign(clone(DEFAULT_PROGRESS), obj(raw) || {});
    p.career = Object.assign(clone(DEFAULT_PROGRESS.career), obj(p.career) || {});
    for (const k of ['journeyCleared', 'dailiesPlayed', 'achievements']) p[k] = obj(p[k]) || {};
    return p;
  }

  // Merge two progress documents (this device's and another's) so neither
  // side's progress is lost: the further journey unlock, union of cleared
  // stages / dailies / achievements, the larger career counters.
  function mergeProgress(local, remote) {
    const base = clone(DEFAULT_PROGRESS);
    const a = Object.assign({}, base, obj(local) || {});
    const b = Object.assign({}, base, obj(remote) || {});
    const ca = Object.assign({}, base.career, a.career || {});
    const cb = Object.assign({}, base.career, b.career || {});
    return Object.assign({}, b, a, {
      journeyUnlocked: Math.max(num(a.journeyUnlocked) || 1, num(b.journeyUnlocked) || 1),
      journeyCleared: union(a.journeyCleared, b.journeyCleared),
      masteryCleared: Math.max(num(a.masteryCleared), num(b.masteryCleared)),
      dailiesPlayed: union(a.dailiesPlayed, b.dailiesPlayed),
      achievements: union(a.achievements, b.achievements),
      career: {
        melds: Math.max(num(ca.melds), num(cb.melds)),
        rounds: Math.max(num(ca.rounds), num(cb.rounds)),
        winStreak: Math.max(num(ca.winStreak), num(cb.winStreak)),
        bestStreak: Math.max(num(ca.bestStreak), num(cb.bestStreak)),
      },
      lastDailySeed: a.lastDailySeed || b.lastDailySeed || null,
    });
  }
  /** Key-order-free JSON (the same document merged either way round). */
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    return JSON.stringify(v);
  }
  function same(a, b) { return canon(normalize(a)) === canon(normalize(b)); }

  /** The browser build's cloud slot text (its progress as JSON), or null. */
  function readForeign(text) {
    if (typeof text !== 'string' || !text) return null;
    try { const d = JSON.parse(text); return obj(d) ? normalize(d) : null; } catch (_) { return null; }
  }

  // session.js's localStorage envelope { v: 1, data, checksum } (djb2 over the JSON).
  function checksum(data) {
    const s = JSON.stringify(data);
    let h = 5381;
    for (let i = 0; i < s.length; ++i) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
    return h;
  }
  function wrap(data) { return JSON.stringify({ v: 1, data: data, checksum: checksum(data) }); }
  function unwrap(text) {
    try {
      const doc = JSON.parse(text);
      return doc && doc.v === 1 && doc.checksum === checksum(doc.data) ? doc.data : null;
    } catch (_) { return null; }
  }

  /* ---------- the game's own options (engine settings) ---------- */
  const PALETTES = ['default', 'deuteranopia', 'protanopia', 'tritanopia'];
  const DEFAULT_OPTIONS = { captions: true, haptics: true, colorPalette: 'default', leftHanded: false, tutorialSeen: {} };
  const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);
  /** The valid option values in raw (others left out). */
  function pickOptions(raw) {
    const r = obj(raw) || {}, out = {};
    for (const k of ['captions', 'haptics', 'leftHanded']) if (typeof r[k] === 'boolean') out[k] = r[k];
    if (PALETTES.indexOf(r.colorPalette) >= 0) out.colorPalette = r.colorPalette;
    if (obj(r.tutorialSeen)) {
      const seen = {};
      for (const k of Object.keys(r.tutorialSeen)) if (r.tutorialSeen[k] === true) seen[k] = true;
      out.tutorialSeen = seen;
    }
    return out;
  }
  // Every key the browser build wrote to the account's settings KV (session.js
  // DEFAULT_SETTINGS without bindings, and sh-language.js's ui.language).
  const BROWSER_KEYS = ['music', 'effects', 'ambience', 'voice', 'muted', 'captions', 'quality', 'graphics',
    'reducedMotion', 'highContrast', 'largeText', 'colorPalette', 'leftHanded', 'holdToConfirm', 'timingAssist',
    'haptics', 'camera', 'tutorialSeen', 'ui.language'];

  return {
    DEFAULT_PROGRESS: DEFAULT_PROGRESS, normalize: normalize, mergeProgress: mergeProgress, same: same,
    readForeign: readForeign, wrap: wrap, unwrap: unwrap,
    PALETTES: PALETTES, DEFAULT_OPTIONS: DEFAULT_OPTIONS, OPTION_KEYS: OPTION_KEYS, pickOptions: pickOptions,
    BROWSER_KEYS: BROWSER_KEYS,
  };
});
