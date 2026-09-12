'use strict';
/*
 * Meld Hall — bootstrap: capability detection, host time sync, render loop,
 * canvas picking, lifecycle (visibility/resize), analytics funnel (local,
 * anonymous), WebGL fallback.
 */
(function () {
  const Rules = window.MeldRules;
  const Content = window.MeldContent;
  const Session = window.MeldSession;
  const Audio = window.MeldAudio;
  const Render = window.MeldRender;
  const UI = window.MeldUI;
  const Platform = window.MeldPlatform || null;
  const Net = window.MeldNet || null;

  /* anonymous funnel events (start, tutorial step, round end, retry, settings, error) */
  const funnel = [];
  function track(event, detail) {
    funnel.push({ t: Date.now(), event: event, detail: detail || null });
    if (funnel.length > 200) funnel.shift();
  }
  window.addEventListener('error', function (e) { track('error', String(e.message).slice(0, 80)); });

  /* captions: text cue for every meaningful sound */
  const captionEl = document.getElementById('caption-toast');
  let captionTimer = null;
  Audio.onCaption(function (text) {
    if (!UI.settings || !UI.settings.captions) return;
    captionEl.textContent = text;
    captionEl.style.display = 'block';
    if (captionTimer) clearTimeout(captionTimer);
    captionTimer = setTimeout(function () { captionEl.style.display = 'none'; }, 1800);
  });

  /* pause/resume the solo AI driver (pause overlay, hidden tab) */
  function setAIPaused(paused) {
    const sess = UI.session;
    if (!sess) return;
    paused = paused || document.hidden || UI.currentScreen !== 'play' ||
      !!document.querySelector('#overlay-pause.active, #overlay-settings.active');
    sess.aiPaused = !!paused;
    if (paused) {
      if (sess.aiTimer) { clearTimeout(sess.aiTimer); sess.aiTimer = null; }
    } else {
      sess.scheduleAI();
    }
  }

  /* platform time sync (round-trip adjusted), recoverable on failure.
     Authenticated when a launch token is present; silent otherwise. */
  function syncTime() {
    const t0 = Date.now();
    const req = (Platform && Platform.enabled())
      ? Platform.api('/api/v1/time')
      : fetch('/api/v1/time').then(function (r) { return r.json(); });
    Promise.resolve(req).then(function (j) {
      if (j && typeof j.now === 'number') {
        const t1 = Date.now();
        UI.serverOffset = j.now - Math.round((t0 + t1) / 2);
        UI.refreshTitle();
      }
    }).catch(function () { /* offline: local clock is fine */ });
  }

  /* theme for session */
  function themeFor(session) {
    const id = session && session.contentRef && session.contentRef.theme;
    return Content.THEMES.filter(function (t) { return t.id === id; })[0] || Content.THEMES[0];
  }

  /* quality tier pick */
  function resolveQuality(setting) {
    if (setting !== 'auto') return setting;
    const mem = navigator.deviceMemory || 4;
    const cores = navigator.hardwareConcurrency || 4;
    if (mem <= 2 || cores <= 2) return 'low';
    if (mem >= 8 && cores >= 8) return 'high';
    return 'medium';
  }

  /* ---------- render scene ---------- */
  let scene3d = null;
  let renderFailed = false;
  function ensureScene() {
    if (scene3d || renderFailed) return scene3d;
    try {
      scene3d = new Render.Scene(document.getElementById('gl'), themeFor(UI.session), {
        quality: resolveQuality(UI.settings.quality),
        reducedMotion: UI.settings.reducedMotion,
      });
    } catch (e) {
      renderFailed = true;
      track('error', 'webgl_unavailable');
      document.getElementById('compat-message').classList.add('active');
      return null;
    }
    return scene3d;
  }

  UI.onRenderRequest = function () {
    const sc = ensureScene();
    if (sc && UI.session) sc.sync(UI.session.state, UI.selection);
  };
  UI.onBurst = function () {
    if (scene3d) scene3d.burst(0, 0.4, Render.FRAMING.meldRowZ, 32);
  };
  UI.onCameraReset = function () { if (scene3d) scene3d.resetCamera(); };

  /* quality changes apply live */
  const origApply = UI.applySettings.bind(UI);
  UI.applySettings = function () {
    origApply();
    if (scene3d) {
      scene3d.setQuality(resolveQuality(UI.settings.quality));
      scene3d.reducedMotion = !!UI.settings.reducedMotion;
    }
  };

  /* the pause overlay halts the solo simulation while it is open */
  const origOverlay = UI.overlay.bind(UI);
  UI.overlay = function (id, open) {
    origOverlay(id, open);
    setAIPaused(false);
  };
  const origShow = UI.show.bind(UI);
  UI.show = function (name) {
    origShow(name);
    setAIPaused(false);
  };

  /* ---------- pointer input: tap vs drag thresholds, pointer capture ---------- */
  const canvas = document.getElementById('gl');
  let downAt = null;
  canvas.addEventListener('pointerdown', function (e) {
    downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    Audio.ensure();
  });
  canvas.addEventListener('pointerup', function (e) {
    if (!downAt) return;
    const dx = e.clientX - downAt.x, dy = e.clientY - downAt.y;
    const dist = Math.hypot(dx, dy), dt = performance.now() - downAt.t;
    downAt = null;
    if (dist > 12 || dt > 600) return; // drag/camera gesture, not a tap
    if (!UI.session || !scene3d) return;
    const hit = scene3d.pick(e.clientX, e.clientY);
    if (!hit) return;
    const s = UI.session;
    if (hit.zone === 'deck') UI.doDraw('deck');
    else if (hit.zone === 'discardPile') UI.doDraw('discard');
    else if (hit.zone === 'hand') UI.toggleCard(hit.cardId);
    else if (hit.zone === 'meldTarget' && UI.selection.length === 1)
      s.command({ type: 'layoff', card: UI.selection[0], meld: hit.index });
  });
  canvas.addEventListener('pointercancel', function () { downAt = null; });
  canvas.addEventListener('lostpointercapture', function () { downAt = null; });

  /* ---------- render loop with visibility heartbeat ---------- */
  let lastT = 0, running = true;
  function loop(t) {
    requestAnimationFrame(loop);
    if (!running) return;
    const dt = Math.min(0.1, (t - lastT) / 1000 || 0.016);
    lastT = t;
    if (scene3d && UI.session && UI.currentScreen === 'play') {
      scene3d.update(dt);
      scene3d.render();
    }
  }
  document.addEventListener('visibilitychange', function () {
    running = !document.hidden;
    Audio.setBackground(document.hidden);
    setAIPaused(document.hidden); // backgrounding pauses solo simulation
    if (!document.hidden) syncTime();
  });

  let resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (scene3d) scene3d.resize(); }, 80);
  });
  window.addEventListener('orientationchange', function () {
    setTimeout(function () { if (scene3d) scene3d.resize(); }, 200);
  });

  /* ---------- boot: boot -> title -> profile-ready ---------- */
  UI.bindSettings(Session.loadSettings(), function (key) { track('settings_change', key); });

  /* StarHermit platform: launch token (fragment read once + stripped),
     identity, cloud-save mirror, sync status, hosted-table probe. */
  if (Platform) {
    Platform.boot(Session);
    Platform.onSync(function () { UI.refreshTitle(); });
    Platform.initCloud(Session).then(function (mergedRemote) {
      if (mergedRemote) UI.refreshTitle(); // remote progress reseeded the cache
    });
  }
  if (Net) Net.probe().then(function (ok) { UI.hostedAvailable = ok; });

  UI.show('title');
  UI.refreshTitle();
  syncTime();
  track('start');
  requestAnimationFrame(loop);

  // funnel event hooks on session lifecycle
  const origAttach = UI.attachSession.bind(UI);
  UI.attachSession = function (s) {
    origAttach(s);
    track('start', s.mode);
    s.on(function (evt) {
      if (evt.type === 'lessonComplete') track('tutorial_step', evt.lesson);
      if (evt.type === 'roundOver' || evt.type === 'matchOver') track('round_end', s.mode);
    });
  };
})();
