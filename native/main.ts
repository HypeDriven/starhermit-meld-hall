// Meld Hall on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (src/rules.js), content
// (src/content.js) and the session with its modes, undo, AI pacing, lesson
// goals, progress and achievements (src/session.js) are the browser build's,
// unchanged in what they decide; this module is what src/ui.js and
// src/main.js did around them — the screens' flow (title → mode select →
// play ⇄ pause / settings / help → results), the session's events (sounds,
// captions, announcements, the meld sparks, the results with achievements),
// the player's commands from the action tray, the hand, the meld chips, the
// keys and pads and taps on the 3D table (deck, discard pile, hand cards,
// meld markers), hints, undo, the camera reset, the Daily by the platform's
// clock, posting a finished match to the leaderboard and the Daily's board,
// and the lifecycle (a hidden window pauses the AI, as visibilitychange did).
// Screens are drawn by screens.ts (starhermit:ui), the table by render.ts
// (starhermit:scene).
//
// Time is the runtime's fixed steps: the AI's think time (session.js
// scheduleAI) runs on a clock that advances 1/60 s per fixed step, so a
// paused game, a hidden window and slow frames never move the table and play
// scripts replay exactly.
import "./classic.ts";
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onTouch, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import { Content, Rules, Sess, type Session, type SessionEvent, type Settings } from "./classic.ts";
import * as audio from "./audio.ts";
import { N, S, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

export type Screen = "title" | "mode" | "play" | "results" | "help";
export type ModeId = "practice" | "journey" | "daily" | "challenge" | "learn";
export const PLAYERS = [2, 3, 4];
export const TARGETS = [30, 50, 100];
export const DIFFICULTIES = [N("Relaxed"), N("Regular"), N("Sharp")];

export const app = {
  screen: "title" as Screen,
  /** Open overlays, top last: the pause menu, Settings over it (index.html .overlay). */
  overlays: [] as ("pause" | "settings")[],
  /** Frame the screen or overlay opened on (the press that opened it must not also act on it). */
  openedFrame: 0,
  focusNext: null as string | null,
  helpReturn: "title" as "title" | "play",
  session: null as Session | null,
  settings: null as unknown as Settings,
  /** Selected card ids (ui.js selection) and the keyboard's place in the hand. */
  selection: [] as number[],
  focusIdx: 0,
  pendingMode: "practice" as ModeId,
  modeDetailFull: false,
  practice: { players: 0, target: 1, difficulty: 0 },
  challenge: 0,
  /** Compact layouts: the progress / status sheets (index.html .rail.open). */
  railLeft: false,
  railRight: false,
  lastUnlocked: [] as string[],
  lb: null as platform.Posted | "posting" | null,
  /** The Daily's board: undefined loading, null none. */
  dailyEntries: undefined as platform.Row[] | null | undefined,
  caption: null as { key: string; until: number } | null,
  toast: null as { text: () => string; until: number } | null,
  /** The last hint (announced, and shown over the tray for a while). */
  hint: null as { text: () => string; until: number } | null,
};
const now = (): number => frame().time;

// ------------------------------------------------------------------ helpers
export function announce(text: string, assertive = false): void {
  if (text) ui.announce(text.slice(0, 500), { politeness: assertive ? "assertive" : "polite" });
}
export function toast(text: () => string): void {
  app.toast = { text, until: now() + 3.2 };
  announce(text());
}
function haptic(): void { if (app.settings.haptics) { try { vibrate(12); } catch { /* no motor */ } } }
export function nameFor(p: number): string {
  const s = app.session;
  return p === (s ? s.humanSeat : 0) ? T("You") : T("Opponent {n}", { n: p + 1 });
}
export function overlay(): "pause" | "settings" | null { return app.overlays[app.overlays.length - 1] ?? null; }

/** AI pacing on the fixed-step clock (session.js setTimers). */
let clock = 0;
let timerId = 0;
const timers: { id: number; at: number; fn: () => void }[] = [];
Sess.setTimers({
  set: (fn, ms) => { const id = ++timerId; timers.push({ id, at: clock + ms, fn }); return id; },
  clear: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
});
let hidden = false;
/** main.js setAIPaused: the solo AI waits while the pause menu or Settings is open, off the table, or hidden. */
function refreshAI(): void {
  const s = app.session;
  if (!s) return;
  const paused = hidden || app.screen !== "play" || app.overlays.length > 0;
  const was = !!s.aiPaused;
  s.aiPaused = paused;
  if (paused) {
    if (s.aiTimer) { const i = timers.findIndex((t) => t.id === s.aiTimer); if (i >= 0) timers.splice(i, 1); s.aiTimer = null; }
  } else if (was || !s.aiTimer) s.scheduleAI();
}

export function show(screen: Screen, focus: string | null = null): void {
  app.screen = screen;
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  app.railLeft = app.railRight = false;
  ui.setFocus(null);
  refreshAI();
}
export function openOverlay(o: "pause" | "settings"): void {
  if (overlay() === o) return;
  app.overlays.push(o);
  app.openedFrame = frame().frame;
  app.focusNext = o === "pause" ? "btn-resume" : "btn-settings-close";
  ui.setFocus(null);
  refreshAI();
}
export function closeOverlay(): void {
  app.overlays.pop();
  app.openedFrame = frame().frame;
  const top = overlay();
  app.focusNext = top === "pause" ? "btn-resume" : top === "settings" ? "btn-settings-close" : null;
  ui.setFocus(null);
  refreshAI();
}

// ------------------------------------------------------------------ title and mode select
export function progress(): ReturnType<typeof Sess.loadProgress> { return Sess.loadProgress(); }
export function dailyDay(): string { return Content.dailyFor(new Date(platform.nowMs())).day; }
export function showModeSelect(preselect: ModeId | null): void {
  if (preselect !== null) { app.pendingMode = preselect; app.modeDetailFull = false; show("mode", "mode-practice"); }
}
export function pickMode(m: ModeId): void {
  app.pendingMode = m;
  app.modeDetailFull = true;
  audio.play("ui");
}
export function startPendingMode(): void {
  const m = app.pendingMode;
  if (m === "practice") {
    attachSession(Sess.startPractice({
      players: PLAYERS[app.practice.players], targetScore: TARGETS[app.practice.target], aiDifficulty: app.practice.difficulty + 1,
    }));
  } else if (m === "journey") startJourney();
  else if (m === "daily") startDaily();
  else if (m === "challenge") attachSession(Sess.startChallenge(Content.CHALLENGES[app.challenge]?.id ?? "ch_speed"));
  else if (m === "learn") startLearn();
}
export function startJourney(): void { attachSession(Sess.startJourney(progress().journeyUnlocked - 1)); }
export function startDaily(): void { attachSession(Sess.startDaily(platform.nowMs())); }
export function startLearn(): void {
  const seen = app.settings.tutorialSeen || {};
  let idx = Content.LESSONS.findIndex((l) => !seen[l.id]);
  if (idx < 0) idx = 0;
  attachSession(Sess.startLearn(idx));
}
export function goTitle(): void {
  timers.length = 0;
  app.session = null;
  app.overlays = [];
  render.setActive(false);
  show("title", "btn-play");
}

// ------------------------------------------------------------------ the session
function attachSession(session: Session): void {
  timers.length = 0;
  app.session = session;
  app.selection = [];
  app.focusIdx = 0;
  app.overlays = [];
  app.hint = null;
  render.setTheme(session.contentRef?.theme);
  session.on((evt) => onSessionEvent(session, evt));
  render.setActive(true);
  show("play");
  syncAll();
  announce(objectiveText());
  audio.play("deal");
  session.scheduleAI();
}

export function objectiveText(): string {
  const s = app.session;
  if (!s) return "";
  const c = s.contentRef;
  if (s.mode === "learn" && c) return `${T(c.title!)} — ${T(c.text!)}`;
  if (s.mode === "challenge" && c) return `${T(c.title!)}: ${T(c.text!)}`;
  return T("Round {round} — first to {target} points wins the match. Go out with an empty hand to win the round.", { round: s.state.round, target: s.state.targetScore });
}

const REASONS: Record<string, string> = {
  out_of_turn: N("it is not your turn"),
  not_draw_phase: N("you have already drawn this turn"),
  not_act_phase: N("draw a card first"),
  invalid_meld_shape: N("those cards are not a set or a run"),
  cards_not_in_hand: N("card not in your hand"),
  card_not_in_hand: N("card not in your hand"),
  invalid_layoff: N("that card does not extend the meld"),
  no_such_meld: N("no such meld"),
  deck_empty: N("the deck is empty"),
  discard_empty: N("the discard pile is empty"),
  terminal_roundOver: N("the round has ended"),
  terminal_matchOver: N("the match has ended"),
};
function reasonText(r: string): string { return REASONS[r] ? T(REASONS[r]!) : r; }

function onSessionEvent(s: Session, evt: SessionEvent): void {
  if (s !== app.session) return;
  if (evt.type === "invalid") {
    audio.play("invalid");
    announce(T("Action rejected: {reason}", { reason: reasonText(evt.reason ?? "") }), true);
    return;
  }
  if (evt.type === "lessonComplete") {
    const seen = { ...(app.settings.tutorialSeen || {}) };
    seen[s.contentRef!.id] = true;
    app.settings.tutorialSeen = seen;
    Sess.saveSettings(app.settings);
    announce(T("Lesson complete! Finish the round or start the next lesson."));
    audio.play("achievement");
  }
  if (evt.type === "state") {
    for (const e of evt.events || []) {
      if (e.type === "draw") audio.play("draw");
      else if (e.type === "meld") { audio.play("meld"); render.burst(32); }
      else if (e.type === "layoff") audio.play("layoff");
      else if (e.type === "discard") audio.play("discard");
    }
    if (s.state.turn === s.humanSeat && s.state.phase === "draw" && (!evt.command || evt.command.type === "discard")) {
      audio.play("turn");
      announce(T("Your turn. Draw a card."));
    }
    app.selection = app.selection.filter((c) => s.state.hands[s.humanSeat]!.cards.includes(c));
    syncAll();
    // adaptive music rises with table size
    audio.setMusicIntensity(Math.min(1, s.state.table.length / 6));
  }
  if (evt.type === "roundOver" || evt.type === "matchOver") {
    const p = Sess.loadProgress();
    const unlocked = Sess.applyResultToProgress(p, s);
    Sess.saveProgress(p);
    for (let i = 0; i < unlocked.length; i++) audio.play("achievement");
    showResults(unlocked);
  }
}

/** The table follows the state and the selection (ui.js syncAll's render request). */
export function syncAll(): void {
  const s = app.session;
  if (!s) return;
  const n = s.state.hands[s.humanSeat]!.cards.length;
  app.focusIdx = Math.max(0, Math.min(n - 1, app.focusIdx));
  render.sync(s.state, app.selection);
}

// ------------------------------------------------------------------ actions
export function legal(): ReturnType<Session["legal"]> { return app.session ? app.session.legal() : []; }
export function doDraw(source: "deck" | "discard"): void { app.session?.command({ type: "draw", source }); haptic(); }
export function doMeld(): void {
  if (app.selection.length >= 3) app.session?.command({ type: "meld", cards: app.selection.slice() });
  haptic();
}
export function doLayoff(meld?: number): void {
  const s = app.session;
  if (!s || app.selection.length !== 1) return;
  const card = app.selection[0]!;
  if (meld !== undefined) { s.command({ type: "layoff", card, meld }); return; }
  const l = s.legal().filter((a) => a.type === "layoff" && a.card === card);
  if (l.length) s.command({ type: "layoff", card, meld: (l[0] as { meld: number }).meld });
  haptic();
}
export function doDiscard(): void {
  if (app.selection.length === 1) app.session?.command({ type: "discard", card: app.selection[0]! });
  haptic();
}
export function doUndo(): void { app.session?.undo(); }
export function doHint(): void {
  const l = legal();
  if (!l.length) return;
  const a = l.find((x) => x.type === "meld") || l.find((x) => x.type === "layoff") || l[0]!;
  let msg: () => string;
  if (a.type === "draw") msg = a.source === "deck" ? () => T("Hint: draw from the deck.") : () => T("Hint: draw from the discard pile.");
  else if (a.type === "meld") {
    const cards = a.cards.map(Rules.cardName).join(", ");
    msg = Rules.meldKind(a.cards) === "set" ? () => T("Hint: meld {cards} (set).", { cards }) : () => T("Hint: meld {cards} (run).", { cards });
  } else if (a.type === "layoff") msg = () => T("Hint: lay {card} onto meld {n}.", { card: Rules.cardName(a.card), n: a.meld });
  else msg = () => T("Hint: discard {card}.", { card: Rules.cardName(a.card) });
  announce(msg());
  app.hint = { text: msg, until: now() + 5 };
  audio.play("hint");
}
export function toggleCard(cardId: number): void {
  const i = app.selection.indexOf(cardId);
  if (i >= 0) app.selection.splice(i, 1); else app.selection.push(cardId);
  audio.play("select");
  haptic();
  syncAll();
}
export function resetCamera(): void { render.resetCamera(); }
export function togglePause(): void { if (overlay() === "pause") closeOverlay(); else openOverlay("pause"); }
export function leaveMatch(): void { goTitle(); }

// ------------------------------------------------------------------ results
function showResults(unlocked: string[]): void {
  const s = app.session!;
  const r = s.resultSummary!;
  app.lastUnlocked = unlocked;
  app.overlays = [];
  showDailyBoard();
  postToLeaderboard();
  show("results", "btn-results-next");
  audio.play(r.phase === "matchOver" && r.matchWinner === s.humanSeat ? "matchWin" : r.humanWon ? "roundWin" : "roundLose");
  announce(resultsHeadline());
}
export function resultsHeadline(): string {
  const s = app.session!;
  const r = s.resultSummary!;
  const b = r.breakdown;
  return r.humanWon
    ? T("You took the round! {points} points from deadwood.", { points: b.pointsAwarded })
    : (r.phase === "matchOver" && r.matchWinner !== s.humanSeat ? T("{name} wins the match.", { name: nameFor(r.matchWinner!) })
      : T("{name} went out and scored {points}.", { name: nameFor(b.winner), points: b.pointsAwarded }));
}
/** Signed in only: a finished match (not a lesson) posts the human's match total once; the line shows the rank. */
function postToLeaderboard(): void {
  app.lb = null;
  const s = app.session;
  if (!s || !s.resultSummary || s.resultSummary.phase !== "matchOver" || s.mode === "learn" || !platform.signedIn()) return;
  app.lb = "posting";
  void platform.postScore(s.state.scores[s.humanSeat]!).then((r) => { if (app.session === s) app.lb = r; });
}
export function leaderboardLine(): string | null {
  const r = app.lb;
  if (!r) return null;
  if (r === "posting") return S("lbPosting");
  return !r.posted ? S("lbNotPosted") : r.rank ? S("lbRank", { rank: r.rank }) : S("lbPosted");
}
/** Daily is the ranked mode: the shared board read-only when the platform has one. */
function showDailyBoard(): void {
  app.dailyEntries = undefined;
  const s = app.session;
  if (!s || s.mode !== "daily" || !platform.signedIn()) return;
  void platform.topScores().then((rows) => { if (app.session === s) app.dailyEntries = rows; });
}
export function resultsNext(): void {
  const s = app.session;
  if (!s) return;
  if (s.state.phase === "roundOver") {
    s.nextRound();
    app.selection = [];
    show("play");
    syncAll();
    audio.play("deal");
  } else if (s.mode === "journey" && s.resultSummary && s.resultSummary.matchWinner === s.humanSeat) {
    attachSession(Sess.startJourney(Math.min(Content.STAGES.length - 1, (s.contentRef!.index ?? 0) + 1)));
  } else {
    attachSession(Sess.startPractice({ players: s.state.players, targetScore: s.state.targetScore }));
  }
}
export function replayLast(): void {
  const s = app.session;
  if (!s || !s.resultSummary || !s.resultSummary.replay) return;
  const v = Rules.verifyReplay(s.resultSummary.replay);
  const text = v.ok ? T("Replay verified: identical final state.") : T("Replay mismatch: {reason}", { reason: v.reason ?? "" });
  announce(text);
  toast(() => (v.ok ? T("Replay verified: identical final state.") : T("Replay mismatch: {reason}", { reason: v.reason ?? "" })));
}

// ------------------------------------------------------------------ help, account
export function showHelp(from: "title" | "play"): void {
  app.helpReturn = from;
  app.overlays = [];
  show("help", "btn-help-back");
}
export function helpBack(): void {
  if (app.helpReturn === "play" && app.session) show("play");
  else show("title", "btn-play");
}
export function copyInvite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  audio.play("ui");
  try { clipboard.writeText(link); toast(() => S("copied")); } catch { toast(() => S("copyFailed")); }
}
export function signIn(): void { void requestSignIn().catch(() => undefined); }

