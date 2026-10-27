// The look of the menus, HUD, rails, tray and dialogs: the browser build's
// src/style.css, rewritten class-based in tools/ui-style.css and converted
// once with `starhermit css` into assets/ui-style.json (`npm run css`),
// registered at start with the theme the runtime's own widgets (scroll bars,
// focus rings, selects, check boxes) take. The old body.high-contrast palette
// is a token set applied while the runtime's high-contrast option is on, and
// the colour-vision palettes (the game's own option) move the accent and the
// red suits to safely separable hues, as body.palette-* did.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string | number>;
let base: Tokens = {};
let styles: Record<string, ui.Style> = {};
/** style.css body.high-contrast. */
const HIGH_CONTRAST: Tokens = { bg: "#000000", panel: "#000000", panel2: "#111111", text: "#ffffff", muted: "#dddddd", accent: "#ffd700", focus: "#00ffff", hud: "#000000", line: "#ffffff", edge: "#ffffff" };
/** style.css body.palette-*: the accent and the red suits. */
const PALETTES: Record<string, Tokens> = {
  default: {},
  deuteranopia: { accent: "#4aa3ff", "red-suit": "#14568f" },
  protanopia: { accent: "#4aa3ff", "red-suit": "#14568f" },
  tritanopia: { accent: "#7fd0d8", "red-suit": "#b03a2e" },
};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  styles = css.styles as Record<string, ui.Style>;
  ui.setFont({ family: "sans-serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 12, radius: 8,
    text: "#eef2f8", muted: "#9aa8bc", panel: "#1a2334", control: "#223048", hovered: "#2b3b58",
    pressed: "#1a2334", field: "#223048", accent: "#e8b34b", focus: "#7fc4ff", outline: "#3a4a68",
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$text" } },
    paragraph: { text: { color: "$text" } },
    heading: { text: { color: "$text" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "$muted", radius: 4 } } },
    tooltip: { background: "$panel", text: { color: "$text" }, radius: 6, padding: 6 },
    // index.html .overlay: the panel over a dim of the screen behind it.
    dialog: { ...(css.styles[".dialog-panel"] as ui.Style), parts: { backdrop: { background: "#05080eb3" } } },
  });
}
/** A converted class's style object (for drawing it with a changed opacity). */
export function styleOf(cls: string): ui.Style { return styles[`.${cls}`] ?? {}; }

let key = "";
/** The high-contrast and colour-vision tokens over the sheet's. */
export function applyTokens(highContrast: boolean, palette: string): void {
  const k = `${highContrast}:${palette}`;
  if (k === key) return;
  key = k;
  ui.setTokens({ ...base, ...(PALETTES[palette] ?? {}), ...(highContrast ? HIGH_CONTRAST : {}) });
}
/** The current token value (the hand's suit colours). */
export function token(name: string, highContrast: boolean, palette: string): string {
  const t = { ...base, ...(PALETTES[palette] ?? {}), ...(highContrast ? HIGH_CONTRAST : {}) };
  return String(t[name] ?? "#000000");
}
