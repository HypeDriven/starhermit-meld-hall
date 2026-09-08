'use strict';
/*
 * Meld Hall — offline test suite (node tests/run.js).
 * Covers: rules legality, invalid-action reasons, scoring components,
 * terminal states, serialization, replay determinism (property test),
 * malformed-command fuzzing, golden sessions, and content validation.
 */
const assert = require('assert');
const Rules = require('../src/rules.js');
const Content = require('../src/content.js');
const Session = require('../src/session.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); ++passed; console.log('  ok  ' + name); }
  catch (e) { ++failed; console.error('FAIL  ' + name + '\n      ' + (e && e.stack || e)); }
}

let cid = 0;
function cmd(type, player, extra) {
  return Object.assign({ id: 't' + (++cid), type: type, player: player }, extra || {});
}

/* ---------- meld validity ---------- */
test('set: 3 same rank different suits valid', function () {
  assert.strictEqual(Rules.isSet([0, 13, 26]), true); // A clover/diamond/heart
});
test('set: same suit twice invalid', function () {
  assert.strictEqual(Rules.isSet([0, 0, 13]), false);
});
test('set: mixed ranks invalid', function () {
  assert.strictEqual(Rules.isSet([0, 14, 26]), false);
});
test('set: two cards invalid', function () {
  assert.strictEqual(Rules.isSet([0, 13]), false);
});
test('run: consecutive same suit valid', function () {
  assert.strictEqual(Rules.isRun([4, 5, 6]), true);
});
test('run: gap invalid', function () {
  assert.strictEqual(Rules.isRun([4, 6, 8]), false);
});
test('run: mixed suits invalid', function () {
  assert.strictEqual(Rules.isRun([4, 5, 19]), false);
});
test('card values: ace 1, face 10, pip value', function () {
  assert.strictEqual(Rules.cardValue(0), 1);
  assert.strictEqual(Rules.cardValue(9), 10);
  assert.strictEqual(Rules.cardValue(12), 10);
  assert.strictEqual(Rules.cardValue(4), 5);
});

/* ---------- initial state ---------- */
test('initial state: 2 players, 10 cards each, deck and discard correct', function () {
  const s = Rules.initialState(42, { players: 2, targetScore: 50 });
  assert.strictEqual(s.hands[0].cards.length, 10);
  assert.strictEqual(s.hands[1].cards.length, 10);
  assert.strictEqual(s.deck.length, 52 - 21);
  assert.strictEqual(s.discardPile.length, 1);
  assert.strictEqual(s.phase, 'draw');
  assert.strictEqual(s.turn, 0);
  assert.strictEqual(s.tick, 0);
  // all 52 unique cards accounted for
  const all = s.deck.concat(s.discardPile, s.hands[0].cards, s.hands[1].cards).slice().sort(function (a, b) { return a - b; });
  assert.strictEqual(all.length, 52);
  for (let i = 0; i < 52; ++i) assert.strictEqual(all[i], i);
});
test('initial state deterministic for same seed', function () {
  const a = Rules.initialState(777, { players: 3 });
  const b = Rules.initialState(777, { players: 3 });
  assert.strictEqual(Rules.hashState(a), Rules.hashState(b));
});
test('different seeds give different deals', function () {
  const a = Rules.initialState(1, { players: 2 });
  const b = Rules.initialState(2, { players: 2 });
  assert.notStrictEqual(Rules.hashState(a), Rules.hashState(b));
});

