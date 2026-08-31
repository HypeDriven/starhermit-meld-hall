'use strict';
/*
 * Meld Hall — pure deterministic rules engine.
 * No DOM, no three.js, no timers. Works in Node (module.exports) and
 * browsers (window.MeldRules). All state is JSON-serializable.
 *
 * Game: 2-4 player rummy-style meld game.
 *   Turn = draw (deck or discard pile) -> optional melds/layoffs -> discard.
 *   Round ends when a player empties their hand ("goes out") or the deck
 *   is exhausted. Winner scores the sum of opponents' deadwood.
 *   Match ends when a player reaches the target score.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MeldRules = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {

  const RULES_VERSION = '1.0.0';

  /* ---------- seeded random stream ---------- */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- cards: id 0..51, rank = id % 13 (0=Ace..12=King), suit = id/13 ---------- */
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const SUITS = ['clover', 'diamond', 'heart', 'spire']; // original suit names
  const SUIT_GLYPHS = ['\u2663', '\u2666', '\u2665', '\u2660'];

  function rankOf(id) { return id % 13; }
  function suitOf(id) { return (id / 13) | 0; }
  function cardValue(id) {
    const r = rankOf(id);
    if (r === 0) return 1;        // Ace
    if (r >= 10) return 10;       // J, Q, K
    return r + 1;
  }
  function cardName(id) { return RANKS[rankOf(id)] + SUIT_GLYPHS[suitOf(id)]; }

  /* ---------- meld validity ---------- */
  function isSet(ids) {
    if (ids.length < 3 || ids.length > 4) return false;
    const r = rankOf(ids[0]);
    const suits = {};
    for (const id of ids) {
      if (rankOf(id) !== r) return false;
      const s = suitOf(id);
      if (suits[s]) return false;
      suits[s] = true;
    }
    return true;
  }
  function isRun(ids) {
    if (ids.length < 3) return false;
    const s = suitOf(ids[0]);
    const rs = ids.map(rankOf).sort(function (a, b) { return a - b; });
    for (let i = 0; i < rs.length; ++i) {
      if (suitOf(ids[i]) !== s) return false;
      if (i > 0 && rs[i] !== rs[i - 1] + 1) return false;
    }
    return true;
  }
  function meldKind(ids) {
    if (isSet(ids)) return 'set';
    if (isRun(ids)) return 'run';
    return null;
  }
  function canLayoff(cardId, meld) {
    if (isSet(meld)) {
      if (meld.length >= 4) return false;
      if (rankOf(cardId) !== rankOf(meld[0])) return false;
      for (const id of meld) if (suitOf(id) === suitOf(cardId)) return false;
      return true;
    }
    if (isRun(meld)) {
      if (suitOf(cardId) !== suitOf(meld[0])) return false;
      const rs = meld.map(rankOf);
      const lo = Math.min.apply(null, rs), hi = Math.max.apply(null, rs);
      const r = rankOf(cardId);
      if (r === lo - 1 || r === hi + 1) {
        for (const id of meld) if (id === cardId) return false;
        return true;
      }
    }
    return false;
  }

  /* ---------- state ---------- */
  function shuffledDeck(seed) {
    const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
    const deck = [];
    for (let i = 0; i < 52; ++i) deck.push(i);
    for (let i = deck.length - 1; i > 0; --i) {
      const j = Math.floor(rng() * (i + 1));
      const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    return deck;
  }

  function initialState(seed, opts) {
    opts = opts || {};
    const players = Math.min(4, Math.max(2, opts.players || 2));
    const handSize = opts.handSize || (players === 2 ? 10 : 7);
    const deck = shuffledDeck(seed >>> 0);
    const hands = [];
    for (let p = 0; p < players; ++p) hands.push({ cards: [], melds: [] });
    for (let k = 0; k < handSize; ++k)
      for (let p = 0; p < players; ++p) hands[p].cards.push(deck.pop());
    for (let p = 0; p < players; ++p) hands[p].cards.sort(function (a, b) { return a - b; });
    const discardPile = [deck.pop()];
    return {
      version: RULES_VERSION,
      seed: seed >>> 0,
      tick: 0,
      players: players,
      targetScore: opts.targetScore || 100,
      round: 1,
      phase: 'draw',            // draw | act | roundOver | matchOver
      turn: 0,
      deck: deck,
      discardPile: discardPile,
      hands: hands,
      table: [],                // melds: { cards:[ids], kind:'set'|'run', owner:p }
      scores: new Array(players).fill(0),
      roundBreakdown: null,     // filled at roundOver
      invalidActions: new Array(players).fill(0),
      startedAtTick: 0,
      terminalReason: null,
      log: [],                  // ordered command record for replay
      lastCommandId: null,
    };
  }

  function deadwood(hand) {
    let t = 0;
    for (const c of hand.cards) t += cardValue(c);
    return t;
  }

  /* ---------- stable state hash (djb2 over canonical JSON) ---------- */
  function hashState(state) {
    const snap = {
      v: state.version, s: state.seed, t: state.tick, p: state.players,
      ph: state.phase, tu: state.turn, d: state.deck, dp: state.discardPile,
      h: state.hands, tb: state.table, sc: state.scores, r: state.round,
      tr: state.terminalReason,
    };
    const str = JSON.stringify(snap);
    let h = 5381;
    for (let i = 0; i < str.length; ++i) h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0;
    return ('0000000' + h.toString(16)).slice(-8);
  }

  /* ---------- legal actions ---------- */
  // Enumerate every legal command for player p. Same API used by UI hints,
  // tutorials, AI, and the authoritative server.
  function legalActions(state, p) {
    if (state.phase === 'roundOver' || state.phase === 'matchOver') return [];
    if (p !== state.turn) return [];
    const hand = state.hands[p];
    const acts = [];
    if (state.phase === 'draw') {
      if (state.deck.length > 0) acts.push({ type: 'draw', source: 'deck' });
      if (state.discardPile.length > 0) acts.push({ type: 'draw', source: 'discard' });
      return acts;
    }
    // phase === 'act'
    // melds: sets by rank, runs by suit
    const byRank = {}, bySuit = {};
    for (const c of hand.cards) {
      (byRank[rankOf(c)] = byRank[rankOf(c)] || []).push(c);
      (bySuit[suitOf(c)] = bySuit[suitOf(c)] || []).push(c);
    }
    for (const r in byRank) {
      const g = byRank[r];
      if (g.length >= 3) {
        acts.push({ type: 'meld', cards: g.slice(0, 3) });
        if (g.length === 4) acts.push({ type: 'meld', cards: g.slice() });
      }
    }
    for (const s in bySuit) {
      const g = bySuit[s].slice().sort(function (a, b) { return rankOf(a) - rankOf(b); });
      // maximal consecutive runs, and their size>=3 sub-runs anchored at each end
      let i = 0;
      while (i < g.length) {
        let j = i;
        while (j + 1 < g.length && rankOf(g[j + 1]) === rankOf(g[j]) + 1) ++j;
        const len = j - i + 1;
        if (len >= 3) {
          for (let a = i; a <= j; ++a)
            for (let b = Math.max(j, a + 2); b <= j; ++b)
              acts.push({ type: 'meld', cards: g.slice(a, b + 1) });
        }
        i = j + 1;
      }
    }
    // layoffs
    for (const c of hand.cards)
      for (let m = 0; m < state.table.length; ++m)
        if (canLayoff(c, state.table[m].cards)) acts.push({ type: 'layoff', card: c, meld: m });
    // discards
    for (const c of hand.cards) acts.push({ type: 'discard', card: c });
    return acts;
  }

  function hasAction(list, pred) {
    for (const a of list) if (pred(a)) return true;
    return false;
  }

  /* ---------- command application ---------- */
  function removeCards(hand, ids) {
    const set = {};
    for (const id of ids) set[id] = true;
    const kept = [];
    for (const c of hand.cards) if (!set[c]) kept.push(c);
    if (kept.length !== hand.cards.length - ids.length) return false;
    hand.cards = kept;
    return true;
  }

  // Returns { ok:true, state, events } or { ok:false, reason }.
  // Never mutates the input state on failure; mutates a deep copy on success.
  function applyCommand(prev, cmd) {
    if (!cmd || typeof cmd !== 'object') return { ok: false, reason: 'malformed_command' };
    if (typeof cmd.id !== 'string' || cmd.id.length === 0 || cmd.id.length > 64)
      return { ok: false, reason: 'missing_command_id' };
    if (cmd.id === prev.lastCommandId) return { ok: true, duplicate: true, state: prev, events: [] };
    const p = cmd.player;
    if (typeof p !== 'number' || p < 0 || p >= prev.players) return { ok: false, reason: 'bad_player' };
    if (prev.phase === 'roundOver' || prev.phase === 'matchOver') {
      if (cmd.type !== 'nextRound') return { ok: false, reason: 'terminal_' + prev.phase };
    } else if (p !== prev.turn) {
      return { ok: false, reason: 'out_of_turn' };
    }

    const state = JSON.parse(JSON.stringify(prev));
    const events = [];
    const hand = state.hands[p];

    function invalid(reason) {
      state.invalidActions[p] += 1; // counted for tie-breaks, but state rejected
      return { ok: false, reason: reason };
    }

    if (cmd.type === 'draw') {
      if (state.phase !== 'draw') return invalid('not_draw_phase');
      if (cmd.source === 'deck') {
        if (state.deck.length === 0) return invalid('deck_empty');
        hand.cards.push(state.deck.pop());
      } else if (cmd.source === 'discard') {
        if (state.discardPile.length === 0) return invalid('discard_empty');
        hand.cards.push(state.discardPile.pop());
      } else return invalid('bad_source');
      state.phase = 'act';
      events.push({ type: 'draw', player: p, source: cmd.source });
    } else if (cmd.type === 'meld') {
      if (state.phase !== 'act') return invalid('not_act_phase');
      if (!Array.isArray(cmd.cards) || cmd.cards.length < 3) return invalid('bad_meld');
      const kind = meldKind(cmd.cards);
      if (!kind) return invalid('invalid_meld_shape');
      if (!removeCards(hand, cmd.cards)) return invalid('cards_not_in_hand');
      state.table.push({ cards: cmd.cards.slice().sort(function (a, b) { return a - b; }), kind: kind, owner: p });
      hand.melds.push(cmd.cards.length);
      events.push({ type: 'meld', player: p, kind: kind, count: cmd.cards.length });
      if (hand.cards.length === 0) endRound(state, p, 'player_out'); // melded out
    } else if (cmd.type === 'layoff') {
      if (state.phase !== 'act') return invalid('not_act_phase');
      const m = state.table[cmd.meld];
      if (!m) return invalid('no_such_meld');
      if (typeof cmd.card !== 'number' || hand.cards.indexOf(cmd.card) < 0) return invalid('card_not_in_hand');
      if (!canLayoff(cmd.card, m.cards)) return invalid('invalid_layoff');
      removeCards(hand, [cmd.card]);
      m.cards.push(cmd.card);
      m.cards.sort(function (a, b) { return a - b; });
      events.push({ type: 'layoff', player: p, meld: cmd.meld });
      if (hand.cards.length === 0) endRound(state, p, 'player_out'); // laid off last card
    } else if (cmd.type === 'discard') {
      if (state.phase !== 'act') return invalid('not_act_phase');
      if (typeof cmd.card !== 'number' || hand.cards.indexOf(cmd.card) < 0) return invalid('card_not_in_hand');
      removeCards(hand, [cmd.card]);
      state.discardPile.push(cmd.card);
      events.push({ type: 'discard', player: p });
      // round end checks
      if (hand.cards.length === 0) {
        endRound(state, p, 'player_out');
      } else if (state.deck.length === 0) {
        // deck exhausted: lowest deadwood wins
        let best = 0, bestD = Infinity;
        for (let q = 0; q < state.players; ++q) {
          const d = deadwood(state.hands[q]);
          if (d < bestD) { bestD = d; best = q; }
        }
        endRound(state, best, 'deck_exhausted');
      } else {
        state.turn = (state.turn + 1) % state.players;
        state.phase = 'draw';
      }
    } else if (cmd.type === 'nextRound') {
      if (state.phase !== 'roundOver') return { ok: false, reason: 'not_round_over' };
      const fresh = initialState((state.seed + state.round * 7919) >>> 0, {
        players: state.players, targetScore: state.targetScore,
      });
      fresh.round = state.round + 1;
      fresh.scores = state.scores.slice();
      fresh.invalidActions = state.invalidActions.slice();
      fresh.log = state.log.slice();
      fresh.tick = state.tick;
      fresh.lastCommandId = state.lastCommandId;
      Object.keys(state).forEach(function (k) { delete state[k]; });
      Object.assign(state, fresh);
      events.push({ type: 'nextRound', round: state.round });
    } else {
      return { ok: false, reason: 'unknown_command_type' };
    }

    state.tick += 1;
    state.lastCommandId = cmd.id;
    state.log.push({ tick: state.tick, player: p, type: cmd.type, id: cmd.id, hash: hashState(state) });
    return { ok: true, state: state, events: events };
  }

  function endRound(state, winner, reason) {
    const dw = [];
    for (let q = 0; q < state.players; ++q) dw.push(deadwood(state.hands[q]));
    let points = 0;
    for (let q = 0; q < state.players; ++q) if (q !== winner) points += dw[q];
    if (reason === 'deck_exhausted') points -= dw[winner];
    if (points < 0) points = 0;
    state.scores[winner] += points;
    state.roundBreakdown = {
      winner: winner, reason: reason, deadwood: dw,
      pointsAwarded: points, totals: state.scores.slice(), round: state.round,
    };
    // match end?
    let matchWinner = -1, best = -1;
    for (let q = 0; q < state.players; ++q)
      if (state.scores[q] >= state.targetScore && state.scores[q] > best) { best = state.scores[q]; matchWinner = q; }
    if (matchWinner >= 0) {
      state.phase = 'matchOver';
      state.terminalReason = 'target_score_reached';
      state.matchWinner = matchWinner;
    } else {
      state.phase = 'roundOver';
      state.terminalReason = null;
    }
  }
  // Tie-break ordering for equal match scores: fewer invalid actions,
  // lower elapsed ticks, then stable session id (lower wins).
  function comparePlayers(state, a, b, sessionId) {
    if (state.scores[a] !== state.scores[b]) return state.scores[b] - state.scores[a];
    if (state.invalidActions[a] !== state.invalidActions[b]) return state.invalidActions[a] - state.invalidActions[b];
    const ea = state.tick - state.startedAtTick;
    if (ea !== 0 && a !== b) return a - b; // ticks are shared; fall through to stable order
    const sid = ('' + (sessionId || '')).length; // deterministic, stable
    return (a - b) || sid * 0;
  }

  /* ---------- deterministic AI ---------- */
  // Heuristic, no hidden randomness: identical state -> identical choice.
  function aiChoose(state, p) {
    const acts = legalActions(state, p);
    if (acts.length === 0) return null;
    if (state.phase === 'draw') {
      // take discard if it completes or extends something
      const top = state.discardPile[state.discardPile.length - 1];
      if (top !== undefined) {
        const hand = state.hands[p].cards;
        const sameRank = hand.filter(function (c) { return rankOf(c) === rankOf(top); }).length;
        const sameSuitAdj = hand.filter(function (c) {
          return suitOf(c) === suitOf(top) && Math.abs(rankOf(c) - rankOf(top)) <= 2;
        }).length;
        if (sameRank >= 2 || sameSuitAdj >= 2 || canLayoffAny(top, state))
          return { type: 'draw', source: 'discard' };
      }
      return { type: 'draw', source: 'deck' };
    }
    // act phase: meld the biggest, layoff everything, then discard worst card
    let best = null;
    for (const a of acts) {
      if (a.type === 'meld' && (!best || a.cards.length > best.cards.length)) best = a;
    }
    if (best) return { type: 'meld', cards: best.cards };
    for (const a of acts) if (a.type === 'layoff') return { type: 'layoff', card: a.card, meld: a.meld };
    // discard highest-value card that is least connected
    const hand = state.hands[p].cards;
    let worst = hand[0], worstScore = -Infinity;
    for (const c of hand) {
      let links = 0;
      for (const o of hand) {
        if (o === c) continue;
        if (rankOf(o) === rankOf(c)) links += 2;
        else if (suitOf(o) === suitOf(c) && Math.abs(rankOf(o) - rankOf(c)) <= 2) links += 1;
      }
      const s = cardValue(c) * 2 - links;
      if (s > worstScore) { worstScore = s; worst = c; }
    }
    return { type: 'discard', card: worst };
  }
  function canLayoffAny(card, state) {
    for (const m of state.table) if (canLayoff(card, m.cards)) return true;
    return false;
  }

  /* ---------- replay ---------- */
  // replayEnvelope: { version, seed, options, commands:[{id,player,type,...}], hashes, result }
  function buildReplay(initialOpts, commands, finalState) {
    return {
      schema: 1,
      rulesVersion: RULES_VERSION,
      seed: initialOpts.seed,
      options: initialOpts.options || {},
      commands: commands,
      hashes: finalState.log.map(function (e) { return e.hash; }),
      terminal: finalState.phase === 'matchOver' || finalState.phase === 'roundOver'
        ? { phase: finalState.phase, scores: finalState.scores.slice(), reason: finalState.terminalReason || 'round_end' }
        : null,
    };
  }
  function verifyReplay(envelope) {
    let state = initialState(envelope.seed, envelope.options);
    const hashes = [];
    for (const cmd of envelope.commands) {
      const r = applyCommand(state, cmd);
      if (!r.ok) return { ok: false, reason: 'replay_command_failed:' + r.reason };
      state = r.state;
      hashes.push(hashState(state));
    }
    for (let i = 0; i < envelope.hashes.length; ++i)
      if (envelope.hashes[i] !== hashes[i]) return { ok: false, reason: 'hash_mismatch_at_' + i };
    return { ok: true, state: state };
  }

  function serialize(state) { return JSON.stringify(state); }
  function deserialize(json) {
    const s = typeof json === 'string' ? JSON.parse(json) : json;
    if (!s || s.version !== RULES_VERSION) throw new Error('unsupported_state_version');
    return s;
  }

  return {
    RULES_VERSION: RULES_VERSION,
    mulberry32: mulberry32,
    RANKS: RANKS, SUITS: SUITS, SUIT_GLYPHS: SUIT_GLYPHS,
    rankOf: rankOf, suitOf: suitOf, cardValue: cardValue, cardName: cardName,
    isSet: isSet, isRun: isRun, meldKind: meldKind, canLayoff: canLayoff,
    initialState: initialState, deadwood: deadwood, hashState: hashState,
    legalActions: legalActions, applyCommand: applyCommand,
    comparePlayers: comparePlayers, aiChoose: aiChoose,
    buildReplay: buildReplay, verifyReplay: verifyReplay,
    serialize: serialize, deserialize: deserialize,
  };
});