// ------------------------------------------------------------------ keys and pads (ui.js onKey)
const fresh = (): boolean => frame().frame !== app.openedFrame;
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  const a = e.action;
  if (app.screen !== "play" || !app.session || overlay()) {
    if (a === "cancel" && fresh()) {
      if (overlay()) closeOverlay();
      else if (app.screen === "help") helpBack();
      else if (app.screen === "mode") show("title", "btn-play");
    }
    return;
  }
  const s = app.session;
  const hand = s.state.hands[s.humanSeat]!;
  if (a === "cancel") {
    if (!fresh()) return;
    if (app.selection.length) { app.selection = []; syncAll(); } else openOverlay("pause");
    return;
  }
  if (a === "pause") { if (fresh()) openOverlay("pause"); return; }
  if (s.isOver()) return;
  // Enter and Space on a focused widget are its own (ui.js: the focused button's click); the arrows always walk the hand.
  const uiKeys = ui.focused() !== null;
  if (a === "left" || a === "right") {
    app.focusIdx = a === "left" ? Math.max(0, app.focusIdx - 1) : Math.min(hand.cards.length - 1, app.focusIdx + 1);
    app.focusNext = `card-${app.focusIdx}`;
    app.openedFrame = frame().frame;
  } else if (a === "confirm") {
    if (uiKeys) return;
    if (hand.cards[app.focusIdx] !== undefined) toggleCard(hand.cards[app.focusIdx]!);
  } else if (a === "draw_deck") doDraw("deck");
  else if (a === "draw_discard") doDraw("discard");
  else if (a === "meld") doMeld();
  else if (a === "layoff") doLayoff();
  else if (a === "discard") doDiscard();
  else if (a === "undo") doUndo();
  else if (a === "hint") doHint();
  else if (a === "camera_reset") resetCamera();
});

