// The browser build's pure game scripts, shared with the Node tests: the
// rules engine (deal, draw, meld, lay off, discard, scoring, the AI, replay
// envelopes), the versioned content (themes, 40 Journey stages, the Daily,
// lessons, challenges, achievements), the session (modes, undo, AI pacing,
// lesson goals, progress and achievements), the save model and options
// (src/store.js) and the string tables (src/*.js, UMD), evaluated as classic
// scripts so their globals are this module's exports.
import { loadClassic } from "starhermit:script";

for (const f of ["src/rules.js", "src/content.js", "src/session.js", "src/store.js", "src/strings.js", "src/i18n.js", "src/sh-strings.js"]) loadClassic(f);

// -- The shapes this client reads -------------------------------------------------
export type Phase = "draw" | "act" | "roundOver" | "matchOver";
export interface Meld { cards: number[]; kind: "set" | "run"; owner: number }
export interface Hand { cards: number[]; melds: number[] }
export interface Breakdown {
  winner: number; reason: "player_out" | "deck_exhausted"; deadwood: number[]; pointsAwarded: number; totals: number[]; round: number;
}
export interface State {
  version: string; seed: number; tick: number; players: number; targetScore: number; round: number; phase: Phase; turn: number;
  deck: number[]; discardPile: number[]; hands: Hand[]; table: Meld[]; scores: number[]; roundBreakdown: Breakdown | null;
  invalidActions: number[]; terminalReason: string | null; matchWinner?: number; lastCommandId: string | null;
}
export type Action =
  | { type: "draw"; source: "deck" | "discard" }
  | { type: "meld"; cards: number[] }
  | { type: "layoff"; card: number; meld: number }
  | { type: "discard"; card: number };
export type Command = Action & { id?: string; player?: number };
export interface GameEvent { type: string; player?: number; kind?: string; source?: string; meld?: number; round?: number }
export interface Theme { id: string; name: string; felt: string; wood: string; wall: string; accent: string; cardBack: string; keyLight: number; fill: number }
export interface Stage {
  id: string; index: number; seed: number; title: string; mastery: boolean; players: number; targetScore: number; aiDifficulty: number; theme: string;
}
export interface Lesson { id: string; title: string; text: string; require: { type: string; kind?: string } }
export interface Challenge { id: string; title: string; text: string; kind: string }
export interface Daily { id: string; day: string; seed: number; theme: string }
export interface Achievement { key: string; title: string; text: string }
export interface Replay { commands: unknown[]; hashes: string[] }
export interface Summary {
  phase: Phase; winner: number; humanWon: boolean; breakdown: Breakdown; matchWinner: number | null; replay: Replay;
}
export interface SessionEvent { type: string; reason?: string; events?: GameEvent[]; command?: Command; ai?: boolean; lesson?: string; summary?: Summary }
export interface Session {
  mode: "learn" | "journey" | "daily" | "practice" | "challenge";
  contentRef: (Partial<Stage> & Partial<Lesson> & Partial<Challenge> & { id: string; theme?: string }) | null;
  humanSeat: number; aiDifficulty: number; allowUndo: boolean; undoStack: string[]; aiTimer: unknown; aiPaused?: boolean;
  state: State; resultSummary: Summary | null; lessonDone: boolean;
  on(fn: (e: SessionEvent) => void): void;
  legal(): Action[];
  command(cmd: Command): { ok: boolean; reason?: string };
  undo(): boolean;
  isOver(): boolean;
  nextRound(): { ok: boolean };
  scheduleAI(): void;
}
export interface Progress {
  journeyUnlocked: number; journeyCleared: Record<string, boolean>; masteryCleared: number;
  dailiesPlayed: Record<string, boolean>; achievements: Record<string, boolean>;
  career: { melds: number; rounds: number; winStreak: number; bestStreak: number }; lastDailySeed: number | null;
}
export interface Settings { captions: boolean; haptics: boolean; colorPalette: string; leftHanded: boolean; tutorialSeen: Record<string, boolean>; [k: string]: unknown }
export interface Options { captions: boolean; haptics: boolean; colorPalette: string; leftHanded: boolean; tutorialSeen: Record<string, boolean> }

interface RulesApi {
  RANKS: string[]; SUIT_GLYPHS: string[];
  rankOf(id: number): number; suitOf(id: number): number; cardValue(id: number): number; cardName(id: number): string;
  meldKind(ids: number[]): "set" | "run" | null;
  deadwood(hand: Hand): number;
  verifyReplay(env: Replay): { ok: boolean; reason?: string };
}
interface ContentApi {
  THEMES: Theme[]; STAGES: Stage[]; LESSONS: Lesson[]; CHALLENGES: Challenge[]; ACHIEVEMENTS: Achievement[];
  dailyFor(d?: Date): Daily;
}
interface SessionApi {
  startLearn(i: number): Session; startJourney(i: number): Session; startDaily(now: number): Session;
  startPractice(o: { players?: number; targetScore?: number; aiDifficulty?: number; seed?: number }): Session;
  startChallenge(id: string): Session;
  loadSettings(): Settings; saveSettings(s: Settings): void;
  loadProgress(): Progress; saveProgress(p: Progress): void;
  applyResultToProgress(p: Progress, s: Session): string[];
  setTimers(t: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void }): void;
}
interface StoreApi {
  DEFAULT_PROGRESS: Progress;
  normalize(raw: unknown): Progress;
  mergeProgress(local: unknown, remote: unknown): Progress;
  same(a: unknown, b: unknown): boolean;
  readForeign(text: string | null): Progress | null;
  wrap(data: unknown): string;
  unwrap(text: string): unknown;
  PALETTES: string[]; DEFAULT_OPTIONS: Options; OPTION_KEYS: (keyof Options)[];
  pickOptions(raw: unknown): Partial<Options>;
  BROWSER_KEYS: string[];
}
interface I18nApi {
  T(key: string, vars?: Record<string, string | number> | null): string;
  setLocale(tag: string): string;
  readonly lang: string;
  locales: string[];
}
interface ShApi { shStrings(langs: string[]): Record<string, string> }

const g = globalThis as unknown as {
  MeldRules: RulesApi; MeldContent: ContentApi; MeldSession: SessionApi; MeldStore: StoreApi; MHI18N: I18nApi; ShStrings: ShApi;
};
export const Rules = g.MeldRules;
export const Content = g.MeldContent;
export const Sess = g.MeldSession;
export const Store = g.MeldStore;
export const I18n = g.MHI18N;
export const ShStrings = g.ShStrings;
