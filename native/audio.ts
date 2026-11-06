// Sound, as the browser build's src/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event, alternating between
// an event's variants (card select / deselect, draw / take, the two UI
// clicks), with the event's caption; the hall's room tone (white noise
// lowpassed at 220 Hz, looped) and the gentle chord pad (four triangle
// chords of three notes, one every 3 s, each swelling in over 0.8 s and out by
// 3.2 s) whose level rises with the melds on the table. The browser build ran
// both live (a noise loop and oscillators every 3 s); here they are rendered
// offline once at start (OfflineAudioContext) into clips and looped on the music bus
// (the runtime has no ambience bus; the room tone's gain folds in the old
// ambience slider's 40 % default against music's 50 %). The pad's pitch no
// longer rises with the intensity, only its level. The runtime's Options own
// the volumes, the mute and the voice limit; UI clicks play on the
// "interface" bus, the rest on "effects". The oscillator blips the browser
// build synthesized while a sample decoded are not ported, so a clip still
// loading is silent. Every clip loads at once in onStart; the room tone and the
// pad start once the mixer runs (natively at once, in a browser after the first
// press).
import { context, createClip, loadClip, OfflineAudioContext, play as playClip, SoundBank, type AudioClip, type Sound } from "starhermit:audio";

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
const banks = new Map<string, SoundBank>();
let captionFn: ((key: string) => void) | null = null;
/** fn(English caption key) for every captioned sound. */
export function onCaption(fn: (key: string) => void): void { captionFn = fn; }

/** Loads every clip and renders the loops at once (onStart); a cue whose clips are still loading is skipped. */
export function loadSfx(): void {
  for (const [event, list] of Object.entries(SFX)) {
    void Promise.all(list.map((name) => loadClip(`sfx/${name}.opus`).catch((e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); return null; })))
      .then((loaded) => {
        const clips = loaded.filter((c) => c !== null);
        if (clips.length) banks.set(event, new SoundBank({ clips, order: "sequence", bus: event === "ui" ? "interface" : "effects" }));
      });
  }
  renderLoops();
}

/** src/audio.js play(kind): the event's next variant and its caption. */
export function play(event: Sfx): void {
  const names = SFX[event];
  if (!names) return;
  if (CAPTIONS[event] && captionFn) captionFn(CAPTIONS[event]!);
  try { banks.get(event)?.play(); }
  catch { /* the mixer is full this frame: skip it */ }
}

// -- the room tone and the chord pad ------------------------------------------------------------
const RATE = 22050;
/** The 2 s noise loop through a 220 Hz lowpass; periodic once the filter settles, so the loop joins. */
async function renderAmbience(): Promise<AudioClip> {
  const n = RATE * 2, settle = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, settle + n, RATE);
  const noise = off.createNoise({ seed: 0x51a7, seconds: 2 });
  const lp = off.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 220;
  noise.connect(lp).connect(off.destination);
  noise.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE);
}
const CHORDS = [[261.6, 329.6, 392], [220, 261.6, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6]];
const PAD_N = RATE * 12;
/** One 12 s cycle of the pad (each chord at 3 s steps, its 0.2 s tail wrapped round to the start). */
async function renderPad(): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(RATE * 12.2), RATE);
  CHORDS.forEach((chord, j) => {
    const at = j * 3;
    const g = off.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.05, at + 0.8);
    g.gain.linearRampToValueAtTime(0, at + 3.2);
    g.connect(off.destination);
    for (const f of chord) {
      const osc = off.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = f;
      osc.connect(g);
      osc.start(at);
      osc.stop(at + 3.2);
    }
  });
  const d = (await off.startRendering()).getChannelData(0);
  const out = d.slice(0, PAD_N);
  for (let i = PAD_N; i < d.length; i++) out[i - PAD_N]! += d[i]!;
  return createClip([out], RATE);
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

/** Renders the room tone and the pad, one context each (onStart). */
function renderLoops(): void {
  const warn = (e: unknown): void => console.warn(`audio: ${String(e)}`);
  renderAmbience().then((c) => { ambClip = c; }, warn);
  renderPad().then((c) => { padClip = c; }, warn);
}

/** Each frame, once the mixer runs: the room tone and the pad. */
export function update(): void {
  if (context.state !== "running") return;
  if (ambClip && !ambVoice) {
    try { ambVoice = playClip(ambClip, { bus: "music", gain: 0.8, loop: true }); } catch { ambVoice = null; }
    return;
  }
  if (padClip && !padVoice) {
    try { padVoice = playClip(padClip, { bus: "music", gain: 1 + intensity, loop: true }); } catch { padVoice = null; }
  }
}
