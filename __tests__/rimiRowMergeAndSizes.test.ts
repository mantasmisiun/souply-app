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

    test('an engine DOUBLE-READ of the same row is suppressed, keeping the fuller text (rimi-30-04-2026-2)', () => {
        // Vision emitted the same physical row twice with different garbles;
        // x-joining them doubled the name and ate a product.
        const out = mergeRowFragmentsRimi([
            { text: 'Virtos GIMINIŲ dešrelės,', yTop: 2691, yBottom: 2753, xLeft: 31, xRight: 551 },
            { text: 'Virtos CIMINIŲ derelės,', yTop: 2700, yBottom: 2752, xLeft: 28, xRight: 540 },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].text).toBe('Virtos GIMINIŲ dešrelės,');
    });

    test('a DOUBLE-READ price anchor is suppressed too (ios-56 minted a phantom band from it)', () => {
        const out = mergeRowFragmentsRimi([
            { text: 'grietine, 30 %, 400 g', yTop: 1299, yBottom: 1332, xLeft: 15, xRight: 420 },
            { text: '2,99 A', yTop: 1294, yBottom: 1332, xLeft: 1219, xRight: 1340 },
            { text: '2,99 A', yTop: 1299, yBottom: 1334, xLeft: 1221, xRight: 1342 },
        ]);
        expect(out.filter((l) => l.text === '2,99 A')).toHaveLength(1);
    });

    test('genuine side-by-side fragments still join (no x-overlap = not duplicates)', () => {
        const out = mergeRowFragmentsRimi([
            L('3 vnt.', 1147, 60, 140),
            L('X 4,99 EUR', 1142, 300, 240),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].text).toBe('3 vnt. X 4,99 EUR');
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

    test('a garbled multi-buy X ("x*2,69") still parses — qty and ppu captured (rimi-30-04-2026-2 p11)', () => {
        const r = parseRimiReceipt([
            L('UAB RIMI LIETUVA, T1010', 100, 20),
            L('PIRKEJAS XXXXXXXXX XX0001', 200, 20),
            L('Virtos GIMINIŲ dešrelės, a.r., 260g', 600, 22),
            L('2 vnt. x*2,69 EUR', 660, 74, 400),
            L('5,38 A', 660, 1219, 120),
            L('SUTEIKTOS NUOLAIDOS:', 900, 19),
            L('Mokėti', 1100, 17),
            L('5,38', 1100, 1150, 140),
            L('Mokestis Suma su PVM', 1150, 17),
        ]);
        expect(r.products).toHaveLength(1);
        expect(r.products[0].quantity).toBe(2);
        expect(r.products[0].price).toBe(2.69);
        expect(r.products[0].name).not.toMatch(/vnt|EUR/);
        expect(r.footer.reconciled).toBe(true);
    });

    test('a lead-digit-garbled anchor heals when the multi line corroborates (ios-56 DEARY "0,78A")', () => {
        const r = parseRimiReceipt([
            L('UAB RIMI LIETUVA, T1010', 100, 20),
            L('PIRKEJAS XXXXXXXXX XX0001', 200, 20),
            L('Isp. šalavijo ir kokoso pudingas DEARY, 150 g', 600, 22),
            L('2 vnt. X 1,39 EUR', 660, 74, 400),
            L('0,78 A', 660, 1219, 120),   // printed 2,78 — leading digit garbled
            L('SUTEIKTOS NUOLAIDOS:', 900, 19),
            L('Mokėti', 1100, 17),
            L('2,78', 1100, 1150, 140),
            L('Mokestis Suma su PVM', 1150, 17),
        ]);
        expect(r.products).toHaveLength(1);
        expect(r.products[0].price).toBe(1.39);  // per-unit normalized from healed 2.78
        expect(r.products[0].quantity).toBe(2);
        expect(r.footer.reconciled).toBe(true);  // healed total reconciles to the cent
    });

    test('a zero-garbled anchor ("O,65") still anchors — two products stay separate (rimi-30-04-2026-13)', () => {
        // The letter-O garble killed the anchor and TWO sūrelis products
        // merged into one band. The lead-garble fold restores it via the
        // relaxed (VAT-less) anchor lane.
        const r = parseRimiReceipt([
            L('UAB RIMI LIETUVA, T1010', 100, 20),
            L('PIRKEJAS XXXXXXXXX XX0001', 200, 20),
            L('Sūrelis MAGIJA su vanile', 600, 22),
            L('O,65', 600, 1219, 120),          // ← garbled anchor, no VAT letter
            L('Sūrelis MAGIJA su', 660, 22),
            L('kakava, 24,5 %', 720, 22),
            L('0,65 A', 720, 1219, 120),
            L('SUTEIKTOS NUOLAIDOS:', 900, 19),
            L('Mokėti', 1100, 17),
            L('1,30', 1100, 1150, 140),
            L('Mokestis Suma su PVM', 1150, 17),
        ]);
        expect(r.products).toHaveLength(2);
        expect(r.products[0].price).toBe(0.65);
        expect(r.footer.reconciled).toBe(true);
    });

    test('a produce grade token ("C2-3, 1") never reads as a savings amount (ios-55 citrinos)', () => {
        // The garbled-Nuol rescue requires EXACTLY two cent digits; the grade
        // token + wrapped size digit used to become savings=3,10 → a phantom
        // "discount DROPPED" warning on a discount-less product.
        const r = parseRimiReceipt([
            L('UAB RIMI LIETUVA, T1010', 100, 20),
            L('PIRKEJAS XXXXXXXXX XX0001', 200, 20),
            L('Citrinos Verna, 1kl, C2-3, 1', 600, 22),
            L('kg', 660, 22, 60),
            L('0,390 kg X 2,49 EUR/kg', 720, 36, 400),
            L('0,97 A', 720, 1219, 120),
            L('SUTEIKTOS NUOLAIDOS:', 900, 19),
            L('Mokėti', 1100, 17),
            L('0,97', 1100, 1150, 140),
            L('Mokestis Suma su PVM', 1150, 17),
        ]);
        expect(r.products).toHaveLength(1);
        const p = r.products[0];
        expect(p.name).toContain('C2-3');
        expect(p.promoPrice).toBeNull();
        expect(p.quantity).toBe(0.39);
        expect(r.footer.reconciled).toBe(true);
    });

    test('a mushed weighed line ("46g429 EUKG") recovers €/kg and kg from the anchor (ios-55 paprikos)', () => {
        const r = parseRimiReceipt([
            L('UAB RIMI LIETUVA, T1010', 100, 20),
            L('PIRKEJAS XXXXXXXXX XX0001', 200, 20),
            L('Raud. saldžiosios paprikos', 600, 22),
            L('46g429 EUKG', 660, 0, 400),   // printed: 0,406 kg X 4,29 EUR/kg
            L('1,74 A', 660, 1219, 120),
            L('SUTEIKTOS NUOLAIDOS:', 900, 19),
            L('Mokėti', 1100, 17),
            L('1,74', 1100, 1150, 140),
            L('Mokestis Suma su PVM', 1150, 17),
        ]);
        expect(r.products).toHaveLength(1);
        const p = r.products[0];
        expect(p.name).toBe('Raud. saldžiosios paprikos');
        expect(p.pricePerUnit).toBe(4.29);
        expect(p.quantity).toBe(0.406);
        expect(p.unit).toBe('kg');
        expect(r.footer.reconciled).toBe(true);
    });

    test('a garbled hint WITHOUT corroborating digits stays zeroed (never fabricate)', () => {
        // Leading digits "99" do not appear in the derived qty (1.74/4.29 =
        // 0.406) → recovery must refuse; poison guard zeroes the price and
        // zeroedLineTotal still reconciles the receipt.
        const r = parseRimiReceipt([
            L('UAB RIMI LIETUVA, T1010', 100, 20),
            L('PIRKEJAS XXXXXXXXX XX0001', 200, 20),
            L('Raud. saldžiosios paprikos', 600, 22),
            L('99x429 EUKG', 660, 0, 400),
            L('1,74 A', 660, 1219, 120),
            L('SUTEIKTOS NUOLAIDOS:', 900, 19),
            L('Mokėti', 1100, 17),
            L('1,74', 1100, 1150, 140),
            L('Mokestis Suma su PVM', 1150, 17),
        ]);
        expect(r.products[0].price).toBe(0);
        expect(r.products[0].pricePerUnit).toBeNull();
        expect(r.footer.reconciled).toBe(true); // zeroedLineTotal books the money
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
