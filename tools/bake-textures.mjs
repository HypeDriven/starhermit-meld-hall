// Bakes the browser build's procedural canvas textures (src/render.js before
// the engine port: feltTexture, woodTexture, floorTexture, makeFaceTexture,
// makeBackTexture with the authored assets/card-back.webp over it) into
// assets/textures/ by running that canvas code unchanged in Chrome
// (~/games/tools/gpu-chrome.mjs). Their per-pixel grain (getImageData over
// every pixel) paints far too slowly on the engine's canvas at start-up, so
// the engine client loads these images instead (native/render.ts):
//   felt-<px>.png, wood-<px>.png, floor-<px>.png   per preset texture budget
//     (Balanced 256, High 512, Ultra 1024; felt half, wood 2× wide × ⅛ tall)
//   faces.webp   the 52 card faces, 13 ranks × 4 suits, 256 × 368 px each
//   backs.webp   the card back per theme (content.js THEMES order), 256 × 368 each
// Run once; commit the images.   node tools/bake-textures.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const Content = require('../src/content.js');
function findPlaywright() {
  const roots = [root, resolve(root, '..'), ...readdirSync(resolve(root, '..')).map((d) => resolve(root, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

// The old src/render.js painters, verbatim but returning canvases.
const painters = String.raw`
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUIT_GLYPHS = ['♣', '♦', '♥', '♠'];
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function canvas(w, h) { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; return cv; }
function grain(g, w, h, amount, seed) {
  const img = g.getImageData(0, 0, w, h), d = img.data, r = rng(seed);
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * amount;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}
function scaled(w, h, aw, ah) { const cv = canvas(w, h), g = cv.getContext('2d'); g.scale(w / aw, h / ah); return [cv, g]; }
function feltTexture(size) {
  const n = size || 256, [cv, g] = scaled(n, n, 256, 256), r = rng(7);
  g.fillStyle = '#f0f0f0'; g.fillRect(0, 0, 256, 256);
  g.globalAlpha = 0.07; g.lineWidth = 1;
  for (let i = 0; i < 900; ++i) {
    const x = r() * 256, y = r() * 256, a = r() * Math.PI, l = 2 + r() * 5;
    g.strokeStyle = r() < 0.5 ? '#000' : '#fff';
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  g.globalAlpha = 1;
  grain(g, n, n, 22, 11);
  return cv;
}
function woodTexture(size) {
  const w = (size || 512) * 2, h = Math.max(16, (size || 512) / 8), [cv, g] = scaled(w, h, 1024, 64), r = rng(3);
  g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, 1024, 64);
  for (let i = 0; i < 60; ++i) {
    const y = r() * 64, h = 0.5 + r() * 2.2;
    g.fillStyle = r() < 0.6 ? 'rgba(60,40,20,' + (0.08 + r() * 0.16) + ')' : 'rgba(255,240,220,' + (0.06 + r() * 0.1) + ')';
    g.beginPath(); g.moveTo(0, y);
    for (let x = 0; x <= 1024; x += 32) g.lineTo(x, y + Math.sin(x * 0.01 + i) * 1.5);
    g.lineTo(1024, y + h); g.lineTo(0, y + h); g.fill();
  }
  grain(g, w, h, 14, 5);
  return cv;
}
function floorTexture(size) {
  const n = size || 512, [cv, g] = scaled(n, n, 512, 512), r = rng(9);
  for (let row = 0; row < 8; ++row) {
    let x = -r() * 256;
    while (x < 512) {
      const len = 160 + r() * 200, v = 150 + r() * 60;
      g.fillStyle = 'rgb(' + v + ',' + (v * 0.92) + ',' + (v * 0.85) + ')';
      g.fillRect(x, row * 64, len, 64);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(x, row * 64, 2, 64);
      x += len;
    }
    g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(0, row * 64, 512, 2);
  }
  grain(g, n, n, 18, 13);
  return cv;
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}
function makeFaceTexture(cardId) {
  const W = 256, H = 368;
  const cv = canvas(W, H), g = cv.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#f8f4ea'); grd.addColorStop(1, '#efe8d8');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  grain(g, W, H, 6, 17 + cardId);
  g.strokeStyle = '#cdbf9f'; g.lineWidth = 4;
  roundRect(g, 10, 10, W - 20, H - 20, 16); g.stroke();
  const suit = (cardId / 13) | 0, red = suit === 1 || suit === 2;
  const rank = RANKS[cardId % 13], glyph = SUIT_GLYPHS[suit];
  g.fillStyle = red ? '#a83232' : '#22303e';
  const corner = function () {
    g.textAlign = 'center'; g.textBaseline = 'top';
    g.font = 'bold ' + (rank.length > 1 ? 84 : 96) + 'px Georgia, serif';
    g.fillText(rank, 54, 18);
    g.font = '72px Georgia, serif';
    g.fillText(glyph, 54, 112);
  };
  corner();
  g.save(); g.translate(W, H); g.rotate(Math.PI); corner(); g.restore();
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '130px Georgia, serif';
  g.fillText(glyph, W / 2 + 18, H / 2 + 8);
  return cv;
}
function makeBackTexture(color, img) {
  const W = 256, H = 368;
  const cv = canvas(W, H), g = cv.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, W, H);
  const frame = function () {
    g.strokeStyle = 'rgba(255,255,255,0.4)'; g.lineWidth = 5;
    roundRect(g, 16, 16, W - 32, H - 32, 14); g.stroke();
    g.strokeStyle = 'rgba(232,179,75,0.55)'; g.lineWidth = 2;
    roundRect(g, 26, 26, W - 52, H - 52, 10); g.stroke();
  };
  g.globalAlpha = 0.16; g.strokeStyle = '#fff'; g.lineWidth = 2;
  g.beginPath();
  for (let i = -H; i < W + H; i += 18) { g.moveTo(i, 0); g.lineTo(i + H, H); g.moveTo(i + H, 0); g.lineTo(i, H); }
  g.stroke(); g.globalAlpha = 1;
  frame();
  // the authored back art, tinted over the procedural pattern (as when it decoded)
  g.globalAlpha = 0.85;
  g.drawImage(img, 12, 12, W - 24, H - 24);
  g.globalAlpha = 1;
  frame();
  return cv;
}
function sheet(cols, rows, list) {
  const cv = canvas(cols * 256, rows * 368), g = cv.getContext('2d');
  list.forEach(function (c, i) { g.drawImage(c, (i % cols) * 256, Math.floor(i / cols) * 368); });
  return cv;
}
async function backs(colors, src) {
  const img = new Image();
  await new Promise(function (res, rej) { img.onload = res; img.onerror = rej; img.src = src; });
  return sheet(colors.length, 1, colors.map(function (c) { return makeBackTexture(c, img); }));
}
`;

const backArt = 'data:image/webp;base64,' + readFileSync(join(root, 'assets', 'card-back.webp')).toString('base64');
const jobs = [];
for (const tb of [256, 512, 1024]) {
  jobs.push([`felt-${tb / 2}.png`, `feltTexture(${tb / 2})`]);
  jobs.push([`wood-${tb}.png`, `woodTexture(${tb})`]);
  jobs.push([`floor-${tb}.png`, `floorTexture(${tb})`]);
}
jobs.push(['faces.webp', 'sheet(13, 4, Array.from({ length: 52 }, (_, i) => makeFaceTexture(i)))']);
jobs.push(['backs.webp', `backs(${JSON.stringify(Content.THEMES.map((t) => t.cardBack))}, ${JSON.stringify(backArt)})`]);

const out = join(root, 'assets', 'textures');
mkdirSync(out, { recursive: true });
const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, close } = await launchChrome(chromium);
const page = await browser.newPage();
await page.setContent('<!doctype html><html><body></body></html>');
await page.addScriptTag({ content: painters });
for (const [file, expr] of jobs) {
  const url = await page.evaluate(async ([e, webp]) => {
    const cv = await (0, eval)(e);
    return webp ? cv.toDataURL('image/webp', 0.92) : cv.toDataURL('image/png');
  }, [expr, file.endsWith('.webp')]);
  writeFileSync(join(out, file), Buffer.from(url.split(',')[1], 'base64'));
  console.log(file);
}
await close();
