'use strict';
/*
 * Meld Hall — DOM shell: screens, focus management, keyboard, live regions,
 * settings binding, accessible hand mirror, and canvas picking glue.
 * UI state is kept separate from simulation state.
 */
(function (root, factory) {
  const api = factory(root.MeldRules, root.MeldContent, root.MeldSession, root.MeldAudio);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MeldUI = api;
})(typeof self !== 'undefined' ? self : globalThis, function (Rules, Content, Session, Audio) {

  function $(id) { return document.getElementById(id); }

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
      if (b) b.focus();
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
  };

  /* ---------- mode select ---------- */
  const MODES = [
    { id: 'practice', name: 'Practice', desc: 'Custom game vs the hall AI. Undo allowed, unranked.', ranked: false, minutes: '5–10 min' },
    { id: 'journey', name: 'Journey', desc: 'Forty authored stages, one new idea at a time, mastery every fifth.', ranked: false, minutes: '5–15 min' },
    { id: 'daily', name: 'Daily', desc: 'One shared seed and ruleset per UTC day. Ranked.', ranked: true, minutes: '10 min' },
    { id: 'challenge', name: 'Challenge', desc: 'Constrained goals: turn limits, deadwood targets, crowded tables.', ranked: false, minutes: '5–10 min' },
    { id: 'learn', name: 'Learn', desc: 'Interactive lessons. One rule at a time; you perform each action.', ranked: false, minutes: '2 min' },
  ];

  UI.prototype.showModeSelect = function (preselect) {
    const list = $('mode-list');
    list.innerHTML = '';
    const self = this;
    for (const m of MODES) {
      const b = document.createElement('button');
      b.textContent = m.name;
      b.setAttribute('aria-describedby', 'mode-detail');
      b.addEventListener('click', function () {
        self.pendingMode = m.id;
        $('mode-detail').textContent = m.desc + ' Expected duration: ' + m.minutes + '. ' +
          (m.ranked ? 'This result is ranked.' : 'Not ranked.');
        $('mode-options').classList.toggle('hidden', m.id !== 'practice');
        Audio.play('ui');
      });
      list.appendChild(b);
    }
    this.pendingMode = preselect || 'practice';
    $('mode-detail').textContent = MODES.filter(function (m) { return m.id === self.pendingMode; })[0].desc;
    $('mode-options').classList.toggle('hidden', this.pendingMode !== 'practice');
    this.show('mode');
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
      this.attachSession(Session.startChallenge('ch_speed'));
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
    session.scheduleAI();
  };

  UI.prototype.objectiveText = function () {
    const s = this.session;
    if (!s) return '';
    const st = s.state;
    if (s.mode === 'learn' && s.contentRef) return s.contentRef.title + ' — ' + s.contentRef.text;
    if (s.mode === 'challenge' && s.contentRef) return s.contentRef.title + ': ' + s.contentRef.text;
    return 'Round ' + st.round + ' — first to ' + st.targetScore + ' points wins the match. Go out with an empty hand to win the round.';
  };

  UI.prototype.onSessionEvent = function (evt) {
    const s = this.session;
    if (evt.type === 'invalid') {
      Audio.play('invalid');
      this.announceError('Action rejected: ' + this.reasonText(evt.reason));
      return;
    }
    if (evt.type === 'lessonComplete') {
      this.settings.tutorialSeen[s.contentRef.id] = true;
      Session.saveSettings(this.settings);
      this.announce('Lesson complete! Finish the round or start the next lesson.');
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
        this.announce('Your turn. Draw a card.');
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
      out_of_turn: 'it is not your turn',
      not_draw_phase: 'you have already drawn this turn',
      not_act_phase: 'draw a card first',
      invalid_meld_shape: 'those cards are not a set or a run',
      cards_not_in_hand: 'card not in your hand',
      card_not_in_hand: 'card not in your hand',
      invalid_layoff: 'that card does not extend the meld',
      no_such_meld: 'no such meld',
      deck_empty: 'the deck is empty',
      discard_empty: 'the discard pile is empty',
      terminal_roundOver: 'the round has ended',
      terminal_matchOver: 'the match has ended',
    };
    return map[r] || r;
  };

  /* ---------- rendering sync ---------- */
  UI.prototype.syncAll = function () {
    const s = this.session;
    if (!s) return;
    const st = s.state;
    const hand = st.hands[s.humanSeat];

    $('hud-objective').textContent = this.objectiveText();
    $('hud-turn').textContent = st.phase === 'matchOver' ? 'Match over'
      : st.phase === 'roundOver' ? 'Round over'
      : st.turn === s.humanSeat ? (st.phase === 'draw' ? 'Your turn — draw' : 'Your turn — meld / discard')
      : 'Opponent ' + (st.turn + 1) + ' is thinking…';
    $('hud-deck').textContent = 'Deck: ' + st.deck.length;
    $('hud-score').textContent = 'You ' + st.scores[s.humanSeat] + ' — best rival ' +
      Math.max.apply(null, st.scores.filter(function (_, i) { return i !== s.humanSeat; }).concat([0]));
    $('rail-objective').textContent = this.objectiveText();
    $('rail-progress').textContent = 'Round ' + st.round + ' · deadwood in hand: ' + Rules.deadwood(hand) +
      ' · table melds: ' + st.table.length;

    // scores rail
    const rs = $('rail-scores');
    rs.innerHTML = '';
    for (let p = 0; p < st.players; ++p) {
      const div = document.createElement('div');
      div.textContent = (p === s.humanSeat ? 'You' : 'Opponent ' + (p + 1)) + ': ' + st.scores[p] +
        ' (' + st.hands[p].cards.length + ' cards)';
      if (p === s.humanSeat) div.style.color = 'var(--accent)';
      rs.appendChild(div);
    }

    // meld chips
    const md = $('meld-dom');
    md.innerHTML = '';
    st.table.forEach(function (m, i) {
      const chip = document.createElement('button');
      chip.className = 'meld-chip';
      chip.dataset.meld = i;
      chip.textContent = (m.kind === 'set' ? 'Set' : 'Run') + ' ' + i + ': ' + m.cards.map(Rules.cardName).join(' ');
      md.appendChild(chip);
    });

    // accessible hand mirror
    const hd = $('hand-dom');
    hd.innerHTML = '';
    const self = this;
    hand.cards.forEach(function (c, i) {
      const b = document.createElement('button');
      b.className = 'card-btn' + ((Rules.suitOf(c) === 1 || Rules.suitOf(c) === 2) ? ' red' : '') +
        (self.selection.indexOf(c) >= 0 ? ' selected' : '');
      b.dataset.card = c;
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', self.selection.indexOf(c) >= 0 ? 'true' : 'false');
      b.setAttribute('aria-label', Rules.cardName(c) + ', value ' + Rules.cardValue(c));
      b.innerHTML = Rules.RANKS[Rules.rankOf(c)] + '<br>' + Rules.SUIT_GLYPHS[Rules.suitOf(c)];
      hd.appendChild(b);
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
    if (a.type === 'draw') msg = 'Hint: draw from the ' + a.source + '.';
    else if (a.type === 'meld') msg = 'Hint: meld ' + a.cards.map(Rules.cardName).join(', ') + ' (' + (Rules.meldKind(a.cards)) + ').';
    else if (a.type === 'layoff') msg = 'Hint: lay ' + Rules.cardName(a.card) + ' onto meld ' + a.meld + '.';
    else msg = 'Hint: discard ' + Rules.cardName(a.card) + '.';
    this.announce(msg);
    Audio.play('select');
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
    const b = r.breakdown;
    $('results-h').textContent = r.phase === 'matchOver' ? 'Match over' : 'Round ' + b.round + ' over';
    $('results-headline').textContent = r.humanWon
      ? 'You took the round! ' + b.pointsAwarded + ' points from deadwood.'
      : (r.phase === 'matchOver' && r.matchWinner !== s.humanSeat ? 'Opponent ' + (r.matchWinner + 1) + ' wins the match.'
        : 'Opponent ' + (b.winner + 1) + ' went out and scored ' + b.pointsAwarded + '.');
    const tbl = $('results-table');
    let html = '<tr><th>Player</th><th>Deadwood</th><th>Match score</th></tr>';
    for (let p = 0; p < s.state.players; ++p) {
      html += '<tr' + (p === s.humanSeat ? ' class="you"' : '') + '><td>' +
        (p === s.humanSeat ? 'You' : 'Opponent ' + (p + 1)) + (p === b.winner ? ' ★' : '') + '</td><td>' +
        b.deadwood[p] + '</td><td>' + b.totals[p] + ' / ' + s.state.targetScore + '</td></tr>';
    }
    html += '<tr><td colspan="3" class="muted">Reason: ' + (b.reason === 'player_out' ? 'a player emptied their hand' : 'the deck ran out') +
      '. Points = sum of opponents\u2019 deadwood' + (b.reason === 'deck_exhausted' ? ' minus winner\u2019s own' : '') + '.</td></tr>';
    tbl.innerHTML = html;
    const ach = $('results-achievements');
    ach.innerHTML = (unlocked && unlocked.length)
      ? unlocked.map(function (k) {
          const a = Content.ACHIEVEMENTS.filter(function (x) { return x.key === k; })[0];
          return '<p><span class="badge">Achievement</span> <strong>' + a.title + '</strong> — ' + a.text + '</p>';
        }).join('')
      : '';
    $('btn-results-next').textContent = r.phase === 'roundOver' ? 'Next round' : 'Play again';
    this.show('results');
    Audio.play(r.humanWon ? 'roundWin' : 'roundLose');
    this.announce($('results-headline').textContent);
  };

  /* ---------- help ---------- */
  UI.prototype.showHelp = function (from) {
    this.helpReturn = from || 'title';
    $('help-rules').innerHTML =
      '<div class="menu-grid">' +
      '<div class="panel"><h3>Draw</h3><p>Start each turn by taking the deck top card or the face-up discard.</p></div>' +
      '<div class="panel"><h3>Meld</h3><p>A <strong>set</strong> is 3–4 cards of one rank. A <strong>run</strong> is 3+ consecutive cards of one suit. Melded cards leave your hand and score safety.</p></div>' +
      '<div class="panel"><h3>Lay off</h3><p>Extend any table meld with a matching card from your hand.</p></div>' +
      '<div class="panel"><h3>Discard &amp; deadwood</h3><p>End your turn with one discard. When a player empties their hand, everyone else\u2019s remaining cards (deadwood) become the winner\u2019s points.</p></div>' +
      '</div>';
    const b = this.settings.bindings;
    $('help-controls').innerHTML = '<ul>' +
      '<li>Move between cards: ' + b.left.replace('Arrow', '') + '/' + b.right.replace('Arrow', '') + ' arrow keys</li>' +
      '<li>Select card: ' + b.confirm + ' · Draw deck: D · Take discard: F</li>' +
      '<li>Meld selection: M · Lay off: L · Discard: X</li>' +
      '<li>Undo (practice): U · Hint: H · Pause: P · Camera reset: C · Cancel: Esc</li>' +
      '<li>Pointer/touch: tap cards to select, tap deck or discard pile to draw, tap a meld marker to lay off.</li></ul>';
    this.show('help');
  };

  /* ---------- settings ---------- */
  UI.prototype.bindSettings = function (settings, onChange) {
    this.settings = settings;
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
    wire('set-music', 'music'); wire('set-effects', 'effects');
    wire('set-ambience', 'ambience'); wire('set-voice', 'voice');
    wire('set-muted', 'muted', true); wire('set-captions', 'captions', true);
    wire('set-quality', 'quality'); wire('set-motion', 'reducedMotion', true);
    wire('set-contrast', 'highContrast', true); wire('set-large-text', 'largeText', true);
    wire('set-lefty', 'leftHanded', true); wire('set-haptics', 'haptics', true);
    wire('set-palette', 'colorPalette');
    this.applySettings();
  };

  UI.prototype.applySettings = function () {
    const s = this.settings;
    document.body.classList.toggle('high-contrast', !!s.highContrast);
    document.body.classList.toggle('large-text', !!s.largeText);
    Audio.applySettings(s);
  };

  /* ---------- keyboard ---------- */
  UI.prototype.onKey = function (e) {
    if (this.currentScreen !== 'play' || !this.session) {
      if (e.code === 'Escape') { this.overlay('overlay-pause', false); this.overlay('overlay-settings', false); }
      return;
    }
    const b = this.settings.bindings;
    const s = this.session;
    const hand = s.state.hands[s.humanSeat];
    const code = e.code;
    if (code === 'Escape') {
      if (this.selection.length) { this.selection = []; this.syncAll(); }
      else this.overlay('overlay-pause', true);
      e.preventDefault(); return;
    }
    if (code === b.pause || code === 'KeyP') { this.overlay('overlay-pause', true); e.preventDefault(); return; }
    if (s.isOver()) return;
    if (code === b.left) { this.focusIdx = Math.max(0, this.focusIdx - 1); this.focusCard(); e.preventDefault(); }
    else if (code === b.right) { this.focusIdx = Math.min(hand.cards.length - 1, this.focusIdx + 1); this.focusCard(); e.preventDefault(); }
    else if (code === b.confirm || code === 'Space') {
      if (hand.cards[this.focusIdx] !== undefined) this.toggleCard(hand.cards[this.focusIdx]);
      e.preventDefault();
    }
    else if (code === b.drawDeck || code === 'KeyD') { this.doDraw('deck'); e.preventDefault(); }
    else if (code === b.drawDiscard || code === 'KeyF') { this.doDraw('discard'); e.preventDefault(); }
    else if (code === b.meld || code === 'KeyM') { this.doMeld(); e.preventDefault(); }
    else if (code === b.layoff || code === 'KeyL') { this.doLayoff(); e.preventDefault(); }
    else if (code === b.discard || code === 'KeyX') { this.doDiscard(); e.preventDefault(); }
    else if (code === b.undo || code === 'KeyU') { s.undo(); e.preventDefault(); }
    else if (code === b.hint || code === 'KeyH') { this.doHint(); e.preventDefault(); }
    else if (code === b.cameraReset || code === 'KeyC') { if (this.onCameraReset) this.onCameraReset(); e.preventDefault(); }
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
    click('btn-mode-back', function () { self.show('title'); self.refreshTitle(); });
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
    click('btn-results-leave', function () { self.session = null; self.show('title'); self.refreshTitle(); });
    click('btn-results-replay', function () { self.replayLast(); });
    click('btn-results-next', function () {
      const s = self.session;
      if (s && s.state.phase === 'roundOver') { s.nextRound(); self.show('play'); self.syncAll(); }
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
  };

  UI.prototype.replayLast = function () {
    const s = this.session;
    if (!s || !s.resultSummary) return;
    const env = s.resultSummary.replay;
    const v = Rules.verifyReplay(env);
    this.announce(v.ok ? 'Replay verified: identical final state.' : 'Replay mismatch: ' + v.reason);
  };

  return new UI();
});
