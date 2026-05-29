/**
 * Lowercase + strip Lithuanian (and any Latin) diacritics so client-side
 * filters match what users actually type on a Lithuanian keyboard.
 *
 * Lithuanian users habitually drop the accents: searching "zvake" must
 * find "žvakė", "duona" must find "Duona", "asuolis" must find "ąžuolas".
 * `String.normalize('NFD')` decomposes letters like `ž` → `z` + combining
 * caron; the regex then drops the combining marks, leaving plain ASCII.
 *
 * Mirrors `normalizeProductName` over in the receipt matcher (utils/
 * compareToTruth.ts) but kept separate because that one also collapses
 * punctuation — here we keep substring semantics intact.
 */
export function searchFold(s: string): string {
    return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
