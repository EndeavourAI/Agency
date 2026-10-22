import { RGBA } from "@opentui/core";
import type { ThemeName, UiMode } from "../state/types.ts";
import type { Color } from "../view/rows.ts";

/** The three canvas themes (class.js THEMES), colour for colour. Every text level passes WCAG AA on bg, panel and element. */
export const HEX = {
  agency: {
    bg: "#101113",
    panel: "#17181b",
    element: "#24262a",
    line: "#2e3035",
    text: "#ebe9e4",
    soft: "#c3c0b8",
    muted: "#8f8c85",
    dim: "#6a6760",
    brand: "#e0b46c",
    you: "#8fb3e8",
    youBg: "#1f2839",
    plan: "#b9a3ff",
    auto: "#f08a5d",
    add: "#8fcf7f",
    del: "#ef7c74",
    addBg: "#18241a",
    delBg: "#2b1716",
  },
  night: {
    bg: "#1a1b26",
    panel: "#1f2335",
    element: "#2a2f45",
    line: "#3b4261",
    text: "#c0caf5",
    soft: "#a9b1d6",
    muted: "#8d97c3",
    dim: "#636d9e",
    brand: "#e0af68",
    you: "#7aa2f7",
    youBg: "#2a3354",
    plan: "#bb9af7",
    auto: "#ff9e64",
    add: "#9ece6a",
    del: "#f7768e",
    addBg: "#20303b",
    delBg: "#37222c",
  },
  light: {
    bg: "#faf8f3",
    panel: "#f1eee6",
    element: "#e5e1d6",
    line: "#d6d1c4",
    text: "#22201c",
    soft: "#45413a",
    muted: "#625d54",
    dim: "#8b857b",
    brand: "#855a0d",
    you: "#2a5fa8",
    youBg: "#dde6f2",
    plan: "#6b45c2",
    auto: "#a4471c",
    add: "#2c7136",
    del: "#b2392d",
    addBg: "#e3efdf",
    delBg: "#f5e1dc",
  },
} as const satisfies Record<ThemeName, Record<string, string>>;

export type ColorName = keyof (typeof HEX)["agency"];
/** `scrim` dims what a dialog covers (class.js `scrim`); a terminal without truecolor gets none, as a blend would leave the palette. */
export type Palette = Record<ColorName, Color> & { scrim: RGBA | null };

const SCRIM = {
  agency: [16, 17, 19, 0.78],
  night: [22, 22, 30, 0.78],
  light: [250, 248, 243, 0.8],
} as const satisfies Record<ThemeName, readonly [number, number, number, number]>;

const LEVELS: readonly number[] = [0, 95, 135, 175, 215, 255];

/** The xterm-256 index nearest to a colour: the 6x6x6 cube or the grey ramp, whichever is closer. */
export function nearest256(hex: string): number {
  const rgb = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const dist = (c: readonly number[]) => c.reduce((n, v, i) => n + (v - (rgb[i] ?? 0)) ** 2, 0);
  const step = (v: number): number =>
    LEVELS.reduce((best, l, i) => (Math.abs(l - v) < Math.abs((LEVELS[best] ?? 0) - v) ? i : best), 0);
  const [r = 0, g = 0, b = 0] = rgb.map(step);
  const avg = Math.round(((rgb[0] ?? 0) + (rgb[1] ?? 0) + (rgb[2] ?? 0)) / 3);
  const grey = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const greyV = 8 + grey * 10;
  const cube = [r, g, b].map((i) => LEVELS[i] ?? 0);
  return dist([greyV, greyV, greyV]) < dist(cube) ? 232 + grey : 16 + 36 * r + 6 * g + b;
}

const palettes = new Map<string, Palette>();

/** Truecolor hex, or the nearest of the 256 colours when the terminal does not say it does RGB. Cached: views memoize rows on its identity. */
export function palette(theme: ThemeName, truecolor: boolean): Palette {
  const key = `${theme}:${truecolor}`;
  const hit = palettes.get(key);
  if (hit) return hit;
  const src = HEX[theme] ?? HEX.agency;
  const out = { scrim: null } as Palette;
  for (const k of Object.keys(src) as ColorName[])
    out[k] = truecolor ? src[k] : RGBA.fromIndex(nearest256(src[k]));
  const [r, g, b, a] = SCRIM[theme] ?? SCRIM.agency;
  if (truecolor) out.scrim = RGBA.fromInts(r, g, b, Math.round(a * 255));
  palettes.set(key, out);
  return out;
}

/** Build has no colour of its own; only a departure from it takes one. */
export const modeColor = (c: Palette, mode: UiMode): Color =>
  mode === "plan" ? c.plan : mode === "auto" ? c.auto : c.text;

/** COLORTERM, TERM or Windows Terminal says truecolor; anything else gets the 256-colour fallback. */
export const isTruecolor = (env: Record<string, string | undefined> = process.env): boolean =>
  /truecolor|24bit/i.test(env.COLORTERM ?? "") ||
  /direct|truecolor/i.test(env.TERM ?? "") ||
  env.WT_SESSION !== undefined;
