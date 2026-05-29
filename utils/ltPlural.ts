/**
 * Lithuanian-noun plural suffix resolver, mirroring the CLDR rules:
 *
 *   one   — last digit is 1, except teens (11–19)   → "prekė"
 *   few   — last digit 2–9,  except teens (12–19)   → "prekės"
 *   other — everything else (0, 10–20, 100, …)      → "prekių"
 *
 * Why this exists instead of leaning on `t('items.count', { count })`:
 * i18next's plural resolver depends on `Intl.PluralRules`, which Hermes
 * historically ships without full ICU data on some Android builds — so
 * Lithuanian collapses to one/other and "2 prekė" / "5 prekė" leaks
 * through. Picking the suffix ourselves keeps the keys but bypasses the
 * runtime's plural detection.
 *
 * Callers pass the desired translation key prefix (e.g. `'items.count'`)
 * and we append `_one` / `_few` / `_other` before handing it to `t()`.
 */
export type LtPluralSuffix = 'one' | 'few' | 'other';

export function ltPluralSuffix(count: number): LtPluralSuffix {
    const n = Math.abs(Math.trunc(count));
    const lastTwo = n % 100;
    if (lastTwo >= 11 && lastTwo <= 19) return 'other';
    const last = n % 10;
    if (last === 1) return 'one';
    if (last >= 2 && last <= 9) return 'few';
    return 'other';
}