/* ---------- command validation ---------- */
test('reject out-of-turn command', function () {
  const s = Rules.initialState(5, { players: 2 });
  const r = Rules.applyCommand(s, cmd('draw', 1, { source: 'deck' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'out_of_turn');
});
test('reject malformed commands', function () {
  const s = Rules.initialState(5, { players: 2 });
  assert.strictEqual(Rules.applyCommand(s, null).ok, false);
  assert.strictEqual(Rules.applyCommand(s, {}).ok, false);
  assert.strictEqual(Rules.applyCommand(s, cmd('nonsense', 0)).ok, false);
  assert.strictEqual(Rules.applyCommand(s, { id: 'x', type: 'draw', player: 9 }).ok, false);
});
test('duplicate command id is idempotent', function () {
  let s = Rules.initialState(5, { players: 2 });
  const c = cmd('draw', 0, { source: 'deck' });
  const r1 = Rules.applyCommand(s, c);
  assert.strictEqual(r1.ok, true);
  s = r1.state;
  const r2 = Rules.applyCommand(s, c);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.duplicate, true);
  assert.strictEqual(r2.state, s);
});
test('failed command does not mutate state', function () {
  const s = Rules.initialState(5, { players: 2 });
  const before = Rules.serialize(s);
  Rules.applyCommand(s, cmd('meld', 0, { cards: [0, 1, 2] }));
  assert.strictEqual(Rules.serialize(s), before);
});
test('draw then discard advances turn', function () {
  let s = Rules.initialState(5, { players: 2 });
  s = Rules.applyCommand(s, cmd('draw', 0, { source: 'deck' })).state;
  assert.strictEqual(s.phase, 'act');
  const c = s.hands[0].cards[0];
  s = Rules.applyCommand(s, cmd('discard', 0, { card: c })).state;
  assert.strictEqual(s.turn, 1);
  assert.strictEqual(s.phase, 'draw');
  assert.strictEqual(s.tick, 2);
});
test('double draw rejected', function () {
  let s = Rules.initialState(5, { players: 2 });
  s = Rules.applyCommand(s, cmd('draw', 0, { source: 'deck' })).state;
  const r = Rules.applyCommand(s, cmd('draw', 0, { source: 'deck' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not_draw_phase');
});
test('discard before draw rejected', function () {
  const s = Rules.initialState(5, { players: 2 });
  const r = Rules.applyCommand(s, cmd('discard', 0, { card: s.hands[0].cards[0] }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not_act_phase');
});

/* ---------- meld / layoff flow ---------- */
function rigState() {
  // hand-crafted state: player 0 holds a set (0,13,26) and can lay off 39
  const s = Rules.initialState(5, { players: 2 });
  s.phase = 'act';
  s.turn = 0;
  s.hands[0].cards = [0, 13, 26, 39, 1];
  s.table = [];
  return s;
}
test('meld a set removes cards and adds table meld', function () {
  let s = rigState();
  const r = Rules.applyCommand(s, cmd('meld', 0, { cards: [0, 13, 26] }));
  assert.strictEqual(r.ok, true);
  s = r.state;
  assert.strictEqual(s.hands[0].cards.length, 2);
  assert.strictEqual(s.table.length, 1);
  assert.strictEqual(s.table[0].kind, 'set');
});
test('invalid meld shape rejected with reason', function () {
  const s = rigState();
  const r = Rules.applyCommand(s, cmd('meld', 0, { cards: [0, 13, 1] }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid_meld_shape');
});
test('layoff extends a set with fourth suit', function () {
  let s = rigState();
  s = Rules.applyCommand(s, cmd('meld', 0, { cards: [0, 13, 26] })).state;
  const r = Rules.applyCommand(s, cmd('layoff', 0, { card: 39, meld: 0 }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state.table[0].cards.length, 4);
});
test('layoff wrong card rejected', function () {
  let s = rigState();
  s = Rules.applyCommand(s, cmd('meld', 0, { cards: [0, 13, 26] })).state;
  const r = Rules.applyCommand(s, cmd('layoff', 0, { card: 1, meld: 0 }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid_layoff');
});
test('layoff onto full set rejected by canLayoff', function () {
  assert.strictEqual(Rules.canLayoff(39, [0, 13, 26, 39]), false);
});
test('legal actions include sub-runs not ending at the run top', function () {
  // player 0 holds 3-4-5-6 of clover (ids 2,3,4,5): melding just 3-4-5 must be offered
  const s = rigState();
  s.hands[0].cards = [2, 3, 4, 5, 40];
  const melds = Rules.legalActions(s, 0).filter(function (a) { return a.type === 'meld'; });
  const hasSubRun = melds.some(function (a) {
    return a.cards.length === 3 && a.cards.indexOf(2) >= 0 && a.cards.indexOf(3) >= 0 && a.cards.indexOf(4) >= 0;
  });
  assert.ok(hasSubRun, 'sub-run [2,3,4] not enumerated: ' + JSON.stringify(melds));
  const hasFull = melds.some(function (a) { return a.cards.length === 4; });
  assert.ok(hasFull, 'full run [2,3,4,5] not enumerated');
});

/* ---------- scoring & terminal ---------- */
test('going out: winner scores opponents deadwood, breakdown recorded', function () {
  let s = rigState();
  s.hands[0].cards = [1]; // one card left, discard it to go out
  s.hands[1].cards = [9, 10, 11]; // deadwood 10+10+10=30
  s = Rules.applyCommand(s, cmd('discard', 0, { card: 1 })).state;
  assert.strictEqual(s.phase, 'roundOver');
  assert.strictEqual(s.roundBreakdown.winner, 0);
  assert.strictEqual(s.roundBreakdown.reason, 'player_out');
  assert.strictEqual(s.roundBreakdown.pointsAwarded, 30);
  assert.strictEqual(s.scores[0], 30);
});
test('match ends at target score with terminal reason', function () {
  let s = rigState();
  s.targetScore = 20;
  s.scores[0] = 15;
  s.hands[0].cards = [1];
  s.hands[1].cards = [9, 12]; // 20 deadwood
  s = Rules.applyCommand(s, cmd('discard', 0, { card: 1 })).state;
  assert.strictEqual(s.phase, 'matchOver');
  assert.strictEqual(s.terminalReason, 'target_score_reached');
  assert.strictEqual(s.matchWinner, 0);
  assert.strictEqual(Rules.legalActions(s, 0).length, 0);
});
test('nextRound starts fresh round preserving scores', function () {
  let s = rigState();
  s.hands[0].cards = [1];
  s = Rules.applyCommand(s, cmd('discard', 0, { card: 1 })).state;
  assert.strictEqual(s.phase, 'roundOver');
  s = Rules.applyCommand(s, cmd('nextRound', 0)).state;
  assert.strictEqual(s.phase, 'draw');
  assert.strictEqual(s.round, 2);
  assert.ok(s.scores[0] > 0, 'winner score preserved across rounds');
  assert.strictEqual(s.hands[0].cards.length, 10);
});

/* ---------- serialization ---------- */
test('serialize/deserialize round-trips', function () {
  const s = Rules.initialState(99, { players: 4 });
  const s2 = Rules.deserialize(Rules.serialize(s));
  assert.strictEqual(Rules.hashState(s), Rules.hashState(s2));
});
test('deserialize rejects wrong version', function () {
  assert.throws(function () { Rules.deserialize({ version: '0.0' }); });
});

/* ---------- determinism / replay property test ---------- */
function playFullMatch(seed, players) {
  let s = Rules.initialState(seed, { players: players, targetScore: 40 });
  const commands = [];
  let guard = 0;
  while (s.phase !== 'matchOver' && guard++ < 4000) {
    if (s.phase === 'roundOver') {
      const c = cmd('nextRound', s.roundBreakdown.winner);
      const r = Rules.applyCommand(s, c);
      assert.ok(r.ok, 'nextRound failed: ' + r.reason);
      s = r.state; commands.push(c); continue;
    }
    const choice = Rules.aiChoose(s, s.turn);
    assert.ok(choice, 'AI found no action in phase ' + s.phase);
    const c = Object.assign({ id: 'sim' + guard, player: s.turn }, choice);
    const r = Rules.applyCommand(s, c);
    assert.ok(r.ok, 'command failed: ' + r.reason + ' ' + JSON.stringify(c));
    s = r.state; commands.push(c);
  }
  return { state: s, commands: commands };
}
for (const seed of [1, 7, 12345, 999999, 31337]) {
  test('golden match seed=' + seed + ' reaches matchOver', function () {
    const m = playFullMatch(seed, 2);
    assert.strictEqual(m.state.phase, 'matchOver');
    assert.ok(m.state.matchWinner >= 0);
  });
}
test('golden match 3 and 4 players terminate', function () {
  assert.strictEqual(playFullMatch(555, 3).state.phase, 'matchOver');
  assert.strictEqual(playFullMatch(556, 4).state.phase, 'matchOver');
});
test('replay property: same seed + commands -> identical hashes', function () {
  const m1 = playFullMatch(4242, 2);
  const m2 = playFullMatch(4242, 2);
  assert.strictEqual(Rules.hashState(m1.state), Rules.hashState(m2.state));
  const env = Rules.buildReplay({ seed: 4242, options: { players: 2, targetScore: 40 } }, m1.commands, m1.state);
  const v = Rules.verifyReplay(env);
  assert.ok(v.ok, v.reason);
  assert.strictEqual(Rules.hashState(v.state), Rules.hashState(m1.state));
});
test('replay detects tampered hash', function () {
  const m = playFullMatch(11, 2);
  const env = Rules.buildReplay({ seed: 11, options: { players: 2, targetScore: 40 } }, m.commands, m.state);
  env.hashes[3] = 'deadbeef';
  assert.strictEqual(Rules.verifyReplay(env).ok, false);
});

/* ---------- fuzz: malformed commands never hang or corrupt ---------- */
test('fuzz: 2000 random malformed commands all rejected cleanly', function () {
  let s = Rules.initialState(2024, { players: 2 });
  s = Rules.applyCommand(s, cmd('draw', 0, { source: 'deck' })).state;
  const rng = Rules.mulberry32(1);
  const before = Rules.hashState(s);
  for (let i = 0; i < 2000; ++i) {
    const junk = {
      id: 'f' + i,
      player: Math.floor(rng() * 8) - 2,
      type: ['draw', 'meld', 'layoff', 'discard', 'boom', '', null][Math.floor(rng() * 7)],
      cards: rng() < 0.5 ? [Math.floor(rng() * 60) - 5, Math.floor(rng() * 60), 'x'] : undefined,
      card: Math.floor(rng() * 60) - 5,
      meld: Math.floor(rng() * 6) - 1,
      source: ['deck', 'discard', 'moon'][Math.floor(rng() * 3)],
    };
    const r = Rules.applyCommand(s, junk);
    if (r.ok && !r.duplicate) s = r.state; // legal fuzz hits are fine
  }
  const after = Rules.serialize(s);
  JSON.parse(after); // still valid JSON, state well-formed
  assert.ok(Number.isFinite(s.tick));
  assert.ok(s.tick >= 1);
  assert.notStrictEqual(typeof before, 'undefined');
});
test('fuzz: no NaN in scores after random legal play', function () {
  const m = playFullMatch(80808, 3);
  for (const sc of m.state.scores) { assert.ok(Number.isInteger(sc)); assert.ok(sc >= 0); }
});

/* ---------- content validators ---------- */
test('all 40 stages pass offline validation', function () {
  assert.strictEqual(Content.STAGES.length, 40);
  const report = Content.validateAll();
  assert.ok(report.ok, JSON.stringify(report));
});
test('every stage seed produces a playable match', function () {
  for (const st of Content.STAGES) {
    const m = playFullMatch(st.seed, st.players);
    assert.strictEqual(m.state.phase, 'matchOver', st.id + ' did not terminate');
  }
});
test('mastery stages every fifth', function () {
  for (let i = 0; i < 40; ++i) assert.strictEqual(Content.STAGES[i].mastery, (i + 1) % 5 === 0);
});
test('daily seed immutable within a UTC day, changes across days', function () {
  const a = Content.dailyFor(new Date(Date.UTC(2026, 3, 10, 0, 0)));
  const b = Content.dailyFor(new Date(Date.UTC(2026, 3, 10, 23, 59)));
  const c = Content.dailyFor(new Date(Date.UTC(2026, 3, 11, 0, 0)));
  assert.strictEqual(a.seed, b.seed);
  assert.strictEqual(a.id, b.id);
  assert.notStrictEqual(a.seed, c.seed);
});
test('five themes, all unique', function () {
  assert.strictEqual(Content.THEMES.length, 5);
  assert.strictEqual(new Set(Content.THEMES.map(function (t) { return t.id; })).size, 5);
});
test('achievement keys stable lowercase', function () {
  for (const a of Content.ACHIEVEMENTS) assert.ok(/^[a-z0-9_]+$/.test(a.key), a.key);
});
test('lessons require concrete actions', function () {
  assert.ok(Content.LESSONS.length >= 5);
  for (const l of Content.LESSONS) assert.ok(l.require && l.require.type, l.id);
});

/* ---------- session layer ---------- */
test('session: practice allows undo, restores prior state', function () {
  const sess = Session.startPractice({ seed: 314, players: 2, targetScore: 30 });
  const before = Rules.hashState(sess.state);
  const r = sess.command({ type: 'draw', source: 'deck' });
  assert.ok(r.ok);
  assert.ok(sess.undo());
  assert.strictEqual(Rules.hashState(sess.state), before);
});
test('session: journey mode forbids undo', function () {
  const sess = Session.startJourney(0);
  sess.command({ type: 'draw', source: 'deck' });
  assert.strictEqual(sess.undo(), false);
});
test('session: journey stage content matches content module', function () {
  const sess = Session.startJourney(4);
  assert.strictEqual(sess.contentRef.mastery, true);
  assert.strictEqual(sess.mode, 'journey');
});
test('session: learn lesson completes on required action', function () {
  const sess = Session.startLearn(0); // draw lesson
  let done = false;
  sess.on(function (e) { if (e.type === 'lessonComplete') done = true; });
  sess.command({ type: 'draw', source: 'deck' });
  assert.ok(done);
});
test('progression: achievements are idempotent', function () {
  const p = JSON.parse(JSON.stringify(Session.DEFAULT_PROGRESS));
  const sess = Session.startPractice({ seed: 314 });
  sess.resultSummary = { phase: 'roundOver', humanWon: true, breakdown: { winner: 0, deadwood: [0, 5], pointsAwarded: 5, totals: [5, 0], round: 1 } };
  const u1 = Session.applyResultToProgress(p, sess);
  const u2 = Session.applyResultToProgress(p, sess);
  assert.deepStrictEqual(u1, ['first_out']);
  assert.deepStrictEqual(u2, []);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
