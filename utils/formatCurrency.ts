/**
 * Locale-aware number and date formatters used across the app.
 *
 * Why centralised: prevents `replace(".", ",")` and the per-call
 * `i18n.language === 'en' ? 'en-GB' : 'lt-LT'` ternary from scattering
 * across components. A single source of truth means flipping the user's
 * language updates every euro/date/distance display consistently.
 *
 * Why `Intl.NumberFormat` / `Intl.DateTimeFormat` over manual: they
 * handle the comma-vs-dot decision, thousand separators, currency
 * symbol placement ("46,30 €" vs "€46.30"), and per-locale date
 * conventions in one call. Hermes ships full Intl on RN 0.74+.
 */

import i18n from '../i18n';

/** App language → BCP-47 locale tag for Intl APIs. */
function resolveLocale(locale?: string): string {
    if (locale) return locale;
    const lang = (i18n.language || 'lt').toLowerCase();
    return lang === 'en' ? 'en-GB' : 'lt-LT';
}

/**
 * Format a money amount as a currency string in the current UI locale.
 * Examples:
 *   lt-LT: formatEuro(46.3)   → "46,30 €"
 *   en-GB: formatEuro(46.3)   → "€46.30"
 */
export function formatEuro(amount: number, locale?: string): string {
    if (!Number.isFinite(amount)) return "—";
    return new Intl.NumberFormat(resolveLocale(locale), {
        style: "currency",
        currency: "EUR",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(amount);
}

/**
 * Format a plain decimal number (no currency) with the current locale's
 * separator. Use for quantities, scores, percentages — anywhere a `.toFixed`
 * would have leaked a dot into LT UI.
 */
export function formatDecimal(
    value: number,
    fractionDigits: number = 2,
    locale?: string,
): string {
    if (!Number.isFinite(value)) return "—";
    return new Intl.NumberFormat(resolveLocale(locale), {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
    }).format(value);
}

/**
 * Format a distance in kilometres. One decimal under 10 km ("1,2 km"),
 * rounded above ("12 km") — the convention users expect from maps apps.
 */
export function formatKm(km: number, locale?: string): string {
    if (!Number.isFinite(km)) return "—";
    if (km <= 0) return "0 km";
    const fractionDigits = km < 10 ? 1 : 0;
    const formatted = new Intl.NumberFormat(resolveLocale(locale), {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
    }).format(km);
    return `${formatted} km`;
}

/**
 * Format a Date (or anything `new Date()` accepts) using the current
 * UI locale. Defaults to short numeric date (e.g. "2026-05-14" in lt-LT,
 * "14/05/2026" in en-GB). Pass `options` to override.
 */
export function formatDate(
    value: Date | string | number,
    options?: Intl.DateTimeFormatOptions,
    locale?: string,
): string {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(resolveLocale(locale), options);
}
