'use strict';
/*
 * Meld Hall — versioned content: stages, themes, tutorials, daily seeds.
 * UMD: module.exports in Node, window.MeldContent in browsers.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MeldContent = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {

  const CONTENT_VERSION = '1.0.0';

  /* ---------- five original visual themes ---------- */
  const THEMES = [
    {
      id: 'hall_dusk', name: 'Hall Dusk',
      felt: '#2e5d4b', wood: '#6b4a2f', wall: '#1b2436', accent: '#e8b34b',
      cardBack: '#7a3b3b', keyLight: 0xffe0b3, fill: 0x4a5f8a,
    },
    {
      id: 'morning_gild', name: 'Morning Gild',
      felt: '#3b6e5f', wood: '#8a6a44', wall: '#2a2f26', accent: '#f2d38a',
      cardBack: '#3f5e8a', keyLight: 0xfff3d6, fill: 0x8a9a6a,
    },
    {
      id: 'midnight_parlor', name: 'Midnight Parlor',
      felt: '#23304a', wood: '#4a3230', wall: '#10141f', accent: '#9a7bd0',
      cardBack: '#2e4a6a', keyLight: 0xcdd8ff, fill: 0x3a3f5e,
    },
    {
      id: 'harvest_fair', name: 'Harvest Fair',
      felt: '#5e4a2e', wood: '#7a5232', wall: '#241a12', accent: '#e07840',
      cardBack: '#8a4432', keyLight: 0xffd9a8, fill: 0x7a5a3a,
    },
    {
      id: 'winter_ledger', name: 'Winter Ledger',
      felt: '#3a5560', wood: '#5a5a62', wall: '#161d24', accent: '#7fd0d8',
      cardBack: '#44606e', keyLight: 0xeaf6ff, fill: 0x5a7a86,
    },
  ];

  /* ---------- deterministic seed derivation ---------- */
  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; ++i) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
    return h >>> 0;
  }

  /* ---------- 40 authored journey stages ----------
   * Difficulty is expressed through players, target score, hand size,
   * time/move pressure and goals — not merely bigger numbers.
   * Curve: concept introduced alone, combined with a known one, then a
   * mastery stage (every 5th). */
  const MECHANICS = ['draw', 'meld_set', 'meld_run', 'layoff', 'deadwood', 'pressure'];

  function makeStage(i) {
    const n = i + 1;
    const mastery = n % 5 === 0;
    const band = Math.floor(i / 5); // 0..7
    const players = band < 2 ? 2 : band < 5 ? 3 : 4;
    const targetScore = 40 + band * 15 + (mastery ? 20 : 0);
    const mechCount = Math.min(MECHANICS.length, 2 + Math.floor(i / 4));
    return {
      id: 'stage_' + String(n).padStart(2, '0'),
      index: i,
      version: CONTENT_VERSION,
      seed: hashStr('meld-hall-stage-' + n),
      title: mastery ? 'Mastery ' + n : 'Stage ' + n,
      mastery: mastery,
      players: players,
      targetScore: targetScore,
      aiDifficulty: Math.min(3, 1 + Math.floor(i / 12)), // 1..3
      goals: {
        winMatch: true,
        maxRounds: mastery ? 4 : 6,
        parTurns: 30 + band * 6,
        minScore: mastery ? targetScore : 0,
      },
      mechanics: MECHANICS.slice(0, mechCount),
      tutorialFlags: i === 0 ? ['draw', 'discard'] : i === 1 ? ['meld_set'] : i === 2 ? ['meld_run'] : i === 4 ? ['layoff'] : [],
      theme: THEMES[band % THEMES.length].id,
      initialState: null, // derived from seed at load; recorded for tooling
    };
  }

  const STAGES = [];
  for (let i = 0; i < 40; ++i) STAGES.push(makeStage(i));

  function getStage(idOrIndex) {
    if (typeof idOrIndex === 'number') return STAGES[idOrIndex] || null;
    for (const s of STAGES) if (s.id === idOrIndex) return s;
    return null;
  }

  /* ---------- daily challenge: one immutable seed + ruleset per UTC day ---------- */
  function dailyFor(dateUtc) {
    const d = dateUtc || new Date();
    const key = d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
    return {
      id: 'daily_' + key,
      day: key,
      version: CONTENT_VERSION,
      seed: hashStr('meld-hall-daily-' + key),
      players: 3,
      targetScore: 75,
      aiDifficulty: 2,
      theme: THEMES[hashStr(key) % THEMES.length].id,
      excludedFromRanking: false, // set true (never reseed) if day is defective
    };
  }

  /* ---------- learn-mode lessons: one rule at a time, player must act ---------- */
  const LESSONS = [
    {
      id: 'lesson_draw', title: 'Drawing a card',
      text: 'Every turn begins with a draw. Take the top card of the deck, or the face-up discard.',
      require: { type: 'draw' }, seed: hashStr('lesson-draw'), players: 2, targetScore: 15,
    },
    {
      id: 'lesson_discard', title: 'Discarding',
      text: 'End your turn by discarding one card. Keep your deadwood low.',
      require: { type: 'discard' }, seed: hashStr('lesson-discard'), players: 2, targetScore: 15,
    },
    {
      id: 'lesson_set', title: 'Sets',
      text: 'Three or four cards of the same rank form a set. Meld one now.',
      require: { type: 'meld', kind: 'set' }, seed: hashStr('lesson-set'), players: 2, targetScore: 15,
      rigged: 'set',
    },
    {
      id: 'lesson_run', title: 'Runs',
      text: 'Three or more consecutive cards of one suit form a run. Meld one now.',
      require: { type: 'meld', kind: 'run' }, seed: hashStr('lesson-run'), players: 2, targetScore: 15,
      rigged: 'run',
    },
    {
      id: 'lesson_layoff', title: 'Laying off',
      text: 'Add a card from your hand to a meld already on the table.',
      require: { type: 'layoff' }, seed: hashStr('lesson-layoff'), players: 2, targetScore: 15,
      rigged: 'layoff',
    },
    {
      id: 'lesson_deadwood', title: 'Deadwood',
      text: 'Cards left in hand when someone goes out count against them. Go out to win the round.',
      require: { type: 'any' }, seed: hashStr('lesson-deadwood'), players: 2, targetScore: 30,
    },
  ];

  /* ---------- challenges ---------- */
  const CHALLENGES = [
    {
      id: 'ch_speed', title: 'Quick Fingers', kind: 'speed',
      text: 'Win a match in 25 turns or fewer.',
      seed: hashStr('challenge-speed'), players: 2, targetScore: 40, turnLimit: 25,
    },
    {
      id: 'ch_frugal', title: 'Low Deadwood', kind: 'deadwood',
      text: 'Win a round while holding 5 or fewer deadwood points.',
      seed: hashStr('challenge-frugal'), players: 2, targetScore: 40, maxDeadwoodOnWin: 5,
    },
    {
      id: 'ch_crowd', title: 'Full Hall', kind: 'layout',
      text: 'Four players, no lays from the discard pile on your first turn each round.',
      seed: hashStr('challenge-crowd'), players: 4, targetScore: 60,
    },
  ];

  /* ---------- achievements (stable lowercase keys, idempotent) ---------- */
  const ACHIEVEMENTS = [
    { key: 'first_out', title: 'First Out', text: 'Win your first round.' },
    { key: 'meld_master', title: 'Meld Master', text: 'Play 25 melds across your career.' },
    { key: 'streak_3', title: 'Hat Trick', text: 'Win three matches in a row.' },
    { key: 'mastery_20', title: 'Hall Regular', text: 'Clear 20 journey mastery stages.' },
    { key: 'long_game', title: 'Marathon Table', text: 'Play 100 rounds in total (any assists).' },
  ];

  /* ---------- offline validators ---------- */
  function validateStage(s) {
    const errors = [];
    if (!s.id || !/^stage_\d\d$/.test(s.id)) errors.push('bad_id');
    if (!Number.isInteger(s.seed) || s.seed < 0) errors.push('bad_seed');
    if (s.players < 2 || s.players > 4) errors.push('bad_players');
    if (!(s.targetScore > 0)) errors.push('bad_target');
    if (!s.goals || !s.goals.winMatch) errors.push('bad_goals');
    if (!Array.isArray(s.mechanics) || s.mechanics.length === 0) errors.push('bad_mechanics');
    if (s.goals && s.goals.parTurns > 200) errors.push('unbounded_duration');
    if (THEMES.every(function (t) { return t.id !== s.theme; })) errors.push('bad_theme');
    return errors;
  }

  function validateAll() {
    const report = { stages: {}, daily: null, ok: true };
    for (const s of STAGES) {
      const errs = validateStage(s);
      if (errs.length) { report.ok = false; report.stages[s.id] = errs; }
    }
    // daily determinism: same day -> same seed
    const d1 = dailyFor(new Date(Date.UTC(2026, 0, 15)));
    const d2 = dailyFor(new Date(Date.UTC(2026, 0, 15, 23, 59)));
    if (d1.seed !== d2.seed || d1.id !== d2.id) { report.ok = false; report.daily = 'nondeterministic'; }
    return report;
  }

  return {
    CONTENT_VERSION: CONTENT_VERSION,
    THEMES: THEMES, STAGES: STAGES, LESSONS: LESSONS,
    CHALLENGES: CHALLENGES, ACHIEVEMENTS: ACHIEVEMENTS,
    getStage: getStage, dailyFor: dailyFor,
    hashStr: hashStr, validateStage: validateStage, validateAll: validateAll,
  };
});
