'use strict';
/*
 * Meld Hall — DOM shell: screens, focus management, keyboard, live regions,
 * settings binding, accessible hand mirror, and canvas picking glue.
 * UI state is kept separate from simulation state.
 */
(function (root, factory) {
  const api = factory(root.MeldRules, root.MeldContent, root.MeldSession, root.MeldAudio,
    root.MeldPlatform || null);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MeldUI = api;
})(typeof self !== 'undefined' ? self : globalThis, function (Rules, Content, Session, Audio, Platform) {

  function $(id) { return document.getElementById(id); }

  // Localization (src/i18n.js): T() translates an English key; N() only marks one for later T().
  function T(key, vars) {
    const I = globalThis.MHI18N;
    if (I) return I.T(key, vars);
    return String(key).replace(/\{(\w+)\}/g, function (m, k) { return vars && k in vars ? vars[k] : m; });
  }
  function N(key) { return key; }
  function lang() { return globalThis.MHI18N ? globalThis.MHI18N.lang : 'en-US'; }
  function shT() { return globalThis.ShStrings.shStrings([lang()]); }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  const SCREENS = ['title', 'mode', 'play', 'results', 'help'];

  function UI() {
    this.session = null;
    this.selection = [];          // selected card ids
    this.focusIdx = 0;            // keyboard focus within hand
    this.lastFocus = null;
    this.pendingMode = null;
    this.serverOffset = 0;        // platform time offset (ms)
    this.onRenderRequest = null;  // set by main.js
    this.helpReturn = 'title';
    this._bind();
  }

  /* ---------- helpers ---------- */
  UI.prototype.announce = function (msg) { $('live-region').textContent = msg; };
  UI.prototype.announceError = function (msg) { $('error-region').textContent = msg; };
  UI.prototype.haptic = function () {
    if (this.settings && this.settings.haptics && navigator.vibrate) navigator.vibrate(12);
  };

  UI.prototype.show = function (name) {
    for (const s of SCREENS) $('screen-' + s).classList.toggle('active', s === name);
    const el = $('screen-' + name).querySelector('button, [tabindex], h1, h2');
    if (el) el.focus && el.focus();
    this.currentScreen = name;
  };

  UI.prototype.overlay = function (id, open) {
    const ov = $(id);
    ov.classList.toggle('active', open);
    if (open) {
      this.lastFocus = document.activeElement;
      const b = ov.querySelector('button.primary, button');
      // focus the primary action without scrolling a tall panel past its heading
      if (b) b.focus({ preventScroll: true });
      if (ov.firstElementChild) ov.firstElementChild.scrollTop = 0;
    } else if (this.lastFocus && this.lastFocus.focus) {
      this.lastFocus.focus(); // focus restoration after modal
    }
  };

  /* ---------- title ---------- */
  UI.prototype.refreshTitle = function () {
    const p = Session.loadProgress();
    $('journey-progress').textContent = p.journeyUnlocked + '/' + Content.STAGES.length;
    const d = Content.dailyFor(new Date(Date.now() + this.serverOffset));
    $('daily-date').textContent = d.day;
    const line = $('profile-line');
    if (Platform && Platform.enabled()) {
      line.textContent = T('Playing as {name} — progress {status}.', { name: Platform.displayName(), status: Platform.statusText() });
    } else {
      line.textContent = T('Guest profile — progress is saved on this device.');
    }
  };

  /* ---------- mode select ---------- */
  const MODES = [
    { id: 'practice', name: N('Practice'), desc: N('Custom game vs the hall AI. Undo allowed, unranked.'), ranked: false, minutes: '5–10' },
    { id: 'journey', name: N('Journey'), desc: N('Forty authored stages, one new idea at a time, mastery every fifth.'), ranked: false, minutes: '5–15' },
    { id: 'daily', name: N('Daily'), desc: N('One shared seed and ruleset per UTC day. Ranked.'), ranked: true, minutes: '10' },
    { id: 'challenge', name: N('Challenge'), desc: N('Constrained goals: turn limits, deadwood targets, crowded tables.'), ranked: false, minutes: '5–10' },
    { id: 'learn', name: N('Learn'), desc: N('Interactive lessons. One rule at a time; you perform each action.'), ranked: false, minutes: '2' },
  ];
  function modeDetail(m) {
    return T(m.desc) + ' ' + T('Expected duration: {minutes} min.', { minutes: m.minutes }) + ' ' +
      (m.ranked ? T('This result is ranked.') : T('Not ranked.'));
  }

  UI.prototype.showModeSelect = function (preselect) {
    const list = $('mode-list');
    list.innerHTML = '';
    const chSel = $('opt-challenge');
    const chosen = chSel.value;
    chSel.innerHTML = '';
    for (const c of Content.CHALLENGES) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = T(c.title);
      chSel.appendChild(o);
    }
    if (chosen) chSel.value = chosen;
    const self = this;
    function showOptions(id) {
      $('mode-options').classList.toggle('hidden', id !== 'practice');
      $('mode-challenge-options').classList.toggle('hidden', id !== 'challenge');
    }
    const modes = MODES.slice();
    for (const m of modes) {
      const b = document.createElement('button');
      b.textContent = T(m.name);
      b.dataset.mode = m.id;
      b.setAttribute('aria-describedby', 'mode-detail');
      b.addEventListener('click', function () {
        self.pendingMode = m.id;
        self.modeDetailFull = true;
        $('mode-detail').textContent = modeDetail(m);
        showOptions(m.id);
        Audio.play('ui');
      });
      list.appendChild(b);
    }
    if (preselect !== null) {
      this.pendingMode = preselect || 'practice';
      this.modeDetailFull = false;
    }
    const cur = modes.filter(function (m) { return m.id === self.pendingMode; })[0];
    $('mode-detail').textContent = this.modeDetailFull ? modeDetail(cur) : T(cur.desc);
    showOptions(this.pendingMode);
    if (preselect !== null) this.show('mode');
  };

  UI.prototype.startPendingMode = function () {
    const m = this.pendingMode;
    if (m === 'practice') {
      this.attachSession(Session.startPractice({
        players: parseInt($('opt-players').value, 10),
        targetScore: parseInt($('opt-target').value, 10),
        aiDifficulty: parseInt($('opt-difficulty').value, 10),
      }));
    } else if (m === 'journey') {
      const p = Session.loadProgress();
      this.attachSession(Session.startJourney(p.journeyUnlocked - 1));
    } else if (m === 'daily') {
      this.attachSession(Session.startDaily(Date.now() + this.serverOffset));
    } else if (m === 'challenge') {
      this.attachSession(Session.startChallenge($('opt-challenge').value || 'ch_speed'));
    } else if (m === 'learn') {
      const seen = (this.settings.tutorialSeen || {});
      let idx = Content.LESSONS.findIndex(function (l) { return !seen[l.id]; });
      if (idx < 0) idx = 0;
      this.attachSession(Session.startLearn(idx));
    }
  };

  /* ---------- session wiring ---------- */
  UI.prototype.attachSession = function (session) {
    const self = this;
    this.session = session;
    this.selection = [];
    this.focusIdx = 0;
    session.on(function (evt) { self.onSessionEvent(evt); });
    this.show('play');
    this.syncAll();
    this.announce(this.objectiveText());
    Audio.play('deal');
    session.scheduleAI();
  };

  UI.prototype.objectiveText = function () {
    const s = this.session;
    if (!s) return '';
    const st = s.state;
    if (s.mode === 'learn' && s.contentRef) return T(s.contentRef.title) + ' — ' + T(s.contentRef.text);
    if (s.mode === 'challenge' && s.contentRef) return T(s.contentRef.title) + ': ' + T(s.contentRef.text);
    return T('Round {round} — first to {target} points wins the match. Go out with an empty hand to win the round.', { round: st.round, target: st.targetScore });
  };

  UI.prototype.nameFor = function (p) {
    const s = this.session;
    return p === (s ? s.humanSeat : 0) ? T('You') : T('Opponent {n}', { n: p + 1 });
  };

  UI.prototype.onSessionEvent = function (evt) {
    const s = this.session;
    if (evt.type === 'invalid') {
      Audio.play('invalid');
      this.announceError(T('Action rejected: {reason}', { reason: this.reasonText(evt.reason) }));
      return;
    }
    if (evt.type === 'lessonComplete') {
      this.settings.tutorialSeen[s.contentRef.id] = true;
      Session.saveSettings(this.settings);
      this.announce(T('Lesson complete! Finish the round or start the next lesson.'));
      Audio.play('achievement');
    }
    if (evt.type === 'state') {
      for (const e of evt.events || []) {
        if (e.type === 'draw') Audio.play('draw');
        else if (e.type === 'meld') { Audio.play('meld'); this.burstAt('meld'); }
        else if (e.type === 'layoff') Audio.play('layoff');
        else if (e.type === 'discard') Audio.play('discard');
      }
      if (s.state.turn === s.humanSeat && s.state.phase === 'draw' && (!evt.command || evt.command.type === 'discard')) {
        Audio.play('turn');
        this.announce(T('Your turn. Draw a card.'));
      }
      this.selection = this.selection.filter(function (c) {
        return s.state.hands[s.humanSeat].cards.indexOf(c) >= 0;
      });
      this.syncAll();
      // adaptive music rises with table size
      Audio.setMusicIntensity(Math.min(1, s.state.table.length / 6));
    }
    if (evt.type === 'roundOver' || evt.type === 'matchOver') {
      const p = Session.loadProgress();
      const unlocked = Session.applyResultToProgress(p, s);
      Session.saveProgress(p);
      for (const k of unlocked) Audio.play('achievement');
      this.showResults(unlocked);
    }
  };

  UI.prototype.reasonText = function (r) {
    const map = {
      out_of_turn: N('it is not your turn'),
      not_draw_phase: N('you have already drawn this turn'),
      not_act_phase: N('draw a card first'),
      invalid_meld_shape: N('those cards are not a set or a run'),
      cards_not_in_hand: N('card not in your hand'),
      card_not_in_hand: N('card not in your hand'),
      invalid_layoff: N('that card does not extend the meld'),
      no_such_meld: N('no such meld'),
      deck_empty: N('the deck is empty'),
      discard_empty: N('the discard pile is empty'),
      terminal_roundOver: N('the round has ended'),
      terminal_matchOver: N('the match has ended'),
    };
    return map[r] ? T(map[r]) : r;
  };

  /* ---------- rendering sync ---------- */
  UI.prototype.syncAll = function () {
    const s = this.session;
    if (!s) return;
    const st = s.state;
    const hand = st.hands[s.humanSeat];

    $('hud-objective').textContent = this.objectiveText();
    $('hud-turn').textContent = st.phase === 'matchOver' ? T('Match over')
      : st.phase === 'roundOver' ? T('Round over')
      : st.turn === s.humanSeat ? (st.phase === 'draw' ? T('Your turn — draw') : T('Your turn — meld / discard'))
      : T('{name} is thinking…', { name: this.nameFor(st.turn) });
    $('hud-deck').textContent = T('Deck: {n}', { n: st.deck.length });
    $('hud-score').textContent = T('You {you} — best rival {rival}', { you: st.scores[s.humanSeat],
      rival: Math.max.apply(null, st.scores.filter(function (_, i) { return i !== s.humanSeat; }).concat([0])) });
    $('rail-objective').textContent = this.objectiveText();
    $('rail-progress').textContent = T('Round {round} · deadwood in hand: {deadwood} · table melds: {melds}',
      { round: st.round, deadwood: Rules.deadwood(hand), melds: st.table.length });

    // scores rail
    const rs = $('rail-scores');
    rs.innerHTML = '';
    for (let p = 0; p < st.players; ++p) {
      const div = document.createElement('div');
      div.textContent = T('{name}: {score} ({cards} cards)', { name: this.nameFor(p), score: st.scores[p], cards: st.hands[p].cards.length });
      if (p === s.humanSeat) div.style.color = 'var(--accent)';
      rs.appendChild(div);
    }

    // The meld chips and the hand mirror are rebuilt only when their melds or
    // cards change, and otherwise updated in place: syncAll runs after every
    // AI command, and a click only fires when press and release land on the
    // same element, so a rebuild mid-press lost the click (and keyboard focus).
    // meld chips
    const md = $('meld-dom');
    const chips = st.table.map(function (m, i) {
      return (m.kind === 'set' ? T('Set {n}', { n: i }) : T('Run {n}', { n: i })) + ': ' + m.cards.map(Rules.cardName).join(' ');
    });
    if (md.children.length !== chips.length || chips.some(function (text, i) { return md.children[i].textContent !== text; })) {
      md.innerHTML = '';
      chips.forEach(function (text, i) {
        const chip = document.createElement('button');
        chip.className = 'meld-chip';
        chip.dataset.meld = i;
        chip.textContent = text;
        md.appendChild(chip);
      });
    }

    // accessible hand mirror
    const hd = $('hand-dom');
    const self = this;
    const sameCards = hd.children.length === hand.cards.length && hand.cards.every(function (c, i) {
      return hd.children[i].dataset.card === String(c);
    });
    if (!sameCards) {
      hd.innerHTML = '';
      hand.cards.forEach(function (c) {
        const b = document.createElement('button');
        b.dataset.card = c;
        b.setAttribute('role', 'option');
        b.innerHTML = Rules.RANKS[Rules.rankOf(c)] + '<br>' + Rules.SUIT_GLYPHS[Rules.suitOf(c)];
        hd.appendChild(b);
      });
    }
    hand.cards.forEach(function (c, i) {
      const b = hd.children[i];
      const cls = 'card-btn' + ((Rules.suitOf(c) === 1 || Rules.suitOf(c) === 2) ? ' red' : '') +
        (self.selection.indexOf(c) >= 0 ? ' selected' : '');
      if (b.className !== cls) b.className = cls;
      b.setAttribute('aria-selected', self.selection.indexOf(c) >= 0 ? 'true' : 'false');
      b.setAttribute('aria-label', T('{card}, value {value}', { card: Rules.cardName(c), value: Rules.cardValue(c) }));
    });

    this.syncActionButtons();
    if (this.onRenderRequest) this.onRenderRequest();
  };

  UI.prototype.syncActionButtons = function () {
    const s = this.session;
    const legal = s.legal();
    function has(type) { return legal.some(function (a) { return a.type === type; }); }
    $('act-draw-deck').disabled = !legal.some(function (a) { return a.type === 'draw' && a.source === 'deck'; });
    $('act-draw-discard').disabled = !legal.some(function (a) { return a.type === 'draw' && a.source === 'discard'; });
    $('act-undo').disabled = !s.allowUndo || s.undoStack.length === 0;
    const sel = this.selection;
    // meld button: enabled if current selection is a legal meld
    const meldOk = sel.length >= 3 && legal.some(function (a) {
      return a.type === 'meld' && a.cards.length === sel.length && a.cards.every(function (c) { return sel.indexOf(c) >= 0; });
    });
    $('act-meld').disabled = !meldOk;
    const layOk = sel.length === 1 && legal.some(function (a) { return a.type === 'layoff' && a.card === sel[0]; });
    $('act-layoff').disabled = !layOk;
    $('act-discard').disabled = !(sel.length === 1 && has('discard'));
    $('act-hint').disabled = legal.length === 0;
  };

  UI.prototype.burstAt = function () { if (this.onBurst) this.onBurst(); };

  /* ---------- actions ---------- */
  UI.prototype.doDraw = function (source) { this.session.command({ type: 'draw', source: source }); this.haptic(); };
  UI.prototype.doMeld = function () {
    if (this.selection.length >= 3) this.session.command({ type: 'meld', cards: this.selection.slice() });
    this.haptic();
  };
  UI.prototype.doLayoff = function () {
    if (this.selection.length !== 1) return;
    const legal = this.session.legal().filter((a) => a.type === 'layoff' && a.card === this.selection[0]);
    if (legal.length) this.session.command({ type: 'layoff', card: this.selection[0], meld: legal[0].meld });
    this.haptic();
  };
  UI.prototype.doDiscard = function () {
    if (this.selection.length === 1) this.session.command({ type: 'discard', card: this.selection[0] });
    this.haptic();
  };
  UI.prototype.doHint = function () {
    const legal = this.session.legal();
    if (!legal.length) return;
    let a = legal.find(function (x) { return x.type === 'meld'; })
      || legal.find(function (x) { return x.type === 'layoff'; })
      || legal[0];
    let msg;
    if (a.type === 'draw') msg = a.source === 'deck' ? T('Hint: draw from the deck.') : T('Hint: draw from the discard pile.');
    else if (a.type === 'meld') msg = Rules.meldKind(a.cards) === 'set'
      ? T('Hint: meld {cards} (set).', { cards: a.cards.map(Rules.cardName).join(', ') })
      : T('Hint: meld {cards} (run).', { cards: a.cards.map(Rules.cardName).join(', ') });
    else if (a.type === 'layoff') msg = T('Hint: lay {card} onto meld {n}.', { card: Rules.cardName(a.card), n: a.meld });
    else msg = T('Hint: discard {card}.', { card: Rules.cardName(a.card) });
    this.announce(msg);
    Audio.play('hint');
  };

  UI.prototype.toggleCard = function (cardId) {
    const i = this.selection.indexOf(cardId);
    if (i >= 0) this.selection.splice(i, 1); else this.selection.push(cardId);
    Audio.play('select');
    this.haptic();
    this.syncAll();
  };

  /* ---------- results ---------- */
  UI.prototype.showResults = function (unlocked) {
    const s = this.session;
    const r = s.resultSummary;
    this.lastUnlocked = unlocked || [];
    this.renderResultsText();
    this.showDailyBoard();
    this.postToLeaderboard();
    this.show('results');
    Audio.play(r.phase === 'matchOver' && r.matchWinner === s.humanSeat ? 'matchWin'
      : r.humanWon ? 'roundWin' : 'roundLose');
    this.announce($('results-headline').textContent);
  };

  // Results text only (no sounds, posting or focus), so a language change re-renders it in place.
  UI.prototype.renderResultsText = function () {
    const s = this.session;
    if (!s || !s.resultSummary) return;
    const r = s.resultSummary;
    const b = r.breakdown;
    const unlocked = this.lastUnlocked;
    $('results-h').textContent = r.phase === 'matchOver' ? T('Match over') : T('Round {n} over', { n: b.round });
    $('results-headline').textContent = r.humanWon
      ? T('You took the round! {points} points from deadwood.', { points: b.pointsAwarded })
      : (r.phase === 'matchOver' && r.matchWinner !== s.humanSeat ? T('{name} wins the match.', { name: this.nameFor(r.matchWinner) })
        : T('{name} went out and scored {points}.', { name: this.nameFor(b.winner), points: b.pointsAwarded }));
    const tbl = $('results-table');
    let html = '<tr><th>' + esc(T('Player')) + '</th><th>' + esc(T('Deadwood')) + '</th><th>' + esc(T('Match score')) + '</th></tr>';
    for (let p = 0; p < s.state.players; ++p) {
      html += '<tr' + (p === s.humanSeat ? ' class="you"' : '') + '><td>' +
        esc(this.nameFor(p)) + (p === b.winner ? ' ★' : '') + '</td><td>' +
        b.deadwood[p] + '</td><td>' + b.totals[p] + ' / ' + s.state.targetScore + '</td></tr>';
    }
    html += '<tr><td colspan="3" class="muted">' + esc(b.reason === 'player_out'
      ? T('Reason: a player emptied their hand. Points = sum of opponents’ deadwood.')
      : T('Reason: the deck ran out. Points = sum of opponents’ deadwood minus winner’s own.')) + '</td></tr>';
    tbl.innerHTML = html;
    const ach = $('results-achievements');
    ach.innerHTML = (unlocked && unlocked.length)
      ? unlocked.map(function (k) {
          const a = Content.ACHIEVEMENTS.filter(function (x) { return x.key === k; })[0];
          return '<p><span class="badge">' + esc(T('Achievement')) + '</span> <strong>' + esc(T(a.title)) + '</strong> — ' + esc(T(a.text)) + '</p>';
        }).join('')
      : '';
    $('btn-results-next').textContent = r.phase === 'roundOver' ? T('Next round') : T('Play again');
    this.renderLeaderboardLine();
    this.renderDailyBoard();
  };

  // Signed in only: a finished match (not a lesson) posts the human's match
  // total once and the results screen shows the board rank.
  UI.prototype.postToLeaderboard = function () {
    const line = $('results-lb');
    if (!line) return;
    line.hidden = true;
    const s = this.session;
    if (!s || !s.resultSummary || s.resultSummary.phase !== 'matchOver' || s.mode === 'learn' ||
      !Platform || !Platform.enabled()) return;
    line.hidden = false;
    s.lbResult = null;
    this.renderLeaderboardLine();
    if (!s.lbPost) s.lbPost = Platform.submitScore(s.state.scores[s.humanSeat]);
    const self = this;
    s.lbPost.then(function (r) {
      if (self.session !== s) return;
      s.lbResult = r;
      self.renderLeaderboardLine();
    });
  };
  UI.prototype.renderLeaderboardLine = function () {
    const line = $('results-lb');
    const s = this.session;
    if (!line || line.hidden || !s) return;
    const L = shT();
    const r = s.lbResult;
    line.textContent = !r ? L.lbPosting : !r.posted ? L.lbNotPosted
      : r.rank ? L.lbRank.replace('{rank}', r.rank) : L.lbPosted;
  };

  // Daily is the ranked mode: show the shared board read-only when the
  // platform exposes one; personal bests stay local regardless.
  UI.prototype.showDailyBoard = function () {
    const board = $('results-board');
    board.innerHTML = '';
    const s = this.session;
    if (!s || s.mode !== 'daily' || !Platform || !Platform.enabled()) return;
    this.dailyEntries = undefined;
    this.renderDailyBoard();
    const self = this;
    Platform.fetchLeaderboard().then(function (entries) {
      if (self.session !== s) return;
      self.dailyEntries = entries || null;
      self.renderDailyBoard();
    });
  };
  UI.prototype.renderDailyBoard = function () {
    const board = $('results-board');
    const s = this.session;
    if (!s || s.mode !== 'daily' || !Platform || !Platform.enabled()) return;
    const entries = this.dailyEntries;
    if (entries === undefined) { board.innerHTML = '<p class="muted">' + esc(T('Loading daily board…')) + '</p>'; return; }
    board.innerHTML = (!entries || !entries.length) ? '' :
      '<h3>' + esc(T('Leaderboard')) + '</h3>' +
      '<table class="score-table"><tr><th>#</th><th>' + esc(T('Player')) + '</th><th>' + esc(T('Score')) + '</th></tr>' +
      entries.map(function (e) {
        return '<tr><td>' + e.rank + '</td><td>' + esc(e.name) + '</td><td>' + e.score + '</td></tr>';
      }).join('') + '</table>' +
      '<p class="muted">' + esc(T('Personal bests are kept in your save.')) + '</p>';
  };

  /* ---------- help ---------- */
  UI.prototype.showHelp = function (from) {
    this.helpReturn = from || 'title';
    this.renderHelp();
    this.show('help');
  };
  UI.prototype.renderHelp = function () {
    const card = function (title, body) { return '<div class="panel"><h3>' + esc(title) + '</h3><p>' + body + '</p></div>'; };
    $('help-rules').innerHTML =
      '<div class="menu-grid">' +
      card(T('Draw'), esc(T('Start each turn by taking the deck top card or the face-up discard.'))) +
      card(T('Meld'), T('A <strong>set</strong> is 3–4 cards of one rank. A <strong>run</strong> is 3+ consecutive cards of one suit. Melded cards leave your hand and score safety.')) +
      card(T('Lay off'), esc(T('Extend any table meld with a matching card from your hand.'))) +
      card(T('Discard & deadwood'), esc(T('End your turn with one discard. When a player empties their hand, everyone else’s remaining cards (deadwood) become the winner’s points.'))) +
      '</div>';
    const k = this.keyText.bind(this);
    const li = function (text) { return '<li>' + esc(text) + '</li>'; };
    $('help-controls').innerHTML = '<ul>' +
      li(T('Move between cards: {keys}', { keys: k('left') + ' ' + k('right') })) +
      li(T('Select card: {select} · Draw deck: {deck} · Take discard: {discard}', { select: k('confirm'), deck: k('drawDeck'), discard: k('drawDiscard') })) +
      li(T('Meld selection: {meld} · Lay off: {layoff} · Discard: {discard}', { meld: k('meld'), layoff: k('layoff'), discard: k('discard') })) +
      li(T('Undo (practice): {undo} · Hint: {hint} · Pause: {pause} · Camera reset: {camera} · Cancel: {cancel}', { undo: k('undo'), hint: k('hint'), pause: k('pause'), camera: k('cameraReset'), cancel: k('cancel') })) +
      li(T('Pointer/touch: tap cards to select, tap deck or discard pile to draw, tap a meld marker to lay off.')) + '</ul>';
  };

  /* ---------- language: re-render everything built in code (src/i18n.js re-applies the markup) ---------- */
  UI.prototype.onLanguage = function () {
    this.refreshTitle();
    if (this.currentScreen === 'mode') this.showModeSelect(null);
    if (this.session) this.syncAll();
    if (this.currentScreen === 'results') this.renderResultsText();
    if (this.currentScreen === 'help') this.renderHelp();
  };

  /* ---------- settings ---------- */
  const SETTING_FIELDS = [
    ['set-music', 'music'], ['set-effects', 'effects'], ['set-ambience', 'ambience'], ['set-voice', 'voice'],
    ['set-muted', 'muted', true], ['set-captions', 'captions', true], ['set-motion', 'reducedMotion', true],
    ['set-contrast', 'highContrast', true], ['set-large-text', 'largeText', true],
    ['set-lefty', 'leftHanded', true], ['set-haptics', 'haptics', true], ['set-palette', 'colorPalette'],
  ];
  // Re-read the settings form from this.settings (after the platform settings load).
  UI.prototype.bindSettingsValues = function () {
    const s = this.settings;
    for (const f of SETTING_FIELDS) {
      const el = $(f[0]);
      if (f[2]) el.checked = !!s[f[1]]; else el.value = s[f[1]];
    }
  };

  /* ---------- key bindings ({action: codes[]}, routed by event.code) ---------- */
  // Defaults: the per-device settings.bindings (matching the control.* lines in
  // starhermit.txt); signed-in players get their StarHermit bindings instead.
  UI.prototype.defaultKeys = function () {
    const b = this.settings.bindings;
    const keys = {};
    for (const a of ['left', 'right', 'confirm', 'cancel', 'pause', 'drawDeck', 'drawDiscard', 'meld', 'layoff', 'discard', 'undo', 'hint', 'cameraReset']) {
      keys[a] = [b[a]];
    }
    if (keys.confirm.indexOf('Space') < 0) keys.confirm.push('Space');
    return keys;
  };
  UI.prototype.setKeys = function (keys) { this.keys = keys; };
  function keyLabel(code) {
    const named = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc' };
    if (named[code]) return named[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    return code || '—';
  }
  UI.prototype.keyText = function (action) { return (this.keys[action] || []).map(keyLabel).join('/'); };

  UI.prototype.bindSettings = function (settings, onChange) {
    this.settings = settings;
    this.keys = this.defaultKeys();
    const self = this;
    function wire(id, key, isCheck) {
      const el = $(id);
      if (isCheck) el.checked = !!settings[key]; else el.value = settings[key];
      el.addEventListener('change', function () {
        settings[key] = isCheck ? el.checked : (el.type === 'range' ? parseFloat(el.value) : el.value);
        Session.saveSettings(settings);
        self.applySettings();
        if (onChange) onChange(key);
        Audio.play('ui');
      });
    }
    for (const f of SETTING_FIELDS) wire(f[0], f[1], f[2]); // #set-quality is bound by gfx-ui.js
    this.applySettings();
  };

  UI.prototype.applySettings = function () {
    const s = this.settings;
    document.body.classList.toggle('high-contrast', !!s.highContrast);
    document.body.classList.toggle('large-text', !!s.largeText);
    for (const p of ['deuteranopia', 'protanopia', 'tritanopia'])
      document.body.classList.toggle('palette-' + p, s.colorPalette === p);
    Audio.applySettings(s);
  };

  /* ---------- keyboard ---------- */
  UI.prototype.onKey = function (e) {
    const keys = this.keys;
    const is = function (action) { return (keys[action] || []).indexOf(e.code) >= 0; };
    if (this.currentScreen !== 'play' || !this.session) {
      if (is('cancel')) { this.overlay('overlay-pause', false); this.overlay('overlay-settings', false); }
      return;
    }
    const s = this.session;
    const hand = s.state.hands[s.humanSeat];
    if (is('cancel')) {
      if (this.selection.length) { this.selection = []; this.syncAll(); }
      else this.overlay('overlay-pause', true);
      e.preventDefault(); return;
    }
    if (is('pause')) { this.overlay('overlay-pause', true); e.preventDefault(); return; }
    if (s.isOver()) return;
    if (is('left')) { this.focusIdx = Math.max(0, this.focusIdx - 1); this.focusCard(); e.preventDefault(); }
    else if (is('right')) { this.focusIdx = Math.min(hand.cards.length - 1, this.focusIdx + 1); this.focusCard(); e.preventDefault(); }
    else if (is('confirm')) {
      if (hand.cards[this.focusIdx] !== undefined) this.toggleCard(hand.cards[this.focusIdx]);
      e.preventDefault();
    }
    else if (is('drawDeck')) { this.doDraw('deck'); e.preventDefault(); }
    else if (is('drawDiscard')) { this.doDraw('discard'); e.preventDefault(); }
    else if (is('meld')) { this.doMeld(); e.preventDefault(); }
    else if (is('layoff')) { this.doLayoff(); e.preventDefault(); }
    else if (is('discard')) { this.doDiscard(); e.preventDefault(); }
    else if (is('undo')) { s.undo(); e.preventDefault(); }
    else if (is('hint')) { this.doHint(); e.preventDefault(); }
    else if (is('cameraReset')) { if (this.onCameraReset) this.onCameraReset(); e.preventDefault(); }
  };

  UI.prototype.focusCard = function () {
    const btns = $('hand-dom').querySelectorAll('.card-btn');
    if (btns[this.focusIdx]) btns[this.focusIdx].focus();
  };

  /* ---------- global bindings ---------- */
  UI.prototype._bind = function () {
    const self = this;
    function click(id, fn) { $(id).addEventListener('click', function () { Audio.ensure(); fn(); }); }

    click('btn-play', function () { self.showModeSelect('practice'); });
    click('btn-daily', function () { self.attachSession(Session.startDaily(Date.now() + self.serverOffset)); });
    click('btn-journey', function () {
      const p = Session.loadProgress();
      self.attachSession(Session.startJourney(p.journeyUnlocked - 1));
    });
    click('btn-learn', function () { self.pendingMode = 'learn'; self.startPendingMode(); });
    click('btn-help', function () { self.showHelp('title'); });
    click('btn-settings', function () { self.overlay('overlay-settings', true); });
    click('btn-mode-back', function () {
      self.show('title');
      self.refreshTitle();
    });
    click('btn-mode-start', function () { self.startPendingMode(); });

    click('act-draw-deck', function () { self.doDraw('deck'); });
    click('act-draw-discard', function () { self.doDraw('discard'); });
    click('act-meld', function () { self.doMeld(); });
    click('act-layoff', function () { self.doLayoff(); });
    click('act-discard', function () { self.doDiscard(); });
    click('act-undo', function () { if (self.session) self.session.undo(); });
    click('act-hint', function () { self.doHint(); });

    click('btn-pause', function () { self.overlay('overlay-pause', true); });
    click('btn-resume', function () { self.overlay('overlay-pause', false); });
    click('btn-pause-settings', function () { self.overlay('overlay-settings', true); });
    click('btn-pause-help', function () { self.overlay('overlay-pause', false); self.showHelp('play'); });
    click('btn-leave', function () {
      self.overlay('overlay-pause', false);
      if (self.session && self.session.aiTimer) clearTimeout(self.session.aiTimer);
      self.session = null;
      self.show('title'); self.refreshTitle();
    });
    click('btn-settings-close', function () { self.overlay('overlay-settings', false); });
    click('btn-help-back', function () {
      if (self.helpReturn === 'play') self.show('play'); else { self.show('title'); self.refreshTitle(); }
    });
    click('btn-results-leave', function () {
      self.session = null; self.show('title'); self.refreshTitle();
    });
    click('btn-results-replay', function () { self.replayLast(); });
    click('btn-results-next', function () {
      const s = self.session;
      if (s && s.state.phase === 'roundOver') { s.nextRound(); self.show('play'); self.syncAll(); Audio.play('deal'); }
      else if (s) {
        if (s.mode === 'journey' && s.resultSummary && s.resultSummary.matchWinner === s.humanSeat) {
          const next = Math.min(Content.STAGES.length - 1, s.contentRef.index + 1);
          self.attachSession(Session.startJourney(next));
        } else {
          self.attachSession(Session.startPractice({ players: s.state.players, targetScore: s.state.targetScore }));
        }
      }
    });
    click('btn-rail-left', function () { $('rail-left').classList.toggle('open'); });
    click('btn-rail-right', function () { $('rail-right').classList.toggle('open'); });
    click('btn-compat-continue', function () { $('compat-message').classList.remove('active'); });

    // hand mirror clicks (delegated)
    $('hand-dom').addEventListener('click', function (e) {
      const b = e.target.closest('.card-btn');
      if (b) self.toggleCard(parseInt(b.dataset.card, 10));
    });
    // meld chips: lay off selected single card onto that meld
    $('meld-dom').addEventListener('click', function (e) {
      const chip = e.target.closest('.meld-chip');
      if (!chip || !self.session || self.selection.length !== 1) return;
      self.session.command({ type: 'layoff', card: self.selection[0], meld: parseInt(chip.dataset.meld, 10) });
    });

    document.addEventListener('keydown', function (e) { self.onKey(e); });
    document.addEventListener('mh-language', function () { self.onLanguage(); });
  };

  UI.prototype.replayLast = function () {
    const s = this.session;
    if (!s || !s.resultSummary) return;
    if (!s.resultSummary.replay) return;
    const env = s.resultSummary.replay;
    const v = Rules.verifyReplay(env);
    this.announce(v.ok ? T('Replay verified: identical final state.') : T('Replay mismatch: {reason}', { reason: v.reason }));
  };

  return new UI();
});
