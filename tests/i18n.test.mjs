// Localization coverage: every English key the markup and code use is
// translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR
// inherit), placeholders survive, the language follows sh-language.js and
// switches live, and the Graphics and StarHermit strings cover the nine locales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadTables, codeKeys, htmlKeys, audit, bootI18n, LOCALES } from './i18n-common.mjs';

const require = createRequire(import.meta.url);
const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

function usedKeys() {
  const keys = new Set(htmlKeys(read('index.html')));
  for (const f of ['src/ui.js', 'src/platform.js', 'src/audio.js', 'src/content.js', 'src/main.js']) codeKeys(read(f), ['caption']).forEach((k) => keys.add(k));
  return [...keys].sort();
}

test('every used key is translated in every locale; placeholders intact', () => {
  const used = usedKeys();
  assert.ok(used.length > 150, 'keys found: ' + used.length);
  assert.deepEqual(audit(loadTables(ROOT, 'src/strings.js', 'MH_STRINGS'), used), []);
});

test('every lesson, challenge and achievement text is a translation key', () => {
  const Content = require('../src/content.js');
  const tables = loadTables(ROOT, 'src/strings.js', 'MH_STRINGS');
  for (const item of [...Content.LESSONS, ...Content.CHALLENGES, ...Content.ACHIEVEMENTS]) {
    for (const k of [item.title, item.text]) assert.ok(tables['de-DE'][k], 'de-DE missing ' + k);
  }
});

test('the locale follows sh-language and switches live', () => {
  const { I18N, events, doc } = bootI18n(ROOT, { strings: 'src/strings.js', i18n: 'src/i18n.js', global: 'MHI18N', languages: ['de-DE'] });
  assert.equal(I18N.lang, 'de-DE');
  assert.equal(doc.documentElement.lang, 'de-DE');
  assert.equal(I18N.T('Discard'), 'Abwerfen');
  I18N.language.setChoice('fr-CA');
  assert.equal(I18N.lang, 'fr-CA');
  assert.equal(events.at(-1), 'fr-CA');
  assert.equal(I18N.T('Score'), 'Pointage');
  assert.equal(I18N.T('Discard'), 'Défausser');
  I18N.language.setChoice('en-GB');
  assert.equal(I18N.T('Color palette'), 'Colour palette');
  I18N.language.setChoice('es-ES');
  assert.equal(I18N.T('Settings'), 'Ajustes');
  assert.equal(I18N.T('Deck: {n}', { n: 7 }), 'Mazo: 7');
});

test('Graphics and StarHermit strings cover all nine locales', () => {
  const GfxUI = require('../src/gfx-ui.js');
  const Sh = require('../src/sh-strings.js');
  const shKeys = Object.keys(Sh.SH_STRINGS['en-US']);
  for (const l of LOCALES) {
    assert.ok(GfxUI.STRINGS[l], l);
    for (const k of shKeys) assert.ok(Sh.SH_STRINGS[l][k], `${l} ${k}`);
  }
});
