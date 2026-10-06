'use strict';
/*
 * Meld Hall — Three.js presentation layer.
 * Table scene: authored camera, procedural table/hall geometry, card meshes
 * with procedural CanvasTexture faces, selection feedback (lift + rim +
 * grounded marker), graphics settings (MeldGfx), optional post-processing,
 * adaptive resolution, reduced-motion support, explicit disposal.
 * Rendering consumes immutable snapshots; it never mutates rules state.
 */
(function (root, factory) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const Rules = isNode ? require('./rules.js') : root.MeldRules;
  const Gfx = isNode ? require('./gfx.js') : root.MeldGfx;
  const api = factory(Rules, Gfx);
  if (isNode) module.exports = api;
  if (root) root.MeldRender = api;
})(typeof self !== 'undefined' ? self : globalThis, function (Rules, Gfx) {

  const CARD_W = 0.7, CARD_H = 1.0, CARD_T = 0.02, GAP = 0.12, CARD_R = 0.07;
  const FELT_TOP = 0.02;                   // felt cylinder top (y = -0.24 + 0.52 / 2)
  const CARD_Y = FELT_TOP + CARD_T / 2 + 0.004; // cards rest on the felt, never coplanar with it
  const LIFT = 0.18;
  // authored framing constants (no magic offsets elsewhere)
  const FRAMING = {
    cameraPos: { x: 0, y: 7.2, z: 6.4 },
    lookAt: { x: 0, y: 0, z: 0.6 },
    fov: 42,
    handRowZ: 3.4, meldRowZ: 0.4, tableRowZ: -1.2, deckZ: -2.6,
  };
  const LAMP_X = [-3.4, 0, 3.4], LAMP_Y = 4.1, LAMP_Z = -4.6;

  // Legacy tier names (pre-Graphics-panel) map onto MeldGfx presets.
  const QUALITY_TIERS = { low: 'low', medium: 'balanced', high: 'high' };

  // Colour grade + vignette. Input: tone-mapped linear colour; output: sRGB.
  // Always the output pass of the chain (it owns the linear -> sRGB step), with
  // the grade blended in by uAmount.
  const GradeShader = {
    uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.28 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;',
      'varying vec2 vUv;',
      'vec3 toSRGB(vec3 c) { c = clamp(c, 0.0, 1.0);',
      '  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }',
      'void main() {',
      '  vec4 src = texture2D(tDiffuse, vUv);',
      '  vec3 c = toSRGB(src.rgb);',
      '  // gentle S-curve, a touch more saturation, warm highlights / cool shadows',
      '  vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.18);',
      '  float l = dot(s, vec3(0.299, 0.587, 0.114));',
      '  s = mix(vec3(l), s, 1.07);',
      '  s *= mix(vec3(0.97, 0.99, 1.04), vec3(1.035, 1.0, 0.965), smoothstep(0.2, 0.8, l));',
      '  float d = length((vUv - 0.5) * vec2(1.1, 1.0));',
      '  s *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);',
      '  gl_FragColor = vec4(mix(c, s, uAmount), src.a);',
      '}',
    ].join('\n'),
  };

  function lin(c) { return new THREE.Color(c).convertSRGBToLinear(); }

  /* ----- deterministic noise for procedural textures ----- */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function canvas(w, h) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    return cv;
  }
  function grain(g, w, h, amount, seed) {
    const img = g.getImageData(0, 0, w, h), d = img.data, r = rng(seed);
    for (let i = 0; i < d.length; i += 4) {
      const n = (r() - 0.5) * amount;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
  }
  function tex(cv, repeat) {
    const t = new THREE.CanvasTexture(cv);
    t.encoding = THREE.sRGBEncoding;
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
    return t;
  }
  function feltTexture() {
    const cv = canvas(256, 256), g = cv.getContext('2d'), r = rng(7);
    g.fillStyle = '#f0f0f0'; g.fillRect(0, 0, 256, 256);
    g.globalAlpha = 0.07; g.lineWidth = 1;
    for (let i = 0; i < 900; ++i) { // short fibres
      const x = r() * 256, y = r() * 256, a = r() * Math.PI, l = 2 + r() * 5;
      g.strokeStyle = r() < 0.5 ? '#000' : '#fff';
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
    g.globalAlpha = 1;
    grain(g, 256, 256, 22, 11);
    return tex(cv, [7, 7]);
  }
  function woodTexture() {
    const cv = canvas(1024, 64), g = cv.getContext('2d'), r = rng(3);
    g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, 1024, 64);
    for (let i = 0; i < 60; ++i) { // long grain streaks along the rim
      const y = r() * 64, h = 0.5 + r() * 2.2;
      g.fillStyle = r() < 0.6 ? 'rgba(60,40,20,' + (0.08 + r() * 0.16) + ')' : 'rgba(255,240,220,' + (0.06 + r() * 0.1) + ')';
      g.beginPath(); g.moveTo(0, y);
      for (let x = 0; x <= 1024; x += 32) g.lineTo(x, y + Math.sin(x * 0.01 + i) * 1.5);
      g.lineTo(1024, y + h); g.lineTo(0, y + h); g.fill();
    }
    grain(g, 1024, 64, 14, 5);
    return tex(cv, [3, 1]);
  }
  function floorTexture() {
    const cv = canvas(512, 512), g = cv.getContext('2d'), r = rng(9);
    for (let row = 0; row < 8; ++row) {
      let x = -r() * 256;
      while (x < 512) {
        const len = 160 + r() * 200, v = 150 + r() * 60;
        g.fillStyle = 'rgb(' + v + ',' + (v * 0.92) + ',' + (v * 0.85) + ')';
        g.fillRect(x, row * 64, len, 64);
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(x, row * 64, 2, 64);
        x += len;
      }
      g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(0, row * 64, 512, 2);
    }
    grain(g, 512, 512, 18, 13);
    return tex(cv, [5, 5]);
  }
  function dotTexture() {
    const cv = canvas(64, 64), g = cv.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    return tex(cv);
  }

  /* ----- card face textures (procedural, cached) ----- */
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }
  function makeFaceTexture(cardId, anisotropy) {
    const W = 256, H = 368;
    const cv = canvas(W, H), g = cv.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, '#f8f4ea'); grd.addColorStop(1, '#efe8d8');
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    grain(g, W, H, 6, 17 + cardId);
    g.strokeStyle = '#cdbf9f'; g.lineWidth = 4;
    roundRect(g, 10, 10, W - 20, H - 20, 16); g.stroke();
    const suit = Rules.suitOf(cardId), red = suit === 1 || suit === 2;
    const rank = Rules.RANKS[Rules.rankOf(cardId)], glyph = Rules.SUIT_GLYPHS[suit];
    g.fillStyle = red ? '#a83232' : '#22303e';
    const corner = function () {
      g.textAlign = 'center'; g.textBaseline = 'top';
      g.font = 'bold ' + (rank.length > 1 ? 84 : 96) + 'px Georgia, serif';
      g.fillText(rank, 54, 18);
      g.font = '72px Georgia, serif';
      g.fillText(glyph, 54, 112);
    };
    corner();
    g.save(); g.translate(W, H); g.rotate(Math.PI); corner(); g.restore();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '130px Georgia, serif';
    g.fillText(glyph, W / 2 + 18, H / 2 + 8);
    const t = tex(cv);
    t.anisotropy = anisotropy;
    return t;
  }
  function makeBackTexture(color, anisotropy) {
    const W = 256, H = 368;
    const cv = canvas(W, H), g = cv.getContext('2d');
    g.fillStyle = color; g.fillRect(0, 0, W, H);
    const frame = function () {
      g.strokeStyle = 'rgba(255,255,255,0.4)'; g.lineWidth = 5;
      roundRect(g, 16, 16, W - 32, H - 32, 14); g.stroke();
      g.strokeStyle = 'rgba(232,179,75,0.55)'; g.lineWidth = 2;
      roundRect(g, 26, 26, W - 52, H - 52, 10); g.stroke();
    };
    g.globalAlpha = 0.16; g.strokeStyle = '#fff'; g.lineWidth = 2;
    g.beginPath();
    for (let i = -H; i < W + H; i += 18) { g.moveTo(i, 0); g.lineTo(i + H, H); g.moveTo(i + H, 0); g.lineTo(i, H); }
    g.stroke(); g.globalAlpha = 1;
    frame();
    const t = tex(cv);
    t.anisotropy = anisotropy;
    // Authored back art (assets/card-back.webp) is tinted over the procedural
    // pattern once it decodes; if it never loads the procedural back stands.
    try {
      const img = new Image();
      img.onload = function () {
        g.globalAlpha = 0.85;
        g.drawImage(img, 12, 12, W - 24, H - 24);
        g.globalAlpha = 1;
        frame();
        t.needsUpdate = true;
      };
      img.onerror = function () {};
      img.src = 'assets/card-back.webp';
    } catch (_) {}
    return t;
  }

  /* Rounded card slab: caps use material index 2 (the box's +y slot), sides index 0. */
  function roundedCardGeometry() {
    const s = new THREE.Shape(), w = CARD_W / 2, h = CARD_H / 2, r = CARD_R;
    s.moveTo(-w + r, -h); s.lineTo(w - r, -h); s.quadraticCurveTo(w, -h, w, -h + r);
    s.lineTo(w, h - r); s.quadraticCurveTo(w, h, w - r, h);
    s.lineTo(-w + r, h); s.quadraticCurveTo(-w, h, -w, h - r);
    s.lineTo(-w, -h + r); s.quadraticCurveTo(-w, -h, -w + r, -h);
    const uv = {
      generateTopUV: function (geo, v, a, b, c) {
        return [a, b, c].map(function (i) {
          return new THREE.Vector2((v[i * 3] + w) / CARD_W, (v[i * 3 + 1] + h) / CARD_H);
        });
      },
      generateSideWallUV: function () {
        return [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()];
      },
    };
    const geo = new THREE.ExtrudeGeometry(s, { depth: CARD_T, bevelEnabled: false, curveSegments: 4, UVGenerator: uv });
    geo.translate(0, 0, -CARD_T / 2);
    geo.rotateX(-Math.PI / 2);
    for (const gr of geo.groups) gr.materialIndex = gr.materialIndex === 0 ? 2 : 0;
    return geo;
  }

  function Scene(canvas, theme, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.theme = theme;
    this.reducedMotion = !!opts.reducedMotion;
    this.detected = opts.detected || 'balanced';
    this.q = opts.graphics || Gfx.resolve({ preset: QUALITY_TIERS[opts.quality] || 'auto' }, this.detected);
    this.renderer = null;
    this.pickHandlers = { card: null, deck: null, discard: null, meld: null };
    this.cardMeshes = [];   // { mesh, cardId, zone, index }
    this.pickMeshes = [];   // deck/discard targets
    this.meldMarkers = [];
    this.springs = [];      // { obj, from, to, t, dur }
    this.disposed = false;
    this.time = 0;
    this.size = [0, 0];
    this.pixelRatio = 0;
    this.adaptiveScale = 1;
    this._frames = [];
    this.fps = 0;
    this.composer = null;
    this.postKey = null;
    this.postFailed = false;
    this._init();
  }

  Scene.prototype._init = function () {
    if (typeof THREE === 'undefined') throw new Error('three_missing');
    const th = this.theme;
    // Context MSAA is a creation-time choice: honoured when the canvas renders directly.
    this.contextAA = this.q.antialias === 'msaa';
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: this.contextAA, powerPreference: 'high-performance' });
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());

    this.scene = new THREE.Scene();
    this.bgDirect = new THREE.Color(th.wall);   // clear colour is not encoded on the direct path
    this.bgLinear = lin(th.wall);               // ...but is linear inside the post chain
    this.scene.background = this.bgDirect;

    this.camera = new THREE.PerspectiveCamera(FRAMING.fov, 1, 0.1, 40);
    this.camera.position.set(FRAMING.cameraPos.x, FRAMING.cameraPos.y, FRAMING.cameraPos.z);
    this.camera.lookAt(FRAMING.lookAt.x, FRAMING.lookAt.y, FRAMING.lookAt.z);

    // lighting: one dominant key (the only shadow caster) + sky/floor fill + ambient
    const key = this.key = new THREE.DirectionalLight(lin(th.keyLight), 1.35);
    key.position.set(3, 8, 4);
    key.target.position.set(0, 0, 0.2);
    const sc = key.shadow.camera; // fitted to the table top (radius 6.7) and cards above it
    sc.left = -7; sc.right = 7; sc.top = 7; sc.bottom = -7; sc.near = 3; sc.far = 17;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 3;
    this.scene.add(key, key.target);
    this.hemi = new THREE.HemisphereLight(lin(th.fill), lin('#1a140e'), 0.6);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.12);
    this.scene.add(this.ambient);
    // warm pool from the pendant lamps (detailed hall only)
    this.lampLight = new THREE.PointLight(lin('#ffc98a'), 0, 16, 1.4);
    this.lampLight.position.set(0, 4.4, -1.6);
    this.scene.add(this.lampLight);

    // pools
    this.boxGeo = new THREE.BoxGeometry(CARD_W, CARD_T, CARD_H);
    this.roundGeo = null;
    this.faceTextures = {};  // cardId -> texture (shared by both detail levels)
    this.faceMats = {};      // cardId -> material array for the current detail level
    this.backTexture = makeBackTexture(th.cardBack, this.anisotropy);
    this.markerMat = new THREE.MeshBasicMaterial({ color: lin(th.accent).multiplyScalar(1.6), transparent: true, opacity: 0.9, toneMapped: false });
    this.ghostMat = new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.35 });
    this.envGroup = null;
    this.envTextures = [];
    this.fx = null;
    this.motes = null;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._applyGraphics(null);
    this.resize();
  };

  /* ----- graphics settings ----- */

  Scene.prototype.setGraphics = function (resolved) {
    const prev = this.q;
    this.q = resolved;
    this._applyGraphics(prev);
  };

  Scene.prototype._applyGraphics = function (prev) {
    const g = this.q, r = this.renderer;
    const size = Gfx.SHADOW_MAP[g.shadows];
    r.shadowMap.enabled = size > 0;
    this.key.castShadow = size > 0;
    if (size > 0 && this.key.shadow.mapSize.x !== size) {
      this.key.shadow.mapSize.set(size, size);
      if (this.key.shadow.map) { this.key.shadow.map.dispose(); this.key.shadow.map = null; }
    }
    if (!prev || prev.detail !== g.detail) this._buildEnvironment();
    this._applyReflections();
    if (!prev || prev.particles !== g.particles || prev.detail !== g.detail) this._buildParticles();
    this.adaptiveScale = 1;
    this._frames.length = 0;
    this.postKey = null; // rebuild the post chain on the next frame
    this._fpsVisible(g.showFps);
    // Materials pick up shadow-map / environment changes on recompile.
    this.scene.traverse(function (o) {
      if (!o.material) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.needsUpdate = true; });
    });
    if (prev && prev.detail !== g.detail && this.lastState) this.sync(this.lastState, this.lastSelection);
  };

  Scene.prototype._applyReflections = function () {
    const on = this.q.reflections === 'on';
    if (on && !this.envMap && THREE.RoomEnvironment) {
      try {
        const pm = new THREE.PMREMGenerator(this.renderer);
        const room = new THREE.RoomEnvironment();
        this.envMap = pm.fromScene(room, 0.04).texture;
        room.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
        pm.dispose();
      } catch (_) { this.envMap = null; }
    }
    const env = on ? this.envMap || null : null;
    this.scene.environment = env;
    // image-based light replaces part of the flat fill so the hall keeps its mood
    this.hemi.intensity = env ? 0.38 : 0.6;
    this.ambient.intensity = env ? 0.03 : 0.12;
  };

  Scene.prototype._buildEnvironment = function () {
    if (this.envGroup) {
      this.scene.remove(this.envGroup);
      this.envGroup.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    for (const t of this.envTextures) t.dispose();
    this.envTextures = [];
    const grp = this.envGroup = new THREE.Group();
    this.scene.add(grp);
    const th = this.theme, detailed = this.q.detail === 'detailed';
    const self = this;
    function T(t) { t.anisotropy = self.anisotropy; self.envTextures.push(t); return t; }
    function add(mesh, cast, receive) { mesh.castShadow = !!cast; mesh.receiveShadow = !!receive; grp.add(mesh); return mesh; }

    // floor
    const floor = add(new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshStandardMaterial(detailed
        ? { color: lin(th.wood).multiplyScalar(0.55), map: T(floorTexture()), roughness: 0.78, envMapIntensity: 0.35 }
        : { color: lin(th.wall).multiplyScalar(1.3), roughness: 0.95 })
    ), false, true);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.55;

    // table: wood rim + felt inlay (procedural, silhouette-first)
    const rim = add(new THREE.Mesh(
      new THREE.CylinderGeometry(6.4, 6.7, 0.5, detailed ? 96 : 48),
      new THREE.MeshStandardMaterial(detailed
        ? { color: lin(th.wood), map: T(woodTexture()), roughness: 0.42, metalness: 0.05, envMapIntensity: 0.8 }
        : { color: lin(th.wood), roughness: 0.6, metalness: 0.05 })
    ), false, true);
    rim.position.y = -0.25;
    const felt = add(new THREE.Mesh(
      new THREE.CylinderGeometry(6.0, 6.0, 0.52, detailed ? 96 : 48),
      new THREE.MeshStandardMaterial(detailed
        ? { color: lin(th.felt), map: T(feltTexture()), roughness: 0.95, envMapIntensity: 0.25 }
        : { color: lin(th.felt), roughness: 0.9 })
    ), false, true);
    felt.position.y = -0.24;

    // hanging lamps over the far side of the table
    const lampMat = new THREE.MeshStandardMaterial({ color: 0x333844, roughness: 0.4, metalness: 0.6 });
    const shadeMat = new THREE.MeshStandardMaterial(detailed
      ? { color: lin(th.accent), emissive: lin(th.accent), emissiveIntensity: 0.25, roughness: 0.3, metalness: 0.85, side: THREE.DoubleSide }
      : { color: lin(th.accent), emissive: lin(th.accent), emissiveIntensity: 0.4 });
    this.bulbs = [];
    for (const x of LAMP_X) {
      const pole = add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 3.2, 8), lampMat));
      pole.position.set(x, detailed ? LAMP_Y + 1.6 : 2.6, LAMP_Z);
      const shade = add(new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.5, detailed ? 32 : 16, 1, true), shadeMat));
      shade.position.set(x, LAMP_Y, LAMP_Z);
      if (detailed) {
        const bulbMat = new THREE.MeshBasicMaterial({ color: lin('#ffd9a0').multiplyScalar(2.6), toneMapped: false });
        const bulb = add(new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 10), bulbMat));
        bulb.position.set(x, LAMP_Y - 0.2, LAMP_Z);
        this.bulbs.push(bulbMat);
      }
    }
    if (detailed) {
      // brass inlay where the felt meets the rim: catches the lamp and room reflections
      const brass = add(new THREE.Mesh(
        new THREE.TorusGeometry(6.08, 0.045, 10, 128),
        new THREE.MeshStandardMaterial({ color: lin('#c89a4a'), roughness: 0.28, metalness: 1, envMapIntensity: 1.2 })
      ), false, true);
      brass.rotation.x = -Math.PI / 2;
      brass.position.y = 0.012;
      // wall panels + chair rail
      const panelMat = new THREE.MeshStandardMaterial({ color: lin(th.wood).multiplyScalar(0.55), roughness: 0.6, envMapIntensity: 0.5 });
      for (let i = 0; i < 7; ++i) {
        const p = add(new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.4, 0.1), panelMat), false, true);
        p.position.set(-7.2 + i * 2.4, 1.2, -7.5);
      }
      const wall = add(new THREE.Mesh(new THREE.PlaneGeometry(40, 14),
        new THREE.MeshStandardMaterial({ color: lin(th.wall).multiplyScalar(1.4), roughness: 0.9 })), false, true);
      wall.position.set(0, 6, -7.62);
      this.scene.fog = new THREE.FogExp2(lin(th.wall), 0.035);
      this.lampLight.intensity = 0.75;
    } else {
      this.scene.fog = null;
      this.lampLight.intensity = 0;
    }

    // card materials depend on the detail level
    for (const k in this.faceMats) this.faceMats[k][0].dispose(), this.faceMats[k][2].dispose();
    this.faceMats = {};
    if (this.backMats) { this.backMats[0].dispose(); this.backMats[2].dispose(); }
    const backSide = this._cardMat({ color: lin('#e8e2d0'), roughness: 0.7 });
    const backTop = this._cardMat({ map: this.backTexture, roughness: 0.5 }, true);
    this.backMats = [backSide, backSide, backTop, backSide, backSide, backSide];
    if (detailed && !this.roundGeo) this.roundGeo = roundedCardGeometry();
    this.cardGeo = detailed ? this.roundGeo : this.boxGeo;
  };

  Scene.prototype._cardMat = function (p, glossy) {
    if (this.q.detail === 'detailed') {
      if (glossy) return new THREE.MeshPhysicalMaterial(Object.assign({ roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.3, envMapIntensity: 0.28 }, p));
      return new THREE.MeshStandardMaterial(Object.assign({ envMapIntensity: 0.3 }, p));
    }
    return new THREE.MeshStandardMaterial(p);
  };

  Scene.prototype._buildParticles = function () {
    const self = this;
    function drop(o) {
      if (!o) return;
      self.scene.remove(o.pts);
      o.pts.geometry.dispose(); o.pts.material.dispose();
    }
    drop(this.fx); drop(this.motes);
    this.fx = null; this.motes = null;
    if (!this.dotTex) this.dotTex = dotTexture();
    const p = this.q.particles;
    if (p !== 'off') this._initBurst(p === 'high' ? 2000 : 500);
    if (p === 'high' && this.q.detail === 'detailed') this._initMotes(140);
  };

  // effects layer: bounded particle pool (points), never raycastable
  Scene.prototype._initBurst = function (max) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(max * 3);
    for (let i = 0; i < max; ++i) pos[i * 3 + 1] = -999;
    const vel = new Float32Array(max * 3);
    const life = new Float32Array(max);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: lin(this.theme.accent).multiplyScalar(1.8), size: 0.09, map: this.dotTex, transparent: true,
      opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.raycast = function () {}; // cosmetic: never intercept picking
    this.scene.add(pts);
    this.fx = { pts: pts, pos: pos, vel: vel, life: life, max: max, next: 0 };
  };

  // ambient dust drifting through the lamp light
  Scene.prototype._initMotes = function (n) {
    const r = rng(21), pos = new Float32Array(n * 3), seed = new Float32Array(n * 3);
    for (let i = 0; i < n; ++i) {
      seed[i * 3] = (r() - 0.5) * 10; seed[i * 3 + 1] = 0.6 + r() * 3.6; seed[i * 3 + 2] = -5 + r() * 6;
      pos.set([seed[i * 3], seed[i * 3 + 1], seed[i * 3 + 2]], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: lin('#ffe2b0'), size: 0.045, map: this.dotTex, transparent: true, opacity: 0.55,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.raycast = function () {};
    this.scene.add(pts);
    this.motes = { pts: pts, pos: pos, seed: seed, n: n };
  };

  Scene.prototype.burst = function (x, y, z, count) {
    if (!this.fx || this.reducedMotion) return;
    const fx = this.fx;
    const n = Math.min(count || 24, this.q.particles === 'high' ? 64 : 32);
    for (let i = 0; i < n; ++i) {
      const k = fx.next = (fx.next + 1) % fx.max;
      fx.pos[k * 3] = x; fx.pos[k * 3 + 1] = y; fx.pos[k * 3 + 2] = z;
      const a = Math.random() * Math.PI * 2, s = 0.6 + Math.random() * 1.4;
      fx.vel[k * 3] = Math.cos(a) * s; fx.vel[k * 3 + 1] = 1.2 + Math.random(); fx.vel[k * 3 + 2] = Math.sin(a) * s;
      fx.life[k] = 1;
    }
    fx.pts.geometry.attributes.position.needsUpdate = true;
  };

  Scene.prototype.faceMat = function (cardId) {
    if (!this.faceMats[cardId]) {
      if (!this.faceTextures[cardId]) this.faceTextures[cardId] = makeFaceTexture(cardId, this.anisotropy);
      const side = this._cardMat({ color: lin('#f0ead8'), roughness: 0.7 });
      const face = this._cardMat({ map: this.faceTextures[cardId], roughness: 0.55 }, true);
      this.faceMats[cardId] = [side, side, face, side, side, side];
    }
    return this.faceMats[cardId];
  };

  /* ----- state -> scene rebuild (cheap; card counts are small) ----- */
  Scene.prototype.sync = function (state, selection) {
    // clear old card/pick meshes
    for (const e of this.cardMeshes) { this.scene.remove(e.mesh); }
    for (const m of this.pickMeshes) this.scene.remove(m);
    for (const m of this.meldMarkers) { this.scene.remove(m); if (m.geometry) m.geometry.dispose(); }
    this.cardMeshes.length = 0; this.pickMeshes.length = 0; this.meldMarkers.length = 0;
    this.springs.length = 0;

    const self = this;
    function addCard(cardId, x, z, zone, index, faceUp) {
      const mesh = new THREE.Mesh(self.cardGeo, faceUp === false ? self.backMats : self.faceMat(cardId));
      mesh.position.set(x, CARD_Y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { zone: zone, index: index, cardId: cardId, baseY: CARD_Y };
      self.scene.add(mesh);
      self.cardMeshes.push({ mesh: mesh, cardId: cardId, zone: zone, index: index });
      return mesh;
    }

    // table melds row(s)
    let mz = FRAMING.meldRowZ;
    let mx = -4.6;
    for (let m = 0; m < state.table.length; ++m) {
      const meld = state.table[m];
      if (mx + meld.cards.length * (CARD_W + GAP) > 4.6) { mx = -4.6; mz -= CARD_H + GAP; }
      for (let k = 0; k < meld.cards.length; ++k) {
        const c = addCard(meld.cards[k], mx + k * (CARD_W * 0.5), mz, 'meld', m, true);
        c.position.y += k * 0.003; c.userData.baseY = c.position.y; // fanned cards stack, never coplanar
      }
      const marker = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.16, 20), this.markerMat);
      marker.rotation.x = -Math.PI / 2;
      marker.position.set(mx - 0.5, FELT_TOP + 0.003, mz);
      marker.userData = { zone: 'meldTarget', index: m };
      this.scene.add(marker);
      this.meldMarkers.push(marker);
      mx += meld.cards.length * (CARD_W * 0.5) + 0.7;
    }

    // human hand (seat 0) — laid along the near edge, centred
    const hand = state.hands[0];
    const total = hand.cards.length * (CARD_W + GAP) - GAP;
    let hx = -total / 2 + CARD_W / 2;
    for (let i = 0; i < hand.cards.length; ++i) {
      const mesh = addCard(hand.cards[i], hx, FRAMING.handRowZ, 'hand', i, true);
      hx += CARD_W + GAP;
      if (selection && selection.indexOf(hand.cards[i]) >= 0) {
        mesh.position.y += LIFT; // lift
        mesh.userData.baseY = mesh.position.y;
        mesh.userData.selected = true;
        const rim = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 32), this.markerMat);
        rim.rotation.x = -Math.PI / 2;
        rim.position.set(mesh.position.x, FELT_TOP + 0.003, mesh.position.z);
        this.scene.add(rim);
        this.meldMarkers.push(rim);
      }
    }

    // opponent hands: face-down rows
    for (let p = 1; p < state.players; ++p) {
      const oh = state.hands[p];
      const oz = FRAMING.tableRowZ - 1.4 - (p - 1) * 0.9;
      const ot = oh.cards.length * (CARD_W * 0.45);
      for (let i = 0; i < oh.cards.length; ++i) {
        const c = addCard(oh.cards[i], -ot / 2 + i * CARD_W * 0.45 + (p - 1.5) * 2.2, oz, 'opp', i, false);
        c.position.y += i * 0.003; c.userData.baseY = c.position.y;
      }
    }

    // deck + discard pile (pickable)
    const deck = addCard(0, -1.0, FRAMING.deckZ, 'deck', 0, false);
    deck.scale.y = Math.max(0.4, state.deck.length / 8);
    deck.position.y = FELT_TOP + CARD_T * deck.scale.y / 2 + 0.004;
    deck.userData.baseY = deck.position.y;
    this.pickMeshes.push(deck);
    const topDisc = state.discardPile[state.discardPile.length - 1];
    if (topDisc !== undefined) {
      const dm = addCard(topDisc, 0.2, FRAMING.deckZ, 'discardPile', 0, true);
      this.pickMeshes.push(dm);
    }

    this.lastState = state;
    this.lastSelection = selection ? selection.slice() : null;
  };

  /* ----- picking ----- */
  Scene.prototype.pick = function (clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((clientY - r.top) / r.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(
      this.cardMeshes.map(function (e) { return e.mesh; })
        .concat(this.pickMeshes)
        .concat(this.meldMarkers.filter(function (m) { return m.userData.zone === 'meldTarget'; }))
    );
    if (!hits.length) return null;
    const u = hits[0].object.userData;
    return { zone: u.zone, index: u.index, cardId: u.cardId };
  };

  /* ----- motion: authored springs, interruptible ----- */
  Scene.prototype.pulse = function (mesh, height) {
    if (this.reducedMotion || !mesh) return;
    this.springs.push({ obj: mesh, baseY: mesh.userData.baseY || CARD_Y, t: 0, dur: 0.35, h: height || 0.15 });
  };

  Scene.prototype.update = function (dt) {
    const moving = !this.reducedMotion;
    if (moving) this.time += dt;
    const t = this.time;
    // critically-damped-ish one-shot pulses: y = base + h*sin(pi * t/dur)
    const pulsing = new Set();
    for (let i = this.springs.length - 1; i >= 0; --i) {
      const s = this.springs[i];
      s.t += dt;
      const k = Math.min(1, s.t / s.dur);
      s.obj.position.y = s.baseY + Math.sin(Math.PI * k) * s.h;
      pulsing.add(s.obj);
      if (k >= 1) { s.obj.position.y = s.baseY; this.springs.splice(i, 1); }
    }
    // idle bob on selected cards (gentle; static under reduced motion)
    for (const e of this.cardMeshes) {
      const m = e.mesh;
      if (!m.userData.selected || pulsing.has(m)) continue;
      m.position.y = m.userData.baseY + (moving ? Math.sin(t * 2.4 + m.position.x) * 0.02 : 0);
    }
    // lamp shimmer
    if (this.bulbs && this.bulbs.length) {
      const f = moving ? 1 + 0.035 * Math.sin(t * 7.3) + 0.02 * Math.sin(t * 13.7 + 1.3) : 1;
      this.lampLight.intensity = 0.75 * f;
      for (const b of this.bulbs) b.color.setRGB(1, 0.69, 0.35).multiplyScalar(2.6 * f);
    }
    if (document.hidden) return;
    if (this.fx) {
      const fx = this.fx;
      let any = false;
      for (let k = 0; k < fx.max; ++k) {
        if (fx.life[k] <= 0) continue;
        any = true;
        fx.life[k] -= dt * 1.4;
        fx.vel[k * 3 + 1] -= dt * 3;
        fx.pos[k * 3] += fx.vel[k * 3] * dt;
        fx.pos[k * 3 + 1] += fx.vel[k * 3 + 1] * dt;
        fx.pos[k * 3 + 2] += fx.vel[k * 3 + 2] * dt;
        if (fx.life[k] <= 0) fx.pos[k * 3 + 1] = -999;
      }
      if (any) fx.pts.geometry.attributes.position.needsUpdate = true;
    }
    if (this.motes && moving) {
      const m = this.motes;
      for (let i = 0; i < m.n; ++i) {
        const s = i * 3, ph = i * 1.7;
        m.pos[s] = m.seed[s] + Math.sin(t * 0.13 + ph) * 0.6;
        m.pos[s + 1] = m.seed[s + 1] + Math.sin(t * 0.21 + ph * 0.7) * 0.35;
        m.pos[s + 2] = m.seed[s + 2] + Math.cos(t * 0.11 + ph) * 0.5;
      }
      m.pts.geometry.attributes.position.needsUpdate = true;
    }
  };

  /* ----- post-processing ----- */
  Scene.prototype._postKey = function (w, h) {
    const g = this.q;
    const msaaPost = g.antialias === 'msaa' && !this.contextAA;
    return (g.post || msaaPost) ? [g.ao, g.bloom, g.grade, g.antialias, w, h, this.pixelRatio].join('|') : 'none';
  };

  Scene.prototype._disposePost = function () {
    if (!this.composer) return;
    for (const p of this.composer.passes) {
      if (p.dispose) try { p.dispose(); } catch (_) {}
    }
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.composer = null;
    this.ssao = null;
  };

  Scene.prototype._buildPost = function (w, h) {
    const g = this.q, r = this.renderer, pr = this.pixelRatio;
    this._disposePost();
    if (this.postKey === 'none' || this.postFailed) return;
    try {
      if (!THREE.EffectComposer) throw new Error('post_missing');
      const pw = Math.max(1, Math.round(w * pr)), ph = Math.max(1, Math.round(h * pr));
      const opts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat,
        type: r.capabilities.isWebGL2 ? THREE.HalfFloatType : THREE.UnsignedByteType };
      const target = (g.antialias === 'msaa' && r.capabilities.isWebGL2)
        ? new THREE.WebGLMultisampleRenderTarget(pw, ph, opts)
        : new THREE.WebGLRenderTarget(pw, ph, opts);
      const composer = new THREE.EffectComposer(r, target);
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      if (g.ao !== 'off') {
        const ao = new THREE.SSAOPass(this.scene, this.camera, pw, ph);
        // HDR beauty buffer so dark hall tones do not band
        ao.beautyRenderTarget.dispose();
        ao.beautyRenderTarget = new THREE.WebGLRenderTarget(pw, ph, opts);
        ao.ssaoMaterial.uniforms.tDiffuse.value = ao.beautyRenderTarget.texture;
        if (g.ao === 'on') {
          ao.kernelSize = 16; ao.kernel = [];
          ao.generateSampleKernel();
          ao.ssaoMaterial.defines.KERNEL_SIZE = 16;
          ao.ssaoMaterial.uniforms.kernel.value = ao.kernel;
          ao.ssaoMaterial.needsUpdate = true;
        }
        ao.kernelRadius = 0.35;
        ao.minDistance = 0.0004;
        ao.maxDistance = 0.02;
        composer.addPass(ao);
        this.ssao = ao;
      } else {
        composer.addPass(new THREE.RenderPass(this.scene, this.camera));
      }
      if (g.bloom === 'on') {
        // high threshold: only lamp bulbs, the selection glow and sparks bloom
        composer.addPass(new THREE.UnrealBloomPass(new THREE.Vector2(pw, ph), 0.55, 0.4, 0.88));
      }
      const out = new THREE.ShaderPass(GradeShader);
      out.uniforms.uAmount.value = g.grade === 'on' ? 1 : 0;
      out.uniforms.uVignette.value = g.grade === 'on' ? 0.28 : 0;
      composer.addPass(out);
      if (g.antialias === 'smaa') composer.addPass(new THREE.SMAAPass(pw, ph));
      if (g.antialias === 'fxaa') {
        const fxaa = new THREE.ShaderPass(THREE.FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch (e) {
      // Post-processing is an enhancement: render directly if the chain cannot be built.
      this.postFailed = true;
      this._disposePost();
    }
  };

  Scene.prototype._fpsVisible = function (on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '— fps';
      document.body.appendChild(el);
    }
    if (el) el.hidden = !on;
  };

  // Adaptive resolution: step the render scale down when frames are slow, back up when fast.
  Scene.prototype._adapt = function (dt) {
    const f = this._frames;
    f.push(dt);
    if (f.length < 90) return false;
    let sum = 0;
    for (const x of f) sum += x;
    const avg = sum / f.length;
    f.length = 0;
    this.fps = 1000 / avg;
    const el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = Math.round(this.fps) + ' fps · ' + (Math.round(this.pixelRatio * 100) / 100) + '×';
    if (!this.q.adaptive) return false;
    const before = this.adaptiveScale;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
    return before !== this.adaptiveScale;
  };

  Scene.prototype.render = function () {
    if (this.disposed) return;
    const now = performance.now();
    const dt = this._last ? Math.min(250, now - this._last) : 16;
    this._last = now;
    const rescale = this._adapt(dt);
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    const q = this.q;
    const ratio = Math.min(window.devicePixelRatio || 1, q.maxRatio) * q.scale * this.adaptiveScale;
    if (w !== this.size[0] || h !== this.size[1] || ratio !== this.pixelRatio || rescale) {
      const resized = w !== this.size[0] || h !== this.size[1];
      this.size = [w, h];
      this.pixelRatio = ratio;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(w, h, false);
      if (resized) this.resize();
    }
    const key = this._postKey(w, h);
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost(w, h);
    }
    this.scene.background = this.composer ? this.bgLinear : this.bgDirect;
    if (this.composer) {
      if (this.ssao) {
        const u = this.ssao.ssaoMaterial.uniforms;
        u.cameraProjectionMatrix.value.copy(this.camera.projectionMatrix);
        u.cameraInverseProjectionMatrix.value.copy(this.camera.projectionMatrixInverse);
        u.cameraNear.value = this.camera.near; u.cameraFar.value = this.camera.far;
        this.ssao.depthRenderMaterial.uniforms.cameraFar.value = this.camera.far;
      }
      this.composer.render(dt / 1000);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  };

  /** Rendered size in device pixels (for the Graphics summary). */
  Scene.prototype.pixels = function () {
    return [Math.round(this.size[0] * this.pixelRatio), Math.round(this.size[1] * this.pixelRatio)];
  };

  Scene.prototype.resize = function () {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    // Frame the table rows inside the canvas band not covered by the HUD
    // (top bar) and the DOM hand/tray (bottom), for any aspect ratio.
    // A tray standing as a column on the right (short landscape phones) narrows
    // the band from the right instead.
    let top = 0, bottom = 0, right = 0;
    if (typeof document !== 'undefined') {
      const cr = this.canvas.getBoundingClientRect();
      const band = function (id) {
        const el = document.getElementById(id);
        if (!el || !el.offsetParent) return null;
        const r = el.getBoundingClientRect();
        return r.height ? { t: r.top - cr.top, b: r.bottom - cr.top, l: r.left - cr.left } : null;
      };
      const hud = band('hud-top'); if (hud && hud.b < h * 0.4) top = hud.b;
      for (const id of ['hand-dom', 'action-tray']) {
        const r = band(id); if (!r) continue;
        if (r.t > h * 0.5) bottom = Math.max(bottom, h - r.t);
        else if (r.l > w * 0.5) right = Math.max(right, w - r.l);
      }
    }
    const safeH = Math.max(120, h - top - bottom);
    const safeW = Math.max(160, w - right);
    this.camera.setViewOffset(safeW, safeH, 0, -top, w, h);
    this.camera.aspect = safeW / safeH;
    const tanV = Math.tan(FRAMING.fov * Math.PI / 360);
    const halfW = 5.0, halfD = 3.6; // hand row to deck row, with margin
    const base = Math.hypot(FRAMING.cameraPos.y - FRAMING.lookAt.y, FRAMING.cameraPos.z - FRAMING.lookAt.z);
    const needW = halfW / (tanV * this.camera.aspect * 0.95);
    const needD = halfD * 0.8 / (tanV * 0.95);
    const k = Math.max(1, needW / base, needD / base);
    this.camera.position.set(FRAMING.cameraPos.x, FRAMING.lookAt.y + (FRAMING.cameraPos.y - FRAMING.lookAt.y) * k,
      FRAMING.lookAt.z + (FRAMING.cameraPos.z - FRAMING.lookAt.z) * k);
    this.camera.lookAt(FRAMING.lookAt.x, FRAMING.lookAt.y, FRAMING.lookAt.z);
    this.camera.far = 30 + 12 * k;
    this.camera.updateProjectionMatrix();
  };

  /** Legacy entry point: a tier name ('low' | 'medium' | 'high') maps onto a preset. */
  Scene.prototype.setQuality = function (tierName) {
    this.setGraphics(Gfx.resolve({ preset: QUALITY_TIERS[tierName] || 'balanced' }, this.detected));
  };

  Scene.prototype.resetCamera = function () { this.resize(); };

  Scene.prototype.dispose = function () {
    this.disposed = true;
    this._disposePost();
    for (const k in this.faceTextures) this.faceTextures[k].dispose();
    for (const t of this.envTextures) t.dispose();
    if (this.backTexture) this.backTexture.dispose();
    if (this.dotTex) this.dotTex.dispose();
    if (this.envMap) this.envMap.dispose();
    this.boxGeo.dispose();
    if (this.roundGeo) this.roundGeo.dispose();
    this.scene.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.dispose(); }); }
    });
    this.renderer.dispose();
  };

  return { Scene: Scene, FRAMING: FRAMING, QUALITY_TIERS: QUALITY_TIERS, GradeShader: GradeShader };
});
