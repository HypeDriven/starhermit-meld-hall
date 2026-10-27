// The save document and the game's options (src/store.js): the browser
// build's cloud slot migrates, two devices' progress merges without losing
// either side's, session.js's checksummed envelope round-trips through the
// engine client's localStorage stand-in, and only valid options are kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Store = require('../src/store.js');
const Session = require('../src/session.js');

test('the browser build\'s cloud slot (plain progress JSON) reads as progress', () => {
  const old = { journeyUnlocked: 7, journeyCleared: { stage_01: true }, achievements: { first_out: true }, career: { melds: 30, rounds: 12, winStreak: 1, bestStreak: 3 } };
  const p = Store.readForeign(JSON.stringify(old));
  assert.equal(p.journeyUnlocked, 7);
  assert.deepEqual(p.journeyCleared, { stage_01: true });
  assert.equal(p.career.melds, 30);
  assert.equal(p.masteryCleared, 0, 'missing fields take the defaults');
  assert.equal(Store.readForeign('not json'), null);
  assert.equal(Store.readForeign(null), null);
  assert.equal(Store.readForeign('[1,2]'), null);
});

test('two devices merge: further unlock, union of clears and achievements, larger counters', () => {
  const a = { journeyUnlocked: 3, journeyCleared: { stage_01: true }, achievements: { first_out: true }, dailiesPlayed: { d1: true }, masteryCleared: 1, career: { melds: 5, rounds: 9, winStreak: 0, bestStreak: 2 } };
  const b = { journeyUnlocked: 5, journeyCleared: { stage_02: true }, achievements: { meld_master: true }, dailiesPlayed: { d2: true }, masteryCleared: 0, career: { melds: 25, rounds: 4, winStreak: 2, bestStreak: 2 } };
  const m = Store.mergeProgress(a, b);
  assert.equal(m.journeyUnlocked, 5);
  assert.deepEqual(Object.keys(m.journeyCleared).sort(), ['stage_01', 'stage_02']);
  assert.deepEqual(Object.keys(m.achievements).sort(), ['first_out', 'meld_master']);
  assert.deepEqual(Object.keys(m.dailiesPlayed).sort(), ['d1', 'd2']);
  assert.equal(m.masteryCleared, 1);
  assert.deepEqual(m.career, { melds: 25, rounds: 9, winStreak: 2, bestStreak: 2 });
  assert.ok(Store.same(Store.mergeProgress(m, a), m), 'merging again changes nothing');
  assert.ok(Store.same(Store.mergeProgress(null, a), Store.mergeProgress(a, null)));
});

test('session.js reads and writes progress through the envelope the stand-in keeps', () => {
  let saved = Store.normalize(null);
  globalThis.localStorage = {
    getItem: (k) => (k === 'meldhall.save.v1' ? Store.wrap(saved) : null),
    setItem: (k, v) => { if (k === 'meldhall.save.v1') saved = Store.normalize(Store.unwrap(v)); },
  };
  try {
    const p = Session.loadProgress();
    p.journeyUnlocked = 4;
    Session.saveProgress(p);
    assert.equal(saved.journeyUnlocked, 4);
    assert.equal(Session.loadProgress().journeyUnlocked, 4);
    assert.equal(Store.unwrap('{"v":1,"data":{},"checksum":1}'), null, 'a bad checksum is refused');
  } finally { delete globalThis.localStorage; }
});

test('options: only valid values are kept; the browser build\'s settings keys are all removed', () => {
  assert.deepEqual(Store.pickOptions({ captions: false, haptics: 'yes', colorPalette: 'tritanopia', leftHanded: true, tutorialSeen: { lesson_draw: true, x: 1 } }),
    { captions: false, colorPalette: 'tritanopia', leftHanded: true, tutorialSeen: { lesson_draw: true } });
  assert.deepEqual(Store.pickOptions({ colorPalette: 'neon' }), {});
  for (const k of Store.OPTION_KEYS) assert.ok(Store.BROWSER_KEYS.includes(k), k);
  for (const k of ['music', 'graphics', 'ui.language', 'highContrast']) assert.ok(Store.BROWSER_KEYS.includes(k), k);
});
