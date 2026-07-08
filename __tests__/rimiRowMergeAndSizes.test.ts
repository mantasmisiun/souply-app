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

    test('a skew-chained cluster does NOT eat real neighbouring rows (ios-55 Broileriai multibuy)', () => {
        // Real geometry: the tilted photo chained the name-continuation row
        // and the qty row into one y-cluster, and the cluster-wide dedupe
        // (x-span only) deleted "2 vnt. X 3,49 EUR" as a "double-read" of
        // "ant ib., 500 g EUR" — the multibuy collapsed to 1 × 6,98. Rows
        // must partition by pairwise y-overlap first.
        const out = mergeRowFragmentsRimi([
            { text: 'Broilerių sparnų vid. dalys be', yTop: 1258, yBottom: 1298, xLeft: 15, xRight: 678 },
            { text: 'ant ib., 500 g EUR', yTop: 1291, yBottom: 1336, xLeft: 1, xRight: 415 },
            { text: 'antib., 500 g', yTop: 1299, yBottom: 1332, xLeft: 14, xRight: 301 },
            { text: '2 vnt. X 3,9', yTop: 1315, yBottom: 1353, xLeft: 37, xRight: 323 },
            { text: '2 vnt. X 3,49 EUR', yTop: 1318, yBottom: 1358, xLeft: 38, xRight: 409 },
            { text: '6,98 A', yTop: 1323, yBottom: 1353, xLeft: 814, xRight: 942 },
            { text: 'EUR', yTop: 1329, yBottom: 1357, xLeft: 348, xRight: 413 },
        ]);
        const texts = out.map((l) => l.text);
        expect(texts).toContain('2 vnt. X 3,49 EUR'); // the qty row SURVIVES
        expect(texts).toContain('6,98 A');
        // …while true same-row double-reads still dedupe: one name-continuation
        // variant remains, and the partial "2 vnt. X 3,9" is gone.
        expect(texts.filter((t) => /500 g/.test(t))).toHaveLength(1);
        expect(texts).not.toContain('2 vnt. X 3,9');
    });

    test('a sagging junk double-read still dedupes INTO its row (ios-55 Sojos ALPRO)', () => {
        // "IDDO" / "14 ?50m1" are garbled duplicates of the ALPRO row whose
        // boxes sag — they pairwise-overlap ALPRO ~100% and must stay in its
        // sub-row to be eaten (the greedy-extent partition let them escape
        // and they joined the product name as a phantom continuation line).
        const out = mergeRowFragmentsRimi([
            { text: 'Sojos gaminys aisto garmin.', yTop: 1393, yBottom: 1437, xLeft: 14, xRight: 605 },
            { text: 'Sojos gaminys maisto gamin.', yTop: 1393, yBottom: 1430, xLeft: 14, xRight: 605 },
            { text: 'ALPRO, 14 %,25Oml', yTop: 1418, yBottom: 1451, xLeft: 13, xRight: 383 },
            { text: 'IDDO', yTop: 1423, yBottom: 1444, xLeft: 17, xRight: 121 },
            { text: '14 ?50m1', yTop: 1423, yBottom: 1443, xLeft: 165, xRight: 380 },
        ]);
        const texts = out.map((l) => l.text);
        expect(texts).toContain('ALPRO, 14 %,25Oml'); // the real second name line survives
        expect(texts).not.toContain('IDDO');
        expect(texts).not.toContain('14 ?50m1');
        expect(texts.filter((t) => /Sojos gaminys/.test(t))).toHaveLength(1);
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
    test('", 1lkg" reads as the 1 kg reference, never 11 kg (BE09D63 saldainiai)', () => {
        expect(extractPackSize('Saldainiai SLYVA SOKOLADE, 1lkg')).toMatchObject({ amount: 1, unit: 'kg' });
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

    test('a two-row fusion with a price tail SPLITS at the wall — Galut to the band above, name below (rimi-30-04-2026-2)', () => {
        // "Lazdyny riesutu aetas RiMI 0,65": the 0,65 is CUKRUS' printed
        // Galut. kaina (top half of the box); the garbled name is Lazdynų's
        // (bottom half). The splitter returns each to its own band — no
        // cross-band reads.
        // Filler carries the REAL body-row height (~80px, matching the
        // product rows) — the L() helper's 45px skews the median and pushes
        // the 166px fused box outside the 2.0×/2.6× split window it
        // actually occupies on the real receipt (166/80 ≈ 2.1×).
        const filler = Array.from({ length: 10 }, (_, i) => ({
            text: `Filler body line nr ${i}`, yTop: 3000 + i * 110, yBottom: 3000 + i * 110 + 80, xLeft: 20, xRight: 420,
        }));
        const r = parseRimiReceipt([
            L('UAB RIMI LIETUVA, T1010', 100, 20),
            L('PIRKEJAS XXXXXXXXX XX0001', 200, 20),
            { text: 'Cukrus PANEVEZIO PLIUS, 1 kg', yTop: 1843, yBottom: 1946, xLeft: 34, xRight: 700 },
            { text: '1,19 A', yTop: 1859, yBottom: 1946, xLeft: 1698, xRight: 1900 },
            { text: 'Lazdyny riesutu aetas RiMI 0,65', yTop: 1909, yBottom: 2075, xLeft: 24, xRight: 900 },
            { text: 'BASIC, 400 g', yTop: 2071, yBottom: 2145, xLeft: 31, xRight: 400 },
            { text: '1,54 A', yTop: 2070, yBottom: 2150, xLeft: 1699, xRight: 1900 },
            ...filler,
            L('SUTEIKTOS NUOLAIDOS:', 4300, 19),
            L('Mokėti', 4400, 17),
            L('2,19', 4400, 1150, 140),
            L('Mokestis Suma su PVM', 4500, 17),
        ]);
        expect(r.products).toHaveLength(2);
        expect(r.products[0].name).toContain('Cukrus');
        expect(r.products[0].promoPrice).toBe(0.65);   // recovered IN-BAND
        expect(r.products[1].name).toContain('BASIC');
        expect(r.products[1].name).not.toContain('0,65');
        expect(r.footer.reconciled).toBe(true);        // 0.65 + 1.54 = 2.19
    });

    test('a fused garbage box never drags the clean name line into quarantine (rimi-30-04-2026-23 ALPRO)', () => {
        // Raw geometry: tall "I'T ALPRO" box (1022-1177) y-overlaps the clean
        // first name line — the slice-level row merger used to join them, and
        // the quarantine then ate the REAL name too.
        const filler = Array.from({ length: 10 }, (_, i) => L(`Filler body line nr ${i}`, 2000 + i * 110, 20, 400));
        const r = parseRimiReceipt([
            L('UAB RIMI LIETUVA, T1010', 100, 20),
            L('PIRKEJAS XXXXXXXXX XX0001', 200, 20),
            { text: "I'T ALPRO", yTop: 1022, yBottom: 1177, xLeft: 699, xRight: 1188 },
            { text: 'Sok. sk. sojos ger. ALPRO', yTop: 1027, yBottom: 1104, xLeft: 30, xRight: 700 },
            { text: 'PLANT PROTEIN, 1 1', yTop: 1099, yBottom: 1177, xLeft: 26, xRight: 858 },
            { text: '3,79 A', yTop: 1098, yBottom: 1187, xLeft: 1695, xRight: 1979 },
            ...filler,
            L('SUTEIKTOS NUOLAIDOS:', 3200, 19),
            L('Mokėti', 3300, 17),
            L('3,79', 3300, 1150, 140),
            L('Mokestis Suma su PVM', 3400, 17),
        ]);
        const p = r.products.find((x) => x.name.includes('PLANT'));
        expect(p).toBeDefined();
        expect(p!.name).toContain('Sok. sk. sojos ger. ALPRO');
        expect(p!.name).not.toContain("I'T");
    });

    test('"$" before an uppercase run folds to S ("$OKOLADE" → SOKOLADE)', () => {
        const out = mergeRowFragmentsRimi([]); // fold is entry-level; test via parse
        expect(out).toEqual([]);
        const r = parseRimiReceipt([
            L('UAB RIMI LIETUVA, T1010', 100, 20),
            L('PIRKEJAS XXXXXXXXX XX0001', 200, 20),
            L('Saldainiai SLYVA $OKOLADE, 1lkg', 600, 22),
            L('2,99 A', 600, 1219, 120),
            L('SUTEIKTOS NUOLAIDOS:', 900, 19),
            L('Mokėti', 1100, 17),
            L('2,99', 1100, 1150, 140),
            L('Mokestis Suma su PVM', 1150, 17),
        ]);
        expect(r.products[0].name).toContain('SOKOLADE');
        expect(r.products[0].parsedAmount).toBe(1);
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

    test('a weighed qty leading-digit garble heals from the printed line total (ios-55 citrinos)', () => {
        // Printed "0,390 kg X 2,49 EUR/kg" with total "0,97 A"; OCR read
        // "8,390 kg" (8↔0) and minted 8.39 kg of lemons. anchor ÷ ppu lands
        // on a qty one leading digit away — the receipt corroborates.
        const r = parseRimiReceipt([
            L('UAB RIMI LIETUVA, T1010', 100, 20),
            L('PIRKEJAS XXXXXXXXX XX0001', 200, 20),
            L('Citrinos Verna, 1kl, cž-3, 1', 600, 22),
            L('0, 97 A', 600, 1219, 120),
            L('8,390 kg X 2,49 EUR/kg', 660, 40),
            L('SUTEIKTOS NUOLAIDOS:', 900, 19),
            L('Mokėti', 1100, 17),
            L('0,97', 1100, 1150, 140),
            L('Mokestis Suma su PVM', 1150, 17),
        ]);
        expect(r.products).toHaveLength(1);
        expect(r.products[0].quantity).toBe(0.39);
        expect(r.products[0].pricePerUnit).toBe(2.49);
        expect(r.footer.reconciled).toBe(true);
    });

    test('a doubled-letter pinigai label ("Ppinigai") still books the wallet deduction (ios-55)', () => {
        // Real garble: "Panaudoti MANO RIMI Ppinigai" — the strict `\s+pinig`
        // stem refused it, the -0,33 went unbooked and recon sat 0.33 off.
        const r = parseRimiReceipt([
            L('UAB RIMI LIETUVA, T1010', 100, 20),
            L('PIRKEJAS XXXXXXXXX XX0001', 200, 20),
            L('Prekė VIENAS, 1 vnt.', 600, 22),
            L('1,99 A', 600, 1219, 120),
            L('Prekė ANTRAS, 1 vnt.', 700, 22),
            L('2,15 A', 700, 1219, 120),
            L('SUTEIKTOS NUOLAIDOS:', 900, 19),
            L('Panaudoti MANO RIMI Ppinigai', 950, 14),
            L('-0,33', 950, 794, 80),
            L('Jūs sutaupėte', 1000, 19),
            L('5,93', 1000, 816, 80),
            L('Mokėti', 1100, 17),
            L('3,81', 1100, 1150, 140),
            L('Mokestis Suma su PVM', 1150, 17),
        ]);
        expect(r.footer.total).toBe(3.81);
        expect(r.footer.reconDelta).toBe(0);
        expect(r.footer.reconciled).toBe(true);
    });

    test('a bare UNLABELED block amount never books (no residual force-fitting)', () => {
        // The label row is gone entirely — recon must fail honestly rather
        // than absorb the bare -0,33 into the arithmetic (a bare amount is
        // indistinguishable from an orphaned item-discount summary, and
        // booking it could mask a dropped per-item discount as reconciled).
        const r = parseRimiReceipt([
            L('UAB RIMI LIETUVA, T1010', 100, 20),
            L('PIRKEJAS XXXXXXXXX XX0001', 200, 20),
            L('Prekė VIENAS, 1 vnt.', 600, 22),
            L('1,99 A', 600, 1219, 120),
            L('SUTEIKTOS NUOLAIDOS:', 900, 19),
            L('-0,33', 950, 794, 80),
            L('Mokėti', 1100, 17),
            L('1,66', 1100, 1150, 140),
            L('Mokestis Suma su PVM', 1150, 17),
        ]);
        expect(r.footer.reconciled).toBe(false);
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
