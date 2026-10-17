// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts a 4-player Practice match and keeps playing the human seat through the visible buttons (draw,
// meld / lay off when legal, else discard the highest card), pressing Next / Replay at the results — the
// AI turns, card lifts, selection glow, sparks, lamp shimmer and dust motes run all the time.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#screen-title.active', { timeout: 20000 });
  await page.click('#btn-settings');
  await page.waitForSelector('#overlay-settings.active');
  await page.locator('#set-quality').scrollIntoViewIfNeeded();
  await page.selectOption('#set-quality', preset);
  await page.waitForFunction((p) => document.getElementById('gl').dataset.gfxPreset === p, preset);
  await page.locator('#btn-settings-close').scrollIntoViewIfNeeded();
  await page.click('#btn-settings-close');
  await page.waitForFunction(() => !document.getElementById('overlay-settings').classList.contains('active'));
}

const readState = (page) => page.evaluate(() => {
  const UI = window.MeldUI, s = UI && UI.session;
  if (!s) return null;
  const hand = s.state.hands[s.humanSeat].cards.slice().sort((a, b) => window.MeldRules.cardValue(b) - window.MeldRules.cardValue(a));
  return { screen: UI.currentScreen, phase: s.state.phase, mine: s.state.turn === s.humanSeat, legal: s.legal(),
    selection: UI.selection.slice(), high: hand[0] };
});

const results = (page) => page.locator('#screen-results.active').count();

async function step(page) {
  if (await results(page)) {
    const next = page.locator('#btn-results-next');
    return (await next.isVisible()) ? next.click({ timeout: 3000 }) : page.click('#btn-results-replay', { timeout: 3000 });
  }
  const st = await readState(page);
  if (!st || !st.mine) return;
  const sel = new Set(st.selection);
  if (st.phase === 'draw') {
    const disc = st.legal.some((a) => a.type === 'draw' && a.source === 'discard');
    return page.click(disc ? '#act-draw-discard' : '#act-draw-deck', { timeout: 3000 });
  }
  if (st.phase !== 'act') return;
  const meld = st.legal.find((a) => a.type === 'meld');
  const lay = !meld && st.legal.find((a) => a.type === 'layoff');
  const want = meld ? meld.cards : lay ? [lay.card] : [st.high];
  const extra = [...sel].some((c) => !want.includes(c));
  if (extra) return page.keyboard.press('Escape');
  const missing = want.find((c) => !sel.has(c));
  if (missing != null) return page.click(`#hand-dom .card-btn[data-card="${missing}"]`, { timeout: 3000 });
  return page.click(meld ? '#act-meld' : lay ? '#act-layoff' : '#act-discard', { timeout: 3000 });
}

export async function start(page) {
  await page.click('#btn-play');
  await page.waitForSelector('#screen-mode.active');
  await page.locator('#mode-list').getByRole('button', { name: 'Practice', exact: true }).click();
  await page.selectOption('#opt-players', '4').catch(() => page.selectOption('#opt-players', '3'));
  await page.click('#btn-mode-start');
  await page.waitForSelector('#screen-play.active');
  await page.waitForFunction(() => !!window.MeldUI.session);
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(150).catch(() => {});
    }
  })();
  await page.waitForTimeout(1500);
}
