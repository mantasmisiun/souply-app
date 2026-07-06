import { mergeRowFragmentsRimi, extractPackSize, isRimiReceipt, parseRimiReceipt, NON_CATALOG_PATTERN, type RimiLine } from '../shared/parsers/rimiParser';

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

describe('fused-row detection (346px wrapper-PDF class, 0AE04F24)', () => {
    // Filler body rows so the median row height is established (h=45).
    const filler = Array.from({ length: 10 }, (_, i) => L(`Filler body line nr ${i}`, 2000 + i * 60, 20));

    test('a double-height box spanning TWO disjoint rows is tagged and NOT clustered', () => {
        const fusedBox: RimiLine = { text: 'Raaronal be glitimo BARILIA', yTop: 691, yBottom: 795, xLeft: 19, xRight: 958 };
        const out = mergeRowFragmentsRimi([
            L('Rafinuotas kukuruzy aliejus', 638, 22),
            fusedBox,                       // fusion of "RIMI SMART, 1 l" + "be glitimo BARILLA"
            { text: '2,99 A', yTop: 691, yBottom: 748, xLeft: 1219, xRight: 1340 },
            { text: 'Makaronai', yTop: 736, yBottom: 783, xLeft: 16, xRight: 250 },
            ...filler,
        ]);
        const fused = out.find((l) => l.fusedRow);
        expect(fused?.text).toBe('Raaronal be glitimo BARILIA');
        // The hijack mechanic: without the exclusion the fused box glued
        // "Makaronai" and the garble into one line inside band 1.
        expect(out.map((l) => l.text)).toContain('Makaronai');
        expect(out.map((l) => l.text)).toContain('2,99 A');
    });

    test('a tall SKEWED photo row (no two disjoint rows inside) is NOT tagged (ios-55 false-positive)', () => {
        const skewed: RimiLine = { text: 'AVIZU SeLe0OS MALSENA, 300 g', yTop: 600, yBottom: 672, xLeft: 20, xRight: 700 };
        const out = mergeRowFragmentsRimi([
            skewed,
            { text: '1,09 A', yTop: 610, yBottom: 668, xLeft: 1219, xRight: 1340 },
            ...filler,
        ]);
        expect(out.every((l) => !l.fusedRow)).toBe(true);
    });
});

describe('parseRimiReceipt — receipt-level reconciliation', () => {
    // Minimal synthetic receipt: milk 2,05 + bag 0,01 (skipped but PAID) +
    // deposit 0,20 (unanchored rows) − MANO RIMI pinigai 0,14 = Mokėti 2,12.
    // "Kitos akcijos" is a RECAP of inline discounts — must NOT be booked.
    const R = (moketiAmount: string, extra: RimiLine[] = []): RimiLine[] => [
        L('UAB RIMI LIETUVA, T1010', 100, 20),
        L('PVM mokėtojo kodas LT237153113', 150, 20),
        L('PIRKEJAS XXXXXXXXX XX0001', 200, 20),
        // Deposit rows sit INSIDE the product's band (matches rimi-30-04-2026-12:
        // label → wrap → unanchored amount), followed by the bag product.
        L('Pienas DVARO, 1 l', 600, 22),
        L('2,05 A', 600, 1219, 120),
        L('Užstatas - vienkartinė', 650, 19),
        L('pakuotė', 700, 19),
        L('0,20', 700, 1288, 80),
        L('Plastikinis maiselis, 1 vnt.', 820, 22),
        L('0,01 A', 820, 1219, 120),
        L('SUTEIKTOS NUOLAIDOS:', 900, 19),
        L('Panaudoti MANO RIMI pinigai', 950, 19),
        L('-0,14', 950, 1181, 80),
        L('Kitos akcijos', 1000, 19),
        L('-0,50', 1000, 1181, 80),
        L('Mokėti', 1100, 17),
        L(moketiAmount, 1100, 1150, 140),
        ...extra,
        L('Mokestis Suma su PVM', 1150, 17),
        L('A 21,00 %', 1200, 20),
        L('1,75', 1200, 600, 80),
        L('0,37', 1200, 900, 80),
        L('2,12', 1200, 1200, 80),
    ];

    test('items + deposit + bag − pinigai = Mokėti → reconciled (recap NOT double-booked)', () => {
        const r = parseRimiReceipt(R('2,12'));
        expect(r.products).toHaveLength(1); // bag skipped, deposit not a product
        expect(r.footer.total).toBe(2.12);
        expect(r.footer.reconDelta).toBe(0);
        expect(r.footer.reconciled).toBe(true);
    });

    test('garbled Mokėti: the VAT table is never mistaken for the total; expected total is derived', () => {
        // "44" = the real rimi-30-04-2026-15 shape (printed "0,44", the "0,"
        // lost) — unparseable, unlike "2 12" which parseAmount's loose-cents
        // tolerance legitimately reads.
        const r = parseRimiReceipt(R('44'));
        // Old behavior grabbed the first VAT-table number (1,75 = Be PVM).
        expect(r.footer.total).toBe(2.12);     // derived arithmetically
        expect(r.footer.reconciled).toBe(false); // derived ≠ verified
    });

    test('card-slip PIRKINYS amount rescues a shattered Mokėti as a READ total', () => {
        const r = parseRimiReceipt(R('44', [L('PIRKINYS 2,12 EUR', 1050, 19, 600)]));
        expect(r.footer.total).toBe(2.12);
        expect(r.footer.reconciled).toBe(true); // read → verified
    });

    test('a one-cent mismatch anywhere fails reconciliation (strict, no tolerance)', () => {
        const r = parseRimiReceipt(R('2,13'));
        expect(r.footer.reconciled).toBe(false);
        expect(r.footer.reconDelta).toBe(-0.01);
    });

    test('cash-rounding Apvalinimas books with its printed sign', () => {
        // 2.05 + 0.01 + 0.20 − 0.14 − 0.02 = 2.10
        const r = parseRimiReceipt(R('2,10', [L('Apvalinimas -0,02', 1050, 19, 400)]));
        expect(r.footer.total).toBe(2.1);
        expect(r.footer.reconciled).toBe(true);
    });

    test('a taromat deposit REFUND (negative Užstatas) keeps its printed sign', () => {
        // The deposit lane must not abs() a refund: 2.12 − 0.66 = 1.46.
        const r = parseRimiReceipt(R('1,46', [
            L('Užstato grąžinimas', 1040, 19),
            L('-0,66', 1040, 1181, 80),
        ]));
        expect(r.footer.total).toBe(1.46);
        expect(r.footer.reconciled).toBe(true);
    });

    test('garbled pinigai label ("Rini") still books the wallet deduction', () => {
        const lines = R('2,12').map((l) => l.text === 'Panaudoti MANO RIMI pinigai'
            ? { ...l, text: 'Panaudoti MANO Rini pinigai' } : l);
        const r = parseRimiReceipt(lines);
        expect(r.footer.reconciled).toBe(true);
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
