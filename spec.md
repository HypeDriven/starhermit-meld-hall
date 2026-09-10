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
| Genre | Turn-based rummy-family card game, single-player vs. AI (server supports hosted 2-player) |
| Players | 2–4 seats; the human always holds seat 0, the rest are AI in local play |
| Session | One round 2–4 min; a match to the target score 5–15 min |
| Platforms | Desktop and mobile browsers, portrait and landscape |
| Rendering | Three.js card table on `<canvas id="gl">`, with a complete semantic DOM mirror layered above it — the DOM is playable on its own when WebGL is unavailable |
| Networking | Optional `server.js`: static host, `/api/v1/time`, and an authoritative WebSocket at `/ws` |

### File map

| Path | Responsibility |
|---|---|
| `index.html` | All five screens plus two overlays as static markup; loads the seven scripts in dependency order |
| `src/rules.js` | Pure deterministic rules engine (`window.MeldRules` / CommonJS). No DOM, no timers |
| `src/content.js` | `MeldContent`: 5 themes, 40 journey stages, 6 lessons, 3 challenges, 5 achievements, daily seeds, offline validators |
| `src/session.js` | `MeldSession`: per-match driver, mode factories, undo stack, AI pacing, localStorage settings/progress |
| `src/audio.js` | `MeldAudio`: WebAudio buses, sampled one-shots from `sfx/`, synth fallbacks, captions |
| `src/render.js` | `MeldRender`: the 3D hall, procedural card textures, picking, particles, quality tiers |
| `src/ui.js` | `MeldUI`: screens, focus, keyboard, live regions, settings binding, the accessible hand list |
| `src/main.js` | Bootstrap: capability detection, time sync, pointer taps, render loop, lifecycle, local funnel |
| `src/style.css` | Layout, palette, contrast/large-text/colour-vision variants, safe-area padding |
| `src/three.min.js`, `src/three.module.js` | Vendored Three.js r170 |
| `server.js` | Static server + time/health endpoints + authoritative hosted sessions over raw RFC6455 frames |
| `tests/run.js` | 51 offline tests: rules, scoring, fuzzing, replay determinism, content validation |
| `tests/e2e.mjs` | Playwright-core playthrough of the real UI at 1280×800 and 390×844 |
| `sfx/` | 17 Opus clips, `manifest.txt` (canonical), `manifest.json` (generator input), `manifest.md` |
| `assets/` | Authored images: hall key art, results still, card-back art |
| `coverart.png`, `icon.png`, `favicon.svg` | Platform art |

---

## 2. Design pillars

**1. The table tells the truth.** Every fact that decides a turn — whose turn it is, deck
count, deadwood in hand, the exact contents of every table meld, each seat's score — is
readable as text in the HUD and rails at all times. *Rules in:* redundant DOM mirrors of
3D state, the objective sentence repeated in HUD and rail. *Rules out:* information that
exists only as a 3D affordance, hover-only tooltips, colour as a sole signal.

**2. One engine, one truth.** Hints, tutorials, the AI, the e2e test and the authoritative
server all call the same `legalActions` / `applyCommand` pair in `rules.js`. *Rules in:*
a hint is literally "the first legal action the engine would allow"; the server can reject
a client without a second rulebook. *Rules out:* UI-side legality shortcuts, a separate
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
`reasonText` turns an engine reason code into a sentence in the assertive live region while
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

Hint (`UI.doHint`) reads `session.legal()` and announces the first meld, else the first layoff,
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

| Input | Desktop | Touch |
|---|---|---|
| Select / deselect card | Click a card button; ←/→ moves focus, Enter or Space toggles | Tap a card in the hand strip, or tap the 3D card |
| Draw from stock | *Draw deck* button or **D** | Tap the button, or tap the 3D deck |
| Draw from discard | *Take discard* or **F** | Tap the button, or tap the 3D discard pile |
| Meld selection | *Meld* or **M** (needs ≥3 selected forming a legal meld) | Tap *Meld* |
| Lay off | *Lay off* or **L** with exactly one card selected | Tap the meld chip in the right rail, or the 3D ring marker |
| Discard | *Discard* or **X** with exactly one card selected | Tap *Discard* |
| Undo / Hint | **U** / **H** | Tray buttons |
| Pause | **P** or Esc (Esc first clears a selection if one exists) | ⏸ in the HUD |
| Camera reset | **C** | — |
| Panels | — | ☰ and ⋯ open the left/right rails as bottom sheets |

