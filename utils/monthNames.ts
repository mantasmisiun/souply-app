// Localized month names + range formatting for the profile carousel's
// month-scoped cards. The server only emits short Lithuanian abbreviations
// (LT_MONTHS in statsService), which are wrong in EN and can't express
// LT's year-first ordering — so the client formats its own labels from a
// `YYYY-MM` key. Self-contained (no Intl locale-data dependency — Hermes
// ships limited ICU data).

// Full names. Lithuanian months are lowercase in running text (correct LT
// typography); English months are capitalized.
const MONTHS_LT = [
    'sausis', 'vasaris', 'kovas', 'balandis', 'gegužė', 'birželis',
    'liepa', 'rugpjūtis', 'rugsėjis', 'spalis', 'lapkritis', 'gruodis',
];
const MONTHS_EN = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

// Short abbreviations for the compact range label above the bar chart.
const ABBR_LT = ['sau', 'vas', 'kov', 'bal', 'geg', 'bir', 'lie', 'rgp', 'rgs', 'spa', 'lap', 'grd'];
const ABBR_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const isLt = (locale: string) => locale.toLowerCase().startsWith('lt');

/** Full month name (1-based month), localized. */
export function monthLong(month: number, locale: string): string {
    return (isLt(locale) ? MONTHS_LT : MONTHS_EN)[Math.min(11, Math.max(0, month - 1))];
}

/** Short month abbreviation (1-based month), localized. */
export function monthAbbr(month: number, locale: string): string {
    return (isLt(locale) ? ABBR_LT : ABBR_EN)[Math.min(11, Math.max(0, month - 1))];
}

/** Parse a `YYYY-MM` key into [year, month] (1-based), or null if malformed. */
export function parseMonthKey(key: string): [number, number] | null {
    const [yStr, mStr] = (key ?? '').split('-');
    const y = Number(yStr);
    const m = Number(mStr);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
    return [y, m];
}

/**
 * Format a `YYYY-MM` key into a single-month picker label. Year-first in LT
 * ("2026 liepa"), month-first in EN ("July 2026").
 */
export function formatMonthKey(key: string, locale: string): string {
    const parsed = parseMonthKey(key);
    if (!parsed) return key;
    const [y, m] = parsed;
    const name = monthLong(m, locale);
    return isLt(locale) ? `${y} ${name}` : `${name} ${y}`;
}

/**
 * Format an inclusive month range into a compact label, language-aware.
 *   LT (year first): "2026 bal–lie", cross-year "2025 grd – 2026 sau"
 *   EN:              "Apr–Jul 2026", cross-year "Dec 2025 – Jan 2026"
 * Collapses to a single month when start === end.
 */
export function formatMonthRange(startKey: string, endKey: string, locale: string): string {
    const s = parseMonthKey(startKey);
    const e = parseMonthKey(endKey);
    if (!s || !e) return '';
    const [sy, sm] = s;
    const [ey, em] = e;
    const sName = monthAbbr(sm, locale);
    const eName = monthAbbr(em, locale);
    const lt = isLt(locale);

    if (sy === ey && sm === em) {
        return lt ? `${sy} ${sName}` : `${sName} ${sy}`;
    }
    if (sy === ey) {
        return lt ? `${sy} ${sName}–${eName}` : `${sName}–${eName} ${sy}`;
    }
    return lt
        ? `${sy} ${sName} – ${ey} ${eName}`
        : `${sName} ${sy} – ${eName} ${ey}`;
}
