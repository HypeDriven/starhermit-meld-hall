// The card table on starhermit:scene, as the browser build's src/render.js
// drew it with three.js r137: the hall (floor, wall panels, pendant lamps with
// glowing bulbs, fog), the round table (wood rim, felt inlay, brass ring), the
// cards (rounded and clear-coated on detailed looks), the hand along the near
// edge with lifted selected cards, their accent rings and an idle bob, the
// table melds with their lay-off markers, the opponents' face-down rows, the
// deck (its height by the cards left) and the discard pile, the meld sparks
// and the dust motes in the lamp light, the warm key light with shadows, the
// lamp's light pool and the hemisphere fill — framed by the camera in the band
// the HUD, the action tray and the hand leave (setViewOffset, as before).
//
// From three.js r137 (legacy lights; engine.minor 26): intensities are the page's × π, the
// shadow box and bias the page's, the room environment on every standard material (as r137's scene.environment, scaled by
// each envMapIntensity) and built with the renderer: r137's legacy room light had no inverse-square falloff, so
// r155–r162's no-argument room (intensity 5) is far darker than the page's and the 900 room is the nearer match,
// the lamp's pool raised for the legacy light's cut-off falloff (LAMP_POOL),
// explicitly linear hex colours kept linear, the srgb lin() swatches as plain colours. r137 tone-mapped every draw (ACES at 1.15) before its post chain
// (SSAOPass, UnrealBloomPass, the GradeShader output pass, SMAA / FXAA); the
// runtime's renderer.ao / bloom / grade / antialias tone-map after bloom, so
// the bloom threshold is the old one taken back through the curve. The procedural canvases (card faces and backs, felt, wood rim,
// floor) are baked images (tools/bake-textures.mjs): every card shows its face
// by its own top-face UVs into one atlas. Adaptive resolution, the pixel-ratio
// cap and the frame-rate readout are the runtime's. Rendering never touches the
// rules state.
import {
  ACESFilmicToneMapping, AdditiveBlending, AmbientLight, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color,
  ConeGeometry, CylinderGeometry, DirectionalLight, DoubleSide, ExtrudeGeometry, FogExp2, Group, HemisphereLight, LinearSRGBColorSpace,
  Mesh, MeshBasicMaterial, OrthographicCamera, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, PerspectiveCamera,
  PlaneGeometry, PMREMGenerator, PointLight, Points, PointsMaterial, Raycaster, RepeatWrapping, RingGeometry, RoomEnvironment,
  SRGBColorSpace, Shape, SphereGeometry, TextureLoader, TorusGeometry, Vector2, Vector3, pointerToNdc, renderer, scene,
  type Material, type Object3D, type Side, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import { Content, type State, type Theme } from "./classic.ts";
import type { Look } from "./quality.ts";

const CARD_W = 0.7, CARD_H = 1.0, CARD_T = 0.02, GAP = 0.12, CARD_R = 0.07;
const FELT_TOP = 0.02;                         // felt cylinder top (y = -0.24 + 0.52 / 2)
const CARD_Y = FELT_TOP + CARD_T / 2 + 0.004;  // cards rest on the felt, never coplanar with it
const LIFT = 0.18;
// authored framing constants (no magic offsets elsewhere)
export const FRAMING = {
  cameraPos: { x: 0, y: 7.2, z: 6.4 },
  lookAt: { x: 0, y: 0, z: 0.6 },
  fov: 42,
  handRowZ: 3.4, meldRowZ: 0.4, tableRowZ: -1.2, deckZ: -2.6,
};
const LAMP_X = [-3.4, 0, 3.4], LAMP_Y = 4.1, LAMP_Z = -4.6;
/** r137's legacy point light faded linearly to nothing at its distance; three.js r155+'s falls off with distance^decay:
 * × this matches the lamp's pool on the felt (measured against the browser build). */
const LAMP_POOL = 5;

const lin = (hex: number): Color => new Color().setHex(hex, LinearSRGBColorSpace);

// -- the scene's fixed parts --------------------------------------------------------------------
const camera = new PerspectiveCamera(FRAMING.fov, 1, 0.1, 40);
const raycaster = new Raycaster();
const PI = Math.PI;
const key = new DirectionalLight(0xffe0b3, 1.35 * PI);
key.position.set(3, 8, 4);
key.target.position.set(0, 0, 0.2);
const sc = key.shadow.camera as OrthographicCamera; // fitted to the table top (radius 6.7) and cards above it
sc.left = -7; sc.right = 7; sc.top = 7; sc.bottom = -7; sc.near = 3; sc.far = 17;
sc.updateProjectionMatrix();
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
key.shadow.radius = 3;
const hemi = new HemisphereLight(0x4a5f8a, new Color("#1a140e"), 0.6 * PI);
const ambient = new AmbientLight(0xffffff, 0.12 * PI);
// warm pool from the pendant lamps (detailed hall only)
const lampLight = new PointLight(new Color("#ffc98a"), 0, 16, 1.4);
lampLight.position.set(0, 4.4, -1.6);
scene.add(key, key.target, hemi, ambient, lampLight);

let look: Look | null = null;
let theme: Theme = Content.THEMES[0]!;
let themeIndex = 0;
let reducedMotion = false;
let envGroup: Group | null = null;
let envTexture: Texture | null = null;
let bulbs: MeshBasicMaterial[] = [];
let time = 0;
let lastState: State | null = null;
let lastSelection: number[] = [];

// -- textures ---------------------------------------------------------------------------------
const loader = new TextureLoader();
const textures = new Map<string, Texture>();
/** A package image (cached per path and repeat; a repeat > 0 wraps). */
function image(path: string, rx = 0, ry = 0): Texture {
  const k = `${path}|${rx}|${ry}`;
  let t = textures.get(k);
  if (!t) {
    t = loader.load(path, undefined, undefined, (e: unknown) => console.warn(`${path}: ${e instanceof Error ? e.message : String(e)}`));
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 8;
    if (rx > 0) { t.wrapS = t.wrapT = RepeatWrapping; t.repeat.set(rx, ry); }
    textures.set(k, t);
  }
  return t;
}
/** render.js dotTexture: the sparks' and motes' soft dot. */
const dotTexture = (() => {
  const cv = new OffscreenCanvas(64, 64), g = cv.getContext("2d");
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.35, "rgba(255,255,255,0.45)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new CanvasTexture(cv);
  t.colorSpace = SRGBColorSpace;
  return t;
})();
function envMap(): Texture | null {
  if (!envTexture) {
    try { envTexture = new PMREMGenerator(renderer).fromScene((() => { const room = new RoomEnvironment(renderer); room.position.y = 0 /* pre-r183 page: room at origin (minor 32 default is -3.5) */; return room; })(), 0.04).texture; }
    catch (e) { console.warn(`environment: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return envTexture;
}

// -- materials ----------------------------------------------------------------------------------
interface MatParams {
  color?: Color; map?: Texture | null; roughness?: number; metalness?: number; envMapIntensity?: number;
  emissive?: Color; emissiveIntensity?: number; side?: Side;
}
/** Shading model per budget: Lambert on Low, Standard on Balanced, Physical (clear-coated) on High/Ultra where asked. */
function mat(p: MatParams, phys?: { clearcoat: number; clearcoatRoughness: number }): MeshStandardMaterial | MeshLambertMaterial {
  const tier = look!.budget.material;
  if (tier === "lambert") {
    const { roughness: _r, metalness: _m, envMapIntensity: _e, ...rest } = p;
    return new MeshLambertMaterial(rest);
  }
  const m = phys && tier === "physical" ? new MeshPhysicalMaterial({ ...p, ...phys }) : new MeshStandardMaterial(p);
  m.envMap = look!.reflections ? envMap() : null; // r137's scene.environment, scaled by each material's envMapIntensity
  return m;
}
function cardMat(p: MatParams, glossy = false): MeshStandardMaterial | MeshLambertMaterial {
  if (look!.detailed) {
    if (glossy) return mat({ roughness: 0.5, envMapIntensity: 0.28, ...p }, { clearcoat: 0.35, clearcoatRoughness: 0.3 });
    return mat({ envMapIntensity: 0.3, ...p });
  }
  return mat(p);
}

// -- card geometry: one per card face (and per theme back), its top UVs in the atlas -------------
const FACE_ATLAS = { cols: 13, rows: 4, w: 3328, h: 1472 };
const BACK_ATLAS = { cols: 5, rows: 1, w: 1280, h: 368 };
/** The atlas UV for (u, v) of cell (col, row), 1 px inside the cell's edges. */
function atlasUv(a: typeof FACE_ATLAS, col: number, row: number, u: number, v: number): [number, number] {
  const x = col * 256 + 1 + u * 254, y = row * 368 + 1 + (1 - v) * 366;
  return [x / a.w, 1 - y / a.h];
}
function boxCard(a: typeof FACE_ATLAS, col: number, row: number): BufferGeometry {
  const g = new BoxGeometry(CARD_W, CARD_T, CARD_H);
  const uv = g.getAttribute("uv")!;
  // the +y face (group 2): vertices 8–11
  for (let i = 8; i < 12; i++) uv.setXY(i, ...atlasUv(a, col, row, uv.getX(i), uv.getY(i)));
  uv.needsUpdate = true;
  return g;
}
/** Rounded card slab (render.js roundedCardGeometry): caps (material 0) show the face, the sides (material 1) the edge. */
function roundCard(a: typeof FACE_ATLAS, col: number, row: number): BufferGeometry {
  const s = new Shape(), w = CARD_W / 2, h = CARD_H / 2, r = CARD_R;
  s.moveTo(-w + r, -h); s.lineTo(w - r, -h); s.quadraticCurveTo(w, -h, w, -h + r);
  s.lineTo(w, h - r); s.quadraticCurveTo(w, h, w - r, h);
  s.lineTo(-w + r, h); s.quadraticCurveTo(-w, h, -w, h - r);
  s.lineTo(-w, -h + r); s.quadraticCurveTo(-w, -h, -w + r, -h);
  const geo = new ExtrudeGeometry(s, {
    depth: CARD_T, bevelEnabled: false, curveSegments: 4,
    UVGenerator: {
      generateTopUV: (_g, v, ia, ib, ic) => [ia, ib, ic].map((i) =>
        new Vector2(...atlasUv(a, col, row, (v[i * 3]! + w) / CARD_W, (v[i * 3 + 1]! + h) / CARD_H))),
      generateSideWallUV: () => [new Vector2(), new Vector2(), new Vector2(), new Vector2()],
    },
  });
  geo.translate(0, 0, -CARD_T / 2);
  geo.rotateX(-Math.PI / 2);
  return geo;
}
let faceGeos = new Map<number, BufferGeometry>();
let backGeo: BufferGeometry | null = null;
let faceMats: Material[] = [];
let backMats: Material[] = [];
function faceGeo(id: number): BufferGeometry {
  let g = faceGeos.get(id);
  if (!g) {
    const col = id % 13, row = (id / 13) | 0;
    g = look!.detailed ? roundCard(FACE_ATLAS, col, row) : boxCard(FACE_ATLAS, col, row);
    faceGeos.set(id, g);
  }
  return g;
}
/** The card materials for the current look: [face, side] on rounded cards, the box's six slots (face on +y) otherwise. */
function cardMaterials(): void {
  for (const m of new Set([...faceMats, ...backMats])) m.dispose();
  for (const g of faceGeos.values()) g.dispose();
  faceGeos = new Map();
  if (backGeo) backGeo.dispose();
  backGeo = look!.detailed ? roundCard(BACK_ATLAS, themeIndex, 0) : boxCard(BACK_ATLAS, themeIndex, 0);
  const faceTex = image("assets/textures/faces.webp"), backTex = image("assets/textures/backs.webp");
  const side = cardMat({ color: new Color("#f0ead8"), roughness: 0.7 });
  const face = cardMat({ map: faceTex, roughness: 0.55 }, true);
  const backSide = cardMat({ color: new Color("#e8e2d0"), roughness: 0.7 });
  const backTop = cardMat({ map: backTex, roughness: 0.5 }, true);
  faceMats = look!.detailed ? [face, side] : [side, side, face, side, side, side];
  backMats = look!.detailed ? [backTop, backSide] : [backSide, backSide, backTop, backSide, backSide, backSide];
}

// -- the hall -----------------------------------------------------------------------------------
function disposeTree(root: Object3D): void {
  const geos = new Set<BufferGeometry>(), mats = new Set<Material>();
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry) geos.add(m.geometry);
    if (m.material) for (const x of Array.isArray(m.material) ? m.material : [m.material]) mats.add(x);
  });
  for (const g of geos) g.dispose();
  for (const m of mats) m.dispose();
}
function buildEnvironment(): void {
  if (envGroup) { scene.remove(envGroup); disposeTree(envGroup); }
  const grp = envGroup = new Group();
  scene.add(grp);
  const th = theme, detailed = look!.detailed, b = look!.budget, tb = b.texture, seg = detailed ? b.segments : 48;
  const add = (mesh: Mesh, cast: boolean, receive: boolean): Mesh => { mesh.castShadow = cast; mesh.receiveShadow = receive; grp.add(mesh); return mesh; };
  const wood = new Color(th.wood), wall = new Color(th.wall), felt = new Color(th.felt), accent = new Color(th.accent);

  // floor
  const floor = add(new Mesh(new PlaneGeometry(30, 30), mat(detailed
    ? { color: wood.clone().multiplyScalar(0.55), map: image(`assets/textures/floor-${tb}.png`, 5, 5), roughness: 0.78, envMapIntensity: 0.35 }
    : { color: wall.clone().multiplyScalar(1.3), roughness: 0.95 })), false, true);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.55;

  // table: wood rim + felt inlay
  const rim = add(new Mesh(new CylinderGeometry(6.4, 6.7, 0.5, seg), mat(detailed
    ? { color: wood.clone(), map: image(`assets/textures/wood-${tb}.png`, 3, 1), roughness: 0.42, metalness: 0.05, envMapIntensity: 0.8 }
    : { color: wood.clone(), roughness: 0.6, metalness: 0.05 })), false, true);
  rim.position.y = -0.25;
  const feltMesh = add(new Mesh(new CylinderGeometry(6.0, 6.0, 0.52, seg), mat(detailed
    ? { color: felt.clone(), map: image(`assets/textures/felt-${tb / 2}.png`, 7, 7), roughness: 0.95, envMapIntensity: 0.25 }
    : { color: felt.clone(), roughness: 0.9 })), false, true);
  feltMesh.position.y = -0.24;

  // hanging lamps over the far side of the table
  const lampMat = mat({ color: lin(0x333844), roughness: 0.4, metalness: 0.6 });
  const shadeMat = mat(detailed
    ? { color: accent.clone(), emissive: accent.clone(), emissiveIntensity: 0.25, roughness: 0.3, metalness: 0.85, side: DoubleSide }
    : { color: accent.clone(), emissive: accent.clone(), emissiveIntensity: 0.4 });
  bulbs = [];
  for (const x of LAMP_X) {
    const pole = add(new Mesh(new CylinderGeometry(0.03, 0.03, 3.2, 8), lampMat), false, false);
    pole.position.set(x, detailed ? LAMP_Y + 1.6 : 2.6, LAMP_Z);
    const shade = add(new Mesh(new ConeGeometry(0.5, 0.5, detailed ? 32 : 16, 1, true), shadeMat), false, false);
    shade.position.set(x, LAMP_Y, LAMP_Z);
    if (detailed) {
      const bulbMat = new MeshBasicMaterial({ color: new Color("#ffd9a0").multiplyScalar(2.6), toneMapped: false });
      const bulb = add(new Mesh(new SphereGeometry(0.13, 16, 10), bulbMat), false, false);
      bulb.position.set(x, LAMP_Y - 0.2, LAMP_Z);
      bulbs.push(bulbMat);
    }
  }
  if (detailed) {
    // brass inlay where the felt meets the rim
    const brass = add(new Mesh(new TorusGeometry(6.08, 0.045, 10, 128),
      mat({ color: new Color("#c89a4a"), roughness: 0.28, metalness: 1, envMapIntensity: 1.2 })), false, true);
    brass.rotation.x = -Math.PI / 2;
    brass.position.y = 0.012;
    // wall panels + chair rail
    const panelMat = mat({ color: wood.clone().multiplyScalar(0.55), roughness: 0.6, envMapIntensity: 0.5 });
    for (let i = 0; i < 7; ++i) {
      const p = add(new Mesh(new BoxGeometry(1.8, 2.4, 0.1), panelMat), false, true);
      p.position.set(-7.2 + i * 2.4, 1.2, -7.5);
    }
    const wallMesh = add(new Mesh(new PlaneGeometry(40, 14), mat({ color: wall.clone().multiplyScalar(1.4), roughness: 0.9 })), false, true);
    wallMesh.position.set(0, 6, -7.62);
    scene.fog = new FogExp2(wall.clone(), 0.035);
    lampLight.intensity = 0.75 * LAMP_POOL * PI;
  } else {
    scene.fog = null;
    lampLight.intensity = 0;
  }
  key.color.setHex(th.keyLight);
  hemi.color.setHex(th.fill);
  scene.background = wall.clone();
  cardMaterials();
}

// -- particles ----------------------------------------------------------------------------------
interface Fx { pts: Points; pos: Float32Array; vel: Float32Array; life: Float32Array; max: number; next: number }
let fx: Fx | null = null;
let motes: { pts: Points; pos: Float32Array; seed: Float32Array; n: number } | null = null;
function buildParticles(): void {
  for (const o of [fx, motes]) if (o) { scene.remove(o.pts); o.pts.geometry.dispose(); (o.pts.material as Material).dispose(); }
  fx = null; motes = null;
  const p = look!.particles;
  if (p !== "off") {
    // effects layer: bounded particle pool, never picked
    const max = p === "high" ? 2000 : 500;
    const pos = new Float32Array(max * 3);
    for (let i = 0; i < max; ++i) pos[i * 3 + 1] = -999;
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(pos, 3));
    const pts = new Points(geo, new PointsMaterial({
      color: new Color(theme.accent).multiplyScalar(1.8), size: 0.09, map: dotTexture, transparent: true,
      opacity: 0.95, depthWrite: false, blending: AdditiveBlending, toneMapped: false,
    }));
    pts.frustumCulled = false;
    scene.add(pts);
    fx = { pts, pos, vel: new Float32Array(max * 3), life: new Float32Array(max), max, next: 0 };
  }
  if (p === "high" && look!.detailed) {
    // ambient dust drifting through the lamp light
    const n = look!.budget.motes, r = rng(21), pos = new Float32Array(n * 3), seed = new Float32Array(n * 3);
    for (let i = 0; i < n; ++i) {
      seed[i * 3] = (r() - 0.5) * 10; seed[i * 3 + 1] = 0.6 + r() * 3.6; seed[i * 3 + 2] = -5 + r() * 6;
      pos.set([seed[i * 3]!, seed[i * 3 + 1]!, seed[i * 3 + 2]!], i * 3);
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(pos, 3));
    const pts = new Points(geo, new PointsMaterial({
      color: new Color("#ffe2b0"), size: 0.045, map: dotTexture, transparent: true, opacity: 0.55, depthWrite: false, blending: AdditiveBlending,
    }));
    pts.frustumCulled = false;
    scene.add(pts);
    motes = { pts, pos, seed, n };
  }
}
/** Sparks over the meld row (render.js burst). */
export function burst(count = 32): void {
  if (!fx || reducedMotion) return;
  const cap = look!.budget.burst;
  const n = Math.min(count, look!.particles === "high" ? cap : Math.round(cap / 2));
  for (let i = 0; i < n; ++i) {
    const k = fx.next = (fx.next + 1) % fx.max;
    fx.pos[k * 3] = 0; fx.pos[k * 3 + 1] = 0.4; fx.pos[k * 3 + 2] = FRAMING.meldRowZ;
    const a = Math.random() * Math.PI * 2, s = 0.6 + Math.random() * 1.4;
    fx.vel[k * 3] = Math.cos(a) * s; fx.vel[k * 3 + 1] = 1.2 + Math.random(); fx.vel[k * 3 + 2] = Math.sin(a) * s;
    fx.life[k] = 1;
  }
  fx.pts.geometry.getAttribute("position")!.needsUpdate = true;
}

// -- state → scene ------------------------------------------------------------------------------
interface CardInfo { zone: "hand" | "meld" | "opp" | "deck" | "discardPile"; index: number; cardId: number; baseY: number; selected: boolean }
const markerMat = new MeshBasicMaterial({ color: new Color(theme.accent).multiplyScalar(1.6), transparent: true, opacity: 0.9, toneMapped: false });
let cardMeshes: Mesh<Material | Material[]>[] = [];
let pickMeshes: Mesh<Material | Material[]>[] = [];
let markers: Mesh[] = [];
const info = new Map<Object3D, CardInfo | { zone: "meldTarget"; index: number }>();
const markerGeo = new RingGeometry(0.1, 0.16, 20);
const rimGeo = new RingGeometry(0.42, 0.5, 32);

/** render.js sync: rebuilds the cards for a rules state and the hand's selection (cheap; card counts are small). */
export function sync(state: State, selection: number[]): void {
  lastState = state;
  lastSelection = selection.slice();
  if (!look) return;
  for (const m of [...cardMeshes, ...markers]) scene.remove(m);
  cardMeshes = []; pickMeshes = []; markers = [];
  info.clear();
  const addCard = (cardId: number, x: number, z: number, zone: CardInfo["zone"], index: number, faceUp: boolean): Mesh<Material | Material[]> => {
    const mesh = new Mesh(faceUp ? faceGeo(cardId) : backGeo!, faceUp ? faceMats : backMats);
    mesh.position.set(x, CARD_Y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    info.set(mesh, { zone, index, cardId, baseY: CARD_Y, selected: false });
    scene.add(mesh);
    cardMeshes.push(mesh);
    return mesh;
  };
  const setBase = (m: Mesh<Material | Material[]>): void => { (info.get(m) as CardInfo).baseY = m.position.y; };

  // table melds row(s)
  let mz = FRAMING.meldRowZ, mx = -4.6;
  for (let m = 0; m < state.table.length; ++m) {
    const meld = state.table[m]!;
    if (mx + meld.cards.length * (CARD_W + GAP) > 4.6) { mx = -4.6; mz -= CARD_H + GAP; }
    for (let k = 0; k < meld.cards.length; ++k) {
      const c = addCard(meld.cards[k]!, mx + k * (CARD_W * 0.5), mz, "meld", m, true);
      c.position.y += k * 0.003; setBase(c); // fanned cards stack, never coplanar
    }
    const marker = new Mesh(markerGeo, markerMat);
    marker.rotation.x = -Math.PI / 2;
    marker.position.set(mx - 0.5, FELT_TOP + 0.003, mz);
    info.set(marker, { zone: "meldTarget", index: m });
    scene.add(marker);
    markers.push(marker);
    mx += meld.cards.length * (CARD_W * 0.5) + 0.7;
  }

  // the human hand (seat 0) along the near edge, centred
  const hand = state.hands[0]!;
  const total = hand.cards.length * (CARD_W + GAP) - GAP;
  let hx = -total / 2 + CARD_W / 2;
  for (let i = 0; i < hand.cards.length; ++i) {
    const mesh = addCard(hand.cards[i]!, hx, FRAMING.handRowZ, "hand", i, true);
    hx += CARD_W + GAP;
    if (selection.includes(hand.cards[i]!)) {
      mesh.position.y += LIFT;
      const d = info.get(mesh) as CardInfo;
      d.baseY = mesh.position.y;
      d.selected = true;
      const rim = new Mesh(rimGeo, markerMat);
      rim.rotation.x = -Math.PI / 2;
      rim.position.set(mesh.position.x, FELT_TOP + 0.003, mesh.position.z);
      scene.add(rim);
      markers.push(rim);
    }
  }

  // opponent hands: face-down rows
  for (let p = 1; p < state.players; ++p) {
    const oh = state.hands[p]!;
    const oz = FRAMING.tableRowZ - 1.4 - (p - 1) * 0.9;
    const ot = oh.cards.length * (CARD_W * 0.45);
    for (let i = 0; i < oh.cards.length; ++i) {
      const c = addCard(oh.cards[i]!, -ot / 2 + i * CARD_W * 0.45 + (p - 1.5) * 2.2, oz, "opp", i, false);
      c.position.y += i * 0.003; setBase(c);
    }
  }

  // deck + discard pile (pickable)
  const deck = addCard(0, -1.0, FRAMING.deckZ, "deck", 0, false);
  deck.scale.y = Math.max(0.4, state.deck.length / 8);
  deck.position.y = FELT_TOP + CARD_T * deck.scale.y / 2 + 0.004;
  setBase(deck);
  pickMeshes.push(deck);
  const top = state.discardPile[state.discardPile.length - 1];
  if (top !== undefined) pickMeshes.push(addCard(top, 0.2, FRAMING.deckZ, "discardPile", 0, true));
}

// -- picking ------------------------------------------------------------------------------------
export interface Pick { zone: string; index: number; cardId?: number }
/** Window pixels → the card, pile or meld marker under them (render.js pick). */
export function pick(x: number, y: number): Pick | null {
  if (!renderer.camera) return null;
  raycaster.setFromCamera(pointerToNdc(x, y), camera);
  const hits = raycaster.intersectObjects([...cardMeshes, ...pickMeshes, ...markers.filter((m) => info.get(m)?.zone === "meldTarget")]);
  const d = hits.length ? info.get(hits[0]!.object) : undefined;
  return d ? { zone: d.zone, index: d.index, cardId: "cardId" in d ? d.cardId : undefined } : null;
}
/** A table point's window pixels (the browser check taps the deck there). */
export function toScreen(x: number, y: number, z: number, width: number, height: number): { x: number; y: number } {
  const v = new Vector3(x, y, z).project(camera);
  return { x: (v.x + 1) / 2 * width, y: (1 - v.y) / 2 * height };
}
/** The deck's or the discard pile's window rectangle (projected corners), or null without a table. */
export function pileRect(which: "deck" | "discard", width: number, height: number): { x: number; y: number; width: number; height: number } | null {
  if (!renderer.camera || !lastState) return null;
  if (which === "discard" && !lastState.discardPile.length) return null;
  const cx = which === "deck" ? -1.0 : 0.2, cz = FRAMING.deckZ, y = FELT_TOP + 0.05;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const p = toScreen(cx + dx * CARD_W / 2, y, cz + dz * CARD_H / 2, width, height);
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  // the deck stands over the opponents' row; keep its rectangle to its own uncovered part
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// -- framing ------------------------------------------------------------------------------------
let frameKey = "";
/** Frame the table rows inside the window band not covered by the HUD (top), the hand and tray (bottom) or a side tray (right). */
function frameCamera(w: number, h: number, top: number, bottom: number, right: number): void {
  const safeH = Math.max(120, h - top - bottom);
  const safeW = Math.max(160, w - right);
  camera.setViewOffset(safeW, safeH, 0, -top, w, h);
  camera.aspect = safeW / safeH;
  const tanV = Math.tan(FRAMING.fov * Math.PI / 360);
  const halfW = 5.0, halfD = 3.6; // hand row to deck row, with margin
  const base = Math.hypot(FRAMING.cameraPos.y - FRAMING.lookAt.y, FRAMING.cameraPos.z - FRAMING.lookAt.z);
  const needW = halfW / (tanV * camera.aspect * 0.95);
  const needD = halfD * 0.8 / (tanV * 0.95);
  const k = Math.max(1, needW / base, needD / base);
  camera.position.set(FRAMING.cameraPos.x, FRAMING.lookAt.y + (FRAMING.cameraPos.y - FRAMING.lookAt.y) * k,
    FRAMING.lookAt.z + (FRAMING.cameraPos.z - FRAMING.lookAt.z) * k);
  camera.lookAt(FRAMING.lookAt.x, FRAMING.lookAt.y, FRAMING.lookAt.z);
  camera.far = 30 + 12 * k;
  camera.updateProjectionMatrix();
}
/** The camera key: the framing again (render.js resetCamera). */
export function resetCamera(): void { frameKey = ""; }

// -- the look -----------------------------------------------------------------------------------
function applyReflections(): void {
  const env = look!.reflections ? envMap() : null;
  // r137's scene.environment honoured each material's envMapIntensity; three.js r163+'s (the engine's) applies
  // scene.environmentIntensity instead, so every standard material takes the room as its own envMap.
  scene.traverse((o) => {
    const m = (o as Mesh).material;
    if (!m) return;
    for (const x of Array.isArray(m) ? m : [m]) if (x instanceof MeshStandardMaterial) x.envMap = env;
  });
  // image-based light replaces part of the flat fill so the hall keeps its mood
  hemi.intensity = (env ? 0.38 : 0.6) * PI;
  ambient.intensity = (env ? 0.03 : 0.12) * PI;
}
function rebuild(): void {
  buildEnvironment();
  buildParticles();
  markerMat.color.set(theme.accent).multiplyScalar(1.6);
  if (lastState) sync(lastState, lastSelection);
  applyReflections();
}
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  // r137 tone-mapped every scene draw (ACES at 1.15, into the post chain's target too); the post chain then ran on that.
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  // SSAOPass (kernel radius 0.35, 16 or 32 samples at Ultra) → the runtime's ambient occlusion.
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.8, radius: 0.35, distanceExponent: 1, thickness: 1, scale: 1, samples: next.ao === "high" ? 16 : 8, resolution: 1,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // UnrealBloomPass(strength 0.55, radius 0.4, threshold 0.88 on the tone-mapped light): the runtime blooms before
  // tone mapping, where ACES at 1.15 reaches 0.88 from 1.6 — so only lamp bulbs, the selection glow and sparks bloom.
  // r137 page: the r160 bloom model with the page's own 0.55 (minor 30).
  renderer.bloom = next.bloom ? { model: "r160", strength: 0.55, radius: 0.4, threshold: 1.6, resolution: next.budget.bloomRes } : null;
  // GradeShader (the output pass, display colours): 0.18 S-curve, +7 % saturation, warm highlights / cool shadows, vignette 0.28.
  renderer.grade = next.grade ? {
    space: "display", contrastCurve: "s", contrast: 0.18, saturation: 1.07, split: [0.2, 0.8], shadows: [0.97, 0.99, 1.04], highlights: [1.035, 1.0, 0.965],
    vignette: { amount: 0.28, inner: 0.38, outer: 0.9, scale: [1.1, 1] },
  } : null;
  renderer.antialias = next.antialias;
  renderer.shadowMap.enabled = next.shadows > 0;
  key.castShadow = next.shadows > 0;
  if (next.shadows > 0) key.shadow.mapSize = next.shadows;
  rebuild();
}
/** The session's theme (content.js THEMES: the Journey stage's or the Daily's, else Hall Dusk). */
export function setTheme(id: string | undefined): void {
  const i = Math.max(0, Content.THEMES.findIndex((t) => t.id === id));
  if (i === themeIndex && envGroup) return;
  themeIndex = i;
  theme = Content.THEMES[i]!;
  if (look) rebuild();
}
export function setReducedMotion(on: boolean): void { reducedMotion = on; }
/** Whether the table draws (the menus show the key art and panels instead). */
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }

// -- per frame ----------------------------------------------------------------------------------
/** Each frame: the framing for the window and its HUD bands (window px), the selected cards' bob, lamp shimmer, sparks and motes. */
export function update(dt: number, w: number, h: number, band: { top: number; bottom: number; right: number }): void {
  const fk = `${w}x${h}:${Math.round(band.top)}:${Math.round(band.bottom)}:${Math.round(band.right)}`;
  if (w > 0 && h > 0 && fk !== frameKey) { frameKey = fk; frameCamera(w, h, band.top, band.bottom, band.right); }
  dt = Math.min(0.1, dt);
  const moving = !reducedMotion;
  if (moving) time += dt;
  const t = time;
  // idle bob on selected cards (static under reduced motion)
  for (const m of cardMeshes) {
    const d = info.get(m) as CardInfo;
    if (d.selected) m.position.y = d.baseY + (moving ? Math.sin(t * 2.4 + m.position.x) * 0.02 : 0);
  }
  // lamp shimmer
  if (bulbs.length) {
    const f = moving ? 1 + 0.035 * Math.sin(t * 7.3) + 0.02 * Math.sin(t * 13.7 + 1.3) : 1;
    lampLight.intensity = 0.75 * LAMP_POOL * PI * f;
    for (const b of bulbs) b.color.setRGB(1, 0.69, 0.35).multiplyScalar(2.6 * f);
  }
  if (fx) {
    let any = false;
    for (let k = 0; k < fx.max; ++k) {
      if (fx.life[k]! <= 0) continue;
      any = true;
      fx.life[k]! -= dt * 1.4;
      fx.vel[k * 3 + 1]! -= dt * 3;
      fx.pos[k * 3]! += fx.vel[k * 3]! * dt;
      fx.pos[k * 3 + 1]! += fx.vel[k * 3 + 1]! * dt;
      fx.pos[k * 3 + 2]! += fx.vel[k * 3 + 2]! * dt;
      if (fx.life[k]! <= 0) fx.pos[k * 3 + 1] = -999;
    }
    if (any) fx.pts.geometry.getAttribute("position")!.needsUpdate = true;
  }
  if (motes && moving) {
    const m = motes;
    for (let i = 0; i < m.n; ++i) {
      const s = i * 3, ph = i * 1.7;
      m.pos[s] = m.seed[s]! + Math.sin(t * 0.13 + ph) * 0.6;
      m.pos[s + 1] = m.seed[s + 1]! + Math.sin(t * 0.21 + ph * 0.7) * 0.35;
      m.pos[s + 2] = m.seed[s + 2]! + Math.cos(t * 0.11 + ph) * 0.5;
    }
    m.pts.geometry.getAttribute("position")!.needsUpdate = true;
  }
}

/* deterministic noise for the decor (render.js rng) */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