// ------------------------------------------------------------------ taps on the table (main.js canvas pointer)
/** Rectangles (window pixels) where a press belongs to the UI, set by screens.ts each frame. */
export const hudRects: { x: number; y: number; width: number; height: number }[] = [];
const onHud = (x: number, y: number): boolean => hudRects.some((r) => x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height);
type PEvent = { down: boolean; x: number; y: number; id: number };
const events: PEvent[] = [];
let lastTouch = -1e9;
let downAt: { x: number; y: number; t: number; id: number } | null = null;
onTouch((e) => {
  lastTouch = now();
  if (e.control) return;
  if (e.phase === "start") events.push({ down: true, x: e.x, y: e.y, id: e.id });
  else if (e.phase === "end") events.push({ down: false, x: e.x, y: e.y, id: e.id });
  else if (e.phase === "cancel" && downAt && downAt.id === e.id) downAt = null;
});
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  events.push({ down: e.pressed, x: e.x, y: e.y, id: -1 });
});
/** Decided once the frame's UI is built (presses on the HUD, tray, hand and menus are theirs). */
function pointerInput(): void {
  for (const ev of events.splice(0)) {
    const live = app.screen === "play" && !overlay() && !!app.session;
    if (ev.down) {
      downAt = live && !onHud(ev.x, ev.y) ? { x: ev.x, y: ev.y, t: now(), id: ev.id } : null;
      continue;
    }
    const d = downAt;
    downAt = null;
    if (!d || d.id !== ev.id || !live) continue;
    // a drag or a long press is a gesture, not a tap
    if (Math.hypot(ev.x - d.x, ev.y - d.y) > 12 * frame().scale || now() - d.t > 0.6) continue;
    const hit = render.pick(ev.x, ev.y);
    if (!hit) continue;
    ui.setFocus(null);
    if (hit.zone === "deck") doDraw("deck");
    else if (hit.zone === "discardPile") doDraw("discard");
    else if (hit.zone === "hand" && hit.cardId !== undefined) toggleCard(hit.cardId);
    else if (hit.zone === "meldTarget" && app.selection.length === 1) app.session!.command({ type: "layoff", card: app.selection[0]!, meld: hit.index });
  }
}

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  app.settings = Sess.loadSettings();
  audio.loadSfx();
  audio.onCaption((key) => { if (app.settings.captions) app.caption = { key, until: now() + 1.8 }; });
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  render.setActive(false);
  show("title", "btn-play");
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onOptionsChange(() => { if (app.settings) app.settings = Sess.loadSettings(); });
onSessionEnded(() => toast(() => S("signedOut"))); // keep playing locally
onSuspend(() => { hidden = true; refreshAI(); platform.flush(); });
onResume(() => { hidden = false; refreshAI(); });

onFixedUpdate(() => {
  clock += 1000 / 60;
  for (let i = 0; i < timers.length; i++) {
    const t = timers[i]!;
    if (t.at <= clock) { timers.splice(i, 1); i--; t.fn(); }
  }
});

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyTokens(ui.preferences().highContrast, app.settings.colorPalette);
  audio.update();
  const t = now();
  if (app.caption && app.caption.until < t) app.caption = null;
  if (app.toast && app.toast.until < t) app.toast = null;
  if (app.hint && app.hint.until < t) app.hint = null;
  platform.flushWrites();
});
/** The window band the table is framed in (window px), set by screens.ts. */
export const view = { top: 0, bottom: 0, right: 0 };
const pending: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built (state changes mid-build would break later widgets). */
export function later(fn: () => void): void { pending.push(fn); }
onRender(() => {
  hudRects.length = 0;
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  pointerInput();
  const f = frame();
  render.update(frameDt, f.width, f.height, view);
});
