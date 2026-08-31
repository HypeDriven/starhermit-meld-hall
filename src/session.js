'use strict';
/*
 * Meld Hall — session driver.
 * Owns local match state, modes (learn/journey/daily/practice/challenge),
 * undo (practice), replay envelopes, AI pacing, and persistence of
 * settings/progression. Rules state only changes through validated commands.
 */
(function (root, factory) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const Rules = isNode ? require('./rules.js') : root.MeldRules;
  const Content = isNode ? require('./content.js') : root.MeldContent;
  const api = factory(Rules, Content);
  if (isNode) module.exports = api;
  if (root) root.MeldSession = api;
})(typeof self !== 'undefined' ? self : globalThis, function (Rules, Content) {

  const SAVE_KEY = 'meldhall.save.v1';
  const SETTINGS_KEY = 'meldhall.settings.v1';

  let cmdCounter = 0;
  function nextCmdId() { return 'c' + (++cmdCounter) + '_' + Date.now().toString(36); }

  const DEFAULT_SETTINGS = {
    music: 0.5, effects: 0.8, ambience: 0.4, voice: 0.0,
    muted: false, captions: true,
    quality: 'auto',           // auto | low | medium | high
    reducedMotion: false, highContrast: false, largeText: false,
    colorPalette: 'default',   // default | deuteranopia | protanopia | tritanopia
    leftHanded: false, holdToConfirm: false, timingAssist: false, haptics: true,
    camera: 'default', tutorialSeen: {},
    bindings: {
      confirm: 'Enter', cancel: 'Escape', pause: 'KeyP',
      drawDeck: 'KeyD', drawDiscard: 'KeyF', meld: 'KeyM',
      layoff: 'KeyL', discard: 'KeyX', undo: 'KeyU', hint: 'KeyH',
      cameraReset: 'KeyC', left: 'ArrowLeft', right: 'ArrowRight',
      up: 'ArrowUp', down: 'ArrowDown',
    },
  };

  function loadJSON(key, fallback) {
    try {
      if (typeof localStorage === 'undefined') return fallback;
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const doc = JSON.parse(raw);
      if (doc && doc.v === 1 && doc.checksum === checksum(doc.data)) return doc.data;
      return fallback;
    } catch (_) { return fallback; }
  }
  function saveJSON(key, data) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(key, JSON.stringify({ v: 1, data: data, checksum: checksum(data) }));
    } catch (_) {}
  }
  function checksum(data) {
    const s = JSON.stringify(data);
    let h = 5381;
    for (let i = 0; i < s.length; ++i) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
    return h;
  }

  const DEFAULT_PROGRESS = {
    journeyUnlocked: 1, journeyCleared: {}, masteryCleared: 0,
    dailiesPlayed: {}, achievements: {},
    career: { melds: 0, rounds: 0, winStreak: 0, bestStreak: 0 },
    lastDailySeed: null,
  };

  /* ---------- session ---------- */
  function Session(opts) {
    this.mode = opts.mode;                 // learn | journey | daily | practice | challenge
    this.contentRef = opts.content || null; // stage/lesson/challenge object
    this.humanSeat = 0;
    this.aiDifficulty = opts.aiDifficulty || 1;
    this.allowUndo = opts.mode === 'practice';
    this.commands = [];                    // applied commands (replay)
    this.undoStack = [];                   // prior states (practice only)
    this.listeners = [];
    this.aiTimer = null;
    const seed = opts.seed >>> 0;
    this.initial = {
      seed: seed,
      options: {
        players: opts.players || 2,
        targetScore: opts.targetScore || 100,
        handSize: opts.handSize,
      },
    };
    this.state = Rules.initialState(seed, this.initial.options);
    this.lessonDone = false;
    this.resultSummary = null;
  }

  Session.prototype.on = function (fn) { this.listeners.push(fn); };
  Session.prototype.emit = function (evt) {
    for (const fn of this.listeners) { try { fn(evt, this); } catch (e) { console.error(e); } }
  };

  Session.prototype.legal = function () {
    return Rules.legalActions(this.state, this.humanSeat);
  };

  // The single mutation path. Returns { ok, reason? }.
  Session.prototype.command = function (cmd) {
    cmd.player = this.humanSeat;
    cmd.id = cmd.id || nextCmdId();
    const before = this.state;
    const r = Rules.applyCommand(before, cmd);
    if (!r.ok) {
      this.emit({ type: 'invalid', reason: r.reason });
      return r;
    }
    if (r.duplicate) return r;
    if (this.allowUndo) this.undoStack.push(Rules.serialize(before));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.state = r.state;
    this.commands.push(cmd);
    this.emit({ type: 'state', events: r.events, command: cmd });
    this.checkLesson(cmd);
    this.maybeFinish();
    if (!this.isOver()) this.scheduleAI();
    return r;
  };

  Session.prototype.undo = function () {
    if (!this.allowUndo || this.undoStack.length === 0) return false;
    // pop back to the last state where it was the human's draw phase
    while (this.undoStack.length) {
      const json = this.undoStack.pop();
      const s = Rules.deserialize(json);
      const idx = this.commands.map(function (c) { return c.id; }).lastIndexOf(s.lastCommandId);
      this.state = s;
      this.commands = this.commands.slice(0, Math.max(0, idx + 1));
      if (s.turn === this.humanSeat && s.phase === 'draw') break;
    }
    this.emit({ type: 'state', events: [{ type: 'undo' }] });
    return true;
  };

  Session.prototype.isOver = function () {
    return this.state.phase === 'matchOver' || this.state.phase === 'roundOver';
  };

  Session.prototype.nextRound = function () {
    if (this.state.phase !== 'roundOver') return { ok: false, reason: 'not_round_over' };
    const r = Rules.applyCommand(this.state, { id: nextCmdId(), player: this.humanSeat, type: 'nextRound' });
    if (r.ok) { this.state = r.state; this.commands.push({ id: this.state.lastCommandId, player: 0, type: 'nextRound' }); this.emit({ type: 'state', events: r.events }); this.scheduleAI(); }
    return r;
  };

  Session.prototype.scheduleAI = function () {
    const self = this;
    if (this.aiTimer) { clearTimeout(this.aiTimer); this.aiTimer = null; }
    if (typeof setTimeout === 'undefined') return;
    if (this.state.turn === this.humanSeat || this.isOver()) return;
    const delay = Math.max(250, 900 - this.aiDifficulty * 200);
    this.aiTimer = setTimeout(function () {
      self.aiTimer = null;
      const p = self.state.turn;
      const choice = Rules.aiChoose(self.state, p);
      if (!choice) return;
      choice.player = p;
      choice.id = nextCmdId();
      const r = Rules.applyCommand(self.state, choice);
      if (r.ok && !r.duplicate) {
        self.state = r.state;
        self.commands.push(choice);
        self.emit({ type: 'state', events: r.events, command: choice, ai: true });
        self.maybeFinish();
        if (!self.isOver()) self.scheduleAI();
      }
    }, delay);
  };

  Session.prototype.checkLesson = function (cmd) {
    if (this.mode !== 'learn' || !this.contentRef || this.lessonDone) return;
    const req = this.contentRef.require;
    if (!req || req.type === 'any') return;
    if (cmd.type === req.type && (!req.kind || (cmd.type === 'meld' && Rules.meldKind(cmd.cards) === req.kind))) {
      this.lessonDone = true;
      this.emit({ type: 'lessonComplete', lesson: this.contentRef.id });
    }
  };

  Session.prototype.maybeFinish = function () {
    const s = this.state;
    if (s.phase === 'roundOver' || s.phase === 'matchOver') {
      const b = s.roundBreakdown;
      const humanWon = b && b.winner === this.humanSeat;
      this.resultSummary = {
        phase: s.phase,
        winner: b ? b.winner : -1,
        humanWon: !!humanWon,
        breakdown: b,
        matchWinner: s.matchWinner !== undefined ? s.matchWinner : null,
        replay: Rules.buildReplay(this.initial, this.commands, s),
      };
      this.emit({ type: this.state.phase, summary: this.resultSummary });
    }
  };

  /* ---------- mode factories ---------- */
  function startLearn(lessonIndex) {
    const lesson = Content.LESSONS[Math.max(0, Math.min(Content.LESSONS.length - 1, lessonIndex || 0))];
    return new Session({
      mode: 'learn', content: lesson, seed: lesson.seed,
      players: lesson.players, targetScore: lesson.targetScore,
    });
  }
  function startJourney(stageIndex) {
    const st = Content.getStage(stageIndex);
    return new Session({
      mode: 'journey', content: st, seed: st.seed, players: st.players,
      targetScore: st.targetScore, aiDifficulty: st.aiDifficulty,
    });
  }
  function startDaily(serverNow) {
    const d = Content.dailyFor(serverNow ? new Date(serverNow) : undefined);
    return new Session({
      mode: 'daily', content: d, seed: d.seed, players: d.players,
      targetScore: d.targetScore, aiDifficulty: d.aiDifficulty,
    });
  }
  function startPractice(opts) {
    opts = opts || {};
    const seed = opts.seed !== undefined ? opts.seed : (Math.random() * 0xffffffff) >>> 0;
    return new Session({
      mode: 'practice', seed: seed,
      players: opts.players || 2,
      targetScore: opts.targetScore || 50,
      aiDifficulty: opts.aiDifficulty || 1,
    });
  }
  function startChallenge(id) {
    const ch = Content.CHALLENGES.filter(function (c) { return c.id === id; })[0] || Content.CHALLENGES[0];
    return new Session({
      mode: 'challenge', content: ch, seed: ch.seed, players: ch.players,
      targetScore: ch.targetScore, aiDifficulty: 2,
    });
  }

  /* ---------- progression ---------- */
  function applyResultToProgress(progress, session) {
    const p = progress;
    const r = session.resultSummary;
    if (!r || !r.breakdown) return [];
    const unlocked = [];
    p.career.rounds += 1;
    const melds = session.state.hands[session.humanSeat].melds;
    p.career.melds += melds.reduce(function (a, b) { return a + b; }, 0);
    function grant(key) {
      if (!p.achievements[key]) { p.achievements[key] = true; unlocked.push(key); }
    }
    if (r.humanWon) grant('first_out');
    if (p.career.melds >= 25) grant('meld_master');
    if (p.career.rounds >= 100) grant('long_game');
    if (r.phase === 'matchOver') {
      if (r.matchWinner === session.humanSeat) {
        p.career.winStreak += 1;
        if (p.career.winStreak > p.career.bestStreak) p.career.bestStreak = p.career.winStreak;
        if (p.career.winStreak >= 3) grant('streak_3');
        if (session.mode === 'journey' && session.contentRef) {
          const idx = session.contentRef.index;
          p.journeyCleared[session.contentRef.id] = true;
          if (idx + 2 > p.journeyUnlocked) p.journeyUnlocked = Math.min(Content.STAGES.length, idx + 2);
          if (session.contentRef.mastery) {
            p.masteryCleared += 1;
            if (p.masteryCleared >= 20) grant('mastery_20');
          }
        }
      } else {
        p.career.winStreak = 0;
      }
    }
    return unlocked;
  }

  return {
    Session: Session,
    startLearn: startLearn, startJourney: startJourney,
    startDaily: startDaily, startPractice: startPractice, startChallenge: startChallenge,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS, DEFAULT_PROGRESS: DEFAULT_PROGRESS,
    loadSettings: function () { return Object.assign({}, DEFAULT_SETTINGS, loadJSON(SETTINGS_KEY, {})); },
    saveSettings: function (s) { saveJSON(SETTINGS_KEY, s); },
    loadProgress: function () {
      const p = loadJSON(SAVE_KEY, null);
      return p ? Object.assign(JSON.parse(JSON.stringify(DEFAULT_PROGRESS)), p) : JSON.parse(JSON.stringify(DEFAULT_PROGRESS));
    },
    saveProgress: function (p) { saveJSON(SAVE_KEY, p); },
    applyResultToProgress: applyResultToProgress,
  };
});