Bindings live in `settings.bindings` and the help screen renders them from that object, so a
rebound key documents itself. Canvas taps are separated from camera drags by a threshold in
`main.js`: a pointer that moves more than 12 px or is held longer than 600 ms is a gesture,
not a tap. Pointer capture is taken on `pointerdown` and released on cancel/lost-capture.

**Input locking.** There is no timed lock. Legality *is* the lock: `syncActionButtons` disables
every tray button whose action is not currently legal — including all of them while an AI seat
is thinking, because `legalActions` returns `[]` for a seat that is not on turn. The AI driver
itself is suspended whenever the pause or settings overlay is open, the screen is not `play`,
or the tab is hidden (`setAIPaused` in `main.js`).

**Feedback per input.** Selection: card lifts 10 px with an accent ring, `aria-selected` flips,
`select` sound. Legal action: the matching sound plus a rebuilt scene; melds add a 32-particle
burst. Illegal action: `invalid` sound plus a sentence in the assertive live region. Haptics
(12 ms) fire on every committed action when enabled and supported.

---

## 7. Screens and UI flow

```
title ──Play──▶ mode ──Start──▶ play ──round/match end──▶ results ──▶ play | title
  │  └──Daily / Journey / Learn────▶ play          results ──Leave──▶ title
  └──How to Play──▶ help ──Back──▶ title
play ──Esc/P──▶ [overlay-pause] ──Help──▶ help ──Back──▶ play
any ──Settings──▶ [overlay-settings] (modal, focus-trapped by focus restore)
```

`UI.show` toggles `.active` on exactly one of the five `<section class="screen">` elements and
moves focus to its first button or heading. Overlays remember `document.activeElement` and
restore it on close.

**Play layout.** A CSS grid: HUD row, body, action tray, hand strip. Below 1024 px the grid is a
single column and the two rails are hidden, reachable as bottom sheets (`position:absolute`,
`max-height:50vh`, scrollable) via the ☰ / ⋯ buttons. At 1024 px and above the grid becomes
`260px 1fr 260px` and both rails are permanently visible beside the table. The 3D canvas is a
fixed backdrop behind the screen layer; `#screen-play` is `pointer-events:none` with its children
re-enabled, so canvas picking works through the empty middle of the layout while every control
stays clickable.

**Safe areas.** `--sat/--sab/--sal/--sar` come from `env(safe-area-inset-*)`; every screen pads by
them and both the action tray and the caption toast add `--sab` to their bottom offset, so the
tray never sits under a home indicator. `viewport-fit=cover` is set in the head.

**Never cut off:** the action tray and hand strip (they wrap rather than scroll horizontally), the
turn/deck/score badges, the results table, and the objective sentence. Buttons are ≥44×44 px.

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

**Typography.** System UI stack (`"Segoe UI", system-ui, sans-serif`) throughout; card faces are
drawn into a 128×184 canvas with bold 64 px rank and 44 px suit glyph. Larger text scales the
whole body to 120%.

**Motion.** Cards ease toward their target position and selected cards hover; the meld burst is
32 particles with gravity. Reduced motion (`settings.reducedMotion`, forwarded to
`scene.reducedMotion`) snaps positions instead of easing and suppresses idle drift; the CSS
selection lift and the DOM layout remain, so nothing becomes ambiguous when motion is off.

**Quality tiers** (`QUALITY_TIERS`): low = pixel ratio 1, no shadows, no particles, 0.8 render
scale, lamps and panels dropped; medium = 1.5 / shadows / 500 particles / lamps; high = 2 /
shadows / 2000 particles / lamps and wall panels. `auto` picks from `deviceMemory` and
`hardwareConcurrency`.

**Hero of the screen.** The felt between the meld row and the hand row — the melds are what the
player reads, so the camera centres slightly behind them and the lamps pool light there.

**Authored images.**

