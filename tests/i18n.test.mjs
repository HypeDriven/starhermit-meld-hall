// Localization coverage: every English key the engine client (native/*.ts),
// the content and the sound captions show is translated in every locale
// (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR inherit), placeholders
// survive, no table keeps a key nothing shows (assets/strings.json).
// Run: node --test tests/i18n.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { codeKeys, audit } from './i18n-common.mjs';

const require = createRequire(import.meta.url);
const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const TABLES = JSON.parse(read('assets/strings.json'));
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
  assert.deepEqual(audit(TABLES, used), []);
});

test('regional variants inherit; the generated tables hold what they did', () => {
  assert.equal(TABLES['de-DE'].Discard, 'Abwerfen');
  assert.equal(TABLES['en-GB']['Color palette'], 'Colour palette');
  assert.equal(TABLES['es-ES'].Settings, 'Ajustes');
  assert.equal(TABLES['es-419']['Deck: {n}'], 'Mazo: {n}');
  assert.equal(TABLES['en-US'].Discard, 'Discard');
});
