/**
 * Which ink is readable on a given background — black or white.
 *
 * The cover colour is chosen by the user from a palette that spans a pink
 * (#EB6784), an amber (#F0AE3F) and a green (#4FAE52), plus any custom colour
 * they pick. Hard-coding white ink for "any cover colour" left the amber cover's
 * title as white-on-yellow, which is close to invisible — and it degrades with
 * every light colour someone chooses next.
 *
 * Uses relative luminance (WCAG 2.1), not a naive average: the eye is far more
 * sensitive to green than to blue, so #F0AE3F reads much brighter than its RGB
 * mean suggests and must take dark ink.
 */

const srgbToLinear = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** Parse #rgb / #rrggbb / #rrggbbaa into 0-255 components. */
const parseHex = (hex: string): [number, number, number] | null => {
    const h = hex.trim().replace('#', '');
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) return null;
    return [
        parseInt(full.slice(0, 2), 16),
        parseInt(full.slice(2, 4), 16),
        parseInt(full.slice(4, 6), 16),
    ];
};

/** WCAG relative luminance, 0 (black) → 1 (white). */
export const relativeLuminance = (hex: string): number => {
    const rgb = parseHex(hex);
    if (!rgb) return 0;
    const [r, g, b] = rgb.map(srgbToLinear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio between two luminances, 1:1 → 21:1. */
const ratio = (a: number, b: number): number =>
    (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * The floor white ink has to clear to stay. 3.0 is WCAG's minimum for LARGE
 * text, which is what a cover title is (22 pt, bold).
 *
 * Chosen rather than "whichever ratio is higher" on purpose: black wins the
 * arithmetic on every colour in the palette, but the app's identity is white on
 * the pink, and at 3.09:1 that is legible. The amber cover is 1.94:1 — it fails
 * even this relaxed bar, which is exactly the "white letters on a yellowish
 * background, almost unreadable" the palette shipped with.
 */
const LARGE_TEXT_MIN = 3.0;

/**
 * Ink for text and icons sitting ON `background`.
 *
 * `dark`/`light` are overridable so a caller can use its palette's near-black
 * instead of pure #000, which looks harsh on a saturated colour.
 */
export const inkOn = (background: string, dark = '#1A1A1A', light = '#FFFFFF'): string => {
    const bg = relativeLuminance(background);
    return ratio(bg, relativeLuminance(light)) >= LARGE_TEXT_MIN ? light : dark;
};

/** True when white ink would fail the large-text contrast floor on this colour. */
export const isLightColor = (background: string): boolean =>
    ratio(relativeLuminance(background), 1) < LARGE_TEXT_MIN;
