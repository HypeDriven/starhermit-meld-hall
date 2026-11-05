// The look per graphics level. The engine-owned effects (shadows and their map
// size, ambient occlusion, bloom, the grade, anti-aliasing) are the level's own
// (levelSettings(): the same table every StarHermit game reads). The game's art
// (materials, textures, segments, motes, sparks, reflections, detail) is the
// browser build's four presets and budgets (src/gfx.js TABLE / BUDGETS) keyed
// by the level's quality tier, with the motes and sparks scaled within the tier
// by the level's particle budget against the tier's anchor level (quantum,
// molecular, terrestrial, galactic), at most 2×. The runtime owns the rest of
// what the old Graphics panel did: Auto and the level choice, render scale and
// the pixel-ratio cap, adaptive resolution, the frame-rate limit and readout.
// The old panel's per-effect overrides are not offered (the runtime's Options
// choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Hall, table and cards: Lambert (Low), Standard (Balanced), clear-coated Physical card faces (High/Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Floor texture size in px (felt: half, wood rim: 2× wide × ⅛ tall). */
  texture: 256 | 512 | 1024;
  /** Table rim / felt cylinder segments. */
  segments: number;
  /** Dust motes in the lamp light (particles high + detailed table). */
  motes: number;
  /** Sparks per meld burst at particles high (low: half). */
  burst: number;
}
export interface Look {
  preset: QualityTier;
  /** The level's key-light shadow map size, 0 when the level draws no shadows. */
  shadows: number;
  /** The level's ambient occlusion (null: off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null: off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  /** Image-based reflections from a neutral room. */
  reflections: boolean;
  /** The detailed hall: textured floor, rim and felt, wall panels, lamp bulbs, brass inlay, fog, rounded cards. */
  detailed: boolean;
  particles: "off" | "low" | "high";
  budget: Budget;
}

type Art = Pick<Look, "reflections" | "detailed" | "particles">;
const ART: Record<QualityTier, Art> = {
  low: { reflections: false, detailed: false, particles: "low" },
  balanced: { reflections: true, detailed: true, particles: "low" },
  high: { reflections: true, detailed: true, particles: "high" },
  ultra: { reflections: true, detailed: true, particles: "high" },
};
// gfx.js BUDGETS (Low's 128 px texture is never drawn: Low's table is plain).
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 256, segments: 32, motes: 40, burst: 24 },
  balanced: { material: "standard", texture: 256, segments: 48, motes: 70, burst: 40 },
  high: { material: "physical", texture: 512, segments: 96, motes: 140, burst: 64 },
  ultra: { material: "physical", texture: 1024, segments: 128, motes: 200, burst: 96 },
};
/** The level whose settings are each tier's preset. */
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };
const MOTE_MAX = 400;

/** The look for a graphics level (the frame's by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = BUDGETS[preset];
  // Motes and sparks grow with the level's particle budget above the tier's anchor, at most 2×.
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: { ...b, texture: Math.min(b.texture, s.maxTextureSize) as Budget["texture"],
      motes: Math.min(MOTE_MAX, Math.round(b.motes * k)), burst: Math.round(b.burst * k) },
  };
}
