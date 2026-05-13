/**
 * Locale-aware number formatters used across the receipt-detail surfaces.
 *
 * Centralising these prevents the `replace(".", ",")` pattern from being
 * sprinkled across components. The redesign needs to display euros and
 * kilometres in many places (savings stat, per-row total, distance line,
 * footer grid, category breakdown). When we eventually ship outside
 * Lithuania, only this file changes.
 *
 * Why `Intl.NumberFormat` over manual: it handles the comma vs dot
 * decision, thousand separators, and per-locale spacing rules ("46,30 €"
 * vs "€46.30") in one call. Hermes ships with full Intl on RN 0.74+.
 */

/**
 * Format a money amount as a Lithuanian-style euro string by default.
 * Examples (lt-LT):
 *   formatEuro(46.3)       → "46,30 €"
 *   formatEuro(0.05)       → "0,05 €"
 *   formatEuro(1234.5)     → "1 234,50 €"
 */
export function formatEuro(amount: number, locale: string = "lt-LT"): string {
    if (!Number.isFinite(amount)) return "—";
    return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "EUR",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(amount);
}

/**
 * Format a distance in kilometres. Uses one decimal under 10 km
 * ("1,2 km") and rounds to integer above ("12 km") — the convention
 * users expect from maps apps.
 *
 *   formatKm(0)            → "0 km"
 *   formatKm(0.8)          → "0,8 km"
 *   formatKm(1.23)         → "1,2 km"
 *   formatKm(12.7)         → "13 km"
 *   formatKm(120.4)        → "120 km"
 */
export function formatKm(km: number, locale: string = "lt-LT"): string {
    if (!Number.isFinite(km)) return "—";
    if (km <= 0) return "0 km";
    const fractionDigits = km < 10 ? 1 : 0;
    const formatted = new Intl.NumberFormat(locale, {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
    }).format(km);
    return `${formatted} km`;
}
