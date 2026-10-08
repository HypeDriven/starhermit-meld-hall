'use strict';
/*
 * Meld Hall — graphics quality model: presets, per-category overrides, GPU
 * detection and a cost summary. Pure (no three.js, no DOM), shared by the
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

  /** Best preset for this GPU, from the unmasked renderer string when the browser exposes it. */
  function detectPreset(gpu, opts) {
    const g = String(gpu || '').toLowerCase();
    let p;
    if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) p = 'low';
    else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?!.*graphics)|apple m\d/.test(g)) p = 'high';
    else p = 'balanced';
    // Phones and tablets: cap Auto at Balanced (heat and battery).
    if (opts && opts.mobile && (p === 'high' || p === 'ultra')) p = 'balanced';
    return p;
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
  function resolve(saved, detected) {
    const s = saved || {};
    const auto = PRESETS.indexOf(s.preset) < 0;
    const preset = auto ? (PRESETS.indexOf(detected) >= 0 ? detected : 'balanced') : s.preset;
    const row = TABLE[preset];
    const userScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
    const out = { preset: preset, auto: auto, userScale: userScale, scale: row.scale * userScale, maxRatio: row.maxRatio };
    for (const cat in CATEGORIES) {
      out[cat] = CATEGORIES[cat].indexOf(s[cat]) >= 0 ? s[cat] : row[cat];
    }
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
    detectPreset: detectPreset, legacyPreset: legacyPreset, resolve: resolve,
    choosePreset: choosePreset, presetTier: presetTier, describe: describe,
  };
});
