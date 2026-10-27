// The look per graphics level: the browser build's four presets and budgets
// (src/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the dust motes scaled within the tier by the level (frame().levelIndex,
// at most 2×), as the browser build scaled them by its hardware level. The
// runtime owns the rest of what the old Graphics panel did: Auto and the
// level choice, render scale and the pixel-ratio cap, adaptive resolution,
// the frame-rate limit and readout. The old panel's per-effect overrides are
// not offered (the runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
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
  bloomRes: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map (0 = off). */
  shadows: 0 | 512 | 1024 | 2048;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  /** Image-based reflections from a neutral room. */
  reflections: boolean;
  /** The detailed hall: textured floor, rim and felt, wall panels, lamp bulbs, brass inlay, fog, rounded cards. */
  detailed: boolean;
  particles: "off" | "low" | "high";
  budget: Budget;
}

const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, detailed: false, particles: "low" },
  balanced: { shadows: 512, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, detailed: true, particles: "low" },
  high: { shadows: 1024, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, detailed: true, particles: "high" },
  ultra: { shadows: 2048, ao: "high", bloom: true, grade: true, antialias: "smaa", reflections: true, detailed: true, particles: "high" },
};
// gfx.js BUDGETS (Low's 128 px texture is never drawn: Low's table is plain).
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 256, segments: 32, motes: 40, burst: 24, bloomRes: 0.5 },
  balanced: { material: "standard", texture: 256, segments: 48, motes: 70, burst: 40, bloomRes: 0.5 },
  high: { material: "physical", texture: 512, segments: 96, motes: 140, burst: 64, bloomRes: 0.5 },
  ultra: { material: "physical", texture: 1024, segments: 128, motes: 200, burst: 96, bloomRes: 1 },
};
/** The first level index of each tier. */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };
const MOTE_MAX = 400;

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: motes grow with the level above the tier's first, at most 2×.
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return { preset, ...TABLE[preset], budget: b };
}
