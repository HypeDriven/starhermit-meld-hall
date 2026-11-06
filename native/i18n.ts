// Localization: the engine's string tables (assets/strings.json, generated from
// the browser build's tables: the nine StarHermit locales, English text as the
// key) and its `starhermit.*` account lines, in the interface language the
// runtime reports (the player's choice in Options › Language, else the account's
// preferred language or the device's). The runtime's Options replaced the game's
// Language setting (sh-language.js) and the DOM re-labelling: every string is
// drawn through T() each frame, so a change shows on the next frame. Card names
// (A♣, 10♥ …) are the same in every locale.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export type Vars = Record<string, string | number>;
/** A game string by its English key in the player's language; `{name}` placeholders from vars. Anything without a message passes through. */
export function T(key: string, vars?: Vars | null): string {
  if (strings.has(key)) return strings.t(key, vars ?? undefined);
  return vars ? key.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] != null ? String(vars[k]) : m)) : key;
}
/** Marks an English key; translated with T() where it is shown. */
export const N = (key: string): string => key;
/** The engine's account lines (sign in, invite, leaderboard line, …). */
export function S(name: string, vars?: Vars): string { return strings.t(`starhermit.${name}`, vars); }
