'use strict';
/*
 * Meld Hall — Three.js presentation layer.
 * Table scene: authored camera, procedural table/hall geometry, card meshes
 * with procedural CanvasTexture faces, selection feedback (lift + rim +
 * grounded marker), quality tiers, reduced-motion support, explicit disposal.
 * Rendering consumes immutable snapshots; it never mutates rules state.
 */
(function (root, factory) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const Rules = isNode ? require('./rules.js') : root.MeldRules;
  const api = factory(Rules);
  if (isNode) module.exports = api;
  if (root) root.MeldRender = api;
})(typeof self !== 'undefined' ? self : globalThis, function (Rules) {

  const CARD_W = 0.7, CARD_H = 1.0, CARD_T = 0.02, GAP = 0.12;
  // authored framing constants (no magic offsets elsewhere)
  const FRAMING = {
    cameraPos: { x: 0, y: 7.2, z: 6.4 },
    lookAt: { x: 0, y: 0, z: 0.6 },
    fov: 42,
    handRowZ: 3.4, meldRowZ: 0.4, tableRowZ: -1.2, deckZ: -2.6,
  };

  const QUALITY_TIERS = {
    low: { pixelRatio: 1, shadows: false, particles: 0, envDetail: 0.3, renderScale: 0.8 },
    medium: { pixelRatio: 1.5, shadows: true, particles: 500, envDetail: 0.7, renderScale: 1 },
    high: { pixelRatio: 2, shadows: true, particles: 2000, envDetail: 1, renderScale: 1 },
  };

  function Scene(canvas, theme, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.theme = theme;
    this.reducedMotion = !!opts.reducedMotion;
    this.tier = QUALITY_TIERS[opts.quality] || QUALITY_TIERS.medium;
    this.renderer = null;
    this.pickHandlers = { card: null, deck: null, discard: null, meld: null };
    this.cardMeshes = [];   // { mesh, cardId, zone, index }
    this.pickMeshes = [];   // deck/discard targets
    this.meldMarkers = [];
    this.springs = [];      // { obj, from, to, t, dur }
    this.disposed = false;
    this._tmpColor = null;
    this._init();
  }

  Scene.prototype._init = function () {
    if (typeof THREE === 'undefined') throw new Error('three_missing');
    const t = this.tier;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, t.pixelRatio));
    this.renderer.shadowMap.enabled = t.shadows;
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.theme.wall);

    this.camera = new THREE.PerspectiveCamera(FRAMING.fov, 1, 0.1, 100);
    this.camera.position.set(FRAMING.cameraPos.x, FRAMING.cameraPos.y, FRAMING.cameraPos.z);
    this.camera.lookAt(FRAMING.lookAt.x, FRAMING.lookAt.y, FRAMING.lookAt.z);

    // lighting: one dominant key + soft fill + ambient
    const key = new THREE.DirectionalLight(this.theme.keyLight, 1.1);
    key.position.set(3, 8, 4);
    if (t.shadows) { key.castShadow = true; key.shadow.mapSize.set(1024, 1024); }
    this.scene.add(key);
    this.scene.add(new THREE.HemisphereLight(this.theme.fill, 0x222222, 0.55));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.18));

    this._buildEnvironment();

    // pools
    this.cardGeo = new THREE.BoxGeometry(CARD_W, CARD_T, CARD_H);
    this.faceTextures = {};
    this.backTexture = makeBackTexture(this.theme.cardBack);
    const backSide = new THREE.MeshStandardMaterial({ color: 0xe8e2d0, roughness: 0.7 });
    const backTop = new THREE.MeshStandardMaterial({ map: this.backTexture, roughness: 0.6 });
    this.backMats = [backSide, backSide, backTop, backSide, backSide, backSide];
    this.markerMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(this.theme.accent), transparent: true, opacity: 0.85 });
    this.ghostMat = new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.35 });

    // effects layer: bounded particle pool (points), never raycastable
    this.fx = null;
    if (t.particles > 0) this._initParticles(t.particles);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.resize();
  };

  Scene.prototype._buildEnvironment = function () {
    const th = this.theme;
    // floor
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(th.wall).multiplyScalar(1.3), roughness: 0.95 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.55;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // table: wood rim + felt inlay (procedural, silhouette-first)
    const rim = new THREE.Mesh(
      new THREE.CylinderGeometry(6.4, 6.7, 0.5, 48),
      new THREE.MeshStandardMaterial({ color: th.wood, roughness: 0.6, metalness: 0.05 })
    );
    rim.position.y = -0.25;
    rim.receiveShadow = true;
    this.scene.add(rim);
    const felt = new THREE.Mesh(
      new THREE.CylinderGeometry(6.0, 6.0, 0.52, 48),
      new THREE.MeshStandardMaterial({ color: th.felt, roughness: 0.9 })
    );
    felt.position.y = -0.24;
    felt.receiveShadow = true;
    this.scene.add(felt);

    // modest hall dressing at low triangle cost (detail scaled by tier)
    const detail = this.tier.envDetail;
    if (detail > 0.2) {
      const lampMat = new THREE.MeshStandardMaterial({ color: 0x333844, roughness: 0.4, metalness: 0.6 });
      const shadeMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(th.accent), emissive: new THREE.Color(th.accent), emissiveIntensity: 0.4,
      });
      for (let i = -1; i <= 1; ++i) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 3.2, 8), lampMat);
        pole.position.set(i * 3.4, 2.6, -4.6);
        this.scene.add(pole);
        const shade = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.5, 16, 1, true), shadeMat);
        shade.position.set(i * 3.4, 4.1, -4.6);
        this.scene.add(shade);
      }
    }
    if (detail > 0.6) {
      // wall panels
      const panelMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(th.wood).multiplyScalar(0.8), roughness: 0.8 });
      for (let i = 0; i < 5; ++i) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.4, 0.1), panelMat);
        p.position.set(-4.8 + i * 2.4, 1.6, -7.5);
        this.scene.add(p);
      }
    }
  };

  Scene.prototype._initParticles = function (max) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(max * 3);
    const vel = new Float32Array(max * 3);
    const life = new Float32Array(max);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: new THREE.Color(this.theme.accent), size: 0.06, transparent: true, opacity: 0.9, depthWrite: false });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.raycast = function () {}; // cosmetic: never intercept picking
    this.scene.add(pts);
    this.fx = { pts: pts, pos: pos, vel: vel, life: life, max: max, next: 0 };
  };

  Scene.prototype.burst = function (x, y, z, count) {
    if (!this.fx || this.reducedMotion) return;
    const fx = this.fx;
    const n = Math.min(count || 24, 48);
    for (let i = 0; i < n; ++i) {
      const k = fx.next = (fx.next + 1) % fx.max;
      fx.pos[k * 3] = x; fx.pos[k * 3 + 1] = y; fx.pos[k * 3 + 2] = z;
      const a = Math.random() * Math.PI * 2, s = 0.6 + Math.random() * 1.4;
      fx.vel[k * 3] = Math.cos(a) * s; fx.vel[k * 3 + 1] = 1.2 + Math.random(); fx.vel[k * 3 + 2] = Math.sin(a) * s;
      fx.life[k] = 1;
    }
    fx.pts.geometry.attributes.position.needsUpdate = true;
  };

  /* ----- card face textures (procedural, cached) ----- */
  function makeFaceTexture(cardId) {
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 184;
    const g = cv.getContext('2d');
    g.fillStyle = '#f6f2e8';
    g.fillRect(0, 0, 128, 184);
    g.strokeStyle = '#c8c0a8'; g.lineWidth = 4;
    g.strokeRect(3, 3, 122, 178);
    const red = Rules.suitOf(cardId) === 1 || Rules.suitOf(cardId) === 2;
    g.fillStyle = red ? '#a83232' : '#22303e';
    g.font = 'bold 44px serif';
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText(Rules.RANKS[Rules.rankOf(cardId)], 10, 8);
    g.font = '40px serif';
    g.fillText(Rules.SUIT_GLYPHS[Rules.suitOf(cardId)], 10, 52);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '72px serif';
    g.fillText(Rules.SUIT_GLYPHS[Rules.suitOf(cardId)], 64, 118);
    const tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 4;
    return tex;
  }
  function makeBackTexture(color) {
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 184;
    const g = cv.getContext('2d');
    g.fillStyle = color; g.fillRect(0, 0, 128, 184);
    g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 3;
    g.strokeRect(8, 8, 112, 168);
    g.beginPath();
    for (let i = 0; i < 6; ++i) {
      g.moveTo(20 + i * 16, 16); g.lineTo(20 + i * 16, 168);
    }
    g.globalAlpha = 0.18; g.stroke(); g.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(cv);
    // Authored back art (assets/card-back.webp) is tinted over the procedural
    // pattern once it decodes; if it never loads the procedural back stands.
    try {
      const img = new Image();
      img.onload = function () {
        g.globalAlpha = 0.85;
        g.drawImage(img, 6, 6, 116, 172);
        g.globalAlpha = 1;
        g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 3;
        g.strokeRect(8, 8, 112, 168);
        tex.needsUpdate = true;
      };
      img.onerror = function () {};
      img.src = 'assets/card-back.webp';
    } catch (_) {}
    return tex;
  }
  Scene.prototype.faceMat = function (cardId) {
    if (!this.faceTextures[cardId]) {
      const top = makeFaceTexture(cardId);
      const side = new THREE.MeshStandardMaterial({ color: 0xf0ead8, roughness: 0.7 });
      const face = new THREE.MeshStandardMaterial({ map: top, roughness: 0.6 });
      this.faceTextures[cardId] = [side, side, face, side, side, side];
    }
    return this.faceTextures[cardId];
  };

  /* ----- state -> scene rebuild (cheap; card counts are small) ----- */
  Scene.prototype.sync = function (state, selection) {
    // clear old card/pick meshes
    for (const e of this.cardMeshes) { this.scene.remove(e.mesh); }
    for (const m of this.pickMeshes) this.scene.remove(m);
    for (const m of this.meldMarkers) this.scene.remove(m);
    this.cardMeshes.length = 0; this.pickMeshes.length = 0; this.meldMarkers.length = 0;

    const self = this;
    function addCard(cardId, x, z, zone, index, faceUp) {
      const mesh = new THREE.Mesh(self.cardGeo, faceUp === false ? self.backMats : self.faceMat(cardId));
      mesh.position.set(x, CARD_T / 2, z);
      mesh.castShadow = self.tier.shadows;
      mesh.userData = { zone: zone, index: index, cardId: cardId, baseY: CARD_T / 2 };
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
        addCard(meld.cards[k], mx + k * (CARD_W * 0.5), mz, 'meld', m, true);
      }
      const marker = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.16, 20), this.markerMat);
      marker.rotation.x = -Math.PI / 2;
      marker.position.set(mx - 0.5, 0.01, mz);
      marker.userData = { zone: 'meldTarget', index: m };
      this.scene.add(marker);
      this.meldMarkers.push(marker);
      mx += meld.cards.length * (CARD_W * 0.5) + 0.7;
    }

    // human hand (seat 0) — fanned along the near edge
    const hand = state.hands[0];
    const total = hand.cards.length * (CARD_W + GAP) - GAP;
    let hx = -total / 2;
    for (let i = 0; i < hand.cards.length; ++i) {
      const mesh = addCard(hand.cards[i], hx, FRAMING.handRowZ, 'hand', i, true);
      hx += CARD_W + GAP;
      if (selection && selection.indexOf(hand.cards[i]) >= 0) {
        mesh.position.y += 0.18; // lift
        const rim = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 24), this.markerMat);
        rim.rotation.x = -Math.PI / 2;
        rim.position.set(mesh.position.x, 0.012, mesh.position.z);
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
        addCard(oh.cards[i], -ot / 2 + i * CARD_W * 0.45 + (p - 1.5) * 2.2, oz, 'opp', i, false);
      }
    }

    // deck + discard pile (pickable)
    const deck = addCard(0, -1.0, FRAMING.deckZ, 'deck', 0, false);
    deck.scale.y = Math.max(0.4, state.deck.length / 8);
    this.pickMeshes.push(deck);
    const topDisc = state.discardPile[state.discardPile.length - 1];
    if (topDisc !== undefined) {
      const dm = addCard(topDisc, 0.2, FRAMING.deckZ, 'discardPile', 0, true);
      this.pickMeshes.push(dm);
    }

    this.lastState = state;
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
    this.springs.push({ obj: mesh, baseY: mesh.userData.baseY || CARD_T / 2, t: 0, dur: 0.35, h: height || 0.15 });
  };

  Scene.prototype.update = function (dt) {
    // critically-damped-ish one-shot pulses: y = base + h*sin(pi * t/dur)
    for (let i = this.springs.length - 1; i >= 0; --i) {
      const s = this.springs[i];
      s.t += dt;
      const k = Math.min(1, s.t / s.dur);
      s.obj.position.y = s.baseY + Math.sin(Math.PI * k) * s.h;
      if (k >= 1) { s.obj.position.y = s.baseY; this.springs.splice(i, 1); }
    }
    if (this.fx && !document.hidden) {
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
  };

  Scene.prototype.render = function () {
    if (!this.disposed) this.renderer.render(this.scene, this.camera);
  };

  Scene.prototype.resize = function () {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const s = this.tier.renderScale;
    this.renderer.setSize(Math.floor(w * s), Math.floor(h * s), false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  Scene.prototype.setQuality = function (tierName) {
    this.tier = QUALITY_TIERS[tierName] || QUALITY_TIERS.medium;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.tier.pixelRatio));
    this.renderer.shadowMap.enabled = this.tier.shadows;
    this.resize();
  };

  Scene.prototype.resetCamera = function () {
    this.camera.position.set(FRAMING.cameraPos.x, FRAMING.cameraPos.y, FRAMING.cameraPos.z);
    this.camera.lookAt(FRAMING.lookAt.x, FRAMING.lookAt.y, FRAMING.lookAt.z);
  };

  Scene.prototype.dispose = function () {
    this.disposed = true;
    for (const k in this.faceTextures) this.faceTextures[k][2].map.dispose();
    if (this.backTexture) this.backTexture.dispose();
    this.cardGeo.dispose();
    this.scene.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.dispose(); }); }
    });
    this.renderer.dispose();
  };

  return { Scene: Scene, FRAMING: FRAMING, QUALITY_TIERS: QUALITY_TIERS };
});
