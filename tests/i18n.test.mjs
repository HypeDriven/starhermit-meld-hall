// Localization coverage: every English key the engine client (native/*.ts),
// the content and the sound captions show is translated in every locale
// (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR inherit), placeholders
// survive, no table keeps a key nothing shows, the account lines exist in
// every locale, and src/i18n.js switches locale as native/i18n.ts drives it.
// Run: node --test tests/i18n.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadTables, codeKeys, audit, bootI18n, LOCALES } from './i18n-common.mjs';

const require = createRequire(import.meta.url);
const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const Content = require('../src/content.js');

export function usedKeys() {
  const keys = new Set();
  for (const item of [...Content.LESSONS, ...Content.CHALLENGES, ...Content.ACHIEVEMENTS]) { keys.add(item.title); keys.add(item.text); }
  for (const f of readdirSync(new URL('native/', ROOT)).filter((n) => n.endsWith('.ts'))) {
    const src = read('native/' + f);
    codeKeys(src, ['N'], ['T']).forEach((k) => keys.add(k));
    // the sound captions table (native/audio.ts CAPTIONS: English keys translated where shown)
    if (f === 'audio.ts') for (const m of src.slice(src.indexOf('CAPTIONS'), src.indexOf('};', src.indexOf('CAPTIONS'))).matchAll(/: "([^"]+)"/g)) keys.add(m[1]);
  }
  return [...keys].filter((k) => /[A-Za-z]/.test(k) && k !== 'Meld Hall').sort();
}

test('every used key is translated in every locale; placeholders intact; nothing stale', () => {
  const used = usedKeys();
  assert.ok(used.length > 120, `keys found: ${used.length}`);
  assert.deepEqual(audit(loadTables(ROOT, 'src/strings.js', 'MH_STRINGS'), used), []);
});

test('the account and leaderboard lines exist in every locale with their placeholders', () => {
  const Sh = require('../src/sh-strings.js');
  const en = Sh.SH_STRINGS['en-US'];
  for (const loc of LOCALES) {
    const t = Sh.SH_STRINGS[loc];
    assert.ok(t, loc);
    for (const k of Object.keys(en)) {
      assert.ok(t[k], `${loc} ${k}`);
      assert.deepEqual((t[k].match(/\{\w+\}/g) || []).sort(), (en[k].match(/\{\w+\}/g) || []).sort(), `${loc} ${k}`);
    }
  }
});

test('the locale switches as the engine client sets it', () => {
  const { I18N } = bootI18n(ROOT, { strings: 'src/strings.js', i18n: 'src/i18n.js', global: 'MHI18N' });
  assert.equal(I18N.lang, 'en-US');
  assert.equal(I18N.setLocale('de-DE'), 'de-DE');
  assert.equal(I18N.T('Discard'), 'Abwerfen');
  I18N.setLocale('fr-CA');
  assert.equal(I18N.T('Discard'), 'Défausser');
  I18N.setLocale('en-GB');
  assert.equal(I18N.T('Color palette'), 'Colour palette');
  I18N.setLocale('es-ES');
  assert.equal(I18N.T('Settings'), 'Ajustes');
  assert.equal(I18N.T('Deck: {n}', { n: 7 }), 'Mazo: 7');
  assert.equal(I18N.setLocale('xx-YY'), 'en-US');
});