| Asset | Role |
|---|---|
| `assets/hall-keyart.webp` | Title backdrop under a 72–88% dark scrim; suppressed in high contrast |
| `assets/results-still.webp` | Banner at the top of the results panel, decorative (`alt=""`), hidden in high contrast, `onerror` self-hides |
| `assets/card-back.webp` | Composited at 85% over the procedural card back inside `makeBackTexture`; if it fails to decode the procedural back stands unchanged |

---

## 9. Audio direction

**Philosophy.** Everything is a wooden, papery or small-bell sound at conversational level; the
loudest event in the game is the match-win fanfare and it is still restrained. Sound never carries
information that is not also on screen — each cue has a caption string.

**Buses.** `music`, `effects`, `ambience`, `voice` gain nodes feed a master gain; each is set
independently from settings (defaults 0.5 / 0.8 / 0.4 / 0), and `muted` zeroes the master.
Hiding the tab ducks the master to 0 and restores it on return. The context is created lazily on
the first user gesture (`Audio.ensure` on any button click or canvas pointerdown).

**Music and ambience.** Procedural, not sampled: a four-chord triangle-wave pad advances every 3 s,
and `setMusicIntensity` (driven by table meld count / 6) raises both its pitch offset and level as
the table fills. Ambience is a looping 2-second noise buffer through a 220 Hz low-pass — hall room tone.

**Effects.** One-shots are Opus samples fetched lazily from `sfx/` after unlock, decoded once and
cached; events with two clips rotate between them. Every event keeps a synthesized fallback that
plays while a sample is still loading or if the fetch fails, so the game is never silent.

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
| `deal` | `deal-round.opus` | A row of cards dealt onto felt | A session is attached, and on *Next round* |
| `hint` | `hint-shimmer.opus` | Two rising glass bell tones | Hint button or **H** |
| `roundWin` | `round-win.opus` | Brass bell cascade with a harp gliss | Results: the human took the round, match continues |
| `roundLose` | `round-lose.opus` | Three descending marimba notes | Results: an opponent took the round or the match |
| `matchWin` | `match-win.opus` | Restrained brass-and-harp fanfare | Results: the human reaches the target score |
| `achievement` | `achievement-chime.opus` | Glockenspiel with a ringing tail | Each achievement unlocked; lesson completion |
| `ui` | `ui-click.opus`, `ui-confirm.opus` | Wooden click / tick | Menu buttons and settings commits |

**Captions.** With *Captions for sounds* on (default), every event above except `ui` pushes its
caption into `#caption-toast` for 1.8 s, positioned above the tray and clear of the safe area.

---

## 10. Localization

Ships **en-US only**. All player-facing strings are English literals inside `index.html`,
`src/ui.js` (screen text, hint and rejection sentences, results headlines) and `src/content.js`
(mode, stage, lesson, challenge and achievement titles). `<html lang="en">` is static and there is
no locale selection, no string table and no `navigator.language` lookup.

The required set — en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT — is therefore
not met; see "Design intent not yet implemented". The structural allowance is already in place:
every string is built by concatenating short clauses in `ui.js` rather than being baked into
canvas textures, and card faces use rank letters and suit glyphs that need no translation, so a
string table can be introduced without touching the renderer. Panels are `max-width: 70ch` and the
tray wraps, so a 30–40% expansion in German or French costs height, never clipping.

---

## 11. Accessibility

- **Keyboard-only path.** Title → mode → play → results → title is fully operable with Tab, arrows
  and Enter. Within play, ←/→ walk the hand list and Enter/Space toggle selection; D/F/M/L/X/U/H
  bind the tray. Focus moves to the first control of each screen on entry and is restored after an
  overlay closes.
- **Focus visibility.** 3 px `#7fc4ff` outline with 2 px offset on every focusable element,
  `#00ffff` in high contrast.
- **Live regions.** `#live-region` (polite) carries turn changes, hints, lesson completion, results
  headlines and replay verification; `#error-region` (assertive) carries rejection sentences.
  The hand is a real `role="listbox"` with `aria-multiselectable`, and each card button reports
  `aria-selected` and a label of the form "Q♥, value 10".
