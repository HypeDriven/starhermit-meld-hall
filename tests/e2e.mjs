/**
 * Meld Hall — end-to-end QA playthrough (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title -> settings open/close -> help open/back -> Play -> practice setup
 *   -> full rounds of rummy played by clicking the on-screen card buttons and
 *   action tray (plus one keyboard-driven turn) -> results screen -> next
 *   round -> pause/resume + pause-settings mid-round -> leave to title.
 *
 * Game state (window.MeldUI.session) is read only for synchronization and
 * for deciding which visible cards/buttons to click; every action goes
 * through real clicks/key presses on the UI a player sees.
 *
 * Runs twice: desktop 1280x800 and mobile 390x844 (touch). Fails loudly on
 * any non-benign console error or pageerror.
 *
 * Run: npm run test:e2e
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, tag) => `/tmp/meld-hall-e2e-${stage}-${tag}.png`;

// benign GPU/swiftshader noise (from tools/production_game_audit.mjs)
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2', '.ts': 'application/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    // platform time endpoint, so the title screen's fetch stays quiet offline
    if (urlPath === '/api/v1/time') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ now: Date.now() }));
      return;
    }
    if (urlPath === '/api/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }    let p = urlPath === '/' ? '/index.html' : urlPath;
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT) || file.includes(`${path.sep}tests`) || file.includes(`${path.sep}tools`) || path.basename(file).startsWith('.')) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
  // the declared game server (server.js) answers /ws on-platform; answer the
  // upgrade here too so the hosted-mode capability probe stays console-clean
  server.on('upgrade', (req, socket) => {
    if (req.url.split('?')[0] !== '/ws') return socket.destroy();
    const key = req.headers['sec-websocket-key'];
    if (!key) return socket.destroy();
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.on('data', () => {}); // probe sockets open and close without protocol traffic
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ---------- page helpers ---------- */

function readState(page) {
  return page.evaluate(() => {
    const UI = window.MeldUI;
    if (!UI || !UI.session) return null;
    const s = UI.session;
    return {
      screen: UI.currentScreen,
      phase: s.state.phase,
      turn: s.state.turn,
      humanSeat: s.humanSeat,
      round: s.state.round,
      handSize: s.state.hands[s.humanSeat].cards.length,
      deck: s.state.deck.length,
      selection: UI.selection.slice(),
      legal: s.legal(),
    };
  });
}

async function waitHumanDraw(page) {
  await page.waitForFunction(() => {
    const UI = window.MeldUI;
    return UI && UI.session && UI.session.state.turn === UI.session.humanSeat &&
      UI.session.state.phase === 'draw';
  }, null, { timeout: 20000 });
}

/** Play the human's turns (clicking real UI) until the round/match ends. Returns end phase. */
async function playUntilRoundEnd(page, opts = {}) {
  for (let i = 0; i < 400; i++) {
    const st = await readState(page);
    if (!st) throw new Error('session lost mid-round');
    if (st.phase === 'roundOver' || st.phase === 'matchOver') return st.phase;
    if (st.turn !== st.humanSeat) { await page.waitForTimeout(120); continue; }

    if (st.phase === 'draw') {
      if (opts.onFirstDraw && !opts.drawHandled) { opts.drawHandled = true; await opts.onFirstDraw(st); continue; }
      const takeDiscard = st.legal.some((a) => a.type === 'draw' && a.source === 'discard');
      await opts.act(takeDiscard ? '#act-draw-discard' : '#act-draw-deck');
      await page.waitForFunction(() => window.MeldUI.session.state.phase !== 'draw', null, { timeout: 5000 });
      continue;
    }

    if (st.phase === 'act') {
      const sel = new Set(st.selection);
      const meld = st.legal.find((a) => a.type === 'meld');
      if (meld) {
        const missing = meld.cards.filter((c) => !sel.has(c));
        if (missing.length === 0 && sel.size === meld.cards.length) {
          await opts.act('#act-meld');
        } else if (missing.length === 0) {
          await page.keyboard.press('Escape'); // clears stale selection via UI
        } else {
          await opts.act(`#hand-dom .card-btn[data-card="${missing[0]}"]`);
        }
        await page.waitForTimeout(60);
        continue;
      }
      const lay = st.legal.find((a) => a.type === 'layoff');
      if (lay) {
        if (sel.size === 1 && sel.has(lay.card)) {
          await opts.act('#act-layoff');
        } else if (sel.size > 0) {
          await page.keyboard.press('Escape');
        } else {
          await opts.act(`#hand-dom .card-btn[data-card="${lay.card}"]`);
        }
        await page.waitForTimeout(60);
        continue;
      }
      // discard the highest-value card in hand
      const card = await page.evaluate(() => {
        const s = window.MeldUI.session, R = window.MeldRules;
        return s.state.hands[s.humanSeat].cards.slice()
          .sort((a, b) => R.cardValue(b) - R.cardValue(a))[0];
      });
      if (!(sel.size === 1 && sel.has(card))) {
        if (sel.size > 0) await page.keyboard.press('Escape');
        await opts.act(`#hand-dom .card-btn[data-card="${card}"]`);
        await page.waitForTimeout(60);
      }
      await opts.act('#act-discard');
      await page.waitForTimeout(120);
      continue;
    }
    await page.waitForTimeout(120);
  }
  throw new Error('round did not finish within 400 iterations');
}

