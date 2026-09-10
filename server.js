'use strict';
/*
 * Meld Hall — authoritative host server (Node, no external deps).
 * - Static file serving with correct MIME types and path traversal guard.
 * - GET /api/v1/time            -> { now } platform time for countdown/daily sync
 * - GET /api/v1/health          -> { ok }
 * - WebSocket /ws               -> hosted 2-player sessions. The server runs
 *   the rules engine authoritatively: validates identity, membership, turn,
 *   command ids (idempotent dedupe), and legality; broadcasts snapshots.
 *
 * Message protocol (JSON text frames):
 *   c->s { op:'create', name }                 -> { op:'created', sessionId, seat }
 *   c->s { op:'join', sessionId, name }        -> { op:'joined', seat, snapshot }
 *   c->s { op:'command', sessionId, command }  -> { op:'ack', tick } or { op:'reject', reason }
 *   s->c { op:'state', snapshot }              -> after every accepted command
 *   c->s { op:'sync', sessionId }              -> { op:'state', snapshot }  (reconnect)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Rules = require('./src/rules.js');

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
  '.opus': 'audio/ogg', '.webp': 'image/webp',
};

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendJSON(res, code, obj) { send(res, code, 'application/json', JSON.stringify(obj)); }

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
  catch (_) { send(res, 400, 'text/plain', 'bad request'); return; }
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(ROOT, urlPath));
  const rel = path.relative(ROOT, file);
  if (rel === '' || rel.indexOf('..') === 0 || path.isAbsolute(rel)) {
    send(res, 403, 'text/plain', 'forbidden'); return;
  }
  const blocked = rel.split(path.sep).some(function (seg) {
    return seg.charAt(0) === '.' || seg === 'node_modules';
  });
  if (blocked) { send(res, 403, 'text/plain', 'forbidden'); return; }
  fs.readFile(file, function (err, data) {
    if (err) { send(res, 404, 'text/plain', 'not found'); return; }
    send(res, 200, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', data);
  });
}

/* ---------------- hosted sessions (authoritative) ---------------- */
const sessions = new Map(); // id -> { id, state, clients: Map<seat,ws>, names, createdAt }

function newSessionId() { return crypto.randomBytes(4).toString('hex'); }

function snapshotFor(sess) {
  return {
    sessionId: sess.id,
    state: sess.state,
    hash: Rules.hashState(sess.state),
    players: sess.names.slice(),
  };
}
function broadcast(sess, obj) {
  const msg = encodeFrame(JSON.stringify(obj));
  for (const ws of sess.clients.values()) { try { ws.write(msg); } catch (_) {} }
}

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return sendWS(ws, { op: 'reject', reason: 'malformed_json' }); }
  if (typeof msg !== 'object' || !msg || typeof msg.op !== 'string')
    return sendWS(ws, { op: 'reject', reason: 'malformed_message' });

  if (msg.op === 'create') {
    const id = newSessionId();
    const seed = (crypto.randomBytes(4).readUInt32BE(0)) >>> 0;
    const sess = {
      id: id,
      state: Rules.initialState(seed, { players: 2, targetScore: 50 }),
      clients: new Map(), names: ['player', 'player'], createdAt: Date.now(),
      seenCommands: new Set(),
    };
    sess.clients.set(0, ws);
    sess.names[0] = String(msg.name || 'Host').slice(0, 24);
    ws._session = id; ws._seat = 0;
    sessions.set(id, sess);
    return sendWS(ws, { op: 'created', sessionId: id, seat: 0, snapshot: snapshotFor(sess) });
  }

  if (msg.op === 'join') {
    const sess = sessions.get(msg.sessionId);
    if (!sess) return sendWS(ws, { op: 'reject', reason: 'no_such_session' });
    if (sess.clients.has(1) && sess.clients.get(1).readyState !== 0 && !sess.clients.get(1).destroyed)
      return sendWS(ws, { op: 'reject', reason: 'session_full' });
    sess.clients.set(1, ws);
    sess.names[1] = String(msg.name || 'Guest').slice(0, 24);
    ws._session = sess.id; ws._seat = 1;
    sendWS(ws, { op: 'joined', seat: 1, snapshot: snapshotFor(sess) });
    return broadcast(sess, { op: 'state', snapshot: snapshotFor(sess), note: 'opponent_joined' });
  }

  if (msg.op === 'sync') {
    const sess = sessions.get(msg.sessionId);
    if (!sess) return sendWS(ws, { op: 'reject', reason: 'no_such_session' });
    return sendWS(ws, { op: 'state', snapshot: snapshotFor(sess) }); // reconnect source of truth
  }

  if (msg.op === 'command') {
    const sess = sessions.get(msg.sessionId);
    if (!sess) return sendWS(ws, { op: 'reject', reason: 'no_such_session' });
    if (ws._session !== sess.id || ws._seat === undefined)
      return sendWS(ws, { op: 'reject', reason: 'not_a_member' });
    const cmd = msg.command;
    if (!cmd || typeof cmd !== 'object') return sendWS(ws, { op: 'reject', reason: 'malformed_command' });
    if (JSON.stringify(cmd).length > 4096) return sendWS(ws, { op: 'reject', reason: 'payload_too_large' });
    cmd.player = ws._seat; // server binds identity; client-supplied player is ignored
    if (typeof cmd.id !== 'string') return sendWS(ws, { op: 'reject', reason: 'missing_command_id' });
    if (sess.seenCommands.has(cmd.id)) return sendWS(ws, { op: 'ack', tick: sess.state.tick, duplicate: true });
    const r = Rules.applyCommand(sess.state, cmd);
    if (!r.ok) return sendWS(ws, { op: 'reject', reason: r.reason });
    sess.state = r.state;
    sess.seenCommands.add(cmd.id);
    sendWS(ws, { op: 'ack', tick: sess.state.tick });
    broadcast(sess, { op: 'state', snapshot: snapshotFor(sess) });
    if (sess.state.phase === 'matchOver' || sess.state.phase === 'roundOver')
      broadcast(sess, { op: 'result', breakdown: sess.state.roundBreakdown, phase: sess.state.phase });
    return;
  }

  sendWS(ws, { op: 'reject', reason: 'unknown_op' });
}