- **Colour.** Suits carry glyphs as well as colour. Three colour-vision palettes shift the accent
  and the red-suit ink (`#14568f` for deuteranopia/protanopia, `#b03a2e` for tritanopia).
- **Captions** are on by default for all non-UI sounds.
- **Reduced motion** removes easing, drift and the burst; **larger text** scales the body to 120%;
  **high contrast** replaces the palette and drops both decorative images.
- **Targets.** All buttons are at least 44×44 px, including the hand cards (52×72).
- **3D failure is not a failure.** If the WebGL context cannot be created, `#compat-message`
  appears and the game remains completely playable through the DOM hand list, meld chips and tray.

---

## 12. StarHermit integration

`starhermit.txt` declares `name=Meld Hall`, `launch=index.html`, `owner`, `server=server.js`,
`cover=coverart.png`, per https://wiki.starhermit.com/ conventions.

**Used today**

- *Server script.* `server.js` is the declared platform server: it hosts the static bundle
  (refusing dotfiles and `node_modules`, with a normalized-path traversal guard) and exposes
  `GET /api/v1/health` → `{ok, rules}`.
- *Platform time.* `GET /api/v1/time` → `{now}`; the client round-trip-corrects it into
  `UI.serverOffset` and derives the daily challenge day from it, so the daily rolls on host time
  rather than a device clock. A failed fetch silently falls back to the local clock.
- *Authoritative hosted sessions.* `WS /ws` runs the same rules engine server-side: `create`,
  `join`, `sync`, `command`. The server binds the seat from the socket (a client-supplied
  `player` field is overwritten), dedupes by command id, rejects payloads over 4 KB, rejects
  fragmented frames, answers pings, broadcasts a snapshot with its state hash after every accepted
  command, and emits a `result` frame on round or match end. Dead sessions are swept after 6 hours.

**Not used**

Platform identity, presence, leaderboards, achievement sync, cloud saves and matchmaking. The
profile line reads "Guest profile — progress is saved on this device"; achievements and career
stats are local to `meldhall.save.v1`, and the client has no `/ws` connector yet, so hosted play is
server-complete but not exposed in the UI.

---

## 13. Technical architecture

**Module graph.** `rules.js` and `content.js` depend on nothing; `session.js` depends on both;
`audio.js` and `render.js` are leaves; `ui.js` composes rules/content/session/audio; `main.js`
wires ui ↔ render and owns the browser lifecycle. Every module is a UMD factory, so `tests/run.js`
requires the engine in plain Node with no build step and no dependencies.

**Determinism and replay.** All hidden information derives from one 32-bit seed. `buildReplay`
emits `{schema, rulesVersion, seed, options, commands, hashes, terminal}`; `verifyReplay` re-runs
the command list from `initialState` and compares hashes position by position, so a tampered hash
is detected at its index. The results screen's *Replay* button runs this and announces the outcome.

**Persistence.** `meldhall.settings.v1` and `meldhall.save.v1` in localStorage, each wrapped as
`{v:1, data, checksum}`; a version or checksum mismatch returns the defaults. All storage access is
inside try/catch, so private-mode browsers degrade to an in-memory session.

**Performance budgets.** The scene is rebuilt wholesale on every state change — at most ~60 card
meshes, which is cheap; card face textures are cached per card id in `faceTextures` and the box
geometry is shared. Particles are a single preallocated `Points` buffer sized by tier and excluded
from raycasting. Render scale and pixel ratio are clamped per tier (0.8–2.0). The loop stops
entirely when the tab is hidden or the screen is not `play`. Resize is debounced 80 ms;
orientation change re-resizes after 200 ms.

**Local funnel.** `main.js` keeps an in-memory, anonymous ring buffer (200 entries) of
`start`, `settings_change`, `tutorial_step`, `round_end` and `error` events. Nothing is transmitted.

**How the e2e drives the real UI.** `tests/e2e.mjs` serves the repo on an ephemeral port (refusing
`tests/`, `tools/` and dotfiles), then clicks visible DOM: menu buttons, mode buttons, the `<select>`
for target score, `.card-btn` elements in the hand list, and the action tray — plus one turn driven
purely by key presses. It reads `window.MeldUI.session` only to decide *which* visible element to
click and to wait for the AI, never to mutate state.

