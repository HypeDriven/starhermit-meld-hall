// The game's data and the StarHermit platform, on the runtime's modules:
// - session.js keeps its progress and settings in localStorage; here a
//   stand-in over the runtime: the progress (meldhall.save.v1, session.js's
//   checksummed envelope) is the game's save (starhermit:storage `saves`, on
//   the device and in the player's cloud slot) as the plain progress document
//   the browser build mirrored to game:<slug>; two devices' saves merge on a
//   conflict through src/store.js mergeProgress (the browser build's merge);
//   the slot the browser build wrote (the JS SDK's saveJSON) shows as foreign:
//   it is merged in and replaced once;
// - session.js's settings (meldhall.settings.v1) keep only the game's own
//   options here — captions, haptics, colour palette, left-handed tray and the
//   lessons seen — as engine `settings` (same keys, synced with the account);
//   the browser build's values in the account's settings KV are adopted (unless
//   set here since), then all its KV keys are removed (volumes, graphics,
//   reduced motion, contrast, text size and language are the runtime's Options);
// - the player, the invite link, the platform's clock for the Daily, posting a
//   finished match's total through score-script.js (a practice session whose
//   socket carries { type: 'result', scores }, as the JS SDK's submitScores
//   did) with the rank, and the board's top ten for the Daily's results.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions, type Leaderboard,
} from "starhermit:platform";
import { saves, settings as store, storage } from "starhermit:storage";
import { Store, type Options, type Progress } from "./classic.ts";

const SAVE_KEY = "meldhall.save.v1";
const SETTINGS_KEY = "meldhall.settings.v1";
type Key = keyof Options;

// --- the game's options --------------------------------------------------------------------
export const options: Options = JSON.parse(JSON.stringify(Store.DEFAULT_OPTIONS)) as Options;
const listeners = new Set<() => void>();
export function onOptionsChange(fn: () => void): void { listeners.add(fn); }
function changed(): void { for (const fn of listeners) fn(); }
function readOption(key: Key): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = Store.pickOptions({ [key]: v })[key];
  if (ok !== undefined) (options as unknown as Record<string, unknown>)[key] = ok;
}
/** Changes one of the game's options (device and account). */
export function setOption<K extends Key>(key: K, value: Options[K]): void {
  if (JSON.stringify(options[key]) === JSON.stringify(value)) return;
  options[key] = value;
  try { store.set(key, value as unknown as JsonValue); } catch (e) { console.warn(`option ${key}: ${String(e)}`); }
  changed();
}
/** A migrated value, kept unless this game set the key since. */
function adoptOption(key: Key, value: unknown): void {
  const v = Store.pickOptions({ [key]: value })[key];
  if (v === undefined) return;
  try {
    if (store.get(key) !== undefined) return;
    store.set(key, v as unknown as JsonValue);
    (options as unknown as Record<string, unknown>)[key] = v;
    changed();
  } catch { /* keep the device's */ }
}
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  for (const k of keys) if ((Store.OPTION_KEYS as string[]).includes(k)) adoptOption(k as Key, store.legacy(k));
  for (const k of keys) if (Store.BROWSER_KEYS.includes(k)) store.removeLegacy(k);
}

// --- session.js's localStorage ---------------------------------------------------------------
let progress: Progress = Store.normalize(null);
let dirty = false;
const local = {
  getItem(key: string): string | null {
    if (key === SAVE_KEY) return Store.wrap(progress);
    if (key === SETTINGS_KEY) return Store.wrap(options);
    try { return storage.getText(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    if (key === SAVE_KEY) {
      const data = Store.unwrap(String(value));
      if (data) { progress = Store.normalize(data); dirty = true; }
      return;
    }
    if (key === SETTINGS_KEY) {
      const data = Store.pickOptions(Store.unwrap(String(value)));
      for (const k of Store.OPTION_KEYS) if (data[k] !== undefined) setOption(k, data[k] as never);
      return;
    }
    try { storage.set(key, String(value)); } catch (e) { console.warn(`storage ${key}: ${String(e)}`); }
  },
  removeItem(key: string): void { try { storage.remove(key); } catch { /* gone */ } },
};
(globalThis as unknown as { localStorage: typeof local }).localStorage = local;

// --- the save ------------------------------------------------------------------------------
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

function persist(opts: { replaceForeign?: boolean } = {}): void {
  dirty = false;
  try {
    saves.save(progress as unknown as JsonValue, { schema: 1, ...opts });
    lastSavedAt = saves.load()?.savedAt ?? lastSavedAt;
  } catch (e) { console.warn(`save: ${String(e)}`); }
}
/** Each frame: a progress write by session.js reaches the save. */
export function flushWrites(): void { if (dirty) persist(); }
/** Merges another progress document into the live one; whether anything changed (then saved). */
function adopt(other: unknown): boolean {
  const next = Store.mergeProgress(progress, other);
  if (Store.same(next, progress)) return false;
  progress = Store.normalize(next);
  persist();
  return true;
}
saves.onConflict((mine, remote) => ({ merged: Store.mergeProgress(mine?.data ?? null, remote.data) as unknown as JsonValue }));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(cur.data)) merged();
  }
});
/** The browser build's cloud progress: merged with this device's, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const doc = Store.readForeign(old.text);
  let grew = false;
  if (doc) {
    const next = Store.mergeProgress(progress, doc);
    grew = !Store.same(next, progress);
    progress = Store.normalize(next);
  }
  persist({ replaceForeign: true });
  if (grew) merged();
}

/** For the title's player line: local (a guest) | syncing | saving | synced | offline. */
export function syncState(): "local" | "syncing" | "saving" | "synced" | "offline" {
  if (!player()) return "local";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "offline";
  if (st === "loading" || st === "foreign") return "syncing";
  if (st === "uploading" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { flushWrites(); void saves.flush().catch(() => undefined); }

/** Reads the device's save and the game's options (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  progress = Store.normalize(cur?.data ?? null);
  for (const k of Store.OPTION_KEYS) readOption(k);
  store.onChange((k) => {
    if (!(Store.OPTION_KEYS as string[]).includes(k)) return;
    readOption(k as Key);
    changed();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  changed();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

// --- the player and the clock ------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = undefined;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
onPlayerChange(() => refreshPlayer());

/** Now in ms by the platform's clock when it has answered, else the device's (the Daily's day). */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}

// --- the match-score board ---------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
export interface Posted { posted: boolean; rank: number | null }
export interface Row { rank: number; name: string; score: number }

/** Signed in only: post a finished match's total through score-script.js; { posted, rank }. Never rejects. */
export async function postScore(total: number): Promise<Posted> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}

/** The board's top ten with the players' display names; null when unavailable (src/platform.js fetchLeaderboard). */
export async function topScores(): Promise<Row[] | null> {
  if (!player()) return null;
  try {
    const b = await highScoreBoard();
    if (!b) return null;
    const r = await leaderboards.entries(b.id, { pageSize: 10 });
    if (!r.items.length) return null;
    return r.items.slice(0, 10).map((e, i) => ({ rank: e.rank ?? i + 1, name: e.displayName || e.username || "", score: Number.isFinite(e.score) ? e.score : 0 }));
  } catch { return null; }
}
