// Localization: the browser build's string tables (src/strings.js through
// src/i18n.js: the nine StarHermit locales, English text as the key) and the
// account-control strings (src/sh-strings.js), in the interface language the
// runtime reports (preferences().language: the player's choice in Options ›
// Language, else the account's preferred language or the device's). The
// runtime's Options replaced the game's Language setting (sh-language.js) and
// the DOM re-labelling: every string is drawn through T() each frame, so a
// change shows on the next frame. Card names (A♣, 10♥ …) are the same in
// every locale.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { I18n, ShStrings } from "./classic.ts";

const PRIMARY: Record<string, string> = { en: "en-US", es: "es-419", de: "de-DE", fr: "fr-FR", pt: "pt-BR", it: "it-IT" };

/** The shipped locale nearest a BCP 47 tag (en-GB, es-ES and fr-CA by region; es-MX → es-419). */
export function pickLocale(tag: string): string {
  const s = String(tag || "en-US");
  const exact = I18n.locales.find((l) => l.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const lang = s.split("-")[0]!.toLowerCase();
  if (lang === "en" && /-(gb|uk|ie|au|nz|za|in)$/i.test(s)) return "en-GB";
  if (lang === "es" && /-es$/i.test(s)) return "es-ES";
  if (lang === "fr" && /-ca$/i.test(s)) return "fr-CA";
  return PRIMARY[lang] ?? "en-US";
}

let locale = "";
function apply(tag: string): void {
  const next = pickLocale(tag);
  if (next === locale) return;
  locale = I18n.setLocale(next);
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));
export function currentLocale(): string { return locale; }

export type Vars = Record<string, string | number>;
/** A game string by its English key in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return I18n.T(key, vars ?? null); }
/** Marks an English key; translated with T() where it is shown. */
export const N = (key: string): string => key;
/** The account controls' strings (sign in, invite, leaderboard line, …). */
export function S(key: string, vars?: Vars): string {
  let s = ShStrings.shStrings([locale])[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}
