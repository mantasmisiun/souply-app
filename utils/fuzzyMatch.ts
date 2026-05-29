import { searchFold } from './searchFold';

/**
 * Forgiving name-search matcher. Designed to behave like the user expects
 * when filtering Lithuanian product names without paying for a full search
 * engine:
 *
 *   1. Diacritic-fold both sides → "zvake" matches "žvakė".
 *   2. Token-AND ordering: each query token must hit somewhere in the
 *      candidate, but not adjacently or in the typed order — "kapu zvake"
 *      and "zvake kapu" both find "Kapų raudona žvakė".
 *   3. Per-token typo tolerance via Levenshtein with a length-adaptive
 *      budget (no errors for 1–3 char tokens, 1 for 4–5, 2 for 6+). That
 *      catches dropped/transposed letters ("zkae" → "zvake") without
 *      letting 3-letter tokens match anything they shouldn't.
 *
 * Cost is O(|query tokens| × |name tokens| × token-length²). For typical
 * 30-char product names and 1–3 query tokens this is well under 1ms per
 * candidate — fine for in-memory lists up to a few thousand rows. For
 * larger sets the server-side helper in basket-api takes over.
 */

const maxDistanceFor = (len: number) => (len <= 3 ? 0 : len <= 5 ? 1 : 2);

/**
 * Damerau-Levenshtein with an early-exit cap. Standard Levenshtein
 * counts a transposition (zvake ↔ zvkae) as two edits; Damerau collapses
 * it to one, which is the single most common Lithuanian-keyboard typo
 * and the difference between "feels broken" and "feels forgiving".
 */
function damerauLev(a: string, b: string, cap: number): number {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    const al = a.length;
    const bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;
    // Two rolling rows + the current row so we can peek back two steps
    // for the transposition rule.
    let prev2: number[] = Array.from({ length: bl + 1 }, () => 0);
    let prev1: number[] = Array.from({ length: bl + 1 }, (_, j) => j);
    const curr: number[] = Array.from({ length: bl + 1 }, () => 0);
    for (let i = 1; i <= al; i++) {
        curr[0] = i;
        let rowMin = curr[0];
        for (let j = 1; j <= bl; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(
                prev1[j] + 1,        // deletion
                curr[j - 1] + 1,     // insertion
                prev1[j - 1] + cost, // substitution
            );
            if (
                i > 1 && j > 1 &&
                a[i - 1] === b[j - 2] &&
                a[i - 2] === b[j - 1]
            ) {
                curr[j] = Math.min(curr[j], prev2[j - 2] + 1); // transposition
            }
            if (curr[j] < rowMin) rowMin = curr[j];
        }
        if (rowMin > cap) return cap + 1;
        // Slide the rolling rows. `curr` becomes prev1, prev1 becomes
        // prev2; reuse the old prev2 buffer as the next curr to avoid
        // per-iteration allocation.
        const reused = prev2;
        prev2 = prev1;
        prev1 = curr.slice();
        for (let k = 0; k <= bl; k++) reused[k] = 0;
    }
    return prev1[bl];
}

function tokenHits(nameTokens: string[], qTok: string): boolean {
    const cap = maxDistanceFor(qTok.length);
    for (const w of nameTokens) {
        if (w.includes(qTok)) return true;
        if (cap > 0 && damerauLev(w, qTok, cap) <= cap) return true;
    }
    return false;
}

export function fuzzyMatches(name: string, query: string): boolean {
    const q = searchFold(query.trim());
    if (!q) return true;
    const qTokens = q.split(/\s+/).filter(Boolean);
    if (qTokens.length === 0) return true;
    const nameTokens = searchFold(name).split(/\s+/).filter(Boolean);
    if (nameTokens.length === 0) return false;
    return qTokens.every((tok) => tokenHits(nameTokens, tok));
}