/* ---------------- minimal RFC6455 server ---------------- */
function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}
function sendWS(socket, obj) { try { socket.write(encodeFrame(JSON.stringify(obj))); } catch (_) {} }

function acceptSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  let buf = Buffer.alloc(0);
  socket.on('data', function (chunk) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const b0 = buf[0], b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2)); off = 10;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.slice(off, off + len);
      if (masked) {
        const mask = buf.slice(maskOff, maskOff + 4);
        const un = Buffer.alloc(len);
        for (let i = 0; i < len; ++i) un[i] = payload[i] ^ mask[i & 3];
        payload = un;
      }
      buf = buf.slice(off + len);
      if (op === 8) { socket.end(); return; }              // close
      else if (op === 9) {                                 // ping -> pong
        const h = Buffer.from([0x8A, payload.length]);
        socket.write(Buffer.concat([h, payload]));
      } else if (op === 1 && fin) {                        // text
        if (payload.length > 16384) { sendWS(socket, { op: 'reject', reason: 'payload_too_large' }); continue; }
        handleMessage(socket, payload.toString('utf8'));
      }
      if (!fin) { sendWS(socket, { op: 'reject', reason: 'fragmented_frames_unsupported' }); return; }
    }
  });
  socket.on('close', function () {
    const sess = sessions.get(socket._session);
    if (sess) broadcast(sess, { op: 'peer_left', seat: socket._seat });
  });
  socket.on('error', function () {});
}

/* ---------------- http ---------------- */
const server = http.createServer(function (req, res) {
  const p = req.url.split('?')[0];
  if (p === '/api/v1/time') return sendJSON(res, 200, { now: Date.now() });
  if (p === '/api/v1/health') return sendJSON(res, 200, { ok: true, rules: Rules.RULES_VERSION });
  if (p.indexOf('/api/') === 0) return sendJSON(res, 404, { error: 'unknown_endpoint' });
  serveStatic(req, res);
});
server.on('upgrade', function (req, socket) {
  if (req.url.split('?')[0] === '/ws') acceptSocket(req, socket);
  else socket.destroy();
});

// periodic cleanup of dead hosted sessions
setInterval(function () {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.createdAt > 6 * 3600 * 1000) sessions.delete(id);
}, 60000).unref();

if (require.main === module) {
  server.listen(PORT, function () { console.log('Meld Hall listening on http://localhost:' + PORT); });
}

module.exports = { server: server, sessions: sessions };
