import {
    legibleLineCount,
    receiptLikeness,
    UPSIDE_DOWN_SUSPECT_LINES,
    UPSIDE_DOWN_WIN_RATIO,
    UPSIDE_DOWN_MIN_GAIN,
} from '../utils/receiptOcrPipeline';

/** The adoption rule exactly as recoverUpsideDown / rotatePortrait apply it. */
const flipWins = (base: number, flip: number) =>
    flip > base * UPSIDE_DOWN_WIN_RATIO && flip >= base + UPSIDE_DOWN_MIN_GAIN;

/**
 * ORIENTATION SCORING.
 *
 * The device log from a real failure is the reason this scores MONEY AMOUNTS and
 * not lines: a mis-rotated capture OCR'd to 85 lines — far past any line-count
 * threshold — yet the parser then found a single priceless product. Garbled text
 * still produces lines; it stops producing prices. Both orientation decisions
 * (rotatePortrait's CW-vs-CCW vote, which is a 180° choice, and the 180° recovery
 * itself) therefore vote on receiptLikeness.
 */

const line = (text: string) => ({ text });

/** A plausible receipt read: header, priced items, VAT block, totals. */
const healthyRead = [
    'IKI Lietuva, UAB', 'Vilniaus g. 220-1', 'Kvitas 13/621',
    'LAVAZZA QUALITA ORO', '9,99 A', 'DVARO GRIETINE 30%', '2,79 A',
    'KETO LENGVAI DUONA', '2,59 A', 'SUNOKE AVOKADAI', '1,99 A',
    'Nuolaida su kortele', '-4,50 A', 'Moketi', '18,47', 'PVM 21%', 'Aciu',
].map(line);

/** The real failure: PLENTY of lines, but the glyphs garbled so the amounts died. */
const misRotatedRead = [
    'IKl LlefuVa UAB', 'V!In!aus 9 220-l', 'KVlfas l3/62l',
    'LAVAZZ4 QUAL|T4 0R0', '9 gg V', 'DVAR0 GR|ET|NE 3O%', 'Z 7g V',
    'KET0 LENGVA| DU0NA', 'Z Sg V', 'SUN0KE AV0KADA|', 'l gg V',
    'Nu0Ia!da su k0rteIe', '-O SO V', 'M0keti', 'l8 47', 'PVM Zl%', 'Ac!u',
].map(line);

describe('orientation scoring uses money amounts, not line count', () => {
    test('THE BUG: a mis-rotated read has plenty of lines but almost no amounts', () => {
        // Line count cannot tell these apart — which is exactly why it failed.
        expect(legibleLineCount(misRotatedRead)).toBeGreaterThanOrEqual(12);
        // Receipt-likeness separates them decisively.
        expect(receiptLikeness(misRotatedRead)).toBeLessThan(UPSIDE_DOWN_SUSPECT_LINES);
        expect(receiptLikeness(healthyRead)).toBeGreaterThanOrEqual(UPSIDE_DOWN_SUSPECT_LINES);
    });

    test('a healthy read is never re-OCR\'d (no cost on the happy path)', () => {
        expect(receiptLikeness(healthyRead)).toBeGreaterThanOrEqual(UPSIDE_DOWN_SUSPECT_LINES);
    });

    test('flipping a mis-rotated page to the correct one is adopted', () => {
        expect(flipWins(receiptLikeness(misRotatedRead), receiptLikeness(healthyRead))).toBe(true);
    });

    test('noise never unseats a comparable read — margin, not just ratio', () => {
        expect(flipWins(3, 4)).toBe(false);   // clears 1.3× but not the +4 margin
        expect(flipWins(0, 3)).toBe(false);   // ratio is meaningless at 0; margin holds the line
        expect(flipWins(1, 9)).toBe(true);    // a genuine orientation fix
    });

    test('amount detection accepts both separators and signs, rejects bare digits', () => {
        expect(receiptLikeness(['1,29 A', '12.90', '-0,50 A'].map(line))).toBe(3);
        expect(receiptLikeness(['2026', '13/621', 'PVM 21%', 'x'].map(line))).toBe(0);
    });

    test('legibleLineCount still ignores punctuation-only scraps (tie-break use)', () => {
        expect(legibleLineCount(['|||', '---', '.', '  '].map(line))).toBe(0);
        expect(legibleLineCount(['ĄČĘ', 'ab', '12'].map(line))).toBe(3);
    });
});
