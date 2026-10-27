// Plays the web package in Chrome on the machine's GPU (~/games/tools/
// gpu-chrome.mjs; GPU_ADAPTER=software for headless SwiftShader), the loader
// index.html that `npm run package` writes, at a desktop viewport, a phone
// (DPR 3) and a phone held sideways (DPR 3). Each opens Journey stage 1 from
// the title and plays its first round to the results and on into round 2,
// the seated player played by the rules' own AI (rules.js aiChoose for seat
// 0, as tools/gen-plays.mjs does): on the desktop by mouse clicks on the
// hand's cards and the tray, the draws by the D key and one by a click on the
// deck on the 3D table; on the phones by finger taps (CDP touch events) on
// the cards, the tray and the deck on the table. Widgets are found through
// the page's accessibility mirror of the engine's UI (getByRole). Screenshots
// of each step go to --shots. Fails on console errors or warnings, the
// runtime's error screen, or a view that never reaches round 2.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();
const require = createRequire(join(dir, 'package.json'));
const R = require('./src/rules.js');
const C = require('./src/content.js');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

// Journey stage 1's first round, the seated player as the rules' AI.
const stage = C.getStage(0);
const steps = [];
{
  let s = R.initialState(stage.seed, { players: stage.players, targetScore: stage.targetScore });
  let n = 0;
  while (s.phase !== 'roundOver' && s.phase !== 'matchOver') {
    const p = s.turn, c = R.aiChoose(s, p);
    c.player = p; c.id = 'c' + n++;
    if (p === 0) {
      if (c.type === 'draw') steps.push(['turn'], ['draw', c.source]);
      else {
        for (const id of c.type === 'meld' ? c.cards : [c.card]) steps.push(['press', `${R.cardName(id)}, value ${R.cardValue(id)}`]);
        steps.push(['press', { meld: 'Meld', layoff: 'Lay off', discard: 'Discard' }[c.type]]);
      }
    }
    s = R.applyCommand(s, c).state;
  }
}
const views = [
  { name: 'desktop', viewport: { width: 1366, height: 768 } },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
];

const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
let failed = false;
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const cdp = v.hasTouch ? await ctx.newCDPSession(page) : null;
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    const platformRoute = /\/api\//.test(m.location()?.url ?? '');
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text()) && !platformRoute) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
  await page.waitForTimeout(4000);
  const shot = async (name) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${name}.png`) }); } };
  const find = (name) => page.getByRole('button', { name, exact: true }).or(page.getByRole('switch', { name, exact: true })).or(page.getByRole('checkbox', { name, exact: true })).first();
  /** A press on a widget (or a table target): the mouse on the desktop, a finger on the phones. */
  const press = async (name) => {
    const el = find(name);
    await el.waitFor({ timeout: 15000 });
    const b = await el.boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  let reached = false;
  try {
    await shot('title');
    await press(`Journey 1/${C.STAGES.length}`);
    await find('Draw deck').waitFor({ timeout: 30000 });
    await page.waitForTimeout(2000);
    await shot('table');
    let draws = 0;
    for (const [op, a] of steps) {
      if (op === 'turn') await page.getByText('Your turn — draw').first().waitFor({ timeout: 60000 });
      else if (op === 'draw') {
        draws++;
        // the deck on the 3D table (a tap / click through its named target), else the D key or the tray
        if (a === 'deck' && draws === 2) { await press('Deck'); await shot('deck-tapped'); }
        else if (a === 'deck' && !cdp) { await page.keyboard.press('KeyD'); await page.waitForTimeout(250); }
        else await press(a === 'deck' ? 'Draw deck' : 'Take discard');
      } else await press(a);
      if (draws === 3 && op === 'press' && a === 'Discard') await shot('mid-round');
    }
    await find('Next round').waitFor({ timeout: 60000 });
    await page.waitForTimeout(800);
    await shot('results');
    await press('Next round');
    await page.getByText(/Round 2/).first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(1500);
    await shot('round-2');
    reached = true;
  } catch (e) { problems.push(`play: ${String(e.message || e).split('\n')[0]}`); await shot('failed'); }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state === 'running' && problems.length === 0 && reached;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'} round2=${reached}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);
