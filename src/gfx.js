'use strict';
/*
 * Meld Hall — graphics quality model: presets, per-category overrides, StarHermit
 * hardware-level detection, per-preset budgets and a cost summary. Pure (no three.js, no DOM), shared by the
 * renderer, the Graphics settings section and the offline tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MeldGfx = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {

  const PRESETS = ['low', 'balanced', 'high', 'ultra'];

  // Category -> allowed tiers, cheapest first.
  const CATEGORIES = {
    shadows: ['off', 'low', 'medium', 'high'],
    ao: ['off', 'on', 'high'],
    bloom: ['off', 'on'],
    grade: ['off', 'on'],
    antialias: ['off', 'fxaa', 'smaa', 'msaa'],
    reflections: ['off', 'on'],
    detail: ['plain', 'detailed'],
    particles: ['off', 'low', 'high'],
  };

  // Each preset: a row of tiers, a render scale (multiplies the device pixel
  // ratio) and a pixel-ratio cap so Low stays as cheap as the original game.
  const TABLE = {
    low: { scale: 0.8, maxRatio: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa',
      reflections: 'off', detail: 'plain', particles: 'low' },
    balanced: { scale: 1, maxRatio: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa',
      reflections: 'on', detail: 'detailed', particles: 'low' },
    high: { scale: 1, maxRatio: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa',
      reflections: 'on', detail: 'detailed', particles: 'high' },
    ultra: { scale: 1.25, maxRatio: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'smaa',
      reflections: 'on', detail: 'detailed', particles: 'high' },
  };

  const SHADOW_MAP = { off: 0, low: 512, medium: 1024, high: 2048 };

  // Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
  // 5090; src/gpu-level.js → StarHermitGpu, loaded before this file): Low from 0, Balanced from 4, High from
  // 10, Ultra from 17. Phones, tablets and ≤ 4 GB machines are capped at level 9 (Balanced).
  const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
  function gpuApi() {
    const g = typeof globalThis !== 'undefined' ? globalThis : self;
    if (g.StarHermitGpu) return g.StarHermitGpu;
    try { return typeof require === 'function' ? require('./gpu-level.js') : null; } catch (_) { return null; }
  }

  /** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
  function detectLevel(gpu, system) {
    const G = gpuApi();
    const sys = Object.assign({ webgl: true, webgl2: true }, system || {}, { gpu: String(gpu || '') });
    if (!gpu) sys.webgl = false; // no renderer string: no usable WebGL
    return G ? G.detectLevel(sys) : (gpu ? LEVELS.balanced : 0);
  }

  /** The preset Auto starts from for a hardware level. */
  function presetForLevel(level) {
    const G = gpuApi();
    if (G) return G.presetForLevel(level, LEVELS);
    return level >= 17 ? 'ultra' : level >= 10 ? 'high' : level >= 4 ? 'balanced' : 'low';
  }

  /** Best preset for this GPU (the hardware level already caps phones/tablets at Balanced). */
  function detectPreset(gpu, system) {
    return presetForLevel(detectLevel(gpu, system));
  }

  /*
   * Per-preset asset and effect budget. Each preset holds 60 FPS on the weakest GPU Auto gives it (Low →
   * level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). Cards, pick targets
   * and rules are identical on every preset — only visuals change.
   *   material  shading model for the hall, table and cards: lambert (Low) / standard (Balanced) /
   *             physical (High, Ultra: clear-coated card faces)
   *   texture   procedural floor texture size in px (felt: half, wood rim: 2× wide × ⅛ tall)
   *   segments  table rim/felt cylinder segments
   *   motes     dust motes in the lamp light (Particles high + Table detail detailed), scaled with the level
   *   burst     sparks per burst at Particles high (low: half)
   *   bloomRes  bloom resolution as a fraction of the frame
   */
  const BUDGETS = {
    low: { material: 'lambert', texture: 128, segments: 32, motes: 40, burst: 24, bloomRes: 0.5 },
    balanced: { material: 'standard', texture: 256, segments: 48, motes: 70, burst: 40, bloomRes: 0.5 },
    high: { material: 'physical', texture: 512, segments: 96, motes: 140, burst: 64, bloomRes: 0.5 },
    ultra: { material: 'physical', texture: 1024, segments: 128, motes: 200, burst: 96, bloomRes: 1 },
  };
  const MOTE_MAX = 400;

  /** A preset's concrete budget for a hardware level (the mote count scales ≤ 2× within the preset). */
  function budgetFor(preset, level) {
    const b = Object.assign({}, BUDGETS[preset] || BUDGETS.balanced);
    const G = gpuApi(), floor = LEVELS[preset] || 0;
    const lv = Math.max(isFinite(level) && level !== null ? Number(level) : floor, floor);
    const k = G ? Math.min(2, G.scaleBudget(1, lv, floor)) : 1;
    b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
    return b;
  }

  /** Map the pre-graphics-panel `quality` setting onto a preset. */
  function legacyPreset(quality) {
    return { low: 'low', medium: 'balanced', high: 'high' }[quality] || 'auto';
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /**
   * Resolve saved settings into concrete tiers.
   * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
   */
  function resolve(saved, detected, level) {
    const s = saved || {};
    const auto = PRESETS.indexOf(s.preset) < 0;
    const preset = auto ? (PRESETS.indexOf(detected) >= 0 ? detected : 'balanced') : s.preset;
    const row = TABLE[preset];
    const userScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
    const out = { preset: preset, auto: auto, userScale: userScale, scale: row.scale * userScale, maxRatio: row.maxRatio };
    for (const cat in CATEGORIES) {
      out[cat] = CATEGORIES[cat].indexOf(s[cat]) >= 0 ? s[cat] : row[cat];
    }
    out.level = isFinite(level) && level !== null ? Number(level) : LEVELS[preset];
    out.budget = budgetFor(preset, out.level);
    out.adaptive = s.adaptive !== false;
    out.showFps = !!s.show_fps;
    // Post-processing runs only when something needs it; otherwise the canvas renders directly.
    out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' ||
      out.antialias === 'fxaa' || out.antialias === 'smaa';
    return out;
  }

  /** Choosing a preset clears every per-category override (render scale and toggles stay). */
  function choosePreset(saved, preset) {
    const s = saved || {};
    const out = { preset: preset === 'auto' || PRESETS.indexOf(preset) >= 0 ? preset : 'auto' };
    if (s.render_scale !== undefined) out.render_scale = s.render_scale;
    if (s.adaptive !== undefined) out.adaptive = s.adaptive;
    if (s.show_fps !== undefined) out.show_fps = s.show_fps;
    return out;
  }

  /** The preset's own tier for a category (for "From preset (…)" labels). */
  function presetTier(preset, cat) {
    return TABLE[preset] ? TABLE[preset][cat] : undefined;
  }

  /** Short cost summary, e.g. "1024² shadows · SSAO · bloom · SMAA · 1280×800 px". */
  function describe(r, pixels) {
    const parts = [
      r.shadows === 'off' ? 'no shadows' : SHADOW_MAP[r.shadows] + '² shadows',
      r.ao === 'off' ? null : r.ao === 'high' ? 'full ambient occlusion' : 'ambient occlusion',
      r.bloom === 'on' ? 'bloom' : null,
      r.reflections === 'on' ? 'reflections' : null,
      r.antialias === 'off' ? 'no anti-aliasing' : r.antialias.toUpperCase(),
      pixels ? pixels[0] + '×' + pixels[1] + ' px' : null,
    ];
    return parts.filter(Boolean).join(' · ');
  }

  return {
    PRESETS: PRESETS, CATEGORIES: CATEGORIES, SHADOW_MAP: SHADOW_MAP,
    LEVELS: LEVELS, BUDGETS: BUDGETS, MOTE_MAX: MOTE_MAX, detectLevel: detectLevel, presetForLevel: presetForLevel,
    budgetFor: budgetFor, detectPreset: detectPreset, legacyPreset: legacyPreset, resolve: resolve,
    choosePreset: choosePreset, presetTier: presetTier, describe: describe,
  };
});