---

## 14. Testing and acceptance criteria

`npm test` → `tests/run.js`, 51 assertions, no dependencies:

- meld validity, card values, sub-run enumeration, deal shape and per-seed determinism;
- rejection paths (out of turn, malformed, double draw, discard before draw, bad meld shape,
  bad layoff, layoff onto a full set), no mutation on failure, idempotent duplicate ids;
- going out, the deadwood award, breakdown contents, match termination, `nextRound` carry-over,
  serialize/deserialize round trip and version rejection;
- golden matches across seeds and 2/3/4 seats reach `matchOver`; replay determinism as a property
  test plus tampered-hash detection; 2000 malformed commands rejected cleanly; no NaN in scores;
- content: 40 stages pass `validateStage` and are playable, mastery every fifth, daily seeds
  immutable within a UTC day, five unique themes, lowercase achievement keys, actionable lessons;
- session: undo in practice, none in journey, stage/content agreement, lesson completion,
  idempotent achievements.

`npm run test:e2e` → `tests/e2e.mjs` at 1280×800 and 390×844 (touch), failing on any console error
or page error other than the known SwiftShader/GL noise: title loads → settings open/close → help
open/back → Play → practice at target 30 → hand dealt into the accessible list → a full round played
by clicking cards and tray buttons, exercising Hint and Undo → results → Next round → a second round
including a keyboard-only turn → pause/resume plus settings mid-match → progress verified in
localStorage → leave to title.

**QA bar, as checkable statements.**

1. Every implemented feature is reachable by clicking what is on screen — the e2e reaches results
   twice per viewport without touching an internal API.
2. No console errors or warnings at either viewport; the e2e fails on one.
3. Nothing is cut off at 390×844 portrait or at desktop: the tray and hand wrap, rails become sheets,
   safe-area insets pad every edge.
4. A first-time player is taught: Learn requires the action it describes, How to Play states the four
   rules, and illegal actions are explained in words.
5. Rules, hints, AI and server agree because they call the same functions.
6. `node --check` passes on every first-party JS file.

---

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/hall-keyart.webp` | Title screen backdrop | FLUX.2 klein, seed 70831, 1344×768 → WebP q80 (25 KB) | generated in this pass, wired |
| `assets/results-still.webp` | Results panel banner | FLUX.2 klein, seed 25514, 1024×576 → WebP q80 (45 KB) | generated in this pass, wired |
| `assets/card-back.webp` | Card back art over the procedural back | FLUX.2 klein, seed 41207, 512×512 → WebP q85 (139 KB) | generated in this pass, wired |
| `coverart.png` | Platform cover, 1200×675 | prior pass | shipped |
| `icon.png`, `favicon.svg` | Platform icon and tab icon | prior pass | shipped |
| Card faces, backs, felt, wood, lamps | All in-scene geometry and textures | procedural (`render.js`) | shipped |
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
| Music and ambience | Adaptive pad and room tone | procedural WebAudio (`audio.js`) | shipped, by design |

No 3D model assets: every prop in the hall is parametric geometry, so a mesh import would add
weight without changing the silhouette.

---

## 16. Known limitations

- **English only.** No string table, no locale switch (section 10).
- **Hosted play has no client.** `/ws` is fully implemented and authoritative, but no UI creates or
  joins a hosted session, so multiplayer is unreachable from the game.
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

## Design intent not yet implemented

1. **Nine locales.** en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT, selected from
   `navigator.language` with a manual override in Settings, backed by a JSON string table under
   `data/` and a `t(key)` lookup replacing the literals in `ui.js`, `content.js` and `index.html`.
2. **Hosted play in the client.** A Hosted entry on the mode list that opens a `/ws` connection,
   shows the session code, and reconnects through the existing `sync` op.
3. **Enforced challenge goals.** Turn and deadwood constraints evaluated in the session driver so a
   challenge can be failed, with the failure reason shown on the results screen.
4. **Platform identity and leaderboards.** Replacing the guest profile line with a StarHermit
   identity, and posting daily-challenge results to a shared board.
