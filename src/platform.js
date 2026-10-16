'use strict';
/*
 * Meld Hall — StarHermit platform glue over the shared SDK
 * (window.StarHermit from starhermit-sdk.js, loaded first). The SDK owns the
 * launch token (+ renewal), sign-in, profiles, the game:<slug> cloud-save
 * slot, the settings KV and key bindings; this module keeps Meld Hall's API:
 * cloud save (local and cloud progress merged, localStorage stays the
 * offline cache; a write that loses to another device's save is reloaded,
 * merged and saved again), settings mirroring, read-only leaderboard and a
 * small sync status.
 * UMD: loads in Node for tests (pass an SDK instance to boot()).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MeldPlatform = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {

  // Localization (src/i18n.js, browser only): T() translates an English key.
  function T(key, vars) {
    const I = typeof globalThis !== 'undefined' ? globalThis.MHI18N : null;
    if (I) return I.T(key, vars);
    return String(key).replace(/\{(\w+)\}/g, function (m, k) { return vars && k in vars ? vars[k] : m; });
  }

  let sh = null;             // SDK instance (globalThis.StarHermit unless injected)
  let nickname = null;       // account nickname (never username)
  let syncStatus = 'local';  // local | syncing | synced | saving | offline
  const listeners = [];
  const authListeners = [];

  function enabled() { return !!(sh && sh.signedIn); }
  function accessToken() { return enabled() ? sh.token : null; }
  function gameKey() { return sh ? sh.slug : null; }
  function onSync(fn) { listeners.push(fn); }
  function onAuth(fn) { authListeners.push(fn); }
  function notify() { for (const fn of listeners) { try { fn(); } catch (_) {} } }
  function setStatus(s) { if (s !== syncStatus) { syncStatus = s; notify(); } }
  function statusText() {
    switch (syncStatus) {
      case 'syncing': return T('syncing…');
      case 'saving': return T('saving…');
      case 'offline': return T('offline — saved on this device');
      case 'synced': return T('synced to your account');
      default: return T('saved on this device');
    }
  }
  function displayName() {
    if (nickname) return nickname;
    if (enabled()) return T('Player {id}', { id: String(sh.userId).slice(0, 6) });
    return T('Player');
  }
  function loadProfile() {
    sh.profile().then(function (p) {
      nickname = p ? String(p.displayName).slice(0, 24) : null;
      notify();
    });
  }

  // Profile nickname for an arbitrary user id (leaderboard rows).
  function profileName(userId) {
    const id = String(userId || '');
    if (!id || !enabled()) return Promise.resolve(T('Player'));
    return sh.profile(id).then(function (p) {
      return p ? String(p.displayName).slice(0, 24) : T('Player {id}', { id: id.slice(0, 6) });
    });
  }

  /* ---------- cloud save (game:<slug> slot; localStorage stays the cache) ---------- */
  let rawSave = null; // original Session.saveProgress, captured before wrapping
  let session = null; // the Session module passed to boot()
  function num(x) { return typeof x === 'number' && isFinite(x) ? x : 0; }
  function union(a, b) { return Object.assign({}, b || {}, a || {}); }
  // Merge two progress documents (this device's and the cloud's) so neither
  // side's progress is lost: the further journey unlock, union of cleared
  // stages / dailies / achievements, the larger career counters.
  function mergeProgress(Session, local, remote) {
    const base = JSON.parse(JSON.stringify(Session.DEFAULT_PROGRESS));
    const a = Object.assign({}, base, local || {});
    const b = Object.assign({}, base, remote || {});
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
  function localProgress(Session) {
    return typeof Session.loadProgress === 'function' ? Session.loadProgress() : null;
  }
  // Another device saved since our last load (the SDK refused our write):
  // reload the cloud copy, merge it with this device's progress, save the merge.
  function resolveConflict() {
    if (!enabled() || !session) return Promise.resolve(false);
    setStatus('syncing');
    return sh.loadJSON().then(function (remote) {
      const merged = mergeProgress(session, localProgress(session), remote);
      (rawSave || session.saveProgress)(merged);
      notify();
      if (!sh.saveConflicted()) { setStatus('saving'); sh.saveJSON(merged, 0); }
      return true;
    });
  }

  /* ---------- settings KV (changed keys only; key bindings travel via controls) ---------- */
  let lastSettings = null;
  let pendingPatch = null;
  let settingsTimer = null;
  function kvView(s) {
    const o = Object.assign({}, s);
    delete o.bindings;
    return o;
  }
  function primeSettings(s) { lastSettings = JSON.stringify(kvView(s)); }
  function pushSettings(s) {
    if (!enabled() || lastSettings === null) return;
    const obj = kvView(s);
    const json = JSON.stringify(obj);
    if (json === lastSettings) return;
    const prev = JSON.parse(lastSettings);
    lastSettings = json;
    pendingPatch = pendingPatch || {};
    for (const k of Object.keys(obj)) {
      if (JSON.stringify(obj[k]) !== JSON.stringify(prev[k])) pendingPatch[k] = obj[k];
    }
    if (settingsTimer) clearTimeout(settingsTimer);
    settingsTimer = setTimeout(flushSettings, 1500);
  }
  function flushSettings() {
    if (settingsTimer) { clearTimeout(settingsTimer); settingsTimer = null; }
    if (!pendingPatch || !enabled()) return Promise.resolve(null);
    const patch = pendingPatch;
    pendingPatch = null;
    return sh.patchSettings(patch);
  }
  // Platform settings win over the local copy, key by key (bindings excluded).
  function loadSettings(Session, settings) {
    if (!enabled()) return Promise.resolve(false);
    return sh.getSettings().then(function (kv) {
      let changed = false;
      for (const k of Object.keys(Session.DEFAULT_SETTINGS)) {
        if (k === 'bindings') continue;
        if (kv && kv[k] !== undefined && kv[k] !== null) { settings[k] = kv[k]; changed = true; }
      }
      if (changed) Session.saveSettings(settings);
      primeSettings(settings);
      return changed;
    });
  }

  function wrapSession(Session) {
    const origSave = Session.saveProgress;
    rawSave = function (data) { origSave(data); };
    Session.saveProgress = function (p) {
      origSave(p);                       // offline cache first, always
      if (!enabled()) return;
      setStatus('saving');
      sh.saveJSON(p, 2000);              // debounced cloud mirror
    };
    const origSettings = Session.saveSettings;
    Session.saveSettings = function (s) {
      origSettings(s);
      pushSettings(s);
    };
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      const flush = function () { if (enabled()) { sh.flushSave(true); flushSettings(); } };
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); });
    }
  }

  // Boot load: a present cloud doc is merged with this device's progress and
  // reseeds the local cache (the merge is saved back when it adds anything);
  // absent keeps the local progress untouched.
  function initCloud(Session) {
    if (!enabled()) return Promise.resolve(false);
    setStatus('syncing');
    return sh.loadJSON().then(function (data) {
      if (data) {
        const merged = mergeProgress(Session, localProgress(Session), data);
        (rawSave || Session.saveProgress)(merged);
        if (JSON.stringify(merged) !== JSON.stringify(mergeProgress(Session, null, data))) {
          setStatus('saving');
          sh.saveJSON(merged, 0);
          return true;
        }
      }
      setStatus('synced');
      return !!data;
    });
  }

  /* ---------- read-only leaderboard (the game's first platform board) ---------- */
  function fetchLeaderboard() {
    if (!enabled()) return Promise.resolve(null);
    return sh.leaderboard(null, { pageSize: 10 }).then(function (page) {
      const list = (page && page.items) || [];
      if (!page || !page.board || !list.length) return null;
      return Promise.all(list.slice(0, 10).map(function (e, i) {
        return profileName(e.userId).then(function (name) {
          return {
            rank: e.rank !== undefined ? e.rank : i + 1,
            name: name,
            score: e.score !== undefined ? e.score : (e.value !== undefined ? e.value : 0),
          };
        });
      }));
    }).catch(function () { return null; });
  }

  /* ---------- leaderboard posting (score-script.js) ---------- */
  // Signed in only: posts a finished match total through submitScores to the
  // high-score board. Resolves { posted, rank } (rank or null).
  function submitScore(total) {
    if (!enabled()) return Promise.resolve({ posted: false, rank: null });
    return sh.submitScores({ 'high-score': total }).then(function (keys) {
      if (!keys || keys.indexOf('high-score') < 0) return { posted: false, rank: null };
      return sh.leaderboard('high-score', { pageSize: 100 }).then(function (r) {
        const me = ((r && r.items) || []).filter(function (i) { return i.userId === sh.userId; })[0];
        return { posted: true, rank: me ? me.rank : null };
      }, function () { return { posted: true, rank: null }; });
    }, function () { return { posted: false, rank: null }; });
  }

  /* ---------- boot ---------- */
  // Reads the launch token via the SDK and wires save/settings mirroring.
  // Returns true when signed in.
  function boot(Session, sdk) {
    sh = sdk || (typeof globalThis !== 'undefined' ? globalThis.StarHermit : null) || null;
    if (!sh) return false;
    sh.init();
    sh.on('saved', function (ok) { setStatus(ok ? 'synced' : 'offline'); });
    sh.on('saveconflict', function () { resolveConflict(); });
    session = Session || null;
    sh.on('auth', function (a) {
      if (!a.signedIn) { nickname = null; setStatus('local'); }
      for (const fn of authListeners) { try { fn(a); } catch (_) {} }
    });
    if (Session) wrapSession(Session);
    if (!sh.signedIn) return false;
    setStatus('syncing');
    loadProfile();
    return true;
  }

  return {
    boot: boot,
    enabled: enabled,
    accessToken: accessToken,
    gameKey: gameKey,
    displayName: displayName,
    statusText: statusText,
    onSync: onSync,
    onAuth: onAuth,
    initCloud: initCloud,
    resolveConflict: resolveConflict,
    mergeProgress: mergeProgress,
    flushCloud: function () { return enabled() ? sh.flushSave(true) : Promise.resolve(false); },
    loadSettings: loadSettings,
    flushSettings: flushSettings,
    loadBindings: function (defaults) { return enabled() ? sh.loadBindings(defaults) : Promise.resolve(defaults); },
    canSignIn: function () { return !!sh && sh.canSignIn(); },
    signIn: function () { return !!sh && sh.signIn(); },
    inviteLink: function () { return enabled() ? sh.inviteLink() : null; },
    fetchLeaderboard: fetchLeaderboard,
    submitScore: submitScore,
    profileName: profileName,
  };
});
