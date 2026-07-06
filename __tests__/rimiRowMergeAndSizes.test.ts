import { mergeRowFragmentsRimi, extractPackSize, isRimiReceipt, NON_CATALOG_PATTERN, type RimiLine } from '../shared/parsers/rimiParser';

// 300-dpi PDF OCR splits Rimi rows into fragments constantly — these cases are
// lifted from real batch logs (receipts/_logs/rimi/).
const L = (text: string, yTop: number, xLeft: number, w = 200): RimiLine => ({
    text, yTop, yBottom: yTop + 45, xLeft, xRight: xLeft + w,
});

describe('mergeRowFragmentsRimi', () => {
    test('multi-buy fragments rejoin; the price anchor stays separate (5EEA946F p5)', () => {
        const out = mergeRowFragmentsRimi([
            L('X 4,99 EUR', 1142, 300),
            L('3 vnt.', 1147, 60),
            L('14,97 A', 1141, 1200, 120),
        ]);
        const texts = out.map(l => l.text);
        expect(texts).toContain('3 vnt. X 4,99 EUR');
        expect(texts).toContain('14,97 A');
    });

    test('discount thirds rejoin INCLUDING the trailing value (rimi-30-04-2026-3 p1)', () => {
        const out = mergeRowFragmentsRimi([
            L('Nuol.', 745, 60),
            L('-1,30 Galut. kaina', 739, 200),
            L('1,39', 743, 800, 100),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].text).toBe('Nuol. -1,30 Galut. kaina 1,39');
    });

    test('a split VAT letter reunites with ITS price, keeping the anchor alive (rimi-11-05 JUNGA)', () => {
        const out = mergeRowFragmentsRimi([
            L('2 vnt. X 0,99 EUR', 842, 60),
            L('1,98', 845, 1200, 100),
            L('A', 846, 1350, 40),
        ]);
        const texts = out.map(l => l.text);
        expect(texts).toContain('1,98 A');
        expect(texts).toContain('2 vnt. X 0,99 EUR');
    });
});

describe('extractPackSize — 300-dpi garbles', () => {
    test('"400 9" = 400 g (g read as 9)', () => {
        expect(extractPackSize('Makaronai BARILLA FUSILLI, 400 9')).toMatchObject({ amount: 400, unit: 'g' });
    });
    test('"18 0g" = 180 g and "3 Og" = 30 g (split digit runs)', () => {
        expect(extractPackSize('Spragėsiai POPHOUSE, 18 0g')).toMatchObject({ amount: 180, unit: 'g' });
        expect(extractPackSize('Kepimo milteliai, 3 Og')).toMatchObject({ amount: 30, unit: 'g' });
    });
    test('"2, 5kg" = 2,5 kg (decimal join, never 25 kg)', () => {
        expect(extractPackSize('Bulvių lazd. RIMI SMART, 2, 5kg')).toMatchObject({ amount: 2.5, unit: 'kg' });
    });
    test('trailing ", I 1" = 1 l (litre mark read as 1)', () => {
        expect(extractPackSize('Sojos gėr ALPRO PLANT PROTEIN, I 1')).toMatchObject({ amount: 1, unit: 'l' });
    });
    test('"100c" = 100 g but a letter-run ("ig") never shadows the real size', () => {
        expect(extractPackSize('Pieninis šokoladas Poesia 100c A')).toMatchObject({ amount: 100, unit: 'g' });
        expect(extractPackSize('Kečupo skonio užkand.ig CHEETOS, 165g')).toMatchObject({ amount: 165, unit: 'g' });
    });
});

describe('rimi detection + non-catalog', () => {
    test('falls back to PVM code / MANO RIMI / rimi.lt / rimibaltic when the header name is lost', () => {
        expect(isRimiReceipt(['???', 'PVM kodas LT237153113'])).toBe(true);
        expect(isRimiReceipt(['???', 'MANO RIMI programa'])).toBe(true);
        expect(isRimiReceipt(['???', 'www.rimi.lt'])).toBe(true);
        expect(isRimiReceipt(['???', 'info.lt@rimibaltic.lt'])).toBe(true);
        expect(isRimiReceipt(['MAXIMA LT, UAB', 'Aido g. 8'])).toBe(false);
    });
    test('bag with a leading junk letter still skips ("Tmaišelis")', () => {
        expect(NON_CATALOG_PATTERN.test('Plastikinis Tmaišelis, 1 vnt.')).toBe(true);
    });
});
