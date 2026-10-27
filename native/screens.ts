// The browser build's DOM shell (index.html + src/ui.js) as starhermit:ui,
// built every frame over the table: the title over the hall key art (Play,
// Daily Challenge with the day, Journey with the stages unlocked, Learn, How
// to Play, Settings, Sign in / Invite, the profile line), the mode select
// (the five modes, their description, the Practice options and the Challenge
// pick), the play screen (the HUD: objective, turn, deck, scores, the rail
// toggles and Pause; the Objective / Progress and Table / Scores rails; the
// action tray with its keys; the hand as paper card buttons; the hint and
// caption lines), the pause menu and Settings as dialogs, How to Play (the
// rule cards and the effective keys), the results (the still, the headline,
// the score table, achievements, the leaderboard line, the Daily's board,
// Leave / Replay / Next) and the account toast.
// The old media queries are layouts picked by the window's logical size: wide
// (≥ 1024 px: both rails beside the table), compact (the rails as sheets the
// ☰ and ⋯ toggles open above the tray) and short landscape (≤ 500 px tall: a
// one-line HUD, the tray as a two-column block on the right, the hand under
// the table). The table is framed in the band the HUD, tray and hand leave
// (main.ts view → render.ts).
import { frame, openMenu } from "starhermit:engine";
import { bindings, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { Content, Rules, Store } from "./classic.ts";
import { N, S, T } from "./i18n.ts";
import * as audio from "./audio.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  DIFFICULTIES, PLAYERS, TARGETS, app, closeOverlay, copyInvite, dailyDay, doDiscard, doDraw, doHint, doLayoff, doMeld, doUndo,
  helpBack, hudRects, later, leaderboardLine, leaveMatch, legal, nameFor, objectiveText, openOverlay, overlay, pickMode, progress,
  replayLast, resultsHeadline, resultsNext, show, showHelp, showModeSelect, signIn, startDaily, startJourney, startLearn,
  startPendingMode, toggleCard, view, type ModeId,
} from "./main.ts";
import { styleOf, token } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; wide: boolean; short: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, wide: lw >= 1024, short: lh <= 500 && lw > lh && lw < 1024 };
}
const lastSize = new Map<string, number>();
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
const fresh = (): boolean => frame().frame !== app.openedFrame;
interface Btn { id: string; text: string; style?: string; act: () => void; disabled?: boolean; selected?: boolean; key?: string }
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + 4;
/** A button `width` wide (null: its text's); a label too long for it wraps inside; `key` shows the key hint (index.html <kbd>). */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  const s: ui.Style = width != null ? { width } : {};
  if (b.key) {
    opts.content = () => ui.row(`${b.id}-face`, () => {
      ui.label(b.text);
      ui.style("small-muted").label(b.key!);
    }, { spacing: 6, align: "center" });
  } else if (width != null && buttonWidth(b.text, style) > width) {
    const inner = Math.max(20, width - 34);
    opts.content = () => { ui.style({ text: { align: "center" } }).paragraph(b.text, inner); };
  }
  if (ui.style(style, s).id(b.id).button(b.text, opts) && fresh()) later(b.act);
}
/** One full-width button a line (index.html .menu-grid). */
function stack(label: string, list: Btn[], width: number): ui.Rect {
  return ui.column(label, () => { for (const b of list) button(b, width); }, { spacing: 12, width });
}
/** index.html .row: buttons at their own widths in rows that wrap at `width`. */
function flow(label: string, list: Btn[], width: number, gap = 10, justify: "start" | "center" | "end" = "start"): ui.Rect {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, buttonWidth(b.key ? `${b.text} ${b.key}` : b.text, b.style ?? "btn") + (b.key ? 10 : 0));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  return ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, bw(b) >= width ? width : null);
    }, { spacing: gap, width, justify }));
  }, { spacing: gap, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "body", id?: string): void {
  if (!text) return;
  let u = ui.style(cls);
  if (id) u = u.id(id);
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, width);
}
function heading(cls: string, text: string, width: number, id?: string): void {
  if (textWidth(text, cls, "heading") <= width) (id ? ui.id(id) : ui).style(cls).heading(text);
  else ui.style(cls).paragraph(text, width);
}
function badge(id: string, text: string): ui.Rect {
  return ui.column(id, () => ui.style("badge-text").id(`${id}-t`).label(text), { style: "badge", align: "center" });
}
function rect(r: ui.Rect): void { hudRects.push({ x: r.x, y: r.y, width: r.width, height: r.height }); }

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  view.top = 0; view.bottom = 0; view.right = 0;
  switch (app.screen) {
    case "title": titleBackdrop(); page("title", L, titleScreen); break;
    case "mode": backdrop("title-plain"); page("mode", L, modeScreen); break;
    case "help": backdrop(app.session ? "wash" : "title-plain"); page("help", L, helpScreen, 760); break;
    case "results": backdrop("wash"); page("results", L, resultsScreen); break;
    case "play": playScreen(L); break;
  }
  overlays(L);
  bottomLines(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

/** A full-window box in a class: a placed widget, so it covers what was built before it. */
function backdrop(cls: string | ui.Style): void {
  const f = frame(), sc = ui.preferences().scale;
  ui.place(`backdrop`, { anchor: "top-start", x: -f.safeArea.left / sc, y: -f.safeArea.top / sc }, () => {
    ui.widget("", { role: "none", size: { width: f.width / sc, height: f.height / sc }, draw: () => draw.box(0, 0, f.width, f.height, cls) });
  });
}
/** The title's key art, and on detailed looks the slow warm lamp glow breathing over it (static under reduced motion). */
function titleBackdrop(): void {
  const hc = ui.preferences().highContrast;
  const f = frame(), sc = ui.preferences().scale;
  const detailed = f.quality !== "low";
  const glow = !hc && detailed;
  const t = ui.preferences().reducedMotion ? 1 : 0.775 + 0.225 * Math.sin((f.time / 7) * Math.PI);
  ui.place(`backdrop`, { anchor: "top-start", x: -f.safeArea.left / sc, y: -f.safeArea.top / sc }, () => {
    ui.widget("", {
      role: "none", size: { width: f.width / sc, height: f.height / sc }, draw: () => {
        draw.box(0, 0, f.width, f.height, hc ? "title-plain" : "title-art");
        if (glow) draw.box(0, 0, f.width, f.height, { ...styleOf("lamp-glow"), opacity: t });
      },
    });
  });
}
/** A panel (index.html .panel): centred, at most `width` px wide, scrolling inside when taller than the window. */
function page(key: string, L: Layout, build: (w: number, L: Layout) => void, width = 680): void {
  const pad = L.lw < 420 ? 16 : 20;
  const outer = Math.min(width, L.lw - 32);
  const avail = Math.max(80, L.lh - 32);
  const h = lastSize.get(key) ?? 0;
  const scroll = h > avail;
  const inner = outer - 2 * pad - 2 - (scroll ? 14 : 0);
  const opening = frame().frame - app.openedFrame <= 5;
  ui.place(`page-${key}`, "center", () => {
    const body = (): void => {
      const r = ui.column(`${key}-col`, () => build(inner, L), { style: "panel", width: outer - (scroll ? 14 : 0), spacing: 14, padding: pad });
      lastSize.set(key, r.height / L.sc);
    };
    if (scroll) ui.scrollArea(`${key}-scroll`, { width: outer, height: avail }, body, opening ? { scrollTo: { top: 0 } } : undefined);
    else body();
  });
}

// ------------------------------------------------------------------ title and mode select
function profileLine(): string {
  if (!platform.signedIn()) return T("Guest profile — progress is saved on this device.");
  const st = platform.syncState();
  const status = st === "syncing" ? T("syncing…") : st === "saving" ? T("saving…") : st === "offline" ? T("offline — saved on this device")
    : st === "synced" ? T("synced to your account") : T("saved on this device");
  return T("Playing as {name} — progress {status}.", { name: platform.displayName() || T("Player"), status });
}
function badgeButton(b: Btn, extra: string, w: number): void {
  const opts: ui.ButtonOptions = {
    content: () => ui.row(`${b.id}-face`, () => { ui.label(b.text); badge(`${b.id}-badge`, extra); }, { spacing: 12, align: "center" }),
  };
  if (ui.style("btn", { width: w }).id(b.id).button(`${b.text} ${extra}`, opts) && fresh()) later(b.act);
}
function titleScreen(w: number): void {
  ui.column("title-head", () => {
    heading("title", "Meld Hall", w, "title-h");
    para(T("Draw, meld sets and runs, lay off, discard — keep your deadwood low."), w, "muted-center", "tagline");
  }, { spacing: 10, width: w, align: "center" });
  ui.column("title-menu", () => {
    button({ id: "btn-play", text: T("Play"), style: "btn-primary", act: () => showModeSelect("practice") }, w);
    badgeButton({ id: "btn-daily", text: T("Daily Challenge"), act: startDaily }, dailyDay(), w);
    badgeButton({ id: "btn-journey", text: T("Journey"), act: startJourney }, `${progress().journeyUnlocked}/${Content.STAGES.length}`, w);
    button({ id: "btn-learn", text: T("Learn"), act: () => { app.pendingMode = "learn"; startLearn(); } }, w);
    button({ id: "btn-help", text: T("How to Play"), act: () => showHelp("title") }, w);
    button({ id: "btn-settings", text: T("Settings"), act: () => openOverlay("settings") }, w);
    if (!platform.signedIn()) button({ id: "btn-signin", text: S("signIn"), act: signIn }, w);
    if (platform.inviteLink()) button({ id: "btn-invite", text: S("invite"), act: copyInvite }, w);
  }, { spacing: 12, width: w });
  ui.column("title-foot", () => para(profileLine(), w, "muted-center", "profile-line"), { width: w, align: "center" });
}

const MODES: { id: ModeId; name: string; desc: string; ranked: boolean; minutes: string }[] = [
  { id: "practice", name: N("Practice"), desc: N("Custom game vs the hall AI. Undo allowed, unranked."), ranked: false, minutes: "5–10" },
  { id: "journey", name: N("Journey"), desc: N("Forty authored stages, one new idea at a time, mastery every fifth."), ranked: false, minutes: "5–15" },
  { id: "daily", name: N("Daily"), desc: N("One shared seed and ruleset per UTC day. Ranked."), ranked: true, minutes: "10" },
  { id: "challenge", name: N("Challenge"), desc: N("Constrained goals: turn limits, deadwood targets, crowded tables."), ranked: false, minutes: "5–10" },
  { id: "learn", name: N("Learn"), desc: N("Interactive lessons. One rule at a time; you perform each action."), ranked: false, minutes: "2" },
];
function modeDetail(m: (typeof MODES)[number]): string {
  return `${T(m.desc)} ${T("Expected duration: {minutes} min.", { minutes: m.minutes })} ${m.ranked ? T("This result is ranked.") : T("Not ranked.")}`;
}
/** A labelled select (index.html .field). */
function field(id: string, label: string, idx: number, options: string[], w: number, set: (i: number) => void): void {
  ui.column(`${id}-field`, () => {
    para(label, w, "body", `${id}-label`);
    const pick = ui.id(id).select(label, idx, options, { width: w } as ui.WidgetOptions);
    if (pick !== idx) later(() => { set(pick); audio.play("ui"); });
  }, { spacing: 4, width: w });
}
function modeScreen(w: number, L: Layout): void {
  heading("h2", T("Choose a mode"), w, "mode-h");
  // one mode a line; on a short window (phone landscape) a wrapping row, so Start stays in view
  const modeBtn = (m: (typeof MODES)[number], bw?: number): void => {
    if (ui.style("mode-pick", bw ? { width: bw } : {}).id(`mode-${m.id}`).button(T(m.name), { selected: app.pendingMode === m.id }) && fresh()) later(() => pickMode(m.id));
  };
  if (L.short) {
    const rows: (typeof MODES)[number][][] = [[]];
    let used = 0;
    for (const m of MODES) {
      const bw = buttonWidth(T(m.name), "mode-pick");
      if (rows[rows.length - 1]!.length && used + 10 + bw > w) { rows.push([]); used = 0; }
      used += (rows[rows.length - 1]!.length ? 10 : 0) + bw;
      rows[rows.length - 1]!.push(m);
    }
    ui.column("mode-list", () => rows.forEach((r, i) => ui.row(`mode-r${i}`, () => r.forEach((m) => modeBtn(m)), { spacing: 10 })), { spacing: 10, width: w });
  } else ui.column("mode-list", () => { for (const m of MODES) modeBtn(m, w); }, { spacing: 12, width: w });
  const cur = MODES.find((m) => m.id === app.pendingMode)!;
  para(app.modeDetailFull ? modeDetail(cur) : T(cur.desc), w, "muted", "mode-detail");
  if (app.pendingMode === "practice") {
    const cols = w >= 480 ? 3 : 1;
    const fw = cols === 3 ? (w - 24) / 3 : w;
    const fields = (): void => {
      field("opt-players", T("Players"), app.practice.players, PLAYERS.map(String), fw, (i) => { app.practice.players = i; });
      field("opt-target", T("Target score"), app.practice.target, TARGETS.map(String), fw, (i) => { app.practice.target = i; });
      field("opt-difficulty", T("AI difficulty"), app.practice.difficulty, DIFFICULTIES.map((d) => T(d)), fw, (i) => { app.practice.difficulty = i; });
    };
    if (cols === 3) ui.row("mode-options", fields, { spacing: 12, width: w });
    else ui.column("mode-options", fields, { spacing: 12, width: w });
  }
  if (app.pendingMode === "challenge") {
    field("opt-challenge", T("Challenge"), app.challenge, Content.CHALLENGES.map((c) => T(c.title)), w, (i) => { app.challenge = i; });
  }
  ui.row("mode-btns", () => {
    button({ id: "btn-mode-back", text: T("Back"), act: () => show("title", "btn-play") });
    ui.spacer();
    button({ id: "btn-mode-start", text: T("Start"), style: "btn-primary", act: startPendingMode });
  }, { width: w, align: "center" });
}

// ------------------------------------------------------------------ how to play
const KEY_GLYPHS: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc" };
/** The effective keys of an action, e.g. "Enter/Space" (ui.js keyText). */
export function keysFor(action: string): string {
  let list: string[] = [];
  try { list = bindings(action).filter((b) => b.device === "keyboard").map((b) => KEY_GLYPHS[b.label] ?? b.label); } catch { /* not yet */ }
  return [...new Set(list)].join("/") || "—";
}
const RULE_CARDS: [string, string][] = [
  [N("Draw"), N("Start each turn by taking the deck top card or the face-up discard.")],
  [N("Meld"), N("A <strong>set</strong> is 3–4 cards of one rank. A <strong>run</strong> is 3+ consecutive cards of one suit. Melded cards leave your hand and score safety.")],
  [N("Lay off"), N("Extend any table meld with a matching card from your hand.")],
  [N("Discard & deadwood"), N("End your turn with one discard. When a player empties their hand, everyone else’s remaining cards (deadwood) become the winner’s points.")],
];
function helpScreen(w: number): void {
  heading("h2", T("How to play"), w, "help-h");
  const cols = w >= 560 ? 2 : 1;
  const cw = cols === 2 ? (w - 12) / 2 : w;
  ui.column("help-rules", () => {
    for (let r = 0; r < RULE_CARDS.length; r += cols) {
      ui.row(`rules-r${r}`, () => {
        for (const [title, body] of RULE_CARDS.slice(r, r + cols)) {
          ui.column(`rule-${title}`, () => {
            heading("h3", T(title), cw - 34);
            para(T(body).replace(/<[^>]+>/g, ""), cw - 34, "body");
          }, { style: "rule-card", width: cw, spacing: 8 });
        }
      }, { spacing: 12, width: w, align: "stretch" });
    }
  }, { spacing: 12, width: w });
  heading("h3", T("Controls"), w, "controls-h");
  const k = keysFor;
  const lines = [
    T("Move between cards: {keys}", { keys: `${k("left")} ${k("right")}` }),
    T("Select card: {select} · Draw deck: {deck} · Take discard: {discard}", { select: k("confirm"), deck: k("draw_deck"), discard: k("draw_discard") }),
    T("Meld selection: {meld} · Lay off: {layoff} · Discard: {discard}", { meld: k("meld"), layoff: k("layoff"), discard: k("discard") }),
    T("Undo (practice): {undo} · Hint: {hint} · Pause: {pause} · Camera reset: {camera} · Cancel: {cancel}", { undo: k("undo"), hint: k("hint"), pause: k("pause"), camera: k("camera_reset"), cancel: k("cancel") }),
    T("Pointer/touch: tap cards to select, tap deck or discard pile to draw, tap a meld marker to lay off."),
    T("Gamepad: D-pad moves between cards, A selects, X draws from the deck, Y takes the discard, LB melds, RB discards, LT lays off, RT hints, View undoes, B cancels, Menu pauses."),
  ];
  ui.column("help-controls", () => lines.forEach((l, i) => para(`• ${l}`, w, "body", `ctl-${i}`)), { spacing: 6, width: w });
  button({ id: "btn-help-back", text: T("Back"), act: helpBack });
}

// ------------------------------------------------------------------ the play screen
const CARD = { w: 52, h: 72, gap: 6 };
const CARD_SHORT = { w: 44, h: 60, gap: 4 };
function playScreen(L: Layout): void {
  const s = app.session;
  if (!s) return;
  const f = frame(), sc = L.sc, sa = f.safeArea;
  const live = !overlay();
  const st = s.state;
  const hand = st.hands[s.humanSeat]!;
  const lg = live ? legal() : [];
  const sel = app.selection;

  // ---- HUD (index.html #hud-top), inside the screen's 16 px padding and its own 4 px margin
  const M = L.short ? 10 : 20;
  const hudW = L.lw - 2 * M;
  const turn = st.phase === "matchOver" ? T("Match over") : st.phase === "roundOver" ? T("Round over")
    : st.turn === s.humanSeat ? (st.phase === "draw" ? T("Your turn — draw") : T("Your turn — meld / discard"))
    : T("{name} is thinking…", { name: nameFor(st.turn) });
  const rival = Math.max(0, ...st.scores.filter((_, i) => i !== s.humanSeat));
  const score = T("You {you} — best rival {rival}", { you: st.scores[s.humanSeat]!, rival });
  const hudBtns = (): void => {
    const toggle = (side: "left" | "right") => () => { if (side === "left") { app.railLeft = !app.railLeft; app.railRight = false; } else { app.railRight = !app.railRight; app.railLeft = false; } };
    glyphButton("btn-rail-left", T("Progress panel"), "☰", toggle("left"), live);
    glyphButton("btn-pause", T("Pause"), "⏸", () => openOverlay("pause"), live);
    glyphButton("btn-rail-right", T("Status panel"), "⋯", toggle("right"), live);
  };
  const hud = ui.place("hud", { anchor: "top-start", x: M, y: M }, () => {
    ui.column("hud-col", () => {
      if (L.short) {
        ui.row("hud-r1", () => {
          ui.column("hud-left", () => {
            para(objectiveText(), hudW * 0.55, "objective-small", "hud-objective");
            ui.row("hud-badges", () => { badge("hud-turn", turn); badge("hud-deck", T("Deck: {n}", { n: st.deck.length })); }, { spacing: 8 });
          }, { spacing: 3 });
          ui.spacer();
          badge("hud-score", score);
          hudBtns();
        }, { spacing: 8, width: hudW - 24, align: "center" });
      } else {
        const objW = L.wide ? hudW - 24 - textWidth(turn, "badge-text") - textWidth(T("Deck: {n}", { n: st.deck.length }), "badge-text") - 80 : hudW - 24;
        ui.row("hud-r1", () => {
          para(objectiveText(), Math.max(120, objW), "objective", "hud-objective");
          if (L.wide) { badge("hud-turn", turn); badge("hud-deck", T("Deck: {n}", { n: st.deck.length })); }
        }, { spacing: 12, width: hudW - 24, align: "center" });
        if (!L.wide) {
          // the badges wrap as the old flex row did: the turn and the deck, then the score with the buttons
          const deckText = T("Deck: {n}", { n: st.deck.length });
          const fits = textWidth(turn, "badge-text") + textWidth(deckText, "badge-text") + 58 <= hudW - 24;
          ui.row("hud-r2", () => { badge("hud-turn", turn); if (fits) badge("hud-deck", deckText); }, { spacing: 10, width: hudW - 24, align: "center" });
          ui.row("hud-r3", () => { if (!fits) badge("hud-deck", deckText); badge("hud-score", score); hudBtns(); }, { spacing: 10, width: hudW - 24, align: "center" });
        } else {
          ui.row("hud-r2", () => { badge("hud-score", score); hudBtns(); }, { spacing: 10, width: hudW - 24, align: "center" });
        }
      }
    }, { style: "hud", width: hudW, spacing: 6 });
  });
  rect(hud);
  view.top = hud.y + hud.height - sa.top;

  // ---- the deck and the discard pile on the table, named for screen readers and play scripts (taps reach the table)
  for (const [which, name] of [["deck", T("Deck")], ["discard", T("Discard pile")]] as const) {
    const r = render.pileRect(which, f.width, f.height);
    if (r && live) ui.target(name, r, { role: "button" });
  }

  // ---- the action tray and the hand
  const cs = L.short ? CARD_SHORT : CARD;
  const has = (t: string): boolean => lg.some((a) => a.type === t);
  const meldOk = sel.length >= 3 && lg.some((a) => a.type === "meld" && a.cards.length === sel.length && a.cards.every((c) => sel.includes(c)));
  const layOk = sel.length === 1 && lg.some((a) => a.type === "layoff" && a.card === sel[0]);
  const keyHint = (a: string): string | undefined => (L.short ? undefined : keysFor(a));
  let tray: Btn[] = [
    { id: "act-draw-deck", text: T("Draw deck"), style: "btn-tray", key: keyHint("draw_deck"), disabled: !lg.some((a) => a.type === "draw" && a.source === "deck"), act: () => doDraw("deck") },
    { id: "act-draw-discard", text: T("Take discard"), style: "btn-tray", key: keyHint("draw_discard"), disabled: !lg.some((a) => a.type === "draw" && a.source === "discard"), act: () => doDraw("discard") },
    { id: "act-meld", text: T("Meld"), style: "btn-tray", key: keyHint("meld"), disabled: !meldOk, act: doMeld },
    { id: "act-layoff", text: T("Lay off"), style: "btn-tray", key: keyHint("layoff"), disabled: !layOk, act: () => doLayoff() },
    { id: "act-discard", text: T("Discard"), style: "btn-tray", key: keyHint("discard"), disabled: !(sel.length === 1 && has("discard")), act: doDiscard },
    { id: "act-undo", text: T("Undo"), style: "btn-tray", key: keyHint("undo"), disabled: !live || !s.allowUndo || s.undoStack.length === 0, act: doUndo },
    { id: "act-hint", text: T("Hint"), style: "btn-tray", key: keyHint("hint"), disabled: lg.length === 0, act: doHint },
  ];
  // Left-handed controls: the tray's order mirrored (the old option was stored but changed nothing).
  if (app.settings.leftHanded) tray = tray.slice().reverse();
  if (!live) tray = tray.map((b) => ({ ...b, disabled: true }));

  const handW = L.short ? Math.min(L.lw - 280, L.lw * 0.66) : L.lw - 2 * M;
  const perRow = Math.max(1, Math.floor((handW + cs.gap) / (cs.w + cs.gap)));
  const rows = Math.max(1, Math.ceil(hand.cards.length / perRow));
  const handH = rows * cs.h + (rows - 1) * cs.gap + 12 + (L.short ? 0 : 10);
  const handRect = ui.place("hand", { anchor: L.short ? "bottom-start" : "bottom", x: L.short ? M : 0, y: M - 10 }, () => {
    ui.column("hand-dom", () => {
      for (let r = 0; r < rows; r++) {
        ui.row(`hand-r${r}`, () => {
          for (let i = r * perRow; i < Math.min(hand.cards.length, (r + 1) * perRow); i++) handCard(hand.cards[i]!, i, cs, live);
        }, { spacing: cs.gap });
      }
    }, { spacing: cs.gap, align: "center", padding: { top: L.short ? 6 : 16, bottom: 6, start: 6, end: 6 } });
  });
  rect(handRect);

  let trayRect: ui.Rect;
  if (L.short) {
    // a two-column block on the right, from under the HUD to the bottom
    const tw = Math.min(260, L.lw * 0.32);
    const bw = (tw - 16 - 6) / 2;
    trayRect = ui.place("tray", { anchor: "bottom-end", x: M, y: M }, () => {
      ui.column("action-tray", () => {
        for (let i = 0; i < tray.length; i += 2) {
          ui.row(`tray-r${i}`, () => { for (const b of tray.slice(i, i + 2)) button(b, bw); }, { spacing: 6 });
        }
      }, { style: "tray", width: tw, spacing: 6, padding: 8 });
    });
    view.right = f.width - trayRect.x - sa.right;
    view.bottom = f.height - handRect.y - sa.bottom;
  } else {
    const trayW = L.lw - 2 * M;
    trayRect = ui.place("tray", { anchor: "bottom", y: M - 10 + handH }, () => {
      ui.column("action-tray", () => flow("tray-flow", tray, trayW - 16, 8, "center"), { style: "tray", width: trayW, padding: 8 });
    });
    view.bottom = f.height - Math.min(trayRect.y, handRect.y) - sa.bottom;
  }
  rect(trayRect);
  const bottomEdge = L.short ? handRect.y : trayRect.y;

  // ---- rails (wide) or sheets (compact)
  if (L.wide) {
    const railTop = (hud.y + hud.height - sa.top) / sc + 8;
    const railH = Math.max(80, (bottomEdge - sa.top) / sc - railTop - 8);
    rail("rail-left", "top-start", railTop, railH, (w) => progressRail(w), live);
    rail("rail-right", "top-end", railTop, railH, (w) => statusRail(w, live), live);
  } else if (app.railLeft || app.railRight) {
    const w = L.lw - 16;
    const maxH = Math.max(120, Math.min(L.lh * 0.5, (bottomEdge - hud.y - hud.height) / sc - 16));
    const key = app.railLeft ? "sheet-left" : "sheet-right";
    const scroll = (lastSize.get(key) ?? 0) > maxH;
    const inner = w - 28 - (scroll ? 14 : 0);
    const r = ui.place(key, { anchor: "bottom", y: (f.height - bottomEdge - sa.bottom) / sc + 8 }, () => {
      ui.column(key, () => {
        const body = (): void => {
          const c = ui.column(`${key}-in`, () => (app.railLeft ? progressRail(inner) : statusRail(inner, live)), { spacing: 8, width: inner });
          lastSize.set(key, c.height / sc);
        };
        if (scroll) ui.scrollArea(`${key}-scroll`, { width: w - 28, height: maxH }, body);
        else body();
      }, { style: "sheet", width: w, spacing: 0 });
    });
    rect(r);
  }

  // ---- the hint line above the tray
  if (app.hint) {
    const text = app.hint.text();
    const w = Math.min(L.lw * 0.92, 640);
    ui.place("hint-line", { anchor: "bottom", y: (f.height - bottomEdge - sa.bottom) / sc + 8 + (app.caption ? 44 : 0) }, () =>
      ui.column("hint-col", () => para(text, w - 28, "caption-text", "hint-text"), { style: "caption", align: "center" }));
  }
  bottomBand = (f.height - bottomEdge - sa.bottom) / sc;
}
let bottomBand = 0;

function glyphButton(id: string, name: string, glyph: string, act: () => void, live: boolean): void {
  const opts: ui.ButtonOptions = { content: () => ui.label(glyph) };
  if (!live) opts.disabled = true;
  if (ui.style("btn").id(id).button(name, opts) && fresh()) later(act);
}
/** index.html .card-btn: the hand's card as a paper button (rank over suit), lifted and ringed when selected. */
function handCard(c: number, i: number, cs: typeof CARD, live: boolean): void {
  const selected = app.selection.includes(c);
  const suit = Rules.suitOf(c);
  const red = suit === 1 || suit === 2;
  const hc = ui.preferences().highContrast;
  const color = token(red ? "red-suit" : "black-suit", false, app.settings.colorPalette);
  const rank = Rules.RANKS[Rules.rankOf(c)]!, glyph = Rules.SUIT_GLYPHS[suit]!;
  const label = T("{card}, value {value}", { card: Rules.cardName(c), value: Rules.cardValue(c) });
  const res = ui.id(`card-${i}`).widget(label, {
    role: "toggle", checked: selected, disabled: !live, size: { width: cs.w, height: cs.h },
    draw: (r, ws) => {
      const lift = selected ? 10 * ws.scale : 0;
      draw.box(r.x, r.y - lift, r.width, r.height, selected ? "card-sel" : "card-face");
      const fs = (cs.h > 64 ? 17 : 15) * ws.scale;
      const ink = hc ? "#000000" : color;
      draw.text(rank, r.x + r.width / 2, r.y - lift + r.height / 2 - fs * 1.05, { size: fs, color: ink, weight: "bold", align: "center" });
      draw.text(glyph, r.x + r.width / 2, r.y - lift + r.height / 2 + fs * 0.05, { size: fs, color: ink, weight: "bold", align: "center" });
    },
  });
  if (res.activated && fresh()) later(() => { app.focusIdx = i; toggleCard(c); });
}
function rail(id: string, anchor: "top-start" | "top-end", top: number, h: number, build: (w: number) => void, _live: boolean): void {
  const w = 252, inner = w - 24;
  const scroll = (lastSize.get(id) ?? 0) > h - 24;
  const r = ui.place(id, { anchor, x: 20, y: top }, () => {
    ui.column(id, () => {
      const body = (): void => {
        const c = ui.column(`${id}-in`, () => build(inner - (scroll ? 14 : 0)), { spacing: 8, width: inner - (scroll ? 14 : 0) });
        lastSize.set(id, c.height / ui.preferences().scale);
      };
      if (scroll) ui.scrollArea(`${id}-scroll`, { width: inner, height: h - 24 }, body);
      else body();
    }, { style: "rail", width: w, spacing: 0 });
  });
  rect(r);
}
/** index.html #rail-left: the objective and progress. */
function progressRail(w: number): void {
  const s = app.session!, st = s.state;
  heading("rail-h", T("Objective").toUpperCase(), w);
  para(objectiveText(), w, "body", "rail-objective");
  heading("rail-h", T("Progress").toUpperCase(), w);
  para(T("Round {round} · deadwood in hand: {deadwood} · table melds: {melds}", { round: st.round, deadwood: Rules.deadwood(st.hands[s.humanSeat]!), melds: st.table.length }), w, "body", "rail-progress");
}
/** index.html #rail-right: the table's melds (a chip lays the one selected card off onto it) and the scores. */
function statusRail(w: number, live: boolean): void {
  const s = app.session!, st = s.state;
  heading("rail-h", T("Table").toUpperCase(), w);
  st.table.forEach((m, i) => {
    const text = `${m.kind === "set" ? T("Set {n}", { n: i }) : T("Run {n}", { n: i })}: ${m.cards.map(Rules.cardName).join(" ")}`;
    const opts: ui.ButtonOptions = {};
    if (!live) opts.disabled = true;
    if (textWidth(text, "chip", "button") > w) opts.content = () => ui.style({ text: { align: "start" } }).paragraph(text, w - 20);
    if (ui.style("chip", { width: w }).id(`meld-${i}`).button(text, opts) && fresh() && live) {
      later(() => { if (app.selection.length === 1) doLayoff(i); });
    }
  });
  heading("rail-h", T("Scores").toUpperCase(), w);
  for (let p = 0; p < st.players; ++p) {
    para(T("{name}: {score} ({cards} cards)", { name: nameFor(p), score: st.scores[p]!, cards: st.hands[p]!.cards.length }), w, p === s.humanSeat ? "you" : "body", `score-${p}`);
  }
}

// ------------------------------------------------------------------ results
function resultsScreen(w: number, L: Layout): void {
  const s = app.session;
  if (!s || !s.resultSummary) return;
  const r = s.resultSummary, b = r.breakdown;
  // the still is decoration: left out in high contrast and on short windows (phone landscape), where the buttons need the room
  if (!ui.preferences().highContrast && !L.short) ui.column("results-still", () => ui.widget("", { role: "none", size: { width: w, height: Math.min(180, w * 0.36) } }), { style: "results-still", width: w });
  heading("h2", r.phase === "matchOver" ? T("Match over") : T("Round {n} over", { n: b.round }), w, "results-h");
  para(resultsHeadline(), w, "body", "results-headline");
  // the score table
  // columns wide enough for their headings' longest word (no word broken mid-letter)
  const word = (t: string): number => Math.max(...t.split(" ").map((x) => textWidth(x, "cell-head"))) + 24;
  const c2 = Math.max(w * 0.22, word(T("Deadwood"))), c3 = Math.max(w * 0.26, word(T("Match score")), word(T("Score")));
  const c1 = w - c2 - c3;
  const tRow = (id: string, cells: string[], cls: string): void => {
    ui.row(id, () => {
      ui.column(`${id}-a`, () => para(cells[0]!, c1 - 20, cls), { width: c1 });
      ui.column(`${id}-b`, () => para(cells[1]!, c2 - 10, cls), { width: c2 });
      ui.column(`${id}-c`, () => para(cells[2]!, c3 - 20, cls), { width: c3 });
    }, { style: "score-row", width: w, spacing: 0 });
  };
  ui.column("results-table", () => {
    tRow("res-head", [T("Player"), T("Deadwood"), T("Match score")], "cell-head");
    for (let p = 0; p < s.state.players; ++p) {
      tRow(`res-${p}`, [nameFor(p) + (p === b.winner ? " ★" : ""), String(b.deadwood[p]), `${b.totals[p]} / ${s.state.targetScore}`], p === s.humanSeat ? "you-strong" : "cell");
    }
    ui.column("res-reason", () => para(b.reason === "player_out"
      ? T("Reason: a player emptied their hand. Points = sum of opponents’ deadwood.")
      : T("Reason: the deck ran out. Points = sum of opponents’ deadwood minus winner’s own."), w - 20, "muted"), { style: "score-row", width: w });
  }, { spacing: 0, width: w });
  app.lastUnlocked.forEach((k, i) => {
    const a = Content.ACHIEVEMENTS.find((x) => x.key === k);
    if (!a) return;
    ui.row(`ach-${i}`, () => {
      badge(`ach-${i}-b`, T("Achievement"));
      para(`${T(a.title)} — ${T(a.text)}`, w - textWidth(T("Achievement"), "badge-text") - 40, "strong");
    }, { spacing: 8, width: w, align: "center" });
  });
  const lb = leaderboardLine();
  if (lb) para(lb, w, "muted", "results-lb");
  if (s.mode === "daily" && platform.signedIn()) {
    const e = app.dailyEntries;
    if (e === undefined) para(T("Loading daily board…"), w, "muted", "daily-loading");
    else if (e && e.length) {
      heading("h3", T("Leaderboard"), w, "lb-h");
      ui.column("lb-table", () => {
        tRow("lb-head", ["#", T("Player"), T("Score")], "cell-head");
        e.forEach((row, i) => tRow(`lb-${i}`, [String(row.rank), row.name || T("Player"), String(row.score)], "cell"));
      }, { spacing: 0, width: w });
      para(T("Personal bests are kept in your save."), w, "muted");
    }
  }
  ui.row("results-btns", () => {
    button({ id: "btn-results-leave", text: T("Leave"), act: leaveMatch });
    ui.spacer();
    button({ id: "btn-results-replay", text: T("Replay"), act: replayLast });
    button({ id: "btn-results-next", text: r.phase === "roundOver" ? T("Next round") : T("Play again"), style: "btn-primary", act: resultsNext });
  }, { width: w, spacing: 10, align: "center" });
}

// ------------------------------------------------------------------ pause and settings
const PALETTES: [string, string][] = [
  ["default", N("Default")], ["deuteranopia", N("Deuteranopia-safe")], ["protanopia", N("Protanopia-safe")], ["tritanopia", N("Tritanopia-safe")],
];
function overlays(L: Layout): void {
  const o = overlay();
  if (!o) return;
  const w = Math.min(520, L.lw - 32) - 42;
  const label = o === "pause" ? T("Paused") : T("Settings");
  const open = ui.dialog(label, "", true, () => {
    const body = (): void => { ui.column(`${o}-col`, () => (o === "pause" ? pausePanel(w) : settingsPanel(w)), { spacing: 14, width: w }); };
    const h = lastSize.get(o) ?? 0;
    const avail = L.lh - 80;
    if (h > avail) ui.scrollArea(`${o}-scroll`, { width: w + 14, height: avail }, () => {
      const r = ui.column(`${o}-wrap`, body, { width: w });
      lastSize.set(o, r.height / L.sc);
    });
    else { const r = ui.column(`${o}-wrap`, body, { width: w }); lastSize.set(o, r.height / L.sc); }
  });
  // Back / Escape closes the dialog (not on the frame it opened: that press opened it).
  if (!open && fresh()) later(closeOverlay);
}
function pausePanel(w: number): void {
  heading("h2", T("Paused"), w, "pause-h");
  stack("pause-menu", [
    { id: "btn-resume", text: T("Resume"), style: "btn-primary", act: closeOverlay },
    { id: "btn-pause-settings", text: T("Settings"), act: () => openOverlay("settings") },
    { id: "btn-pause-help", text: T("Help"), act: () => showHelp("play") },
    { id: "btn-leave", text: T("Leave match"), style: "btn-danger", act: leaveMatch },
  ], w);
}
function settingsPanel(w: number): void {
  heading("h2", T("Settings"), w, "settings-h");
  para(T("Sound, graphics, language, larger text, high contrast and reduced motion are in the StarHermit Options."), w, "muted", "options-note");
  flow("settings-runtime", [
    { id: "btn-options", text: T("Open Options"), act: () => openMenu() },
    { id: "btn-rebind", text: T("Key bindings"), act: () => requestRebind() },
  ], w);
  heading("h3", T("Accessibility"), w, "access-h");
  const opts = app.settings;
  ui.column("set-checks", () => {
    const check = (key: "captions" | "haptics" | "leftHanded", text: string): void => {
      const cur = !!opts[key];
      const next = ui.id(`set-${key}`).checkbox(T(text), cur);
      if (next !== cur) later(() => { platform.setOption(key, next); audio.play("ui"); });
    };
    check("captions", N("Captions for sounds"));
    check("haptics", N("Haptics"));
    check("leftHanded", N("Left-handed controls"));
  }, { spacing: 4, width: w });
  const idx = Math.max(0, PALETTES.findIndex(([id]) => id === opts.colorPalette));
  field("set-palette", T("Color palette"), idx, PALETTES.map(([, l]) => T(l)), Math.min(w, 320), (i) => {
    const id = PALETTES[i]![0];
    if (Store.PALETTES.includes(id)) platform.setOption("colorPalette", id);
  });
  button({ id: "btn-settings-close", text: T("Done"), style: "btn-primary", act: closeOverlay });
}

// ------------------------------------------------------------------ captions and the toast
function bottomLines(L: Layout): void {
  const inPlay = app.screen === "play" && !overlay();
  const base = inPlay ? bottomBand + 8 : 12;
  if (app.caption) {
    const text = T(app.caption.key);
    ui.place("caption", { anchor: "bottom", y: base }, () =>
      ui.column("caption-col", () => para(text, Math.min(L.lw * 0.9, 600) - 28, "caption-text", "caption-text"), { style: "caption", align: "center" }));
  }
  if (app.toast) {
    const text = app.toast.text();
    const w = Math.min(L.lw * 0.92, 420);
    ui.place("toast", { anchor: "bottom", y: base + (app.caption ? 44 : 12) }, () =>
      ui.column("toast-col", () => para(text, w - 34, "toast-text", "toast-text"), { style: "toast", align: "center" }));
  }
}
