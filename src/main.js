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

  /* platform time sync (round-trip adjusted), signed in only: a standalone
     load makes no network request and keeps the local clock. */
  function syncTime() {
    const sh = window.StarHermit;
    if (!(Platform && Platform.enabled()) || !sh || !sh.api) return;
    const t0 = Date.now();
    sh.api('/api/v1/time').then(function (j) {
      if (j && typeof j.now === 'number') {
        const t1 = Date.now();
        UI.serverOffset = j.now - Math.round((t0 + t1) / 2);
        UI.refreshTitle();
      }
    }).catch(function () { /* local clock is fine */ });
  }

  /* theme for session */
  function themeFor(session) {
    const id = session && session.contentRef && session.contentRef.theme;
    return Content.THEMES.filter(function (t) { return t.id === id; })[0] || Content.THEMES[0];
  }

  /* ---------- graphics: GPU probe, quality model, live apply ---------- */
  const Gfx = window.MeldGfx;
  const GfxUI = window.MeldGfxUI;
  function probeGpu() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return '';
      let name = String(gl.getParameter(gl.RENDERER) || '');
      if (!name || /^webkit webgl$/i.test(name)) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (ext) name = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || name);
      }
      return name;
    } catch (_) { return ''; }
  }
  function shortGpu(name) {
    const m = /^ANGLE \((.*)\)$/.exec(name);
    if (!m) return name;
    const parts = m[1].split(', ');
    let n = (parts[1] || parts[0]).replace(/\s*\(0x[0-9a-f]+\)/ig, '').replace(/\s+(Direct3D|vs_|ps_).*$/, '').trim();
    const inner = /^(?:Vulkan|OpenGL|Metal)[^(]*\((.*)\)$/.exec(n);
    if (inner) n = inner[1];
    return n;
  }
  const gpuRaw = probeGpu();
  const gpuName = shortGpu(gpuRaw);
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
    ((navigator.maxTouchPoints || 0) > 0 && !!window.matchMedia && matchMedia('(pointer: coarse)').matches);
  const detected = Gfx.detectPreset(gpuRaw, { mobile: isMobile });
  function gfxResolved() { return Gfx.resolve(UI.settings && UI.settings.graphics, detected); }
  function gfxInfo() {
    const r = gfxResolved();
    let pixels;
    if (scene3d && scene3d.size[0]) pixels = scene3d.pixels();
    else {
      const k = Math.min(window.devicePixelRatio || 1, r.maxRatio) * r.scale;
      pixels = [Math.round(window.innerWidth * k), Math.round(window.innerHeight * k)];
    }
    return { gpu: gpuName, detected: detected, resolved: r, pixels: pixels,
      postFailed: !!(scene3d && scene3d.postFailed), fps: scene3d ? Math.round(scene3d.fps) : 0 };
  }
  window.MeldGfxInfo = gfxInfo; // read by the Graphics panel (and e2e checks)
  function fpsMeter(on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter'; el.setAttribute('aria-hidden', 'true'); el.textContent = '— fps';
      document.body.appendChild(el);
    }
    if (el) el.hidden = !on;
  }
  function applyGraphics() {
    const r = gfxResolved();
    document.body.dataset.gfxPreset = r.preset;
    document.body.dataset.gfxDetail = r.detail;
    document.getElementById('gl').dataset.gfxPreset = r.preset;
    fpsMeter(r.showFps);
    if (scene3d) scene3d.setGraphics(r);
  }

  function motionReduced() {
    return !!(UI.settings && UI.settings.reducedMotion) ||
      !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* ---------- render scene ---------- */
  let scene3d = null;
  let renderFailed = false;
  function ensureScene() {
    if (scene3d || renderFailed) return scene3d;
    try {
      scene3d = new Render.Scene(document.getElementById('gl'), themeFor(UI.session), {
        graphics: gfxResolved(),
        detected: detected,
        reducedMotion: motionReduced(),
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

  /* reduced motion applies live (graphics changes arrive through the Graphics panel) */
  const origApply = UI.applySettings.bind(UI);
  UI.applySettings = function () {
    origApply();
    document.body.classList.toggle('reduced-motion', !!UI.settings.reducedMotion);
    if (scene3d) scene3d.reducedMotion = motionReduced();
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
  const settings = Session.loadSettings();
  if (!settings.graphics || typeof settings.graphics !== 'object') {
    settings.graphics = { preset: Gfx.legacyPreset(settings.quality) }; // migrate the old quality tier
  }
  UI.bindSettings(settings, function (key) { track('settings_change', key); });
  const gfxPanel = GfxUI.mount({
    settings: settings,
    locale: (navigator.languages && navigator.languages[0]) || navigator.language,
    save: function () { Session.saveSettings(settings); },
    onChange: function () { applyGraphics(); track('settings_change', 'graphics'); Audio.play('ui'); },
    info: gfxInfo,
  });
  applyGraphics();
  // keep the cost summary current while Settings is open (resolution, adaptive scale)
  setInterval(function () {
    if (gfxPanel && document.getElementById('overlay-settings').classList.contains('active')) gfxPanel.refreshSummary();
  }, 1000);
  document.getElementById('btn-settings').addEventListener('click', function () { if (gfxPanel) gfxPanel.refresh(); });
  document.getElementById('btn-pause-settings').addEventListener('click', function () { if (gfxPanel) gfxPanel.refresh(); });

  /* StarHermit platform: launch token (fragment read once + stripped),
     identity, cloud-save mirror, sync status. */
  if (Platform) {
    const shT = window.ShStrings.shStrings(navigator.languages || [navigator.language]);
    let toastTimer = null;
    const toast = function (text) {
      const el = document.getElementById('sh-toast');
      el.textContent = text;
      el.hidden = false;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
    };
    // Sign-in (platform host, no token) / invite (signed in); hidden locally.
    const refreshAccount = function () {
      document.getElementById('btn-signin').classList.toggle('hidden', !Platform.canSignIn());
      document.getElementById('btn-invite').classList.toggle('hidden', !Platform.enabled());
    };
    document.getElementById('btn-signin').textContent = shT.signIn;
    document.getElementById('btn-invite').textContent = shT.invite;
    document.getElementById('btn-signin').addEventListener('click', function () { Platform.signIn(); });
    document.getElementById('btn-invite').addEventListener('click', function () {
      const link = Platform.inviteLink();
      if (!link) return;
      Audio.play('ui');
      // navigator.clipboard is undefined outside secure contexts: report it instead of throwing
      const clip = navigator.clipboard && navigator.clipboard.writeText
        ? navigator.clipboard.writeText(link) : Promise.reject(new Error('clipboard unavailable'));
      clip.then(function () { toast(shT.copied); }, function () { toast(shT.copyFailed); });
    });
    Platform.boot(Session);
    refreshAccount();
    Platform.onSync(function () { UI.refreshTitle(); });
    Platform.onAuth(function (a) {
      refreshAccount();
      UI.refreshTitle();
      if (!a.signedIn) toast(shT.signedOut); // keep playing locally
    });
    Platform.initCloud(Session).then(function (mergedRemote) {
      if (mergedRemote) UI.refreshTitle(); // remote progress reseeded the cache
    });
    Platform.loadSettings(Session, settings).then(function (changed) {
      if (changed) { UI.bindSettingsValues(); UI.applySettings(); applyGraphics(); if (gfxPanel) gfxPanel.refresh(); }
    });
    Platform.loadBindings(UI.defaultKeys()).then(function (keys) { UI.setKeys(keys); });
  }

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
