'use strict';
/*
 * Meld Hall — StarHermit platform glue.
 * Launch-token read/strip, Bearer auth + 45-min refresh, account nickname,
 * cloud save (single zip slot, remote-preferred, localStorage stays the
 * offline cache), read-only leaderboard fetch, and a small sync status.
 * Same-origin only; no hard-coded API base. UMD: loads in Node for tests
 * (browser-only paths are guarded).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MeldPlatform = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {

  /* ---------- minimal ZIP (stored entries only, no compression) ---------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function zipStore(name, dataBytes) {
    const enc = new TextEncoder();
    const nameB = enc.encode(name);
    const crc = crc32(dataBytes);
    const out = [];
    const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
    const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
    u32(crc); u32(dataBytes.length); u32(dataBytes.length);
    u16(nameB.length); u16(0);
    const head = new Uint8Array(out);
    const cd = [];
    const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
    const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
    c32(crc); c32(dataBytes.length); c32(dataBytes.length);
    c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
    const cdHead = new Uint8Array(cd);
    const cdOff = head.length + nameB.length + dataBytes.length;
    const parts = [head, nameB, dataBytes, cdHead, nameB];
    const eocd = [];
    const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
    e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
    e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
    parts.push(new Uint8Array(eocd));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const buf = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    return buf;
  }
  function unzipFirstEntry(zipBytes) {
    // Stored single-entry reader: scan local headers for compression 0.
    const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
    let off = 0;
    while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
      const method = dv.getUint16(off + 8, true);
      const size = dv.getUint32(off + 18, true);
      const nameLen = dv.getUint16(off + 26, true);
      const extraLen = dv.getUint16(off + 28, true);
      const dataOff = off + 30 + nameLen + extraLen;
      if (method !== 0) throw new Error('unsupported zip entry');
      return zipBytes.slice(dataOff, dataOff + size);
    }
    throw new Error('bad zip');
  }
  function bytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function base64ToBytes(b64) {
    const s = atob(b64);
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }

  /* ---------- launch token ---------- */
  // Reads #game_token=<jwt> (&session_id=) once and strips it; query-param
  // fallbacks (?token= / ?launch=) exist for local dev only.
  function readLaunchToken() {
    if (typeof location === 'undefined') return null;
    let token = null;
    try {
      const hash = location.hash || '';
      if (hash.indexOf('game_token=') >= 0) {
        token = new URLSearchParams(hash.slice(1)).get('game_token');
        history.replaceState(null, '', location.pathname + location.search);
      } else if (/[?&](token|launch)=/.test(location.search)) {
        const params = new URLSearchParams(location.search);
        token = params.get('token') || params.get('launch');
        for (const key of ['token', 'launch']) params.delete(key);
        const qs = params.toString();
        history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
      }
    } catch (_) { /* strip is best-effort */ }
    return token || null;
  }

  function decodeJwtPayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    try {
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      return JSON.parse(atob(padded));
    } catch (_) { return null; }
  }

  /* ---------- state ---------- */
  let token = null;          // current launch token (swapped on refresh)
  let user = null;           // { sub, slug }
  let nickname = null;       // account nickname (never username)
  let syncStatus = 'local';  // local | syncing | synced | saving | offline
  const listeners = [];
  const nameCache = {};      // userId -> nickname (leaderboard resolution)

  function enabled() { return !!token; }
  function accessToken() { return token; }
  function gameKey() { return user && user.slug ? user.slug : null; }
  function onSync(fn) { listeners.push(fn); }
  function notify() { for (const fn of listeners) { try { fn(); } catch (_) {} } }
  function setStatus(s) { if (s !== syncStatus) { syncStatus = s; notify(); } }
  function statusText() {
    switch (syncStatus) {
      case 'syncing': return 'syncing…';
      case 'saving': return 'saving…';
      case 'offline': return 'offline — saved on this device';
      case 'synced': return 'synced to your account';
      default: return 'saved on this device';
    }
  }
  function displayName() {
    if (nickname) return nickname;
    if (user && user.sub) return 'Player ' + String(user.sub).slice(0, 8);
    return 'Player';
  }

  /* ---------- REST ---------- */
  function authHeaders() {
    return token ? { 'Authorization': 'Bearer ' + token } : {};
  }
  function api(path, opts) {
    opts = opts || {};
    if (typeof fetch === 'undefined') return Promise.reject(new Error('no_fetch'));
    const headers = Object.assign({}, opts.headers || {}, authHeaders());
    if (opts.body && typeof opts.body === 'string' && !headers['Content-Type'])
      headers['Content-Type'] = 'application/json';
    return fetch(path, Object.assign({}, opts, { headers: headers })).then(function (r) {
      if (!r.ok) { const err = new Error('http_' + r.status); err.status = r.status; throw err; }
      return r.status === 204 ? null : r.json();
    });
  }

  function loadProfile() {
    if (!user || !user.sub) return;
    api('/api/v1/users/' + encodeURIComponent(user.sub) + '/profile')
      .then(function (p) {
        if (p && p.nickname) nickname = String(p.nickname).slice(0, 24);
        else if (p && p.id) nickname = 'Player ' + String(p.id).slice(0, 8);
        else nickname = 'Player ' + String(user.sub).slice(0, 8);
        notify();
      })
      .catch(function () { nickname = 'Player ' + String(user.sub).slice(0, 8); notify(); });
  }

  // Profile nickname for an arbitrary user id (leaderboard rows). Cached.
  function profileName(userId) {
    const id = String(userId || '');
    if (!id) return Promise.resolve('Player');
    if (nameCache[id]) return Promise.resolve(nameCache[id]);
    return api('/api/v1/users/' + encodeURIComponent(id) + '/profile')
      .then(function (p) {
        const name = (p && p.nickname) ? String(p.nickname).slice(0, 24)
          : 'Player ' + id.slice(0, 8);
        nameCache[id] = name;
        return name;
      })
      .catch(function () { return 'Player ' + id.slice(0, 8); });
  }

  /* ---------- token refresh (45 min cadence, ~60 s retry) ---------- */
  function scheduleRefresh(delayMs) {
    if (typeof setTimeout === 'undefined' || !gameKey()) return;
    setTimeout(function () {
      api('/api/v1/games/' + encodeURIComponent(gameKey()) + '/launch-token', { method: 'POST' })
        .then(function (j) {
          if (j && typeof j.token === 'string' && j.token) token = j.token;
          scheduleRefresh(45 * 60 * 1000);
        })
        .catch(function () { scheduleRefresh(60 * 1000); });
    }, delayMs);
  }

  /* ---------- cloud save (one zip slot; localStorage stays the cache) ---------- */
  let rawSave = null; // original Session.saveProgress, captured before wrapping
  function saveLocal(Session, data) {
    if (rawSave) rawSave(data); else Session.saveProgress(data);
  }

  function mergeProgress(Session, data) {
    return Object.assign(JSON.parse(JSON.stringify(Session.DEFAULT_PROGRESS)), data || {});
  }

  let flushProgress = function () { return Promise.resolve(false); };

  function wrapProgress(Session) {
    const origSave = Session.saveProgress;
    rawSave = function (data) { origSave(data); };
    let timer = null;
    let pendingDoc = null;
    flushProgress = function () {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!enabled() || !gameKey() || !pendingDoc) return Promise.resolve(false);
      const doc = pendingDoc;
      const bytes = zipStore('progress.json', new TextEncoder().encode(JSON.stringify(doc)));
      setStatus('saving');
      return fetch('/api/v1/me/cloud-saves/' + encodeURIComponent(gameKey()), {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ dataBase64: bytesToBase64(bytes) }),
        keepalive: true,
      }).then(function (r) { setStatus(r.ok ? 'synced' : 'offline'); return r.ok; })
        .catch(function () { setStatus('offline'); return false; });
    };
    Session.saveProgress = function (p) {
      origSave(p);                       // offline cache first, always
      if (!enabled() || !gameKey()) return;
      pendingDoc = p;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flushProgress, 2000); // debounced cloud mirror
    };
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      window.addEventListener('pagehide', function () { flushProgress(); });
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) flushProgress();
      });
    }
  }

  // Remote-preferred load: a present remote doc wins and reseeds the local
  // cache; 404/absent keeps the local progress untouched.
  function initCloud(Session) {
    if (!enabled() || !gameKey() || typeof fetch === 'undefined') return Promise.resolve(false);
    setStatus('syncing');
    return fetch('/api/v1/me/cloud-saves/' + encodeURIComponent(gameKey()), { headers: authHeaders() })
      .then(function (r) {
        if (r.status === 404) { setStatus('synced'); return false; }
        if (!r.ok) throw new Error('http_' + r.status);
        return r.arrayBuffer().then(function (buf) {
          const raw = unzipFirstEntry(new Uint8Array(buf));
          const data = JSON.parse(new TextDecoder().decode(raw));
          saveLocal(Session, mergeProgress(Session, data));
          setStatus('synced');
          return true;
        });
      })
      .catch(function () { setStatus('offline'); return false; });
  }

  /* ---------- read-only leaderboard ---------- */
  function fetchLeaderboard() {
    if (!enabled() || !gameKey()) return Promise.resolve(null);
    return api('/api/v1/games/' + encodeURIComponent(gameKey())).then(function (g) {
      const lid = g && (g.leaderboardId || g.leaderboard_id);
      if (!lid) return null;
      return api('/api/v1/leaderboards/' + encodeURIComponent(lid) +
        '/entries?friendsOnly=false&page=1&pageSize=10');
    }).then(function (page) {
      if (!page) return null;
      const list = Array.isArray(page) ? page : (page.entries || page.items || []);
      if (!list.length) return null;
      return resolveEntryNames(list.slice(0, 10));
    }).catch(function () { return null; });
  }
  function resolveEntryNames(list) {
    return list.reduce(function (chain, e, i) {
      return chain.then(function (out) {
        const uid = e.userId || e.user_id || e.user;
        return profileName(uid).then(function (name) {
          out.push({
            rank: e.rank !== undefined ? e.rank : i + 1,
            name: name,
            score: e.score !== undefined ? e.score : (e.value !== undefined ? e.value : 0),
          });
          return out;
        });
      });
    }, Promise.resolve([]));
  }

  /* ---------- boot ---------- */
  function boot(Session) {
    if (typeof location === 'undefined') return false;
    token = readLaunchToken();
    if (!token) return false;
    const payload = decodeJwtPayload(token);
    if (!payload || !payload.sub) { token = null; return false; }
    user = { sub: String(payload.sub), slug: payload.game_scope ? String(payload.game_scope) : null };
    nickname = 'Player ' + user.sub.slice(0, 8);
    setStatus('syncing');
    loadProfile();
    scheduleRefresh(45 * 60 * 1000);
    if (Session) wrapProgress(Session);
    return true;
  }

  return {
    boot: boot,
    enabled: enabled,
    accessToken: accessToken,
    gameKey: gameKey,
    api: api,
    displayName: displayName,
    statusText: statusText,
    onSync: onSync,
    initCloud: initCloud,
    flushCloud: function () { return flushProgress(); },
    fetchLeaderboard: fetchLeaderboard,
    profileName: profileName,
    decodeJwtPayload: decodeJwtPayload,
    // exposed for tests / strict external zip validation
    zipStore: zipStore,
    unzipFirstEntry: unzipFirstEntry,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    crc32: crc32,
  };
});
