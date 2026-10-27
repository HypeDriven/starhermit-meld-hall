// Sound, as the browser build's src/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event, alternating between
// an event's variants (card select / deselect, draw / take, the two UI
// clicks), with the event's caption; the hall's room tone (white noise
// lowpassed at 220 Hz, looped) and the gentle chord pad (four triangle
// chords of three notes, one every 3 s, each swelling in over 0.8 s and out by
// 3.2 s) whose level rises with the melds on the table. The browser build ran
// both live (a noise loop and oscillators every 3 s); here they are rendered
// once into clips (createClip, a slice a frame) and looped on the music bus
// (the runtime has no ambience bus; the room tone's gain folds in the old
// ambience slider's 40 % default against music's 50 %). The pad's pitch no
// longer rises with the intensity, only its level. The runtime's Options own
// the volumes, the mute and the voice limit; UI clicks play on the
// "interface" bus, the rest on "effects". The oscillator blips the browser
// build synthesized while a sample decoded are not ported (a live synthesis
// graph makes clip loads fail on the engine's web runtime), so a clip still
// loading is silent. Clips load once the mixer runs (natively at once, in a
// browser after the first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";

const SFX: Record<string, string[]> = {
  select: ["card-select", "card-deselect"],
  invalid: ["invalid-buzz"],
  draw: ["card-draw", "card-draw-take"],
  meld: ["meld-fan"],
  layoff: ["layoff-tap"],
  discard: ["card-discard"],
  turn: ["turn-chime"],
  roundWin: ["round-win"],
  roundLose: ["round-lose"],
  achievement: ["achievement-chime"],
  deal: ["deal-round"],
  hint: ["hint-shimmer"],
  matchWin: ["match-win"],
  ui: ["ui-click", "ui-confirm"],
};
/** src/audio.js SFX_CAPTIONS: the text cue of every meaningful sound (English keys, translated where shown). */
export const CAPTIONS: Record<string, string> = {
  select: "Card selected", invalid: "That action is not legal", draw: "Card drawn", meld: "Meld played", layoff: "Card laid off",
  discard: "Card discarded", turn: "Your turn", roundWin: "Round won", roundLose: "Round lost", achievement: "Achievement unlocked",
  deal: "Cards dealt", hint: "Hint offered", matchWin: "Match won",
};
export type Sfx = keyof typeof SFX;
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
const cursor = new Map<string, number>();
let loading = false;
let wantClips = false;
let captionFn: ((key: string) => void) | null = null;
/** fn(English caption key) for every captioned sound. */
export function onCaption(fn: (key: string) => void): void { captionFn = fn; }

/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }

/** src/audio.js play(kind): the event's next variant and its caption. */
export function play(event: Sfx): void {
  const names = SFX[event];
  if (!names) return;
  if (CAPTIONS[event] && captionFn) captionFn(CAPTIONS[event]!);
  const i = (cursor.get(event) ?? 0) % names.length;
  const file = names[i]!;
  const clip = clips.get(file);
  if (!clip) return;
  cursor.set(event, i + 1);
  try { playClip(clip, { bus: event === "ui" ? "interface" : "effects" }); }
  catch { clips.delete(file); if (!queue.includes(file)) queue.push(file); } // a clip the mixer lost: load it again
}

// -- the room tone and the chord pad ------------------------------------------------------------
const RATE = 22050;
const AMB_N = RATE * 2;
const amb = new Float32Array(AMB_N);
let ambPos = 0, ambY = 0, seed = 0x51a7;
function noise(): number {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
  return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
}
/** The 2 s noise loop through a one-pole 220 Hz lowpass, run twice so the loop joins without a click. */
function renderAmbience(count: number): boolean {
  const k = 1 - Math.exp((-2 * Math.PI * 220) / RATE);
  const end = Math.min(2 * AMB_N, ambPos + count);
  for (; ambPos < end; ambPos++) {
    const i = ambPos % AMB_N;
    if (ambPos < AMB_N) amb[i] = noise();
    ambY += k * (amb[i]! - ambY);
    if (ambPos >= AMB_N) amb[i] = ambY;
  }
  return ambPos >= 2 * AMB_N;
}
const CHORDS = [[261.6, 329.6, 392], [220, 261.6, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6]];
const PAD_N = RATE * 12;
const pad = new Float32Array(PAD_N);
let padPos = 0;
/** One 12 s cycle of the pad (each chord at 3 s steps, its 0.2 s tail wrapping round), a slice at a time. */
function renderPad(count: number): boolean {
  const end = Math.min(PAD_N, padPos + count);
  for (; padPos < end; padPos++) {
    let v = 0;
    for (let j = 0; j < 4; j++) {
      let t = (padPos / RATE - j * 3 + 12) % 12;
      if (t >= 3.2) continue;
      const env = t < 0.8 ? t / 0.8 : 1 - (t - 0.8) / 2.4;
      for (const f of CHORDS[j]!) {
        const ph = (t * f) % 1;
        v += (ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph) * 0.05 * env;
      }
    }
    pad[padPos] = v;
  }
  return padPos >= PAD_N;
}
let ambClip: AudioClip | null = null;
let padClip: AudioClip | null = null;
let ambVoice: Sound | null = null;
let padVoice: Sound | null = null;
let intensity = 0;
/** The pad's level with the table (src/audio.js setMusicIntensity: 0.05 → 0.1 at full). */
export function setMusicIntensity(v: number): void {
  const next = Math.max(0, Math.min(1, v));
  if (next === intensity) return;
  intensity = next;
  if (padVoice) try { padVoice.fade(1 + intensity, 1); } catch { /* gone */ }
}

/** Each frame: the clips once the mixer runs (one at a time), then the room tone and the pad. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const list of Object.values(SFX)) for (const n of list) if (!queue.includes(n)) queue.push(n);
  }
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
    }
    return;
  }
  if (loading) return;
  if (!ambClip) {
    if (!renderAmbience(8000)) return;
    try { ambClip = createClip([amb], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); ambPos = 0; }
    return;
  }
  if (!ambVoice) {
    try { ambVoice = playClip(ambClip, { bus: "music", gain: 0.8, loop: true }); } catch { ambVoice = null; }
    return;
  }
  if (!padClip) {
    if (!renderPad(6000)) return;
    try { padClip = createClip([pad], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); padPos = 0; }
    return;
  }
  if (!padVoice) {
    try { padVoice = playClip(padClip, { bus: "music", gain: 1 + intensity, loop: true }); } catch { padVoice = null; }
  }
}
