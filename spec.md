# Meld Hall — running game design document

**Status:** running spec. Present tense; describes the game as it ships today.
Anything the design wants but the code does not do yet is confined to
"Design intent not yet implemented" at the end.

---

## 1. Overview

**Pitch.** A quiet evening at the community hall card table: draw, build sets and runs,
lay off onto anyone's melds, discard, and be the one holding nothing when the hand ends.

| | |
|---|---|
| Genre | Turn-based rummy-family card game, single-player vs. AI |
| Players | 2–4 seats; the human always holds seat 0, the rest are AI in local play |
| Session | One round 2–4 min; a match to the target score 5–15 min |
| Platforms | StarHermit engine script game (engine 1.27.0, host API 1.29, `engine.minor=29`): played natively by the StarHermit client and in browsers by the engine's web runtime; desktop and phones, portrait and landscape |
| Rendering | The card table on `starhermit:scene` (three.js-like 3D) behind an immediate-mode `starhermit:ui` layer (HUD, rails, action tray, the hand as card buttons, dialogs) |
| Networking | None of its own. The platform (player, cloud save, settings, leaderboards, clock) through `starhermit:platform` / `starhermit:storage`; `score-script.js` is the platform script (leaderboard posting) |

### File map

| Path | Responsibility |
|---|---|
| `starhermit.txt` | Manifest: name, owner, `server=score-script.js`, cover, `launch=index.html`, `engine.*` (entry `native/main.ts`, version 1.27.0, minor 29, capabilities platform/storage/clipboard), `control.*` keys, `engine.group.*` and `engine.gamepad.*` |
| `index.html`, `starhermit-files.json` | The engine's web loader and file index, written by `npm run package` (never edited by hand) |
| `native/main.ts` | Entry module: screen flow, the session's events (sounds, captions, announcements, sparks, results), commands from the tray/hand/chips/keys/pads/table taps, hints, undo, AI pacing on the fixed-step clock, results posting, lifecycle |
| `native/screens.ts` | Every screen and dialog on `starhermit:ui`: title, mode select, play (HUD, rails or sheets, tray, hand), pause and Settings dialogs, How to Play, results; captions, hint line and toast |
| `native/render.ts` | The 3D hall and table on `starhermit:scene`: environment, card atlas UVs, sync from the rules state, picking, framing (`setViewOffset`), particles, the look per graphics tier |
| `native/quality.ts` | The old presets and budgets keyed by the runtime's quality tier and level |
| `native/audio.ts` | One-shots from `sfx/`, captions, the room tone and chord pad rendered into looping clips |
| `native/platform.ts` | localStorage stand-in for `session.js`, the save (cloud slot, merge, old-save migration), the game's options as engine settings, legacy settings removal, player, invite, clock, score posting, leaderboard rows |
| `native/style.ts` | Registers `assets/ui-style.json`, the theme, high-contrast and colour-vision tokens |
| `native/i18n.ts` | Locale from the runtime's interface language; `T()`, `N()`, `S()` |
| `native/classic.ts` | Loads the shared classic scripts (`loadClassic`) and types them |
| `src/rules.js` | Pure deterministic rules engine (`MeldRules` / CommonJS). No DOM, no timers |
| `src/content.js` | `MeldContent`: 5 themes, 40 journey stages, 6 lessons, 3 challenges, 5 achievements, daily seeds, offline validators |
| `src/session.js` | `MeldSession`: per-match driver, mode factories, undo stack, AI pacing (timers injectable: `setTimers`), settings/progress through `localStorage` |
| `src/store.js` | `MeldStore`: the progress document, its merge, the old cloud slot reader, session.js's checksummed envelope, the game's options and the old settings-KV keys |
| `src/strings.js`, `src/i18n.js` | Translation tables (English keys, nine locales) and the pure `MHI18N` core |
| `src/sh-strings.js` | Account strings (sign-in, invite, toasts, leaderboard line) in the nine locales |
| `score-script.js` | StarHermit platform script (`server=`): range-checks a finished match total and posts it to the `high-score` leaderboard (canonical copy in the games repo's `tools/score-script.js`) |
| `assets/ui-style.json` | The UI style sheet, converted from `tools/ui-style.css` by `npm run css` |
| `assets/textures/` | Baked card faces and backs (atlases), felt, wood rim and floor per texture budget (`npm run textures`) |
| `assets/*.webp` | Authored images: hall key art, results still, card-back art (baked into `backs.webp`) |
| `sfx/` | 17 Opus clips, `manifest.txt` (canonical), `manifest.json` (generator input), `manifest.md` |
| `tests/` | `run.js` (rules/content/session, 52 tests), `store.test.mjs`, `i18n.test.mjs`, `native.mjs` (+ `native/*.play`) |
| `tools/` | `package-web.mjs`, `css.mjs` + `ui-style.css`, `bake-textures.mjs`, `gen-plays.mjs`, `browser-play.mjs` |
| `coverart.png`, `cover.jpg`, `icon.png` | Platform art |

---

## 2. Design pillars

**1. The table tells the truth.** Every fact that decides a turn — whose turn it is, deck
count, deadwood in hand, the exact contents of every table meld, each seat's score — is
readable as text in the HUD and rails at all times. *Rules in:* text and widget mirrors of
3D state (the hand strip, meld chips, scores), the objective sentence repeated in HUD and rail. *Rules out:* information that
exists only as a 3D affordance, hover-only tooltips, colour as a sole signal.

**2. One engine, one truth.** Hints, tutorials, the AI and the play-script generator
all call the same `legalActions` / `applyCommand` pair in `rules.js`. *Rules in:*
a hint is literally "the first legal action the engine would allow"; a future referee
script needs no second rulebook. *Rules out:* UI-side legality shortcuts, a separate
"tutorial mode" rules path, AI that peeks at hidden hands (it reads only `state`, and
`aiChoose` never touches opponents' cards).

**3. Deterministic and inspectable.** Every deal comes from a named seed through
`mulberry32`; every applied command appends `{tick, player, type, id, hash}` to the log and
`verifyReplay` can rebuild the match hash-for-hash. *Rules in:* daily challenges that are
identical for everyone, a Replay button that reports "identical final state", golden-seed
tests. *Rules out:* `Math.random()` anywhere inside resolution, hidden difficulty rubber-banding.

**4. Hall calm, not casino.** The fantasy is a lamplit municipal card room, not a felt-and-neon
table. *Rules in:* muted green/walnut/brass palettes, a slow four-chord pad, paper and wood
sound sources, one small particle burst reserved for a completed meld. *Rules out:* coin
showers, chip stacks, timers that shout, any sound above a conversational level.

**5. Nothing is a dead end.** Illegal input is always explained in words, not merely refused:
`reasonText` turns an engine reason code into an assertive screen-reader sentence while
`invalid` plays. *Rules in:* disabled action buttons that re-enable the instant the selection
becomes legal, Hint on demand, Undo in Practice. *Rules out:* silent rejection, modal
"you cannot do that" dialogs that steal focus.

---

## 3. Player experience

**Target player.** Someone who knows rummy from a kitchen table, or will learn it in two minutes.

**First 60 seconds.** The title screen names six doors: Play, Daily Challenge (badged with
today's UTC date), Journey (badged `unlocked/40`), Learn, How to Play, Settings. The two
teaching paths are one click away and neither is mandatory. Learn deals a real 2-player match
and states a single instruction in the objective bar — *"Drawing a card — Every turn begins
with a draw."* — and the lesson only completes when the player performs that action, which is
detected in `Session.prototype.checkLesson`. How to Play is four short cards (Draw / Meld /
Lay off / Discard & deadwood) plus the live keyboard map read from the current bindings.
A player who ignores both and presses Play still gets the whole rulebook implicitly: the
action tray disables everything illegal, so at the start of a turn only *Draw deck* and
*Take discard* are pressable, and after drawing, *Discard* lights up as soon as exactly one
card is selected.

**Session shape.** Choose mode (≤2 deliberate actions from title) → repeated turns of
draw / meld / lay off / discard, punctuated by 250–700 ms AI turns → results table with the
deadwood breakdown and the reason string → Next round (same match) or Play again / next
journey stage.

**The beat it is built around.** The turn where a card you drew for one purpose completes a
different meld, empties your hand, and the round ends on you rather than against you — the
score table then shows exactly whose leftover cards paid for it.

---

## 4. Core loop and rules contract

Owner of every rule below: `src/rules.js`.

### Cards and board

Cards are integers `0..51`; `rankOf(id) = id % 13` (0 = Ace … 12 = King), `suitOf(id) = (id/13)|0`
over the original suits `clover, diamond, heart, spire` (`♣ ♦ ♥ ♠`). Values (`cardValue`):
Ace = 1, 2–10 = pip value, J/Q/K = 10. State holds `deck`, `discardPile`, `hands[p].cards`,
`table[]` (`{cards, kind, owner}`), `scores[]`, `phase`, `turn`, `round`, `tick`, `log`.

### Deal (`initialState`)

`shuffledDeck(seed)` is a Fisher–Yates over `mulberry32(seed ^ 0x9e3779b9)`. Hand size is 10
for two players, 7 for three or four; cards are dealt one per player per round, hands sorted
by id, then one card is turned up as the discard pile. Two players therefore start with a
31-card stock.

### Turn structure

`phase` is `draw` then `act`. `legalActions(state, p)` returns `[]` for anyone who is not
`state.turn`, and:

- **draw** — `{type:'draw', source:'deck'}` while the stock is non-empty, `{source:'discard'}`
  while the pile is non-empty. Drawing moves the phase to `act`.
- **act** — every legal meld, layoff and discard, enumerated exhaustively:
  - **Sets** (`isSet`): 3 or 4 cards of one rank, all suits distinct. Both the 3-card subsets and
    the full 4 are offered when a rank appears four times.
  - **Runs** (`isRun`): 3+ consecutive ranks in one suit. Aces are low only — rank 0 never
    follows rank 12, because the check is strictly `rs[i] === rs[i-1] + 1`. Every sub-run of
    length ≥ 3 inside a maximal run is enumerated, so a 4-run offers both 3-card windows.
  - **Layoffs** (`canLayoff`): onto a set, a card of the same rank in a suit the set lacks, and
    only while the set has fewer than 4 cards; onto a run, a same-suit card exactly one rank
    below the low end or above the high end. Any player may extend any meld, including opponents'.
  - **Discards**: any card in hand.

A turn ends only on `discard`. Discarding rotates `turn` and resets `phase` to `draw`.

### Resolution order in `applyCommand`

1. Malformed command / missing `cmd.id` → rejected outright (state untouched).
2. `cmd.id === state.lastCommandId` → returns `{ok:true, duplicate:true}` with the same state:
   the idempotency guard the WebSocket path relies on.
3. Terminal phases accept only `nextRound`; otherwise off-turn commands are rejected.
4. The state is deep-copied; the command mutates the copy only. Any failure past this point
   increments `invalidActions[p]` and returns `{ok:false, reason}` — the caller keeps the old state.
5. On success: `tick += 1`, `lastCommandId` set, and `{tick, player, type, id, hash}` appended to `log`.

`hashState` is a djb2 over a canonical subset of the state and is the unit of replay verification.

### Round end and scoring (`endRound`)

A round ends the instant a hand reaches zero cards — after a meld, a layoff, or a discard —
with reason `player_out`; or, if a discard leaves the stock empty, with reason `deck_exhausted`,
in which case the winner is the seat with the lowest deadwood.

```
points = Σ deadwood(q) for every q ≠ winner
if reason === 'deck_exhausted'  points -= deadwood(winner)
points = max(points, 0)
scores[winner] += points
```

**Worked example.** Two seats, target 50. You (seat 0) discard your last card and go out;
seat 1 holds K♠ (10), 7♦ (7) and A♣ (1). `deadwood = [0, 18]`, reason `player_out`, so
`pointsAwarded = 18` and your total becomes `0 + 18 = 18`. Had the same hand ended by stock
exhaustion with you holding 4 points of your own, the award would have been `18 − 4 = 14`.

`roundBreakdown` records `{winner, reason, deadwood[], pointsAwarded, totals[], round}` — it is
exactly what the results table renders, so the score shown is never a re-derivation.

### Match end and tie-breaks

Reaching `targetScore` sets `phase = 'matchOver'`, `terminalReason = 'target_score_reached'`,
and `matchWinner` (highest score among those at or over the target). `comparePlayers` orders
equal scores by fewer `invalidActions`, then elapsed ticks, then stable seat order.

### RNG, undo and hints

Seeds: journey stages `hashStr('meld-hall-stage-' + n)`, dailies `hashStr('meld-hall-daily-' + YYYY-MM-DD)`
in UTC, lessons and challenges from their own string keys, practice from `Math.random()` unless a
seed is passed. `nextRound` reseeds deterministically as `(seed + round * 7919) >>> 0` and carries
scores, invalid counts and the log forward.

Undo exists only in Practice (`allowUndo = mode === 'practice'`); it rewinds through the stack of
serialized prior states until it reaches a state that is the human's draw phase, so one press
undoes a whole turn including the AI reply. The stack is capped at 200 entries.

Hint (`doHint` in `native/main.ts`) reads `session.legal()` and announces the first meld, else the first layoff,
else the first action — it never searches deeper than the engine's own enumeration, so it advises
without solving.

### AI

`aiChoose` is a pure heuristic over public state plus its own hand. On draw it takes the discard
when the top card shares a rank with two cards in hand, sits within two ranks of two same-suit
cards, or can be laid off immediately; otherwise it draws blind. On act it plays the largest
available meld, then any layoff, then discards the card maximizing `cardValue * 2 − links`, where
links counts rank matches (2) and near same-suit neighbours (1). Difficulty 1–3 changes only the
think delay (`max(250, 900 − 200·difficulty)` ms), not the policy.

---

## 5. Modes and progression

| Mode | Seats | Target | Seed | Undo | Ranked | Distinctive rule |
|---|---|---|---|---|---|---|
| Practice | 2–4 (chosen) | 30/50/100 | random | yes | no | The only mode with the setup panel: seats, target, AI difficulty 1–3 |
| Journey | 2 → 3 → 4 by band | 40 + 15·band (+20 on mastery) | per-stage constant | no | no | 40 authored stages, auto-advance on a match win |
| Daily | 3 | 75 | UTC day | no | yes | Identical deal worldwide; the badge shows the day resolved from server time |
| Challenge | 2 or 4 | 40–60 | per-challenge constant | no | no | Three authored constraints (see below) |
| Learn | 2 | 15–30 | per-lesson constant | no | no | Completes on a required action, not on winning |

**Journey curve** (`makeStage`). Stage *n* (1-indexed): seats 2 for stages 1–10, 3 for 11–25,
4 for 26–40; AI difficulty rises at stages 13 and 25; every fifth stage is a *Mastery* stage with
+20 target, a 4-round cap instead of 6, and `minScore = targetScore`. Mechanic budget grows from
2 to all 6 of `draw, meld_set, meld_run, layoff, deadwood, pressure`, one added every four stages,
and the theme rotates through the five palettes by band. Tutorial flags fire at stages 1, 2, 3 and 5
(`draw`+`discard`, `meld_set`, `meld_run`, `layoff`). `journeyUnlocked` advances only on a match win.

**Lessons** are `lesson_draw`, `lesson_discard`, `lesson_set`, `lesson_run`, `lesson_layoff`,
`lesson_deadwood`; Learn always opens at the first one not marked in `settings.tutorialSeen`.

**Challenges** are `ch_speed` (win in ≤25 turns), `ch_frugal` (win a round holding ≤5 deadwood),
`ch_crowd` (four seats). Their goal text is shown in the objective bar and in the rail.

**Achievements** (idempotent, granted in `applyResultToProgress`): `first_out`, `meld_master`
(25 career melded cards), `streak_3`, `mastery_20`, `long_game` (100 rounds). Career counters,
unlocks and cleared stages persist under `meldhall.save.v1` with a djb2 checksum; a failed
checksum silently falls back to defaults rather than loading a tampered save.

---

## 6. Controls and interaction

Actions are declared in `starhermit.txt` (`control.*` with keys, `engine.gamepad.*` with pad
controls, grouped as Hand / Turn / Assists / Match); players rebind keys and pads in the runtime's
Options (Settings → Key bindings opens it), and How to Play lists the effective keys.

| Action (`control.`) | Keys | Gamepad | Pointer / touch |
|---|---|---|---|
| Previous / next card (`left`, `right`) | ← / → | D-pad or left stick left / right | — |
| Select card (`confirm`) | Enter, Space | South (A) | Click / tap a card in the hand strip, or a card of your hand on the table |
| Draw from deck (`draw_deck`) | D | West (X) | *Draw deck* in the tray, or the deck on the table |
| Take discard (`draw_discard`) | F | North (Y) | *Take discard*, or the discard pile on the table |
| Meld selection (`meld`) | M | Left shoulder | *Meld* (needs ≥ 3 selected forming a legal meld) |
| Lay off (`layoff`) | L | Left trigger | *Lay off* with one card selected; a meld chip in the Table rail; the meld's ring marker on the table |
| Discard (`discard`) | X | Right shoulder | *Discard* with one card selected |
| Undo (`undo`, Practice) | U | Select (View) | *Undo* |
| Hint (`hint`) | H | Right trigger | *Hint* |
| Camera reset (`camera_reset`) | C | Right stick press | — |
| Cancel (`cancel`) | Esc | East (B) | — (clears a selection, else opens the pause menu; closes dialogs, How to Play and the mode select) |
| Pause (`pause`) | P | Start (Menu) | ⏸ in the HUD |

The arrows always walk the hand (the focused card gets the focus ring); Enter and Space act on
whatever widget has focus (a card, a tray button) and select the card at the hand position when
nothing has focus. Every button also takes Tab and Enter. A table tap is a press and release within
12 px and 600 ms (a longer press or a drag is a gesture, not a tap), decided after the frame's UI is
built so presses on the HUD, rails, tray and hand stay theirs; the deck and the discard pile are
named targets in the accessibility tree (`Deck`, `Discard pile`).

**Input locking.** Legality *is* the lock: every tray button whose action is not currently legal is
disabled — all of them while an AI seat is thinking, because `legalActions` returns `[]` for a seat
not on turn. The AI waits while the pause menu or Settings is open, off the play screen, and while
the window is hidden (`refreshAI` in `native/main.ts`).

**Feedback per input.** Selection: the hand card lifts 10 px with an accent ring, the 3D card lifts
and bobs over an accent ring on the felt, the `select` sound. Legal action: the matching sound and a
rebuilt table; melds add a 32-particle burst. Illegal action: the `invalid` sound and an assertive
screen-reader sentence. Haptics (a 12 ms vibration) on every committed action when enabled and the
device has a motor.

---

## 7. Screens and UI flow

```
title ──Play──▶ mode ──Start──▶ play ──round/match end──▶ results ──Next round / Play again──▶ play
  │  └──Daily / Journey / Learn──────▶ play               results ──Leave──▶ title
  ├──How to Play──▶ help ──Back──▶ title
  └──Settings──▶ [Settings dialog]
play ──Esc/P/⏸──▶ [Pause dialog] ──Settings──▶ [Settings dialog] ──Done──▶ [Pause dialog]
                                 ──Help──▶ help ──Back──▶ play
```

Screens are drawn every frame by `native/screens.ts`; focus goes to each screen's first control
(Play, the Practice mode, Resume, Done, Next round). The pause menu and Settings are modal
`ui.dialog`s over a dim of the screen; Back/Escape closes the top one.

- **Title:** the key art under a dark scrim (a plain background in high contrast) with a slow warm
  lamp glow on detailed looks (static under reduced motion); Play (primary), Daily Challenge with the
  day, Journey with the stages unlocked (n/40), Learn, How to Play, Settings, Sign in with StarHermit
  (signed out) and Invite a friend (signed in), the profile line.
- **Mode select:** the five modes (the chosen one outlined) with its description, expected duration
  and ranking; Practice shows Players (2/3/4), Target score (30/50/100) and AI difficulty selects,
  Challenge a challenge select; Back / Start.
- **Play:** the HUD (objective, turn and deck badges, the score badge, ☰ progress, ⏸ pause, ⋯ status),
  the Objective / Progress rail and the Table (meld chips) / Scores rail, the action tray with key
  hints, and the hand strip of paper card buttons (52 × 72, rank over suit glyph, red suits in the
  palette's red). The hint line (5 s) and sound captions (1.8 s) show above the tray.
- **Results:** the results still (hidden in high contrast and in short landscape), "Round N over" / "Match over", the
  headline, the score table (player, deadwood, match score / target, ★ for the round winner, the
  reason), unlocked achievements, the leaderboard line (signed in, finished matches), the Daily's
  top-ten board (signed in), Leave / Replay (verifies the replay envelope) / Next round or Play again.
- **How to Play:** four rule cards, the effective keys, pointer/touch and gamepad lines, Back.
- **Settings dialog:** a note that sound, graphics, language, larger text, high contrast and reduced
  motion are in the StarHermit Options; Open Options; Key bindings; Accessibility: Captions for sounds,
  Haptics, Left-handed controls (mirrors the action tray's order), Color palette; Done.

**Layouts** (by the window's logical size): **wide** (≥ 1024 px) keeps both rails beside the table;
**compact** puts the rails behind ☰ / ⋯ as sheets above the tray (scrolling past half the height);
**short landscape** (≤ 500 px tall, < 1024 px wide) packs the HUD into one band, stands the tray as a
two-column block on the right (key hints left out; they stay in Help) and runs the hand (44 × 60
cards) under the table. In every layout the table is framed in the band the HUD, the tray and the
hand leave (`setViewOffset`). Panels scroll inside when taller than the window; the runtime's
interface size scales everything on large screens; safe areas pad every edge. Nothing is cut off at
390 × 844, 844 × 390 or desktop sizes: the tray and hand wrap, the HUD badges wrap, the results table
sizes its columns to its headings.

---

## 8. Art direction

**Shell palette** (`style.css`): background `#0e1420`, panels `#1a2334` / `#223048`, text `#eef2f8`,
muted `#9aa8bc`, accent `#e8b34b` (brass), danger `#d86a6a`, ok `#6ad88a`, focus ring `#7fc4ff`.
Cards are cream `#f6f2e8` on a `#c8c0a8` border with `#22303e` ink and `#a83232` for the red suits.
High contrast swaps to pure black/white with `#ffd700` accent and `#00ffff` focus.

**Table themes** (`content.js`, one per journey band and per daily): Hall Dusk (felt `#2e5d4b`,
wood `#6b4a2f`, wall `#1b2436`, accent `#e8b34b`), Morning Gild, Midnight Parlor, Harvest Fair,
Winter Ledger. Each theme also drives key/fill light colours and the card-back tint.

**Shape language.** Round table (a 6.4-unit wood cylinder with a 6.0 felt inlay), rectangular
cards with a 0.7 × 1.0 footprint, ring markers for layoff targets, cone pendant lamps. Rows are
fixed by `FRAMING`: hand at z 3.4, melds at 0.4, opponents at −1.2 and back, stock and discard
at −2.6, camera at (0, 7.2, 6.4) with a 42° field of view looking at (0, 0, 0.6).

**Typography.** The UI uses the runtime's sans-serif face; the baked card faces use the bold serif
rank and suit glyph drawn at 256 × 368 px per card. The runtime's text-size and interface-size
options scale the UI.

**Motion.** Selected cards hover with a gentle bob; the meld burst is 32 particles with gravity; the
lamp light shimmers and dust drifts through it. The runtime's reduced-motion option stops the bob,
the shimmer, the drift, the burst and the title's lamp glow.

**Graphics.** ACES filmic tone mapping at exposure 1.15 with sRGB output; theme colours are sRGB.
A warm key directional light (the only shadow caster) with a hemisphere fill and a faint ambient
term; on detailed looks the pendant lamps' warm pool (a point light). Per quality tier (the
runtime's Options › Graphics: `frame().quality`, `native/quality.ts`; the old presets and budgets):

| | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Shadows (key light map) | off | 512 | 1024 | 2048 |
| Ambient occlusion | off | off | on (8 samples) | high (16) |
| Bloom (lamp bulbs, selection glow, sparks) | off | on, ½ res | on, ½ res | on, full res |
| Colour grade + vignette | off | on | on | on |
| Anti-aliasing | MSAA | FXAA | SMAA | SMAA |
| Reflections (`RoomEnvironment` + PMREM) | off | on | on | on |
| Hall | plain (flat materials, box cards) | detailed | detailed | detailed |
| Shading | Lambert | Standard | Physical (clear-coated card faces and backs) | Physical |
| Floor / felt / wood textures | — | 256 / 128 / 512 × 32 | 512 / 256 / 1024 × 64 | 1024 / 512 / 2048 × 128 |
| Rim / felt segments | 48 | 48 | 96 | 128 |
| Particles | sparks (≤ 12) | sparks (≤ 20) | sparks (≤ 64) + dust motes (140, ≤ 2× by level) | sparks (≤ 96) + motes (200, ≤ 400) |

The detailed hall adds the textured plank floor, wood-grain rim and felt fibre, the brass inlay ring,
wall panels, pendant lamps with glowing bulbs, exponential fog and rounded card slabs. Bloom runs on
the light before tone mapping in the runtime (three.js r137 bloomed after it), so its threshold is the
old 0.88 taken back through the curve (1.6). The runtime owns Auto (the device's graphics level),
render scale, the pixel-ratio cap, adaptive resolution, the frame-rate limit and readout; the old
per-effect overrides are not offered. A change of tier applies at once (materials and the hall are
rebuilt, the table kept).

**Textures.** The browser build painted its card faces, card backs (with the authored back art), felt,
wood rim and floor with per-pixel canvas grain at start-up; they are baked once with that same code
in Chrome (`tools/bake-textures.mjs`) into `assets/textures/` — one 13 × 4 face atlas and a back per
theme — and each card shows its face by its own top-face UVs into the atlas.

**Authored images.**

| Asset | Role |
|---|---|
| `assets/hall-keyart.webp` | Title backdrop under a 72–88 % dark scrim; suppressed in high contrast |
| `assets/results-still.webp` | Banner at the top of the results panel, decorative, hidden in high contrast |
| `assets/card-back.webp` | Composited at 85 % over the procedural card back, baked into `assets/textures/backs.webp` |

---

## 9. Audio direction

**Philosophy.** Everything is a wooden, papery or small-bell sound at conversational level; the
loudest event in the game is the match-win fanfare and it is still restrained. Sound never carries
information that is not also on screen — each cue has a caption string.

**Buses.** The runtime's buses and Options › Audio own the volumes, mute and the voice limit: the
effects play on *effects*, UI clicks on *interface*, the room tone and the chord pad on *music* (the
runtime has no ambience bus). Clips load one at a time once the mixer runs (natively at once, in a
browser after the first press); a clip still loading is silent (the browser build's synthesized
fallback blips are not ported: a live synthesis graph makes clip loads fail on the web runtime).

**Music and ambience.** Rendered once into looping clips a slice a frame: the four-chord triangle
pad (one chord every 3 s, each swelling in over 0.8 s and out by 3.2 s; a 12 s loop) and the hall's
room tone (noise through a 220 Hz low-pass, a 2 s loop). The pad's level rises with the melds on the
table (×1 to ×2 at six melds); its pitch no longer rises with it.

### SFX event table

Canonical copy: `sfx/manifest.txt`. Generator input: `sfx/manifest.json`.

| Event id | File(s) | Sound | Fires when |
|---|---|---|---|
| `select` | `card-select.opus`, `card-deselect.opus` | Card lifted off / set down on felt | A card enters or leaves the selection |
| `invalid` | `invalid-buzz.opus` | Dull wooden thunk with a muted buzz | Any rejected command |
| `draw` | `card-draw.opus`, `card-draw-take.opus` | Card off the stock / plucked from a pile | Either draw source, human or AI |
| `meld` | `meld-fan.opus` | Three cards fanned onto wood | A set or run is accepted; fires with the particle burst |
| `layoff` | `layoff-tap.opus` | Card tapped and slid beside others | A card extends an existing meld |
| `discard` | `card-discard.opus` | Card tossed onto a pile | End-of-turn discard |
| `turn` | `turn-chime.opus` | Small bell on a wooden mallet | Turn returns to the human seat |
| `deal` | `deal-round.opus` | A row of cards dealt onto felt | A match starts, and on *Next round* |
| `hint` | `hint-shimmer.opus` | Two rising glass bell tones | Hint button or **H** |
| `roundWin` | `round-win.opus` | Brass bell cascade with a harp gliss | Results: the human took the round, match continues |
| `roundLose` | `round-lose.opus` | Three descending marimba notes | Results: an opponent took the round or the match |
| `matchWin` | `match-win.opus` | Restrained brass-and-harp fanfare | Results: the human reaches the target score |
| `achievement` | `achievement-chime.opus` | Glockenspiel with a ringing tail | Each achievement unlocked; lesson completion |
| `ui` | `ui-click.opus`, `ui-confirm.opus` | Wooden click / tick | Mode and option picks |

**Captions.** With *Captions for sounds* on (default), every event above except `ui` shows its
caption for 1.8 s above the tray in play, at the bottom edge elsewhere.

---

## 10. Localization

**Languages:** en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT — every player-facing
string (title, mode select, HUD, rails, tray, hand and meld labels, hints, rejection reasons, results,
help, pause, settings, lessons, challenges, achievements, sync status, captions, account lines) ships
in all nine. Card names use rank letters and suit glyphs and need no translation.

**Where strings live:** `src/strings.js` holds the tables keyed by the English source text (en-GB,
es-ES and fr-CA list only their differences — *Colour palette*, *Ajustes*, *pointage*); `src/i18n.js`
is the pure lookup; `src/sh-strings.js` the account strings. `native/i18n.ts` picks the locale from the
runtime's interface language (`preferences().language`: Options › Language, else the account's
preferred language, else the device's; es-MX → es-419, en-AU → en-GB, fr → fr-FR, pt-PT → pt-BR) and
follows a change at once: every string is drawn through `T()` each frame. "Meld Hall" and
"StarHermit" stay untranslated. The browser build's own Language setting (`sh-language.js`, its
`ui.language` account key) is replaced by the runtime's Options; the old key is removed.

**Expansion:** panels cap at 680 px and wrap, the tray and HUD badges wrap, so a 30–40 % expansion in
German or French costs height, never clipping.

---

## 11. Accessibility

- **Keyboard and gamepad.** Title → mode → play → results → title is operable by Tab / arrows /
  Enter or the pad's D-pad and South; in play the action keys and pad controls of section 6. Focus
  moves to each screen's first control on entry.
- **Focus visibility.** A 3 px `#7fc4ff` ring (2 px offset) on every focusable widget, `#00ffff` in
  high contrast.
- **Screen readers.** Every widget is in the runtime's accessibility tree with its role and name: the
  hand's cards are toggles named "Q♥, value 10" (pressed when selected), the meld chips name their
  cards, the deck and discard pile on the table are named targets. Turn changes, hints, lesson
  completion, results headlines and replay checks are announced politely; rejections assertively.
- **Colour.** Suits carry glyphs as well as colour. Three colour-vision palettes (the game's own
  option) shift the accent and the red-suit ink (`#14568f` for deuteranopia/protanopia, `#b03a2e` for
  tritanopia).
- **Captions** are on by default for all non-UI sounds; **haptics** can be turned off.
- **The runtime's options:** reduced motion (section 8), larger text and interface size, high
  contrast (the old black/white palette with a gold accent; decorative images hidden).
- **Targets.** Buttons are at least 44 × 44 px, the hand cards 52 × 72 (44 × 60 in short landscape).

---

## 12. StarHermit integration

`starhermit.txt` declares `name=Meld Hall`, `owner`, `server=score-script.js`, `cover=cover.jpg`,
`launch=index.html` (the engine's web loader), the `engine.*` lines and the controls.

- *Player.* `player()` from `starhermit:platform`: the profile line reads "Playing as \<display
  name\> — progress \<syncing… / saving… / synced to your account / offline — saved on this device\>";
  signed out, "Guest profile — progress is saved on this device." and a **Sign in with StarHermit**
  button (`requestSignIn`). A session that ends toasts "signed out" and play goes on locally.
- *Save.* The progress document (journey unlock and clears, mastery count, dailies, achievements,
  career counters) is the engine save (`saves`, on the device and in the account's cloud slot), the
  same plain JSON the browser build mirrored to `game:<slug>`. `session.js` reads and writes it
  through a `localStorage` stand-in (`native/platform.ts`) with its checksummed envelope. A save from
  another device merges in (`saves.onStatus`, `saves.onConflict` → `src/store.js mergeProgress`: the
  further unlock, the union of clears, dailies and achievements, the larger counters). The browser
  build's slot shows as foreign: it is merged with this device's progress and replaced once
  (`saves.foreign()` + `replaceForeign`). Guests' old browser `localStorage` progress cannot migrate.
- *Settings.* The game's own options (captions, haptics, colour palette, left-handed tray, lessons
  seen) are engine `settings` under the same keys; the browser build's values in the account's
  settings KV are adopted (unless set here since), then every key it wrote there is removed (volumes,
  mute, graphics, motion, contrast, text size, bindings, `ui.language` — now the runtime's Options).
  Key bindings are the runtime's (renamed actions: `draw_deck`, `draw_discard`, `camera_reset`; old
  custom bindings of the camelCase actions do not carry over).
- *Clock.* The Daily's UTC day comes from the platform's clock (`serverNow()`), else the device's.
- *Invite link.* Signed in, **Invite a friend** copies the platform invite link (clipboard capability)
  with a toast.
- *Leaderboard posting.* Signed in, every finished match except lessons posts the player's match
  total once through `score-script.js` (a practice session whose socket carries `{ type: 'result',
  scores: { 'high-score': total } }`; the script range-checks it, 0–1000, and posts it to the "Match
  score" board) and the results show "Leaderboard rank: #N" (or posted / not posted). Rounds post
  nothing; guests post nothing and see no line. Solo scores keep the score script's range check
  (no server replay); there is no multiplayer to referee.
- *Daily board.* Signed in, the Daily's results list the board's top ten (display names); personal
  bests stay in the save.

**Not used:** rooms, matchmaking, chat, presence, platform achievements (achievements and career
stats stay in the save), telemetry (the browser build's local funnel is not ported). The old local
dev server (`server.js`, with an unreachable hosted-table `/ws` backend) is gone.

---

## 13. Technical architecture

**Module graph.** `rules.js` and `content.js` depend on nothing; `session.js` on both; `store.js` on
nothing; the string tables on nothing. `native/classic.ts` loads them as classic scripts
(`loadClassic`), so `tests/run.js` runs the very code the client runs, in plain Node. `native/main.ts`
owns the app state and wires `screens.ts` (UI), `render.ts` (table), `audio.ts`, `platform.ts`.

**Time.** The runtime's fixed steps (60/s) drive a clock the AI's think time runs on (`session.js`
`setTimers`, 900 − 200 × difficulty ms, at least 250); a paused game, a hidden window and slow frames
never move the table, and play scripts replay exactly. Widget presses run after the frame's UI is
built (`later`); table taps are decided then too.

**Determinism and replay.** All hidden information derives from one 32-bit seed. `buildReplay`
emits `{schema, rulesVersion, seed, options, commands, hashes, terminal}`; `verifyReplay` re-runs the
commands and compares hashes, so a tampered hash is detected at its index. The results' *Replay*
button runs it and shows the outcome.

**Performance.** The table's cards are rebuilt on every state change (≤ ~60 meshes) from geometry
cached per card face and one face material; particles are one preallocated `Points` buffer per tier.
Static textures are baked images; the audio loops render a slice a frame.

---

## 14. Testing and acceptance criteria

`npm test` runs:

- `tests/run.js` (52 tests): meld validity, card values, sub-run enumeration, deal shape and
  per-seed determinism; rejection paths and no mutation on failure; going out, scoring, match end,
  `nextRound`, serialization; golden matches across seeds and seats; replay determinism and
  tamper detection; 2000 malformed commands; content validation (40 stages, mastery every fifth,
  dailies, themes, achievements, lessons); session undo / lesson / progression; the injected AI timers.
- `tests/store.test.mjs`: the old cloud slot migrates, two devices merge without losing either side,
  session.js's envelope round-trips through the stand-in, options are validated and every old
  settings-KV key is removed.
- `tests/i18n.test.mjs`: every key `native/*.ts`, the content and the captions use is translated in
  every locale with placeholders intact and no stale rows; the account lines; locale switching.
- `tests/native.mjs`: the web index is current, `tsc` passes, `starhermit check .` has no warnings,
  and the `tests/native/*.play` scripts (generated by `tools/gen-plays.mjs`, the seated player played
  by the rules' AI) drive the real UI offscreen (`--render-check`):
  - `menus.play` (desktop): How to Play, Settings (left-handed tray), the mode select with a Practice
    target, a Practice turn (draw, undo, hint, a keyboard pick), pause, Help from pause, Settings from
    pause, leaving; Learn's first lesson;
  - `journey-1.play` (desktop): Journey stage 1's first round to its results with the first draw by a
    click on the deck on the table, Next round, pause, leave;
  - `full-hall-phone.play` (390 × 844 @3): the Full Hall challenge via the mode select, both sheets,
    the whole four-player match to "Opponent 4 wins the match.";
  - `low-deadwood-landscape.play` (844 × 390 @3): the Low Deadwood challenge to the match's end, Replay
    verified, leave.

`npm run test:browser` (`tools/browser-play.mjs`) plays Journey stage 1's first round into round 2 in
GPU Chrome on the packaged loader at desktop (mouse, D key, a click on the 3D deck), phone (DPR 3)
and phone landscape (DPR 3) by finger taps (CDP touch, including a tap on the 3D deck), failing on any
console error or warning or the runtime's error screen. `npm run package` regenerates the loader and
index after every change.

---

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/hall-keyart.webp` | Title screen backdrop | FLUX.2 klein, seed 70831, 1344×768 → WebP q80 (25 KB) | generated in this pass, wired |
| `assets/results-still.webp` | Results panel banner | FLUX.2 klein, seed 25514, 1024×576 → WebP q80 (45 KB) | generated in this pass, wired |
| `assets/card-back.webp` | Card back art over the procedural back | FLUX.2 klein, seed 41207, 512×512 → WebP q85 (139 KB) | generated in this pass, wired |
| `coverart.png` | Platform cover, 1200×675 | prior pass | shipped |
| `icon.png` | Platform icon | prior pass | shipped |
| `assets/textures/*` | Card face atlas, card backs per theme, felt, wood rim, floor | the browser build's procedural painters, baked by `tools/bake-textures.mjs` | shipped |
| Table, lamps, hall geometry | In-scene geometry | parametric (`native/render.ts`) | shipped |
| `sfx/card-select.opus`, `card-deselect.opus` | `select` | MOSS-SFX v2.0 | shipped |
| `sfx/invalid-buzz.opus` | `invalid` | MOSS-SFX v2.0 | shipped |
| `sfx/card-draw.opus`, `card-draw-take.opus` | `draw` | MOSS-SFX v2.0 | shipped |
| `sfx/meld-fan.opus` | `meld` | MOSS-SFX v2.0 | shipped |
| `sfx/layoff-tap.opus` | `layoff` | MOSS-SFX v2.0 | shipped |
| `sfx/card-discard.opus` | `discard` | MOSS-SFX v2.0 | shipped |
| `sfx/turn-chime.opus` | `turn` | MOSS-SFX v2.0 | shipped |
| `sfx/deal-round.opus` | `deal` | MOSS-SFX v2.0, 100 steps | generated in this pass, wired |
| `sfx/hint-shimmer.opus` | `hint` | MOSS-SFX v2.0, 100 steps | generated in this pass, wired |
| `sfx/match-win.opus` | `matchWin` | MOSS-SFX v2.0, 100 steps | generated in this pass, wired |
| `sfx/round-win.opus`, `round-lose.opus` | `roundWin`, `roundLose` | MOSS-SFX v2.0 | shipped |
| `sfx/achievement-chime.opus` | `achievement` | MOSS-SFX v2.0 | shipped |
| `sfx/ui-click.opus`, `ui-confirm.opus` | `ui` | MOSS-SFX v2.0 | shipped |
| Music and ambience | Chord pad and room tone | rendered into clips at start-up (`native/audio.ts`) | shipped, by design |

No 3D model assets: every prop in the hall is parametric geometry, so a mesh import would add
weight without changing the silhouette.

---

## 16. Known limitations

- **Challenge constraints are advisory.** `ch_speed`'s 25-turn limit and `ch_frugal`'s 5-deadwood
  cap are stated in the objective text but not enforced or verified by the rules engine; only
  `ch_crowd`'s seat count actually changes play.
- **Journey stage goals are partly decorative.** `goals.maxRounds`, `parTurns` and `minScore` are
  authored and validated offline, but nothing fails a stage for exceeding them; a stage clears on a
  match win alone.
- **Aces are low only.** K-A-2 is never a run. This is deliberate but is not stated anywhere in the
  in-game help.
- **`comparePlayers` elapsed-time tie-break is nominal.** Ticks are shared across seats, so the
  comparison falls through to stable seat order.
- **No mid-match save.** Leaving a match discards it; only settings, career stats and unlocks persist.
- **Undo can rewind past a round boundary's intent.** It rewinds to the last human draw phase, which
  after a `nextRound` is the first turn of the new round rather than the end of the previous one.
- **Port differences (StarHermit engine).** The synthesized fallback blips that played while a sample
  decoded are gone (a clip still loading is silent); the chord pad's pitch no longer rises with the
  table; the Graphics panel's per-effect overrides, render-scale slider and FPS readout are the
  runtime's Options (quality tier, scale, frame limit); the game's Language, volume, reduced-motion,
  contrast and text-size settings are the runtime's; custom key bindings from the browser build do not
  carry over (actions renamed to lowercase); guests' browser `localStorage` progress does not migrate
  (signed-in cloud saves do). Changes made on purpose: the table takes each match's theme (the browser
  build kept the theme of the first match played in a page), the hint text also shows above the tray
  for 5 s (it was screen-reader only), and the Left-handed option mirrors the action tray (it was
  stored but changed nothing).
- **Hosted client path.** There is none: Meld Hall is solo against AI seats; the old dev server's
  hosted-table backend was never reachable from the client and is removed.

## Design intent not yet implemented

1. **Enforced challenge goals.** Turn and deadwood constraints evaluated in the session driver so a
   challenge can be failed, with the failure reason shown on the results screen.
2. **Online tables.** Two-player tables over platform-routed realtime rooms (matchmaking/friend
   invites) with a server-script referee. A separate ranked daily board.
