'use strict';
/*
 * Meld Hall — hosted table client connector.
 * Talks to the game's own authoritative /ws backend (server.js): host a
 * table (create), join by code, send commands, receive snapshots. In hosted
 * platform mode the launch token is carried as ?access_token=; the server
 * records it and requires joiners to present one for token-created tables.
 * The HostedSession duck-types the local Session surface the UI drives.
 */
(function (root, factory) {
  const Rules = root.MeldRules;
  const Platform = root.MeldPlatform || null;
  const api = factory(Rules, Platform);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MeldNet = api;
})(typeof self !== 'undefined' ? self : globalThis, function (Rules, Platform) {

  let cmdCounter = 0;
  function nextCmdId() { return 'h' + (++cmdCounter) + '_' + Date.now().toString(36); }

  function wsUrl() {
    const proto = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss' : 'ws';
    let url = proto + '://' + location.host + '/ws';
    if (Platform && Platform.enabled && Platform.accessToken())
      url += '?access_token=' + encodeURIComponent(Platform.accessToken());
    return url;
  }

  // Is the game's own session backend reachable from here? Opens (then
  // closes) a WebSocket so hosts without the backend fail silently — no
  // console noise. Solo play never depends on this.
  function probe() {
    return new Promise(function (resolve) {
      if (typeof WebSocket === 'undefined' || typeof location === 'undefined') return resolve(false);
      let ws;
      try { ws = new WebSocket(wsUrl()); } catch (e) { return resolve(false); }
      const timer = setTimeout(function () { try { ws.close(); } catch (_) {} resolve(false); }, 3000);
      ws.onopen = function () { clearTimeout(timer); try { ws.close(); } catch (_) {} resolve(true); };
      ws.onerror = function () { clearTimeout(timer); resolve(false); };
      ws.onclose = function () { clearTimeout(timer); resolve(false); };
    });
  }

  function HostedSession(ws, pendingOp) {
    this.mode = 'hosted';
    this.sessionId = null;
    this.humanSeat = 0;
    this.state = null;
    this.names = null;
    this.commands = [];
    this.undoStack = [];
    this.allowUndo = false;
    this.aiTimer = null;
    this.aiPaused = false;
    this.listeners = [];
    this.resultSummary = null;
    this.opponentJoined = false;
    this._ws = ws;
    this._pending = pendingOp || null; // { op, resolve, reject, timer }
    this._closedByUser = false;
    const self = this;
    ws.onmessage = function (e) { self._onMessage(e.data); };
    ws.onclose = function () { self._onClose(); };
    ws.onerror = function () {};
  }

  HostedSession.prototype.on = function (fn) { this.listeners.push(fn); };
  HostedSession.prototype.emit = function (evt) {
    for (const fn of this.listeners) { try { fn(evt, this); } catch (e) { console.error(e); } }
  };
  HostedSession.prototype._send = function (obj) {
    try { this._ws.send(JSON.stringify(obj)); } catch (_) {}
  };

  HostedSession.prototype._settlePending = function (ok, value) {
    const p = this._pending;
    if (!p) return;
    this._pending = null;
    clearTimeout(p.timer);
    if (ok) p.resolve(value); else p.reject(value);
  };

  HostedSession.prototype._onMessage = function (raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    const op = msg.op;
    if (op === 'created' || op === 'joined') {
      this.sessionId = msg.sessionId || (msg.snapshot && msg.snapshot.sessionId) || this.sessionId;
      this.humanSeat = typeof msg.seat === 'number' ? msg.seat : 0;
      this.state = msg.snapshot.state;
      this.names = msg.snapshot.players;
      this.opponentJoined = op === 'joined';
      this._settlePending(true, this);
      this.emit({ type: 'state', events: [] });
      return;
    }
    if (op === 'state') {
      this.state = msg.snapshot.state;
      this.names = msg.snapshot.players;
      // the join broadcast reaches the joiner too; only the seated opponent
      // or a waiting host should treat it as the peer arriving
      if (msg.note === 'opponent_joined' && !this.opponentJoined) {
        this.opponentJoined = true;
        this.emit({ type: 'peerJoined' });
      }
      this.emit({ type: 'state', events: [] });
      return;
    }
    if (op === 'result') { this._finish(msg.phase, msg.breakdown); return; }
    if (op === 'ack') { return; } // snapshot follows and is the source of truth
    if (op === 'reject') {
      this._settlePending(false, new Error(msg.reason || 'rejected'));
      this.emit({ type: 'invalid', reason: msg.reason || 'rejected' });
      return;
    }
    if (op === 'peer_left') { this.emit({ type: 'peerLeft' }); return; }
  };

  HostedSession.prototype._onClose = function () {
    this._settlePending(false, new Error('connection_lost'));
    if (!this._closedByUser) this.emit({ type: 'connectionLost' });
  };

  HostedSession.prototype._finish = function (phase, breakdown) {
    const humanWon = breakdown && breakdown.winner === this.humanSeat;
    this.resultSummary = {
      phase: phase,
      winner: breakdown ? breakdown.winner : -1,
      humanWon: !!humanWon,
      breakdown: breakdown,
      matchWinner: this.state && this.state.matchWinner !== undefined ? this.state.matchWinner : null,
      replay: null, // hosted tables verify server-side; nothing local to replay
    };
    this.emit({ type: phase, summary: this.resultSummary });
  };

  /* ----- Session duck-type ----- */
  HostedSession.prototype.legal = function () {
    if (!this.state) return [];
    return Rules.legalActions(this.state, this.humanSeat);
  };
  HostedSession.prototype.command = function (cmd) {
    if (!this._ws || this._ws.readyState !== 1) {
      this.emit({ type: 'invalid', reason: 'not_connected' });
      return { ok: false, reason: 'not_connected' };
    }
    cmd.player = this.humanSeat;
    cmd.id = cmd.id || nextCmdId();
    this._send({ op: 'command', sessionId: this.sessionId, command: cmd });
    this.commands.push(cmd);
    return { ok: true };
  };
  HostedSession.prototype.isOver = function () {
    return !!this.state && (this.state.phase === 'matchOver' || this.state.phase === 'roundOver');
  };
  HostedSession.prototype.nextRound = function () {
    return this.command({ type: 'nextRound' });
  };
  HostedSession.prototype.scheduleAI = function () {}; // both seats are human
  HostedSession.prototype.undo = function () { return false; };
  HostedSession.prototype.close = function () {
    this._closedByUser = true;
    try { this._ws.close(); } catch (_) {}
  };
  HostedSession.prototype.playerName = function (p) {
    if (this.names && this.names[p]) return this.names[p];
    return p === this.humanSeat ? 'You' : 'Opponent ' + (p + 1);
  };

  /* ----- connect helpers ----- */
  function connect(create, code, name) {
    return new Promise(function (resolve, reject) {
      if (typeof WebSocket === 'undefined') { reject(new Error('websocket_unavailable')); return; }
      let ws;
      try { ws = new WebSocket(wsUrl()); } catch (e) { reject(e); return; }
      const wantOp = create ? 'created' : 'joined';
      const sess = new HostedSession(ws, {
        op: wantOp,
        resolve: resolve,
        reject: reject,
        timer: setTimeout(function () {
          sess._pending = null;
          try { ws.close(); } catch (_) {}
          reject(new Error('timed out'));
        }, 8000),
      });
      ws.onopen = function () {
        if (create) sess._send({ op: 'create', name: name });
        else sess._send({ op: 'join', sessionId: code, name: name });
      };
    });
  }

  function hostedName() {
    if (Platform && Platform.enabled()) return Platform.displayName();
    return '';
  }

  return {
    probe: probe,
    host: function () { return connect(true, null, hostedName()); },
    join: function (code) { return connect(false, String(code || '').trim().toLowerCase(), hostedName()); },
    HostedSession: HostedSession,
  };
});