/* ---------- one full playthrough pass ---------- */

async function playthrough(browser, tag, viewport, touch, maxRounds) {
  const context = await browser.newContext({ viewport, hasTouch: touch });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !browserNoise.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  const act = touch ? (sel) => page.tap(sel) : (sel) => page.click(sel);
  const step = async (name, fn) => { await fn(); console.log(`ok - [${tag}] ${name}`); };

  try {
    await step('load + title screen', async () => {
      await page.goto(`http://127.0.0.1:${PORT}`, { waitUntil: 'load' });
      await page.waitForSelector('#screen-title.active', { timeout: 10000 });
      await page.waitForSelector('#btn-play');
      if (await page.locator('#compat-message.active').isVisible().catch(() => false)) {
        await act('#btn-compat-continue'); // WebGL unavailable: keep playing via DOM card list
      }
      await page.screenshot({ path: SHOT('title', tag) });
    });

    await step('settings open/close from title', async () => {
      await act('#btn-settings');
      await page.waitForSelector('#overlay-settings.active');
      await page.screenshot({ path: SHOT('settings', tag) });
      await act('#btn-settings-close');
      await page.waitForFunction(() => !document.getElementById('overlay-settings').classList.contains('active'));
    });

    await step('help screen open/back', async () => {
      await act('#btn-help');
      await page.waitForSelector('#screen-help.active');
      await act('#btn-help-back');
      await page.waitForSelector('#screen-title.active');
    });

    await step('mode select -> practice, target 30', async () => {
      await act('#btn-play');
      await page.waitForSelector('#screen-mode.active');
      await page.locator('#mode-list button', { hasText: 'Practice' }).click();
      await page.selectOption('#opt-target', '30');
      await page.selectOption('#opt-players', '2');
      await page.screenshot({ path: SHOT('mode', tag) });
      await act('#btn-mode-start');
      await page.waitForSelector('#screen-play.active');
      await page.waitForFunction(() => !!window.MeldUI.session);
    });

    await step('hand dealt to accessible card list', async () => {
      await waitHumanDraw(page);
      const st = await readState(page);
      const btns = await page.locator('#hand-dom .card-btn').count();
      if (btns !== st.handSize) throw new Error(`hand mirror shows ${btns}, state has ${st.handSize}`);
      if (st.handSize !== 10) throw new Error(`expected 10-card opening hand, got ${st.handSize}`);
      await page.screenshot({ path: SHOT('play', tag) });
    });

    const hook = {};
    await step('round 1: hint + undo exercised, then play to results', async () => {
      // hint is a pure UI action; undo pops back to the draw phase (practice mode)
      await act('#act-hint');
      hook.onFirstDraw = async () => {
        await act('#act-draw-deck');
        await page.waitForFunction(() => window.MeldUI.session.state.phase === 'act');
        await act('#act-undo');
        await page.waitForFunction(() =>
          window.MeldUI.session.state.phase === 'draw' &&
          window.MeldUI.session.state.turn === window.MeldUI.session.humanSeat);
      };
      hook.act = act;
      const end = await playUntilRoundEnd(page, hook);
      console.log(`  round 1 ended: ${end}`);
      await page.waitForSelector('#screen-results.active', { timeout: 5000 });
      const headline = await page.textContent('#results-headline');
      if (!headline || !headline.trim()) throw new Error('empty results headline');
      console.log('  headline:', headline.trim());
      const rows = await page.locator('#results-table tr').count();
      if (rows < 3) throw new Error(`results table too small: ${rows} rows`);
      await page.screenshot({ path: SHOT('results', tag) });
    });

    let round = 1;
    while (round < maxRounds) {
      round++;
      const st = await readState(page);
      if (st.phase === 'matchOver') break;
      await step(`round ${round}: next round + keyboard turn, play to results`, async () => {
        await act('#btn-results-next');
        await page.waitForSelector('#screen-play.active');
        await waitHumanDraw(page);
        // one turn driven entirely by real key presses: draw, select, discard
        await page.keyboard.press('KeyD');
        await page.waitForFunction(() => window.MeldUI.session.state.phase === 'act', null, { timeout: 5000 });
        await page.keyboard.press('Enter'); // toggle focused card
        await page.waitForFunction(() => window.MeldUI.selection.length === 1);
        await page.keyboard.press('KeyX'); // discard it
        await page.waitForFunction(() =>
          window.MeldUI.session.state.turn !== window.MeldUI.session.humanSeat ||
          window.MeldUI.session.isOver(), null, { timeout: 5000 });
        const end = await playUntilRoundEnd(page, { act });
        console.log(`  round ${round} ended: ${end}`);
        await page.waitForSelector('#screen-results.active', { timeout: 5000 });
      });
    }

    await step('pause + resume + settings mid-match', async () => {
      const st = await readState(page);
      if (st.phase !== 'matchOver') {
        await act('#btn-results-next');
        await page.waitForSelector('#screen-play.active');
        await act('#btn-pause');
        await page.waitForSelector('#overlay-pause.active');
        await page.screenshot({ path: SHOT('pause', tag) });
        await act('#btn-pause-settings');
        await page.waitForSelector('#overlay-settings.active');
        await act('#btn-settings-close');
        await page.waitForFunction(() => !document.getElementById('overlay-settings').classList.contains('active'));
        await act('#btn-resume');
        await page.waitForFunction(() => !document.getElementById('overlay-pause').classList.contains('active'));
        // leave through the pause overlay, the way a player quits
        await act('#btn-pause');
        await page.waitForSelector('#overlay-pause.active');
        await act('#btn-leave');
        await page.waitForSelector('#screen-title.active');
      } else {
        await act('#btn-results-leave');
        await page.waitForSelector('#screen-title.active');
      }
      await page.screenshot({ path: SHOT('back-to-title', tag) });
    });

    await step('progress persisted to localStorage', async () => {
      const raw = await page.evaluate(() => localStorage.getItem('meldhall.save.v1'));
      if (!raw) throw new Error('no progress saved');
      const p = JSON.parse(raw).data;
      if (!p.career || p.career.rounds < 1) throw new Error('career rounds not recorded');
      console.log(`  career rounds recorded: ${p.career.rounds}`);
    });
  } finally {
    await context.close();
  }
  return errors;
}

/* ---------- main ---------- */

const { server, port: PORT } = await startServer();
let browser = null;
let failed = false;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  const allErrors = [];
  allErrors.push(...await playthrough(browser, 'desktop', { width: 1280, height: 800 }, false, 3));
  allErrors.push(...await playthrough(browser, 'mobile', { width: 390, height: 844 }, true, 2));
  if (allErrors.length) {
    failed = true;
    console.error('FAIL - console/page errors seen during playthrough:');
    for (const e of allErrors) console.error('  ' + e);
  }
} catch (e) {
  failed = true;
  console.error('FAIL - ' + (e && e.stack || e));
} finally {
  if (browser) await browser.close();
  server.close();
}
if (failed) process.exit(1);
console.log('ok - meld-hall e2e playthrough passed (desktop + mobile)');
