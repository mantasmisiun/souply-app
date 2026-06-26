import { parseIkiReceipt, isIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// A real deduped rawText from the guided scanner. Note the total line reads
// "26, 52 Mokėti" (amount BEFORE the word), and the weight lines.
const RAW = `IKI Lietuva, UAB
Gardino g. 2-2, Siaul iai
PVM mokėtojo kodas LT101937219
SKANĖJA RYZIAI BASMATI, 8
3, 29 A
ATLANTINĖS LAŠIŠOS BE GAL
1, 068 kg X 16,99 EUR/ kg
18, 15 A
NUOLAIDA SU KORTELE -7, 48 A
NAMINIS 2, 5% PIENAS
1,49 A
-0,30 A NUOLAIDA SU KORTELE
ZEMAITIJOS TEPAMAS SURELI
1,99 A
LYDYTAS TEPAMAS SURIS SU
1,99 A
LIETUVISKI POMIDORAI
0, 720 kg X 3, 99 EUR/ kg
2,87 A
-0, 72 A NUOLAIDA
RAUDONOSIOS PAPRIKOS
0,470 kg X 3,49 EUR/ kg
1, 64 A
-0,23 A NUOLAIDA SU KORTELE
Fasuoti obuoliai IKI UKIS
2,090 kg X 1,85 EUR/ kg
3, 87 A
XKUPONAS
0, 00 A
MAIŠELIS PLASTIKINIS LENG
0,01 A
-0,05 A IKI Taškais
Prekiautojo ID 15027037
Laikas 21:07:53 Data 2026-06-11
A0000000041010- MASTERCARD
26, 52 Mokėti Mokėt i
Banko k. S 26, 52
Kvito Nr, 168/645/104148 Kasa 0027
Kasininkas (-ė): SC0-User 8
sutaupete 8.01 EUR
Kvito kodas ED67-5C94-0D6R-64AD`;

const lines: IkiLine[] = RAW.split('\n').map((text, i) => ({
    text, yTop: i * 30, yBottom: i * 30 + 24, xLeft: 0, xRight: 400,
}));

describe('IKI thermal POS parser', () => {
    test('detected as IKI', () => {
        expect(isIkiReceipt(RAW.split('\n'))).toBe(true);
    });

    test('coupons + bags skipped → 8 products', () => {
        const { products } = parseIkiReceipt(lines);
        expect(products.length).toBe(8);
        expect(products.some((p) => /KUPONAS|MAIŠELIS|MAISELIS/i.test(p.name))).toBe(false);
    });

    test('price is the UNIT price; line total = price × quantity', () => {
        const { products } = parseIkiReceipt(lines);
        const p = (frag: string) => products.find((x) => x.name.toUpperCase().includes(frag))!;

        // unit item: price = line price, qty 1
        expect(p('PIENAS')).toMatchObject({ quantity: 1 });
        expect(p('PIENAS').price).toBeCloseTo(1.49, 2);
        expect(p('PIENAS').promoPrice).toBeCloseTo(1.19, 2);     // 1.49 - 0.30

        // weighed: price = €/kg, qty = kg → price×qty ≈ printed line total
        const las = p('LAŠIŠ');
        expect(las.price).toBeCloseTo(16.99, 2);
        expect(las.quantity).toBeCloseTo(1.068, 3);
        expect(las.price * las.quantity).toBeCloseTo(18.15, 1);  // ≈ printed 18.15
        expect(las.promoPrice! * las.quantity).toBeCloseTo(10.67, 1); // 18.15 - 7.48

        const pap = p('PAPRIKOS');
        expect(pap.price).toBeCloseTo(3.49, 2);
        expect(pap.price * pap.quantity).toBeCloseTo(1.64, 1);
        expect(pap.promoPrice! * pap.quantity).toBeCloseTo(1.41, 1); // 1.64 - 0.23

        const ob = p('OBUOLIAI');
        expect(ob.price).toBeCloseTo(1.85, 2);
        expect(ob.price * ob.quantity).toBeCloseTo(3.87, 1);
        expect(ob.promoPrice).toBeNull();                        // no discount
    });

    test('tracks recognised-data bands (lineRegions) for the photo view', () => {
        const { header, footer } = parseIkiReceipt(lines);
        expect(header.lineRegions.some((r) => r.kind === 'storeAddress')).toBe(true);
        expect(footer.lineRegions.some((r) => r.kind === 'total')).toBe(true);
        expect(footer.lineRegions.some((r) => r.kind === 'receiptNo')).toBe(true);
        // date+time share a line here → one combined 'dateTime' band.
        expect(footer.lineRegions.some((r) => r.kind === 'date' || r.kind === 'dateTime')).toBe(true);
    });

    test('time (Laikas) is banded too — combined dateTime when on the date line', () => {
        // RAW line: "Laikas 21:07:53 Data 2026-06-11" — same line → one dateTime band.
        const { footer } = parseIkiReceipt(lines);
        expect(footer.time).toBe('21:07');
        expect(footer.lineRegions.some((r) => r.kind === 'dateTime')).toBe(true);
    });

    test('footer: total parses with the amount BEFORE "Mokėti"', () => {
        const { footer } = parseIkiReceipt(lines);
        expect(footer.total).toBe(26.52);
        expect(footer.date).toBe('2026-06-11');
        expect(footer.receiptNo).toBe('168/645/104148');
        expect(footer.totalSavings).toBeCloseTo(8.01, 2);
    });

    const mkFooterLines = (raw: string[]): IkiLine[] =>
        raw.map((text, i) => ({ text, yTop: i * 30, yBottom: i * 30 + 24, xLeft: 0, xRight: 400 }));

    test('receiptNo: falls back to the "Kvitas <n>" sequence number when "Kvito Nr." is absent', () => {
        const { footer } = parseIkiReceipt(mkFooterLines([
            'IKI Lietuva, UAB',
            'PVM mokėtojo kodas LT101937219',
            'SKANĖJA RYŽIAI BASMATI, 8',
            '3, 29 A',
            'Prekiautojo ID 15027037',
            'Term. 15027037 Kvitas 7317 Atsk 000',  // Kvitas present, NO "Kvito Nr." line
            'SUMA 26,52 EUR',
            'Data 2026-06-11 Laikas 21:07:53',
        ]));
        expect(footer.receiptNo).toBe('7317');
    });

    test('receiptNo: "Kvito Nr." still WINS over "Kvitas" when both are present', () => {
        const { footer } = parseIkiReceipt(mkFooterLines([
            'IKI Lietuva, UAB',
            'PVM mokėtojo kodas LT101937219',
            'SKANĖJA RYŽIAI BASMATI, 8',
            '3, 29 A',
            'Term. 15027037 Kvitas 7317 Atsk 000',          // printed FIRST (higher up)
            'SUMA 26,52 EUR',
            'Kvito Nr. 168/645/104148 Kasa 0027',           // canonical key, printed LOWER
            'Data 2026-06-11 Laikas 21:07:53',
        ]));
        expect(footer.receiptNo).toBe('168/645/104148');
    });

    test('receiptNo: synthesizes from date+time+total when neither Kvito Nr nor Kvitas is present', () => {
        const { footer } = parseIkiReceipt(mkFooterLines([
            'IKI Lietuva, UAB',
            'PVM mokėtojo kodas LT101937219',
            'SKANĖJA RYŽIAI BASMATI, 8',
            '3, 29 A',
            'Prekiautojo ID 15027037',
            'SUMA 26,52 EUR',
            'Data 2026-06-11 Laikas 21:07:53',
        ]));
        expect(footer.receiptNo).toBe('20260611-2107-2652-iki-receipt');
    });
});

// A REAL photographed (smudged) IKI receipt where OCR fused rows and garbled
// digits — the failure cases reported on receipt-17. Verifies the hardening:
// weight-line-not-name, discounts/coupons/points never products, names recovered
// from fused "discount + next name" rows, qty derived from total ÷ €/kg.
const RAW17 = `IKI Lietuva, AB
Gardino 9. 2-2, Šiaul iai
PVY kelio kodas LI101937219
SKANĖ JA RY?. 6ASMATI, 8
3, 29 A
AT! ANTINĖS LASISOS BE GAL
1, v68 kg X 16,99 EUR/ kg
18, 15 A
NUOLAIDA SU KORTELE -7, 48 A
NAMINIS 2,5% PIENAS 49 A
NUOLAIDA SU KORTELE -0,30
2EMAITIJOS TEPAMA, SUREL I
LYDYTAS TEPAMAS SURIS SU
1,99 A
LIETUVISKI POMIDORAI
1,99 A
0, 720 kg X 3, 99 EUR/ kg
NUOLAI DA
2,87 A
-0,72 A RAUDONOS IOS PAPRIKOS
0,470 kg X 3, 439 EUR/ kg
NUOLAI DA SU KORTELE.
1,64 A
-0, 23 A Fasuoti obuoliaf IKI UKIS
2, 090 kg X 1,85 EUR/ kg
wKUPONAS
3, 87 A
xKUPONAS
0, 00 A
MAIŠELIS PLASTIKINIS LENG
0,00 A
IKI Taškais
0,01 A
-0, 05 A
Prekiautojo ID 15027037
Data 2026-06-11 Laikas 21:07:53
Kvito Nr. 168/645/104148 Kasa 0027`;

const lines17: IkiLine[] = RAW17.split('\n').map((text, i) => ({
    text, yTop: i * 30, yBottom: i * 30 + 24, xLeft: 0, xRight: 400,
}));

describe('IKI thermal parser — smudged/fused OCR (receipt-17)', () => {
    const { products } = parseIkiReceipt(lines17);
    const names = products.map((p) => p.name.toUpperCase());
    const has = (re: RegExp) => products.find((p) => re.test(p.name));

    test('no discount / coupon / points / weight-calc lines become products', () => {
        expect(names.some((n) => /NUOLAI/.test(n))).toBe(false);      // discount lines
        expect(names.some((n) => /KUPONAS/.test(n))).toBe(false);     // coupons
        expect(names.some((n) => /TA[SŠ]KAIS/.test(n))).toBe(false);  // points
        expect(names.some((n) => /KG\s*X.*EUR/.test(n))).toBe(false); // weight rows
    });

    test('salmon: name recovered + €/kg price + derived kg qty (not the weight row as name)', () => {
        const salmon = has(/ANTIN|LASIS/i);
        expect(salmon).toBeTruthy();
        expect(salmon!.price).toBeCloseTo(16.99, 2);   // €/kg, not the 18.15 total
        expect(salmon!.quantity).toBeCloseTo(1.068, 2); // 18.15 ÷ 16.99
    });

    test('names fused into discount rows are recovered (paprikos, obuoliai)', () => {
        expect(has(/PAPRIK/i)).toBeTruthy();
        expect(has(/OBUOLI/i)).toBeTruthy();
    });

    test('weighed pomidorai recovers €/kg despite a leaked neighbour price', () => {
        const pom = has(/POMIDOR/i);
        expect(pom).toBeTruthy();
        expect(pom!.price).toBeCloseTo(3.99, 2);       // €/kg, not the leaked 1.99
    });

    test('weighed items are unit "kg" (drives the kg × €/kg line); unit items stay "vnt"', () => {
        expect(has(/ANTIN|LASIS/i)!.unit).toBe('kg');  // salmon
        expect(has(/PAPRIK/i)!.unit).toBe('kg');       // paprikos
        expect(has(/OBUOLI/i)!.unit).toBe('kg');       // obuoliai
        const suris = has(/SURIS|LYDYTAS/i);            // non-weighed
        expect(suris!.unit).toBe('vnt');
    });

    test('store address band detected despite OCR "g." → "9." garble', () => {
        const { header } = parseIkiReceipt(lines17);
        expect(header.lineRegions.some((r) => r.kind === 'storeAddress')).toBe(true);
    });

    test('product bands NEVER overlap (tight bands may leave gaps over garbled rows)', () => {
        for (let k = 0; k < products.length - 1; k++) {
            // Bands hug their own content and stop — a band's bottom may sit ABOVE
            // the next band's top (a gap over unrecognised rows), but must NEVER
            // cross below it (overlap).
            expect(products[k].region.yBottom).toBeLessThanOrEqual(products[k + 1].region.yTop + 0.01);
        }
    });

    test('coupons / bags / points emit distinct skipped bands (not products)', () => {
        const { skippedRegions } = parseIkiReceipt(lines17);
        expect((skippedRegions ?? []).length).toBeGreaterThanOrEqual(3); // wKUPONAS, xKUPONAS, MAIŠELIS, IKI Taškais
        expect((skippedRegions ?? []).every((r) => r.kind === 'skipped')).toBe(true);
        // and none of those lines leaked into the product list
        expect(products.some((p) => /KUPONAS|MAI[SŠ]ELIS|TA[SŠ]KAIS/i.test(p.name))).toBe(false);
    });

    test('skipped bands are DISTINCT and never overlap a product band', () => {
        const { skippedRegions } = parseIkiReceipt(lines17);
        const skips = skippedRegions ?? [];
        // Each skip line is its own band (distinct tops, ≥4 here).
        expect(skips.length).toBeGreaterThanOrEqual(4);
        expect(new Set(skips.map((s) => s.yTop)).size).toBe(skips.length);
        // No skip band overlaps any product band — touching at a seam is fine,
        // genuine overlap (shared interior) is not.
        for (const s of skips) {
            for (const p of products) {
                const overlap = Math.min(s.yBottom, p.region.yBottom) - Math.max(s.yTop, p.region.yTop);
                expect(overlap).toBeLessThanOrEqual(0.5);
            }
        }
    });
});

// Skew-aware quad bands: each OCR line carries per-corner Y (right edge lower
// than left → a tilted receipt). Bands must follow the tilt and seam with no gap
// on BOTH edges.
describe('IKI thermal parser — skewed quad band walls', () => {
    const tiltLines: IkiLine[] = [
        'GARDINO 2-2, SIAULIAI',
        'PVM mokėtojo kodas LT101937219',
        'PIENAS', '1,49 A',
        'SVIESTAS', '2,99 A',
        'Prekiautojo ID 15027037',
    ].map((text, i) => ({
        text, xLeft: 0, xRight: 400,
        yTop: i * 30, yBottom: i * 30 + 24,
        yLeftTop: i * 30, yRightTop: i * 30 + 8,           // right edge 8px lower → tilt
        yLeftBottom: i * 30 + 24, yRightBottom: i * 30 + 32,
    }));
    const { products } = parseIkiReceipt(tiltLines);

    test('band top edge is skewed (left/right Y differ)', () => {
        expect(products.length).toBeGreaterThanOrEqual(2);
        const p = products[1];
        expect(p.region.yRightTop).toBeDefined();
        expect(p.region.yRightTop).not.toBe(p.region.yLeftTop); // tilt preserved
    });

    test('first band starts on its OWN name, below the header — never absorbs it', () => {
        // Company-code line "PVM mokėtojo kodas …" bottom is bent (54 left, 62
        // right). Product 1 (PIENAS, name top 60/68) must start on its OWN name,
        // strictly at-or-below the header edge so it never overlaps — and is NOT
        // pulled UP onto the company-code line (which absorbed the PVM-code line +
        // dashed separator into the first band). The PVM line stays a clean gap.
        const r0 = products[0].region;
        expect(r0.yLeftTop!).toBeGreaterThanOrEqual(54);  // no overlap with header
        expect(r0.yRightTop!).toBeGreaterThanOrEqual(62);
        expect(r0.yLeftTop).toBe(60);   // its own name top, NOT the header's 54
        expect(r0.yRightTop).toBe(68);
        expect(r0.yRightTop).not.toBe(r0.yLeftTop); // bent, not flat
    });

    test('top section shares ONE tilt: product seams meet exactly + product 1 never overlaps the header', () => {
        // Tilted header (address/code) + tilted products → after normalization
        // every band is the same parallelogram, so seams line up to the pixel and
        // product 1 nests strictly below the company-code band on BOTH edges.
        const mk = (text: string, i: number, x0: number, x1: number, sk: number): IkiLine => ({
            text, yTop: i * 40, yBottom: i * 40 + 34, xLeft: x0, xRight: x1,
            yLeftTop: i * 40, yRightTop: i * 40 + sk, yLeftBottom: i * 40 + 34, yRightBottom: i * 40 + 34 + sk,
        });
        const ls: IkiLine[] = [
            mk('IKI Lietuva, UAB', 0, 50, 600, 6),
            mk('Gardino 9. 2-2, Šiauliai', 1, 208, 611, 8),
            mk('PVM mokėtojo kodas LT101937219', 2, 156, 665, 10),
            mk('AT! ANTINĖS LASISOS BE GAL', 3, 51, 760, 9),
            mk('1, 068 kg X 16,99 EUR/ kg', 4, 60, 760, 9),
            mk('18, 15 A', 5, 60, 760, 9),
            mk('NAMINIS 2,5% PIENAS', 6, 50, 760, 11),
            mk('1, 49 A', 7, 500, 760, 11),
            mk('Prekiautojo ID 15027037', 8, 50, 500, 0),
        ];
        const { header, products } = parseIkiReceipt(ls);
        const code = header.lineRegions.find((r) => r.kind === 'storeCode')!;
        const p0 = products[0].region;
        // no overlap with the company-code band on either edge
        expect(p0.yLeftTop!).toBeGreaterThanOrEqual(code.yLeftBottom!);
        expect(p0.yRightTop!).toBeGreaterThanOrEqual(code.yRightBottom!);
        // product seams meet exactly (shared width + slope)
        for (let k = 0; k < products.length - 1; k++) {
            expect(products[k].region.yLeftBottom).toBeCloseTo(products[k + 1].region.yLeftTop!, 5);
            expect(products[k].region.yRightBottom).toBeCloseTo(products[k + 1].region.yRightTop!, 5);
        }
    });

    test('consecutive bands seam with no gap on BOTH the left and right edge', () => {
        for (let k = 0; k < products.length - 1; k++) {
            expect(products[k].region.yLeftBottom).toBe(products[k + 1].region.yLeftTop);
            expect(products[k].region.yRightBottom).toBe(products[k + 1].region.yRightTop);
        }
    });
});

// OCR garble guards: a discount whose "I" came back as "1" ("NUOLA1DA") must
// still be a discount (not a phantom product that steals the real total), and a
// lone leftover letter ("A") must never become a product.
describe('IKI thermal parser — OCR-garble guards', () => {
    const RAW_G = `PVM mokėtojo kodas LT101937219
ATLANTINĖS LAŠIŠOS BE GAL
1, 068 kg X 16,99 EUR/ kg
NUOLA1DA SU KORTELE
18, 15 A
-7,48 A
IKI Taškais
-0,05 A
0, 01 A
Prekiautojo ID 15027037`;
    const g: IkiLine[] = RAW_G.split('\n').map((text, i) => ({
        text, yTop: i * 30, yBottom: i * 30 + 24, xLeft: 0, xRight: 400,
    }));
    const { products } = parseIkiReceipt(g);
    const names = products.map((p) => p.name.toUpperCase());

    test('"NUOLA1DA" (I→1) is treated as a discount, not a product', () => {
        expect(names.some((n) => /NUOL/.test(n))).toBe(false);
    });

    test('salmon keeps its real €/kg + total despite the garbled discount label', () => {
        const salmon = products.find((p) => /LASIS|ANTIN/i.test(p.name));
        expect(salmon).toBeTruthy();
        expect(salmon!.price).toBeCloseTo(16.99, 2);
        expect(salmon!.quantity).toBeCloseTo(1.068, 2);   // 18.15 ÷ 16.99 (not 3.29-leak)
    });

    test('no 1-letter phantom product, and points line is skipped', () => {
        expect(names.includes('A')).toBe(false);
        expect(names.some((n) => /TA[SŠ]KAIS/.test(n))).toBe(false);
    });

    test('garbled "IKI Taškals" (Taškais with i→l) is still skipped, not a product', () => {
        const RAW = `PVM mokėtojo kodas LT101937219
NAMINIS 2,5% PIENAS
1, 49 A
IKI Taškals
-0,05 A
0, 01 A
Prekiautojo ID 15027037`;
        const lines: IkiLine[] = RAW.split('\n').map((text, i) => ({
            text, yTop: i * 30, yBottom: i * 30 + 24, xLeft: 0, xRight: 400,
        }));
        const { products } = parseIkiReceipt(lines);
        expect(products.some((p) => /TA[SŠ]KA/i.test(p.name))).toBe(false);
    });
});

// Real-world OCR garbles seen on receipt-20: a discount label spelled with TWO
// internal spaces ("NUOLA I DA …"), and a discount fused onto the next product's
// name line ("-0,72 A RAUDONOSIOS PAPRIKOS"). The discount must attach to the
// CORRECT (preceding) product, and the fused line must split so the discount and
// the next name get distinct vertical bands.
describe('IKI thermal parser — receipt-20 discount edge cases', () => {
    test('"NUOLA I DA SU KORTELE -7,48 A" applies the discount to the salmon', () => {
        const RAW = `PVM mokėtojo kodas LT101937219
ATI ANTINES LASISOS BE GAL
1, U68 kg X 16.99 EUR/ kg
18, 15 A
NUOLA I DA SU KORTELE -7, 48 A
NAMINIS 2, 5% PIENAS
1,49 A
Prekiautojo ID 15027037`;
        const lines: IkiLine[] = RAW.split('\n').map((text, i) => ({
            text, yTop: i * 30, yBottom: i * 30 + 24, xLeft: 0, xRight: 400,
        }));
        const { products } = parseIkiReceipt(lines);
        // No phantom "NUOLA …" product.
        expect(products.some((p) => /NUOL/i.test(p.name))).toBe(false);
        const salmon = products.find((p) => /LASIS|ANTIN/i.test(p.name));
        expect(salmon).toBeTruthy();
        // 18.15 − 7.48 = 10.67 paid over 1.068 kg → promoPrice ≈ 9.99 €/kg.
        expect(salmon!.promoPrice).toBeCloseTo(9.99, 1);
        expect(salmon!.rawLines.some((l) => /-\s?7[.,]\s?48/.test(l))).toBe(true);
    });

    test('fused "-0,72 A NEXT NAME" splits so the discount stays in the prior band', () => {
        const RAW = `PVM mokėtojo kodas LT101937219
LIETUVISKI POMIDORAI
0, 720 kg X 3,99 EUR/ kg
NUOLAI DA
2, 87 A
-0, 72 A RAUDONOSIOS PAPRIKOS
0,470 kg X 3,49 EUR/ kg
1, 64 A
Prekiautojo ID 15027037`;
        const lines: IkiLine[] = RAW.split('\n').map((text, i) => ({
            text, xLeft: 0, xRight: 400,
            yTop: i * 30, yBottom: i * 30 + 24,
            yLeftTop: i * 30, yRightTop: i * 30,
            yLeftBottom: i * 30 + 24, yRightBottom: i * 30 + 24,
        }));
        const { products } = parseIkiReceipt(lines);
        const tomato = products.find((p) => /POMIDOR/i.test(p.name));
        const pepper = products.find((p) => /PAPRIK/i.test(p.name));
        expect(tomato).toBeTruthy();
        expect(pepper).toBeTruthy();
        // The -0,72 discount belongs to the tomatoes, not the peppers.
        expect(tomato!.rawLines.some((l) => /-\s?0[.,]\s?72/.test(l))).toBe(true);
        expect(pepper!.rawLines.some((l) => /-\s?0[.,]\s?72/.test(l))).toBe(false);
        // Seam between them is BELOW the fused row's top (the box was halved), so
        // the tomato band actually contains the discount text, not the pepper band.
        const fusedTop = 5 * 30; // index of the fused line
        expect(tomato!.region.yBottom).toBeGreaterThan(fusedTop);
    });

    test('split weight + no printed total → total derived from qty × €/kg (not the qty fragment)', () => {
        // receipt-36: OCR split "0,720 kg X 3,99 EUR/kg" into "0,72" + "0 kg X 3,99"
        // AND dropped the printed "2,87" total. The "0,72" is the QUANTITY (0,720
        // kg), not a 0,72 € line total — tomato must read 0,72 kg × 3,99 ≈ 2,87 €.
        const RAW = `PVM mokėtojo kodas LT101937219
LIETUVISKI POMIDORAI
0, 72
0 kg X 3, 99 EUR/ kg
NUOLAIDA RAUDONOSIOS PAPRIKOS
0, 47
0 kg X 3,4 EUR/ kg
1, 64 A
Prekiautojo ID 15027037`;
        const lines: IkiLine[] = RAW.split('\n').map((text, i) => ({
            text, yTop: i * 30, yBottom: i * 30 + 24, xLeft: 0, xRight: 400,
        }));
        const { products } = parseIkiReceipt(lines);
        const tomato = products.find((p) => /POMIDOR/i.test(p.name));
        expect(tomato).toBeTruthy();
        expect(tomato!.unit).toBe('kg');
        expect(tomato!.price).toBeCloseTo(3.99, 2);          // €/kg, not the 0,72 fragment
        expect(tomato!.quantity).toBeCloseTo(0.72, 1);       // ~0,720 kg, NOT 0,18
        expect(tomato!.quantity).toBeGreaterThan(0.5);       // hard guard vs the 0,18 bug
        // line total = €/kg × kg ≈ 2,87 €, NOT 0,72 €.
        expect(tomato!.price * tomato!.quantity).toBeCloseTo(2.87, 1);
    });

    test('two product names fused by a "<price> A <NAME2>" row split into separate products', () => {
        // receipt-37: OCR fused a cheese line-total onto the NEXT product name —
        // "LYDYTAS … 99 A LIETUVISKI POMIDORAI" (the "1," of 1,99 dropped). The
        // "<num> A" marks the cheese total, so POMIDORAI must be its OWN product
        // (weighed 0,720 kg × 3,99 = 2,87), not swallowed into the cheese name.
        const RAW = `PVM mokėtojo kodas LT101937219
LYDYTAS TEPAWAS RIS 99 A LIETUVISKI POMIDORAI
0, 720 kg X 3,99 EUR/ kg
NUOLAIDA
2, 87 A
Prekiautojo ID 15027037`;
        const lines: IkiLine[] = RAW.split('\n').map((text, i) => ({
            text, xLeft: 0, xRight: 400,
            yTop: i * 30, yBottom: i * 30 + 24,
            yLeftTop: i * 30, yRightTop: i * 30,
            yLeftBottom: i * 30 + 24, yRightBottom: i * 30 + 24,
        }));
        const { products } = parseIkiReceipt(lines);
        const tomato = products.find((p) => /POMIDOR/i.test(p.name));
        expect(tomato).toBeTruthy();
        // POMIDORAI is its OWN product — its name is NOT fused with the cheese.
        expect(/LYDYTAS|TEPAW/i.test(tomato!.name)).toBe(false);
        // and it reads the weighed total 0,720 × 3,99 ≈ 2,87 €.
        expect(tomato!.price * tomato!.quantity).toBeCloseTo(2.87, 1);
    });

    test('total bands on the "SUMA … EUR" line even when "Mokėti" is OCR-scrambled', () => {
        // receipt-21: the payment block can come back with "Mokėti" and the amount
        // on separate/garbled lines, so the keyword+amount never co-occur. The
        // canonical "SUMA 26,52 EUR" line must still produce a total + total band.
        const RAW = `PVM mokėtojo kodas LT101937219
NAMINIS 2,5% PIENAS
1, 49 A
Prekiautojo ID 15027037
Data 2026-06-11 Laikas 21:07:53
SUMA 26, 52 EUR
Mokėti Moketi PUM
26, 52
Kvito Nr. 168/645/104148 Kasa 0027`;
        const lines: IkiLine[] = RAW.split('\n').map((text, i) => ({
            text, yTop: i * 30, yBottom: i * 30 + 24, xLeft: 0, xRight: 400,
        }));
        const { footer } = parseIkiReceipt(lines);
        expect(footer.total).toBe(26.52);
        expect(footer.lineRegions.some((r) => r.kind === 'total')).toBe(true);
    });

    test('Kvito Nr. band is FULL-WIDTH and BENT, anchored in Y to the receipt-no value', () => {
        const lines: IkiLine[] = [
            { text: 'PVM mokėtojo kodas LT101937219', yTop: 0, yBottom: 24, xLeft: 0, xRight: 740 },
            { text: 'PIENAS', yTop: 30, yBottom: 54, xLeft: 0, xRight: 200 },
            { text: '1, 49 A', yTop: 60, yBottom: 84, xLeft: 300, xRight: 400 },
            { text: 'Prekiautojo ID 15027037', yTop: 200, yBottom: 224, xLeft: 0, xRight: 400 },
            {
                text: 'Kvito Nr. 168/645/104148 Kasa 0027', yTop: 300, yBottom: 342, xLeft: 50, xRight: 740,
                words: [
                    { text: 'Kvito', xLeft: 50, xRight: 120, yTop: 300, yBottom: 330 },
                    { text: 'Nr.', xLeft: 125, xRight: 160, yTop: 301, yBottom: 331 },
                    { text: '168/645/104148', xLeft: 165, xRight: 560, yTop: 303, yBottom: 333 },
                    { text: 'Kasa', xLeft: 600, xRight: 670, yTop: 310, yBottom: 340 },
                    { text: '0027', xLeft: 680, xRight: 740, yTop: 312, yBottom: 342 },
                ],
            },
        ];
        const { footer } = parseIkiReceipt(lines);
        const rn = footer.lineRegions.find((r) => r.kind === 'receiptNo')!;
        expect(rn).toBeTruthy();
        // HUGS the receipt-no value word "168/645/104148" (x165–560) — matches the OCR
        // box, tight, NOT full-width and NOT anchored to "Kvito"/"Kasa"/"0027".
        expect(rn.xLeft).toBeGreaterThan(140);
        expect(rn.xRight).toBeLessThan(600);
        expect(rn.xRight - rn.xLeft).toBeLessThan(450);
        // sits on the value row (~300–342)
        expect(rn.yTop).toBeGreaterThan(295);
        expect(rn.yTop).toBeLessThan(335);
    });

    test('BOTH total rows are banded (SUMA line + Mokėti line), VAT header excluded', () => {
        const RAW = `PVM mokėtojo kodas LT101937219
NAMINIS 2,5% PIENAS
1, 49 A
Prekiautojo ID 15027037
Data 2026-06-11 Laikas 21:07:53
SUMA 26,52 EUR
26, 52 Mokėti
PVM suma Mokestis Suma su PUM Be PVM
4, 60 21,92 26, 52 A 21, 00 % 26, 52
Kvito Nr. 168/645/104148 Kasa 0027`;
        const lines: IkiLine[] = RAW.split('\n').map((text, i) => ({
            text, yTop: i * 30, yBottom: i * 30 + 24, xLeft: 0, xRight: 400,
        }));
        const { footer } = parseIkiReceipt(lines);
        expect(footer.total).toBe(26.52);
        // a band on the SUMA line AND the Mokėti line — but NOT the VAT header.
        expect(footer.lineRegions.filter((r) => r.kind === 'total').length).toBe(2);
    });

    test('split SUMA (keyword + amount on separate lines) → correct total + band', () => {
        // receipt-27: "Pardavimas SUMA" then "26,52 EUR Patvirtintas" on the next
        // line; the garbled "Mokėti 26. 26 …" must NOT win the value.
        const RAW = `PVM mokėtojo kodas LT101937219
NAMINIS 2,5% PIENAS
1, 49 A
Prekiautojo ID 15027037
Pardavimas SUMA
26,52 EUR Patvirtintas
Mokėti 26. 26, 562 52
Kvito Nr. 168/645/104148 Kasa 0027`;
        const lines: IkiLine[] = RAW.split('\n').map((text, i) => ({
            text, yTop: i * 30, yBottom: i * 30 + 24, xLeft: 0, xRight: 400,
        }));
        const { footer } = parseIkiReceipt(lines);
        expect(footer.total).toBe(26.52);                 // SUMA wins, not the garbled Mokėti
        expect(footer.lineRegions.filter((r) => r.kind === 'total').length).toBe(2); // SUMA-amount + Mokėti
    });

    test('total + band when the SUMA line is reversed ("26,52 EUR SUMA")', () => {
        // receipt-23: OCR flips the order — amount + EUR before the SUMA keyword.
        const RAW = `PVM mokėtojo kodas LT101937219
NAMINIS 2,5% PIENAS
1, 49 A
Prekiautojo ID 15027037
Data 2026-06-11 Laikas 21:07:53
Pardavimas
26,52 EUR SUMA
Kvito Nr. 168/645/104148 Kasa 0027`;
        const lines: IkiLine[] = RAW.split('\n').map((text, i) => ({
            text, yTop: i * 30, yBottom: i * 30 + 24, xLeft: 0, xRight: 400,
        }));
        const { footer } = parseIkiReceipt(lines);
        expect(footer.total).toBe(26.52);
        expect(footer.lineRegions.some((r) => r.kind === 'total')).toBe(true);
    });

    test('line total fused onto the FRONT of a weight row keeps the product', () => {
        // receipt-21: "18,15 A- 1,068 kg X 16,99 EUR/kg" — total prepended to the
        // weight line. Without splitting it off, the whole line reads as a weight
        // row, no total registers, and the salmon is dropped.
        const RAW = `PVM mokėtojo kodas LT101937219
AT! ANTINĖS LASISOS BE GAL
18, 15 A- 1, U68 kg X 16,99 EUR/ kg
-7,48 A NUOLAI DA SU KORTELE
NAMINIS 2,5% PIENAS
1, 49 A
Prekiautojo ID 15027037`;
        const lines: IkiLine[] = RAW.split('\n').map((text, i) => ({
            text, yTop: i * 30, yBottom: i * 30 + 24, xLeft: 0, xRight: 400,
        }));
        const { products } = parseIkiReceipt(lines);
        const salmon = products.find((p) => /LASIS|ANTIN/i.test(p.name));
        expect(salmon).toBeTruthy();
        expect(salmon!.price).toBeCloseTo(16.99, 2);          // €/kg
        expect(salmon!.quantity).toBeCloseTo(1.068, 2);       // 18.15 ÷ 16.99
        expect(salmon!.promoPrice).toBeCloseTo(9.99, 1);      // (18.15−7.48)/1.068
        // and the milk after it still parses (salmon didn't eat the next block)
        expect(products.some((p) => /NAMINIS|PIENAS/i.test(p.name))).toBe(true);
    });
});

// receipt-22: heavily column-scrambled + garbled OCR. Verifies the robustness
// fixes: address stripped off the IKI-fused first line (not a product line),
// garbled coupon "JPONAS" skipped (so the obuoliai price behind it is recovered),
// and a "NUOLAIDA <amt> <NAME>" fusion split so the next product isn't swallowed.
// NOTE: Basmati + Lydytas stay dropped here — their prices were OCR-placed below
// the WRONG product name (a coordinate-level error no parser pass can undo).
describe('IKI thermal parser — receipt-22 scrambled OCR', () => {
    const RAW = `IKI Lietuva, UA8 Gardino g. 2-2, Siauliai
PVM keljo kodas LT101937219
SKANĖ JA RY2. BASMATI, 8
ATI ANTINĖS LASISOS BE GAL
3, 29 A
1, 068 kg X 16, 99 EUR/ kg
NUOLAIDA SU KORTELE
-7, 48 A
18, 15 A
NAMINIS 2,5% PIENAS
NUOLAIDA SU KORTELE
1,49 A
-0, 30 A ZEMAITIJOS TEPAMAC SURELI
1.99 A
LYDYTAS TEPAMAS SURIS SU
LIETUVISKI POMIDORAI
1,99 A
0, 720 kg X 3,99 EUR/ kg
NUOLAIDA 2A RAUDONOS IOS PAPRIKOS
0, 470 kg X 3, 49 EUR/ kg
NUOLAIDA SU KORTELE
Fasuoti obuoliai IKI OKIS
K90 kg X 1, 85 EUR/ kg
JPONAS
3, 87 A
*KUPONAS
0, 00 A
MAISELIS PLASTIKINIS LENG
0, 00 A
IKI Taškais
0, 01 A
-0, 05 A
Prekiautojo ID 15027037`;
    const lines: IkiLine[] = RAW.split('\n').map((text, i) => ({
        text, yTop: i * 30, yBottom: i * 30 + 24, xLeft: 0, xRight: 400,
    }));
    const { header, products } = parseIkiReceipt(lines);
    const names = products.map((p) => p.name.toUpperCase());

    test('address is the real street, not the IKI prefix and not a product line', () => {
        expect(header.storeAddress).toMatch(/Gardino/i);
        expect(header.storeAddress).not.toMatch(/IKI|BASMATI|SKAN/i);
    });

    test('garbled coupon "JPONAS" is skipped, not a product', () => {
        expect(names.some((n) => /JPONAS|PONAS|KUPON/.test(n))).toBe(false);
    });

    test('no "SU KORTELE" phantom from over-splitting the discount label', () => {
        expect(names.some((n) => /^SU\b|KORTELE/.test(n))).toBe(false);
    });

    test('obuoliai recovered (price behind the garbled coupon)', () => {
        const ob = products.find((p) => /OBUOLI/i.test(p.name));
        expect(ob).toBeTruthy();
        expect(ob!.price).toBeCloseTo(1.85, 2);
        expect(ob!.unit).toBe('kg');
    });

    test('paprikos split off the pomidorai discount line (its own product)', () => {
        expect(products.some((p) => /PAPRIK/i.test(p.name))).toBe(true);
        expect(products.some((p) => /POMIDOR/i.test(p.name))).toBe(true);
    });

    test('salmon + milk keep correct values despite the scramble', () => {
        const salmon = products.find((p) => /LASIS|ANTIN/i.test(p.name));
        expect(salmon!.price).toBeCloseTo(16.99, 2);
        expect(salmon!.promoPrice).toBeCloseTo(9.99, 1);
        const milk = products.find((p) => /NAMINIS|PIENAS/i.test(p.name));
        expect(milk!.price).toBeCloseTo(1.49, 2);
        expect(milk!.promoPrice).toBeCloseTo(1.19, 2);
    });

    test('SAFEGUARD: every product band is full-width AND no two bands EVER overlap', () => {
        // Realistic geometry: name boxes narrow on the left, price tokens on the
        // right. The leaked-price (pending) product would otherwise get a name-only
        // band — it must still span the full row, and NO band may overlap another.
        const nm = (text: string, i: number): IkiLine => ({
            text, yTop: i * 40, yBottom: i * 40 + 34, xLeft: 55, xRight: 470,
            yLeftTop: i * 40, yRightTop: i * 40 + 6, yLeftBottom: i * 40 + 34, yRightBottom: i * 40 + 40,
        });
        const pr = (text: string, i: number): IkiLine => ({
            text, yTop: i * 40, yBottom: i * 40 + 34, xLeft: 600, xRight: 760,
            yLeftTop: i * 40, yRightTop: i * 40 + 2, yLeftBottom: i * 40 + 34, yRightBottom: i * 40 + 36,
        });
        const lines: IkiLine[] = [
            nm('PVM kelojo kodas LT101937219', 0),
            nm('SKANĖ JA RY2. BASMATI, 8', 1),   // pending (price leaks below)
            nm('AT! ANTINĖS LASIŠOS BE GAL', 2),
            pr('3, 29 A', 3),
            nm('1, 068 kg X 16,99 EUR/ kg', 4),
            pr('18, 15 A', 5),
            nm('NAMINIS 2,5% PIENAS', 6),
            pr('1, 49 A', 7),
            nm('Prekiautojo ID 15027037', 8),
        ];
        const { products } = parseIkiReceipt(lines);
        // full width: all product bands share one x-span
        const xs = new Set(products.map((p) => `${p.region.xLeft}-${p.region.xRight}`));
        expect(xs.size).toBe(1);
        // no overlaps on EITHER edge (sorted top→bottom)
        const regs = products.map((p) => p.region).sort((a, b) => a.yTop - b.yTop);
        for (let k = 0; k < regs.length - 1; k++) {
            const a = regs[k], b = regs[k + 1];
            expect((a.yLeftBottom ?? a.yBottom) - (b.yLeftTop ?? b.yTop)).toBeLessThanOrEqual(0.001);
            expect((a.yRightBottom ?? a.yBottom) - (b.yRightTop ?? b.yTop)).toBeLessThanOrEqual(0.001);
        }
    });

    test('column-scramble recovery: Basmati + Lydytas reclaimed from leaked prices', () => {
        // Both have an empty block (their price was emitted into the NEXT, weighed
        // product's block as a pre-weight leak) → recovered as unit items.
        const basmati = products.find((p) => /BASMATI|SKAN/i.test(p.name));
        expect(basmati).toBeTruthy();
        expect(basmati!.price).toBeCloseTo(3.29, 2);
        const lydytas = products.find((p) => /LYDYTAS/i.test(p.name));
        expect(lydytas).toBeTruthy();
        expect(lydytas!.price).toBeCloseTo(1.99, 2);
        expect(products.length).toBe(8); // all eight line items present
    });
});

// receipt-24: worst OCR yet — "IKI"→"KI", company code split by a space
// ("LT1019372 19"), and a "NUOLAIDA ŠU KORTELt" label (Lithuanian Š + garbled
// KORTELE). Verifies: address recovered (not the chain line), company code still
// detected, product 1 NEVER overlaps the header, and no "ŠU KORTELt" phantom.
describe('IKI thermal parser — receipt-24 (heavy header garble)', () => {
    const RAW = `KI Lietuva, UA8
Gardino 9. 2-2, Šiauliai
PVY Kėl jo kodas LT1019372 19
SKANĖJA RY2.. 6ASMA TI, 8
3, 29 A
AT! \\NTINĖS LASISOS BE GAL
1, U68 kg X 16.99 EUR/ kg
18, 15 A
NUOLAI DA ŠU KORTELE -7, 48 A
NAMINIS 2,58% PIENAS
1,49 A
RAUDONOSIOS PAPRIKOS
0, 470 kg X 3, 49 EUR/ kg
NUOLAIDA ŠU KORTELt
1,64 A
-0,23 A Fasuoti obuoli ai IKI UKIS
2, 090 kg X 1,85 EUR/ kg
3, 87 A
Prekiautojo ID 15027037`;
    const lines: IkiLine[] = RAW.split('\n').map((text, i) => ({
        text, yTop: i * 30, yBottom: i * 30 + 24, xLeft: 0, xRight: 400,
    }));
    const { header, products } = parseIkiReceipt(lines);

    test('address recovered despite IKI→KI garble (not the chain line)', () => {
        expect(header.storeAddress).toMatch(/Gardino/i);
        expect(header.storeAddress).not.toMatch(/Lietuva|UA8/i);
    });

    test('company code detected despite the digit run being split by a space', () => {
        expect(header.lineRegions.some((r) => r.kind === 'storeCode')).toBe(true);
    });

    test('product 1 NEVER overlaps the header (hard rule)', () => {
        const headerBottom = Math.max(...header.lineRegions.map((r) => r.yBottom));
        expect(products[0].region.yTop).toBeGreaterThanOrEqual(headerBottom);
    });

    test('"NUOLAIDA ŠU KORTELt" is not a phantom; paprikos keeps its 1,64 price', () => {
        expect(products.some((p) => /KORTEL/i.test(p.name))).toBe(false);
        const pap = products.find((p) => /PAPRIK/i.test(p.name));
        expect(pap).toBeTruthy();
        expect(pap!.price).toBeCloseTo(3.49, 2);
        expect(pap!.quantity).toBeCloseTo(0.47, 2); // 1.64 ÷ 3.49
    });
});

// ── COLUMN ENGINE (word-anchored): runs only when per-word boxes are present ──
describe('IKI column engine — row reconstruction from words', () => {
    const word = (text: string, xLeft: number, xRight: number, yTop: number) =>
        ({ text, xLeft, xRight, yTop, yBottom: yTop + 24 });
    const wl = (text: string, yTop: number, words: ReturnType<typeof word>[]): IkiLine => ({
        text, yTop, yBottom: yTop + 24,
        xLeft: Math.min(...words.map((w) => w.xLeft)),
        xRight: Math.max(...words.map((w) => w.xRight)),
        yLeftTop: yTop, yRightTop: yTop, yLeftBottom: yTop + 24, yRightBottom: yTop + 24,
        words,
    });

    test('a price OCR’d as a separate line is matched to its name by Y (scramble resolved)', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [
                word('PVM', 0, 60, 0), word('mokėtojo', 65, 200, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0),
            ]),
            // product 1 — physical row split by OCR into a left name line + a right price line, SAME y
            wl('SKANĖJA', 100, [word('SKANĖJA', 50, 200, 100)]),
            wl('3, 29 A', 100, [word('3,29', 600, 700, 100), word('A', 710, 730, 100)]),
            // product 2
            wl('PIENAS', 140, [word('PIENAS', 50, 200, 140)]),
            wl('1, 49 A', 140, [word('1,49', 600, 700, 140), word('A', 710, 730, 140)]),
            wl('Prekiautojo ID 15027037', 200, [word('Prekiautojo', 0, 150, 200), word('ID', 155, 200, 200), word('15027037', 210, 400, 200)]),
        ];
        const { products } = parseIkiReceipt(lines);
        expect(products).toHaveLength(2);
        const skan = products.find((p) => /SKAN/i.test(p.name))!;
        const pien = products.find((p) => /PIEN/i.test(p.name))!;
        expect(skan).toBeTruthy();
        expect(skan.price).toBeCloseTo(3.29, 2);  // price matched across the OCR line split
        expect(pien.price).toBeCloseTo(1.49, 2);
        // bands: full section width, no overlap (product 1 bottom == product 2 top)
        expect(skan.region.xLeft).toBe(50);
        expect(skan.region.xRight).toBe(730);
        const top = products.sort((a, b) => a.region.yTop - b.region.yTop);
        expect(top[0].region.yBottom).toBeLessThanOrEqual(top[1].region.yTop + 0.01);
    });

    test('a weighed item: name + weight row + total row collapse into one product', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('LIETUVISKI POMIDORAI', 100, [word('LIETUVISKI', 50, 250, 100), word('POMIDORAI', 260, 430, 100)]),
            wl('0,720 kg X 3,99 EUR/ kg', 140, [word('0,720', 50, 130, 140), word('kg', 140, 175, 140), word('X', 180, 200, 140), word('3,99', 210, 290, 140), word('EUR/', 300, 380, 140), word('kg', 390, 425, 140)]),
            wl('2, 87 A', 180, [word('2,87', 600, 700, 180), word('A', 710, 730, 180)]),
            wl('Prekiautojo ID 15027037', 240, [word('Prekiautojo', 0, 150, 240), word('ID', 155, 200, 240)]),
        ];
        const { products } = parseIkiReceipt(lines);
        expect(products).toHaveLength(1);
        const tom = products[0];
        expect(/POMIDOR/i.test(tom.name)).toBe(true);
        expect(tom.unit).toBe('kg');
        expect(tom.price).toBeCloseTo(3.99, 2);            // €/kg
        expect(tom.price * tom.quantity).toBeCloseTo(2.87, 1); // total
        // GAPLESS quad band: the only product spans its NAME row top (y100) down to
        // its lowest row's bottom (the total row at y180, bottom ≈204).
        const r = tom.region;
        expect(r.yTop).toBeCloseTo(100, 0);              // name row top
        expect(r.yBottom).toBeGreaterThan(195);          // covers the price row (y180+)
        expect(r.yBottom).toBeLessThan(215);             // but not far past it
    });

    test('receipt-44 pattern: discount FOLLOWS the total + next name fused on the discount line', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('ATLANTINĖS LAŠIŠOS', 100, [word('ATLANTINĖS', 50, 250, 100), word('LAŠIŠOS', 260, 400, 100)]),
            wl('1,068 kg X 16,99 EUR/ kg', 140, [word('1,068', 50, 130, 140), word('kg', 140, 175, 140), word('X', 180, 200, 140), word('16,99', 210, 300, 140), word('EUR/', 310, 390, 140), word('kg', 400, 435, 140)]),
            wl('18, 15 A', 180, [word('18,15', 600, 700, 180), word('A', 710, 730, 180)]),
            wl('-7,48 A NAMINIS', 220, [word('NAMINIS', 50, 200, 220), word('-7,48', 600, 700, 220), word('A', 710, 730, 220)]),
            wl('1, 49 A', 260, [word('1,49', 600, 700, 260), word('A', 710, 730, 260)]),
            wl('-0, 30 A', 300, [word('-0,30', 600, 700, 300), word('A', 710, 730, 300)]),
            wl('Prekiautojo ID 15027037', 360, [word('Prekiautojo', 0, 150, 360), word('ID', 155, 200, 360)]),
        ];
        const { products } = parseIkiReceipt(lines);
        expect(products).toHaveLength(2);
        const salmon = products.find((p) => /ATLANT|LAŠIŠ/i.test(p.name))!;
        const naminis = products.find((p) => /NAMINIS/i.test(p.name))!;
        // salmon: weighed, total 18.15, discount −7.48 attaches to it (it FOLLOWS the total)
        expect(salmon).toBeTruthy();
        expect(salmon.unit).toBe('kg');
        expect(salmon.price).toBeCloseTo(16.99, 2);
        expect(salmon.quantity).toBeCloseTo(1.068, 2);
        expect(salmon.promoPrice!).toBeCloseTo(9.99, 1); // (18.15−7.48)/1.068
        // NAMINIS: its name was fused onto the salmon's discount line — recovered, not "?"
        expect(naminis).toBeTruthy();
        expect(naminis.price).toBeCloseTo(1.49, 2);
        expect(naminis.promoPrice!).toBeCloseTo(1.19, 1); // (1.49−0.30)
        // full row text reaches rawLines (the weight row, etc.)
        expect(salmon.rawLines.some((l) => /kg.*EUR/i.test(l))).toBe(true);
    });

    test('receipt-45 pattern: "NUOLAIDA SU KORTELĖ" tail is NOT a phantom product; total fused on the weight row', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('ATLANTINĖS LAŠIŠOS', 100, [word('ATLANTINĖS', 50, 250, 100), word('LAŠIŠOS', 260, 400, 100)]),
            // weight AND line-total fused on ONE row
            wl('1,068 kg X 16,99 EUR/ kg 18,15 A', 140, [
                word('1,068', 50, 130, 140), word('kg', 140, 175, 140), word('X', 180, 200, 140),
                word('16,99', 210, 300, 140), word('EUR/', 310, 390, 140), word('kg', 400, 435, 140),
                word('18,15', 600, 700, 140), word('A', 710, 730, 140),
            ]),
            // discount LABEL tail ("SU K HT" = garbled "SU KORTELĖ") + the discount amount
            wl('NUOLAIDA SU K HT -7,48 A', 180, [
                word('NUOLAIDA', 50, 180, 180), word('SU', 190, 230, 180), word('K', 240, 260, 180), word('HT', 270, 300, 180),
                word('-7,48', 600, 700, 180), word('A', 710, 730, 180),
            ]),
            wl('NAMINIS', 220, [word('NAMINIS', 50, 200, 220)]),
            wl('1, 49 A', 260, [word('1,49', 600, 700, 260), word('A', 710, 730, 260)]),
            wl('Prekiautojo ID 15027037', 320, [word('Prekiautojo', 0, 150, 320), word('ID', 155, 200, 320)]),
        ];
        const { products } = parseIkiReceipt(lines);
        // exactly two real products — NO "SU K HT" / "KORTELĖ" phantom
        expect(products.some((p) => /^[SŠ]U\b|KORTEL/i.test(p.name))).toBe(false);
        expect(products).toHaveLength(2);
        const salmon = products.find((p) => /ATLANT|LAŠIŠ/i.test(p.name))!;
        expect(salmon.unit).toBe('kg');
        expect(salmon.price).toBeCloseTo(16.99, 2);
        expect(salmon.quantity).toBeCloseTo(1.068, 2);   // total 18.15 captured off the weight row
        expect(salmon.promoPrice!).toBeCloseTo(9.99, 1); // (18.15−7.48)/1.068, discount attached
        expect(products.find((p) => /NAMINIS/i.test(p.name))!.price).toBeCloseTo(1.49, 2);
    });

    test('per-column: a weight (left) and total (right) OCR’d as separate lines at the SAME Y re-join', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('LIETUVISKI POMIDORAI', 100, [word('LIETUVISKI', 50, 250, 100), word('POMIDORAI', 260, 430, 100)]),
            // SAME physical row (y140) split by OCR: weight on the left, total on the right
            wl('0,720 kg X 3,99 EUR/ kg', 140, [word('0,720', 50, 130, 140), word('kg', 140, 175, 140), word('X', 180, 200, 140), word('3,99', 210, 300, 140), word('EUR/', 310, 390, 140), word('kg', 400, 435, 140)]),
            wl('2, 87 A', 140, [word('2,87', 600, 700, 140), word('A', 710, 730, 140)]),
            wl('Prekiautojo ID 15027037', 200, [word('Prekiautojo', 0, 150, 200), word('ID', 155, 200, 200)]),
        ];
        const { products } = parseIkiReceipt(lines);
        expect(products).toHaveLength(1);
        const tom = products[0];
        expect(/POMIDOR/i.test(tom.name)).toBe(true);
        expect(tom.unit).toBe('kg');
        expect(tom.price).toBeCloseTo(3.99, 2);
        expect(tom.price * tom.quantity).toBeCloseTo(2.87, 1);
    });

    test('receipt-47: next name on the ADJACENT line (not same Y) is not swallowed by the discount row', () => {
        // The salmon discount (-7,48, y180) and the NAMINIS name (y220) are on
        // DIFFERENT physical lines (~1 line-pitch apart). A loose merge tolerance
        // used to fold NAMINIS into the discount row and drop the name → "?".
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('ATLANTINĖS LAŠIŠOS', 100, [word('ATLANTINĖS', 50, 250, 100), word('LAŠIŠOS', 260, 400, 100)]),
            wl('1,068 kg X 16,99 EUR/ kg 18,15 A', 140, [
                word('1,068', 50, 130, 140), word('kg', 140, 175, 140), word('X', 180, 200, 140),
                word('16,99', 210, 300, 140), word('EUR/', 310, 390, 140), word('kg', 400, 435, 140),
                word('18,15', 600, 700, 140), word('A', 710, 730, 140),
            ]),
            wl('NUOLAIDA SU KORTELE', 180, [word('NUOLAIDA', 50, 180, 180), word('SU', 190, 230, 180), word('KORTELE', 240, 360, 180)]),
            wl('-7,48 A', 180, [word('-7,48', 600, 700, 180), word('A', 710, 730, 180)]),
            // NAMINIS sits on the NEXT physical line, left column only
            wl('NAMINIS 2,5%', 220, [word('NAMINIS', 50, 200, 220), word('2,5%', 210, 290, 220)]),
            wl('1, 49 A', 220, [word('1,49', 600, 700, 220), word('A', 710, 730, 220)]),
            wl('Prekiautojo ID 15027037', 300, [word('Prekiautojo', 0, 150, 300), word('ID', 155, 200, 300)]),
        ];
        const { products } = parseIkiReceipt(lines);
        expect(products).toHaveLength(2);
        const naminis = products.find((p) => /NAMINIS/i.test(p.name));
        expect(naminis).toBeTruthy();          // name preserved, not "?"
        expect(naminis!.price).toBeCloseTo(1.49, 2);
        expect(products.some((p) => /^[SŠ]U\b|KORTEL/i.test(p.name))).toBe(false);
    });

    test('receipt-47: a one-line product band is bounded by line size, not stretched to the next product', () => {
        // Product 1 (SKANĖJA) is one line at y100; product 2 is WEIGHED and its
        // price row sits 2 lines lower (y200). The old band stretched product 1's
        // price box down to y200. It must stay ~1 line tall (content-bounded).
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('SKANĖJA RYŽIAI', 100, [word('SKANĖJA', 50, 250, 100), word('RYŽIAI', 260, 400, 100)]),
            wl('3, 29 A', 100, [word('3,29', 600, 700, 100), word('A', 710, 730, 100)]),
            wl('POMIDORAI', 160, [word('POMIDORAI', 50, 250, 160)]),
            wl('0,720 kg X 3,99 EUR/ kg', 200, [word('0,720', 50, 130, 200), word('kg', 140, 175, 200), word('X', 180, 200, 200), word('3,99', 210, 300, 200), word('EUR/', 310, 390, 200), word('kg', 400, 435, 200)]),
            wl('2, 87 A', 200, [word('2,87', 600, 700, 200), word('A', 710, 730, 200)]),
            wl('Prekiautojo ID 15027037', 280, [word('Prekiautojo', 0, 150, 280), word('ID', 155, 200, 280)]),
        ];
        const { products } = parseIkiReceipt(lines);
        const skan = products.find((p) => /SKAN/i.test(p.name))!;
        expect(skan).toBeTruthy();
        // price box (right side) must hug the 3,29 row (~y100-124+gap), NOT reach y200
        expect(skan.region.yRightBottom!).toBeLessThan(150);
        // and it must not collapse either
        expect(skan.region.yRightBottom! - skan.region.yRightTop!).toBeGreaterThan(10);
        // hard rule still holds: no overlap with the next product
        const next = products.find((p) => /POMIDOR/i.test(p.name))!;
        expect(skan.region.yBottom).toBeLessThanOrEqual(next.region.yTop + 0.5);
    });

    test('receipt-48: a decimal-less "49 A" is still a price (trailing A) and is NOT absorbed', () => {
        // Real receipt-48: OCR dropped the leading digits on two scrambled lines —
        // "-7,48 A"→"48 A" (salmon discount) and "1,49 A"→"49 A" (NAMINIS total).
        // Salmon must NOT absorb NAMINIS's price: the 3rd A-price is the boundary.
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('ATLANTINĖS LAŠIŠOS', 100, [word('ATLANTINĖS', 50, 250, 100), word('LAŠIŠOS', 260, 400, 100)]),
            wl('1,068 kg X 16,99 EUR/ kg 18,15 A', 140, [
                word('1,068', 50, 130, 140), word('kg', 140, 175, 140), word('X', 180, 200, 140),
                word('16,99', 210, 300, 140), word('EUR/', 310, 390, 140), word('kg', 400, 435, 140),
                word('18,15', 600, 700, 140), word('A', 710, 730, 140),
            ]),
            // salmon discount — OCR dropped "-7,": just "48 A" + the NUOLAIDA label
            wl('NUOLAIDA 48 A', 180, [word('NUOLAIDA', 50, 180, 180), word('48', 600, 660, 180), word('A', 710, 730, 180)]),
            // NAMINIS total — OCR dropped "1,": just "49 A" on its own (left name lost upstream)
            wl('49 A', 220, [word('49', 600, 660, 220), word('A', 710, 730, 220)]),
            wl('-0,30 A', 260, [word('-0,30', 600, 700, 260), word('A', 710, 730, 260)]),
            wl('Prekiautojo ID 15027037', 320, [word('Prekiautojo', 0, 150, 320), word('ID', 155, 200, 320)]),
        ];
        const { products } = parseIkiReceipt(lines);
        // salmon keeps its 18,15 total + the 48 discount (2 A-prices); the 3rd A-price
        // ("49 A") opens a SECOND product instead of being absorbed.
        expect(products.length).toBe(2);
        const salmon = products.find((p) => /ATLANT|LAŠIŠ/i.test(p.name))!;
        expect(salmon).toBeTruthy();
        expect(salmon.price).toBeCloseTo(16.99, 2);
        expect(salmon.quantity).toBeCloseTo(1.068, 2);  // total 18,15 stayed with salmon
        // the second product carries the "49 A" price (value best-effort) — NOT merged into salmon
        const other = products.find((p) => p !== salmon)!;
        expect(other).toBeTruthy();
        expect(other.price).toBeGreaterThan(0);
    });

    test('receipt-52: a band STRICTLY contains every OCR word of its product, even tilted (band ≡ content)', () => {
        // Tilted receipt: each physical line rises ~0.04/px to the right. A weighed
        // product spans name + weight + discount rows. The band must enclose ALL of
        // its words — the drawn border and the recognised content cannot diverge.
        const tilt = (x: number) => Math.round(0.04 * x);                 // y rises with x
        const tw = (text: string, xL: number, xR: number, baseY: number) =>
            ({ text, xLeft: xL, xRight: xR, yTop: baseY + tilt(xL), yBottom: baseY + 24 + tilt(xR) });
        const twl = (text: string, baseY: number, words: ReturnType<typeof tw>[]): IkiLine => ({
            text, yTop: Math.min(...words.map((w) => w.yTop)), yBottom: Math.max(...words.map((w) => w.yBottom)),
            xLeft: Math.min(...words.map((w) => w.xLeft)), xRight: Math.max(...words.map((w) => w.xRight)),
            yLeftTop: words[0].yTop, yRightTop: words[words.length - 1].yTop,
            yLeftBottom: words[0].yBottom, yRightBottom: words[words.length - 1].yBottom, words,
        });
        const lines: IkiLine[] = [
            twl('PVM mokėtojo kodas LT101937219', 0, [tw('PVM', 0, 60, 0), tw('kodas', 205, 300, 0), tw('LT101937219', 310, 500, 0)]),
            twl('RAUDONOSIOS PAPRIKOS', 100, [tw('RAUDONOSIOS', 50, 280, 100), tw('PAPRIKOS', 290, 430, 100)]),
            twl('0,470 kg X 3,4 EUR/ kg 1,64 A', 150, [tw('0,470', 50, 130, 150), tw('kg', 140, 175, 150), tw('X', 180, 200, 150), tw('3,4', 210, 270, 150), tw('EUR/', 300, 380, 150), tw('kg', 390, 425, 150), tw('1,64', 600, 700, 150), tw('A', 710, 730, 150)]),
            twl('NUOLAIDA SU KORTELE -0,23 A', 200, [tw('NUOLAIDA', 50, 180, 200), tw('SU', 190, 230, 200), tw('KORTELE', 240, 360, 200), tw('-0,23', 600, 700, 200), tw('A', 710, 730, 200)]),
            twl('Prekiautojo ID 15027037', 260, [tw('Prekiautojo', 0, 150, 260), tw('ID', 155, 200, 260)]),
        ];
        const { products } = parseIkiReceipt(lines);
        const raud = products.find((p) => /RAUDONOS/i.test(p.name))!;
        expect(raud).toBeTruthy();
        const r = raud.region;
        // reconstruct every word of the product and assert the parallelogram band
        // (slope from its corners) contains each word's top-left and bottom-right.
        const allWords = lines.slice(1, 4).flatMap((l) => l.words!);
        const w = r.xRight - r.xLeft;
        const sT = (r.yRightTop! - r.yLeftTop!) / w;
        const sB = (r.yRightBottom! - r.yLeftBottom!) / w;
        const topAt = (x: number) => r.yLeftTop! + sT * (x - r.xLeft);
        const botAt = (x: number) => r.yLeftBottom! + sB * (x - r.xLeft);
        for (const wd of allWords) {
            expect(wd.xLeft).toBeGreaterThanOrEqual(r.xLeft - 0.01);
            expect(wd.xRight).toBeLessThanOrEqual(r.xRight + 0.01);
            expect(topAt(wd.xLeft)).toBeLessThanOrEqual(wd.yTop + 0.5);    // top edge above the word
            expect(botAt(wd.xRight)).toBeGreaterThanOrEqual(wd.yBottom - 0.5); // bottom edge below it
        }
    });

    test('receipt-51: a name fused on a prior discount line ("-0,72 A RAUDONOSIOS") is recovered onto its nameless product', () => {
        // The salmon-style block ending in a weighed product whose NAME the column
        // clustering drops. The name lives on the PRIOR discount line; recover it.
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('LIETUVISKI POMIDORAI', 100, [word('LIETUVISKI', 50, 250, 100), word('POMIDORAI', 260, 430, 100)]),
            wl('0,720 kg X 3,99 EUR/ kg 2,87 A', 140, [word('0,720', 50, 130, 140), word('kg', 140, 175, 140), word('X', 180, 200, 140), word('3,99', 210, 300, 140), word('EUR/', 310, 390, 140), word('kg', 400, 435, 140), word('2,87', 600, 700, 140), word('A', 710, 730, 140)]),
            // discount line with the NEXT product's name fused after the amount
            wl('-0,72 A RAUDONOSIOS PAPRIKOS', 180, [word('-0,72', 600, 700, 180), word('A', 710, 730, 180), word('RAUDONOSIOS', 50, 280, 180), word('PAPRIKOS', 290, 430, 180)]),
            wl('0,470 kg X 3,4 EUR/ kg 1,64 A', 220, [word('0,470', 50, 130, 220), word('kg', 140, 175, 220), word('X', 180, 200, 220), word('3,4', 210, 270, 220), word('EUR/', 300, 380, 220), word('kg', 390, 425, 220), word('1,64', 600, 700, 220), word('A', 710, 730, 220)]),
            wl('Prekiautojo ID 15027037', 300, [word('Prekiautojo', 0, 150, 300), word('ID', 155, 200, 300)]),
        ];
        const { products } = parseIkiReceipt(lines);
        // POMIDORAI keeps its discount; the second weighed product is named RAUDONOSIOS,
        // not "?", even if the per-word clustering dropped the fused name.
        expect(products.some((p) => /RAUDONOS/i.test(p.name))).toBe(true);
        const raud = products.find((p) => /RAUDONOS/i.test(p.name))!;
        expect(raud.price).toBeCloseTo(3.4, 2);
    });

    test('receipt-53: two fused-name weighed products in a row recover the RIGHT names (no swap)', () => {
        // POMIDORAI(name) … "-0,72 A RAUDONOSIOS" … RAUDONOSIOS(weighed) …
        // "-0,23 A Fasuoti" … Fasuoti(weighed). If both names are dropped, recovery
        // must give RAUDONOSIOS to the FIRST weighed product and Fasuoti to the next.
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('LIETUVISKI POMIDORAI', 100, [word('LIETUVISKI', 50, 250, 100), word('POMIDORAI', 260, 430, 100)]),
            wl('0,720 kg X 3,99 EUR/ kg 2,87 A', 140, [word('0,720', 50, 130, 140), word('kg', 140, 175, 140), word('X', 180, 200, 140), word('3,99', 210, 300, 140), word('EUR/', 310, 390, 140), word('kg', 400, 435, 140), word('2,87', 600, 700, 140), word('A', 710, 730, 140)]),
            wl('-0,72 A RAUDONOSIOS PAPRIKOS', 180, [word('-0,72', 600, 700, 180), word('A', 710, 730, 180), word('RAUDONOSIOS', 50, 280, 180), word('PAPRIKOS', 290, 430, 180)]),
            wl('0,470 kg X 3,4 EUR/ kg 1,64 A', 220, [word('0,470', 50, 130, 220), word('kg', 140, 175, 220), word('X', 180, 200, 220), word('3,4', 210, 270, 220), word('EUR/', 300, 380, 220), word('kg', 390, 425, 220), word('1,64', 600, 700, 220), word('A', 710, 730, 220)]),
            wl('-0,23 A Fasuoti obuoliai IKI UKIS', 260, [word('-0,23', 600, 700, 260), word('A', 710, 730, 260), word('Fasuoti', 50, 200, 260), word('obuoliai', 210, 360, 260), word('IKI', 370, 420, 260), word('UKIS', 430, 510, 260)]),
            wl('2,090 kg X 1,85 EUR/ kg 3,87 A', 300, [word('2,090', 50, 130, 300), word('kg', 140, 175, 300), word('X', 180, 200, 300), word('1,85', 210, 300, 300), word('EUR/', 310, 390, 300), word('kg', 400, 435, 300), word('3,87', 600, 700, 300), word('A', 710, 730, 300)]),
            wl('Prekiautojo ID 15027037', 360, [word('Prekiautojo', 0, 150, 360), word('ID', 155, 200, 360)]),
        ];
        const { products } = parseIkiReceipt(lines);
        const raud = products.find((p) => /RAUDONOS/i.test(p.name));
        const fas = products.find((p) => /Fasuoti/i.test(p.name));
        expect(raud).toBeTruthy();
        expect(fas).toBeTruthy();
        // names land on the CORRECT data: RAUDONOSIOS=3,4 €/kg, Fasuoti=1,85 €/kg
        expect(raud!.price).toBeCloseTo(3.4, 2);
        expect(fas!.price).toBeCloseTo(1.85, 2);
        // band ≡ content: the RECOVERED name's band reaches the name's LEFT x (50),
        // not just the right-side price column — recognition and band don't diverge.
        expect(raud!.region.xLeft).toBeLessThan(120);
        expect(fas!.region.xLeft).toBeLessThan(120);
    });

    test('receipt-54: a recovered name extends the band to the name (not just the price column)', () => {
        // ZEMAITIJOS's name is fused on the prior discount line; its own row is only
        // the price "1,99 A" (far right). After recovery the band must cover the
        // NAME on the left, not sit as a tiny box over the price.
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('NAMINIS 2,5%', 100, [word('NAMINIS', 50, 200, 100), word('2,5%', 210, 300, 100)]),
            wl('1,49 A', 100, [word('1,49', 600, 700, 100), word('A', 710, 730, 100)]),
            wl('-0,30 A ZEMAITIJOS TEPAM SURELI', 140, [word('-0,30', 600, 700, 140), word('A', 710, 730, 140), word('ZEMAITIJOS', 50, 250, 140), word('TEPAM', 260, 400, 140), word('SURELI', 410, 520, 140)]),
            wl('1,99 A', 175, [word('1,99', 600, 700, 175), word('A', 710, 730, 175)]),
            wl('Prekiautojo ID 15027037', 240, [word('Prekiautojo', 0, 150, 240), word('ID', 155, 200, 240)]),
        ];
        const { products } = parseIkiReceipt(lines);
        const zem = products.find((p) => /ZEMAIT/i.test(p.name))!;
        expect(zem).toBeTruthy();
        expect(zem.price).toBeCloseTo(1.99, 2);
        // the band starts at the name's left edge (~50), NOT at the price column (~600)
        expect(zem.region.xLeft).toBeLessThan(120);
        expect(zem.region.xRight).toBeGreaterThan(700);   // still reaches the price on the right
    });

    test('receipt-60: with the value words dropped, the Kvito band covers the LINE FRAME (so it contains the value), not full receipt width', () => {
        // The "Kvito Nr. 168/645/104148 Kasa 0027" line: MLKit kept only a stray
        // "26, 52" cluster as words but the LINE frame (x71–874) still spans where the
        // receipt-no is. The band covers that frame (contains the value), without
        // stretching to the full receipt width.
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('SKANĖJA 3,29 A', 100, [word('SKANĖJA', 50, 250, 100), word('3,29', 600, 700, 100), word('A', 710, 730, 100)]),
            wl('Prekiautojo ID 15027037', 160, [word('Prekiautojo', 0, 150, 160), word('ID', 155, 200, 160)]),
            wl('SUMA 26,52 EUR', 220, [word('SUMA', 50, 130, 220), word('26,52', 200, 320, 220), word('EUR', 330, 400, 220)]),
            // the scrambled receipt-no line: MLKit's line bbox spans the full width
            // (x71-874) but only a stray "26,"/"52" (physically on the right) survived
            // as words. Built explicitly because the wl() helper derives the bbox from
            // the words, which would hide exactly the case under test.
            {
                text: '26, 52 Kvito Nr. 168/645/104148 Kasa 0027',
                xLeft: 71, xRight: 874, yTop: 300, yBottom: 391,
                yLeftTop: 300, yRightTop: 300, yLeftBottom: 391, yRightBottom: 391,
                words: [word('26,', 778, 824, 300), word('52', 836, 874, 300)],
            },
        ];
        const { footer } = parseIkiReceipt(lines);
        const rn = footer.lineRegions!.find((r) => r.kind === 'receiptNo')!;
        expect(rn).toBeTruthy();
        // covers the line frame (x71–874) — contains where "168/645/104148" is, but
        // NOT full receipt width
        expect(rn.xLeft).toBeLessThan(120);
        expect(rn.xRight).toBeGreaterThan(800);
        expect(rn.xRight).toBeLessThan(900);
    });

    test('receipt-61: a total whose amount words dropped covers the line frame (contains the amount); date is hugged when present', () => {
        const lineFull = (text: string, words: ReturnType<typeof word>[], xL: number, xR: number, yT: number): IkiLine => ({
            text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yT + 36,
            yLeftTop: yT, yRightTop: yT, yLeftBottom: yT + 36, yRightBottom: yT + 36, words,
        });
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('SKANĖJA 3,29 A', 100, [word('SKANĖJA', 50, 250, 100), word('3,29', 600, 700, 100), word('A', 710, 730, 100)]),
            wl('Prekiautojo ID 15027037', 160, [word('Prekiautojo', 0, 150, 160), word('ID', 155, 200, 160)]),
            // date+time on ONE line; MLKit kept only the date words (Laikas/time dropped)
            lineFull('Data 2026-06-11 Laikas 21:07:53', [word('Data', 60, 137, 220), word('2026-06-11', 159, 348, 220)], 60, 886, 220),
            // SUMA total: only the "SUMA" keyword survived as a word
            lineFull('SUMA 26, 52 EUR', [word('SUMA', 63, 137, 300)], 63, 881, 300),
        ];
        const { footer } = parseIkiReceipt(lines);
        const total = footer.lineRegions!.find((r) => r.kind === 'total')!;
        expect(total).toBeTruthy();
        // amount "26,52" words dropped (only "SUMA" survived) → band covers the line
        // frame (x63–881) so it CONTAINS the amount, not just the "SUMA" keyword
        expect(total.xRight).toBeGreaterThan(800);
        const dt = footer.lineRegions!.find((r) => r.kind === 'dateTime')!;
        expect(dt).toBeTruthy();
        // the date word "2026-06-11" survived → hugged tight (≤ x348)
        expect(dt.xRight).toBeLessThan(400);
    });

    test('receipt-60: product bands NEVER overlap on a tilted receipt (seam clamp)', () => {
        const tilt = (x: number) => Math.round(0.045 * x);
        const tw = (t: string, xL: number, xR: number, b: number) => ({ text: t, xLeft: xL, xRight: xR, yTop: b + tilt(xL), yBottom: b + 24 + tilt(xR) });
        const twl = (t: string, b: number, ws: ReturnType<typeof tw>[]): IkiLine => ({
            text: t, yTop: Math.min(...ws.map((w) => w.yTop)), yBottom: Math.max(...ws.map((w) => w.yBottom)),
            xLeft: Math.min(...ws.map((w) => w.xLeft)), xRight: Math.max(...ws.map((w) => w.xRight)),
            yLeftTop: ws[0].yTop, yRightTop: ws[ws.length - 1].yTop, yLeftBottom: ws[0].yBottom, yRightBottom: ws[ws.length - 1].yBottom, words: ws,
        });
        const lines: IkiLine[] = [
            twl('PVM mokėtojo kodas LT101937219', 0, [tw('PVM', 0, 60, 0), tw('kodas', 205, 300, 0), tw('LT101937219', 310, 500, 0)]),
            // tightly-spaced one-line products: the tilt makes their word boxes overlap in Y
            twl('SKANE 3,29 A', 100, [tw('SKANE', 50, 250, 100), tw('3,29', 600, 700, 100), tw('A', 710, 730, 100)]),
            twl('PIENAS 1,49 A', 128, [tw('PIENAS', 50, 250, 128), tw('1,49', 600, 700, 128), tw('A', 710, 730, 128)]),
            twl('SVIESTAS 2,99 A', 156, [tw('SVIESTAS', 50, 250, 156), tw('2,99', 600, 700, 156), tw('A', 710, 730, 156)]),
            twl('Prekiautojo ID 1', 230, [tw('Prekiautojo', 0, 150, 230), tw('ID', 155, 200, 230)]),
        ];
        const { products } = parseIkiReceipt(lines);
        expect(products).toHaveLength(3);
        const s = products.sort((a, b) => a.region.yTop - b.region.yTop);
        for (let i = 1; i < s.length; i++) {
            // per-corner: this band's TOP edge is at/below the previous band's BOTTOM
            // edge — the parallelograms share a seam and never overlap.
            expect(s[i].region.yLeftTop!).toBeGreaterThanOrEqual(s[i - 1].region.yLeftBottom! - 0.5);
            expect(s[i].region.yRightTop!).toBeGreaterThanOrEqual(s[i - 1].region.yRightBottom! - 0.5);
        }
    });

    test('receipt-60: a trailing points line ("-0,05 A", skip word lost) does NOT attach to the last product', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('Fasuoti obuoliai IKI UKIS', 100, [word('Fasuoti', 50, 180, 100), word('obuoliai', 190, 340, 100), word('IKI', 350, 410, 100), word('UKIS', 420, 510, 100)]),
            wl('2,090 kg X 1,85 EUR/ kg 3,87 A', 140, [word('2,090', 50, 130, 140), word('kg', 140, 175, 140), word('X', 180, 200, 140), word('1,85', 210, 300, 140), word('EUR/', 310, 390, 140), word('kg', 400, 435, 140), word('3,87', 600, 700, 140), word('A', 710, 730, 140)]),
            wl('*KUPONAS', 180, [word('*KUPONAS', 50, 200, 180)]),
            wl('0,00 A', 180, [word('0,00', 600, 700, 180), word('A', 710, 730, 180)]),
            wl('MAISELIS PLASTIKINIS LENG', 220, [word('MAISELIS', 50, 220, 220), word('PLASTIKINIS', 230, 440, 220), word('LENG', 450, 530, 220)]),
            wl('0,01 A', 220, [word('0,01', 600, 700, 220), word('A', 710, 730, 220)]),
            // points line: MLKit lost the "IKI Taškais" skip word — only the amount survives
            wl('-0,05 A', 260, [word('-0,05', 600, 700, 260), word('A', 710, 730, 260)]),
            wl('Prekiautojo ID 15027037', 320, [word('Prekiautojo', 0, 150, 320), word('ID', 155, 200, 320)]),
        ];
        const { products } = parseIkiReceipt(lines);
        const fas = products.find((p) => /Fasuoti/i.test(p.name))!;
        expect(fas).toBeTruthy();
        expect(fas.price).toBeCloseTo(1.85, 2);
        expect(fas.promoPrice).toBeNull();   // the -0,05 points line must NOT become a discount
    });

    test('receipt-58: a weight row with a stray colon ("3,4: EUR/kg") still extracts €/kg → weighed item', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('RAUDONOSIOS PAPRIKOS', 100, [word('RAUDONOSIOS', 50, 280, 100), word('PAPRIKOS', 290, 430, 100)]),
            wl('0,470 kg X 3,4: EUR/ kg 1,64 A', 140, [word('0,470', 50, 130, 140), word('kg', 140, 175, 140), word('X', 180, 200, 140), word('3,4:', 210, 280, 140), word('EUR/', 300, 380, 140), word('kg', 390, 425, 140), word('1,64', 600, 700, 140), word('A', 710, 730, 140)]),
            wl('Prekiautojo ID 15027037', 220, [word('Prekiautojo', 0, 150, 220), word('ID', 155, 200, 220)]),
        ];
        const { products } = parseIkiReceipt(lines);
        const raud = products.find((p) => /RAUDONOS/i.test(p.name))!;
        expect(raud).toBeTruthy();
        expect(raud.unit).toBe('kg');               // recognised as weighed, not a unit item
        expect(raud.price).toBeCloseTo(3.4, 2);      // €/kg parsed despite the stray ":"
        expect(raud.quantity).toBeCloseTo(0.482, 2); // 1,64 / 3,4
    });

    test('receipt-57: a space-split / accent-garbled discount label ("NUỚL AT DA ŠU") is not a phantom', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('ATLANTINĖS LAŠIŠOS', 100, [word('ATLANTINĖS', 50, 250, 100), word('LAŠIŠOS', 260, 400, 100)]),
            wl('1,068 kg X 16,99 EUR/ kg 18,15 A', 140, [word('1,068', 50, 130, 140), word('kg', 140, 175, 140), word('X', 180, 200, 140), word('16,99', 210, 300, 140), word('EUR/', 310, 390, 140), word('kg', 400, 435, 140), word('18,15', 600, 700, 140), word('A', 710, 730, 140)]),
            // salmon discount label: leading N + the O garbled to a horned "Ớ", and split by spaces
            wl('NUỚL AT DA ŠU', 180, [word('NUỚL', 50, 150, 180), word('AT', 160, 200, 180), word('DA', 210, 250, 180), word('ŠU', 260, 300, 180)]),
            wl('-7,48 A NAMINIS 2,5%', 220, [word('-7,48', 600, 700, 220), word('A', 710, 730, 220), word('NAMINIS', 50, 200, 220), word('2,5%', 210, 300, 220)]),
            wl('1,49 A', 260, [word('1,49', 600, 700, 260), word('A', 710, 730, 260)]),
            wl('Prekiautojo ID 15027037', 320, [word('Prekiautojo', 0, 150, 320), word('ID', 155, 200, 320)]),
        ];
        const { products } = parseIkiReceipt(lines);
        // "NUỚL AT DA ŠU" must NOT be a product, and must not steal NAMINIS's 1,49
        expect(products.some((p) => /NU.?.?L|UOLAID|AT DA/i.test(p.name))).toBe(false);
        const salmon = products.find((p) => /ATLANT|LAŠIŠ/i.test(p.name))!;
        expect(salmon).toBeTruthy();
        expect(salmon.quantity).toBeCloseTo(1.068, 2);
        expect(salmon.promoPrice!).toBeCloseTo(9.99, 1);
        expect(products.find((p) => /NAMINIS/i.test(p.name))!.price).toBeCloseTo(1.49, 2);
    });

    test('receipt-55: a discount label with a DROPPED leading N ("UOLAIDA ŠU") is not a phantom product', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('ATLANTINĖS LAŠIŠOS', 100, [word('ATLANTINĖS', 50, 250, 100), word('LAŠIŠOS', 260, 400, 100)]),
            wl('1,068 kg X 16,99 EUR/ kg 18,15 A', 140, [word('1,068', 50, 130, 140), word('kg', 140, 175, 140), word('X', 180, 200, 140), word('16,99', 210, 300, 140), word('EUR/', 310, 390, 140), word('kg', 400, 435, 140), word('18,15', 600, 700, 140), word('A', 710, 730, 140)]),
            // salmon's discount LABEL with the leading N eaten by OCR
            wl('UOLAIDA ŠU !S', 180, [word('UOLAIDA', 50, 200, 180), word('ŠU', 210, 250, 180), word('!S', 260, 300, 180)]),
            wl('-7,48 A NAMINIS 2,5%', 220, [word('-7,48', 600, 700, 220), word('A', 710, 730, 220), word('NAMINIS', 50, 200, 220), word('2,5%', 210, 300, 220)]),
            wl('1,49 A', 260, [word('1,49', 600, 700, 260), word('A', 710, 730, 260)]),
            wl('Prekiautojo ID 15027037', 320, [word('Prekiautojo', 0, 150, 320), word('ID', 155, 200, 320)]),
        ];
        const { products } = parseIkiReceipt(lines);
        // "UOLAIDA ŠU" must NOT be a product; salmon keeps its discount, NAMINIS is real
        expect(products.some((p) => /UOLAID|NUOL/i.test(p.name))).toBe(false);
        const salmon = products.find((p) => /ATLANT|LAŠIŠ/i.test(p.name))!;
        expect(salmon).toBeTruthy();
        expect(salmon.quantity).toBeCloseTo(1.068, 2);     // 18,15 total kept
        expect(salmon.promoPrice!).toBeCloseTo(9.99, 1);   // (18,15−7,48)/1,068 — discount attached
        expect(products.find((p) => /NAMINIS/i.test(p.name))!.price).toBeCloseTo(1.49, 2);
    });

    test('receipt-53: a garbled "NUQLAIDA SU KOR.LE" label does not fuse into the next product name', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('NAMINIS 2,5%', 100, [word('NAMINIS', 50, 200, 100), word('2,5%', 210, 300, 100)]),
            wl('1,49 A', 100, [word('1,49', 600, 700, 100), word('A', 710, 730, 100)]),
            wl('NUQLAIDA SU KOR.LE', 140, [word('NUQLAIDA', 50, 220, 140), word('SU', 230, 270, 140), word('KOR.LE', 280, 400, 140)]),
            wl('ŽEMAITIJOS TEPAM', 180, [word('ŽEMAITIJOS', 50, 250, 180), word('TEPAM', 260, 400, 180)]),
            wl('1,99 A', 180, [word('1,99', 600, 700, 180), word('A', 710, 730, 180)]),
            wl('Prekiautojo ID 15027037', 240, [word('Prekiautojo', 0, 150, 240), word('ID', 155, 200, 240)]),
        ];
        const { products } = parseIkiReceipt(lines);
        expect(products.some((p) => /NUQL|NUOL|KOR\.LE/i.test(p.name))).toBe(false);
        const zem = products.find((p) => /ŽEMAIT|ZEMAIT/i.test(p.name));
        expect(zem).toBeTruthy();
        expect(zem!.price).toBeCloseTo(1.99, 2);
    });

    test('receipt-50: a price MLKit grouped onto a label line is NOT lost by the column split', () => {
        // Root cause of the receipt-50 6-product blob: "UOLAIDA ŠU  18,15" is ONE MLKit
        // line (label left + total right). The column engine split it by x; on a tilted
        // receipt the Y re-pair failed and 18,15 was dropped → no total → no boundary.
        // Now the amount re-attaches by SHARED SOURCE LINE, so the total survives and the
        // products split.
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('ATLANTINĖS LAŠIŠOS', 100, [word('ATLANTINĖS', 50, 250, 100), word('LAŠIŠOS', 260, 400, 100)]),
            wl('1,068 kg X 16,99 EUR/ kg', 140, [word('1,068', 50, 130, 140), word('kg', 140, 175, 140), word('X', 180, 200, 140), word('16,99', 210, 300, 140), word('EUR/', 310, 390, 140), word('kg', 400, 435, 140)]),
            // ONE MLKit line: label far left, the 18,15 total far right (tilt would break a Y re-pair)
            wl('NUOLAIDA ŠU 18, 15', 180, [word('NUOLAIDA', 50, 180, 180), word('ŠU', 190, 230, 180), word('18,15', 600, 700, 180)]),
            // NAMINIS as its own product
            wl('NAMINIS 2,5%', 220, [word('NAMINIS', 50, 200, 220), word('2,5%', 210, 300, 220)]),
            wl('NUOLAIDA SU KOF 1, 49', 260, [word('NUOLAIDA', 50, 180, 260), word('SU', 190, 230, 260), word('KOF', 240, 300, 260), word('1,49', 600, 700, 260)]),
            wl('Prekiautojo ID 15027037', 320, [word('Prekiautojo', 0, 150, 320), word('ID', 155, 200, 320)]),
        ];
        const { products } = parseIkiReceipt(lines);
        // salmon keeps its 18,15 total (NOT dropped) → it is its own product, NAMINIS separate
        const salmon = products.find((p) => /ATLANT|LAŠIŠ/i.test(p.name))!;
        expect(salmon).toBeTruthy();
        expect(salmon.quantity).toBeCloseTo(1.068, 2);   // 18,15 / 16,99 — total survived
        // and it did NOT absorb NAMINIS into one blob
        const naminis = products.find((p) => /NAMINIS/i.test(p.name))!;
        expect(naminis).toBeTruthy();
        expect(naminis).not.toBe(salmon);
        // no giant blob: salmon's name does not contain the next products' names
        expect(/NAMINIS/i.test(salmon.name)).toBe(false);
    });

    test('receipt-49: a garbled "NUCLAĪDA SU KOF:É" discount label is NOT a phantom product', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('NAMINIS 2,5%', 100, [word('NAMINIS', 50, 200, 100), word('2,5%', 210, 300, 100)]),
            wl('1,49 A', 100, [word('1,49', 600, 700, 100), word('A', 710, 730, 100)]),
            // garbled "NUOLAIDA SU KORTELĖ" — O→C, ortelė→KOF:É. Must read as a discount LABEL.
            wl('NUCLAĪDA SU KOF:É', 140, [word('NUCLAĪDA', 50, 220, 140), word('SU', 230, 270, 140), word('KOF:É', 280, 380, 140)]),
            wl('-0,30 A', 140, [word('-0,30', 600, 700, 140), word('A', 710, 730, 140)]),
            wl('ŽEMAITIJOS TEPAM', 180, [word('ŽEMAITIJOS', 50, 250, 180), word('TEPAM', 260, 400, 180)]),
            wl('1,99 A', 180, [word('1,99', 600, 700, 180), word('A', 710, 730, 180)]),
            wl('Prekiautojo ID 15027037', 240, [word('Prekiautojo', 0, 150, 240), word('ID', 155, 200, 240)]),
        ];
        const { products } = parseIkiReceipt(lines);
        // no product whose name is the garbled NUOLAIDA/KORTELĖ label
        expect(products.some((p) => /NUCL|NUOL|KOF|KORTEL/i.test(p.name))).toBe(false);
        const naminis = products.find((p) => /NAMINIS/i.test(p.name))!;
        expect(naminis).toBeTruthy();
        expect(naminis.price).toBeCloseTo(1.49, 2);
        expect(naminis.promoPrice!).toBeCloseTo(1.19, 1); // discount −0,30 attached, not a phantom
    });

    test('receipt-49: a weighed product with NO total (OCR dropped it) does not absorb the next product', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            // POMIDORAI: name + weight, but OCR dropped its "2,87 A" total and "-0,72 A"
            wl('LIETUVISKI POMIDORAI', 100, [word('LIETUVISKI', 50, 250, 100), word('POMIDORAI', 260, 430, 100)]),
            wl('0,720 kg X 3,99 EUR/ kg', 140, [word('0,720', 50, 130, 140), word('kg', 140, 175, 140), word('X', 180, 200, 140), word('3,99', 210, 300, 140), word('EUR/', 310, 390, 140), word('kg', 400, 435, 140)]),
            wl('NUOLAIDA', 180, [word('NUOLAIDA', 50, 200, 180)]),
            // RAUDONOSIOS: its own weighed product, total present
            wl('RAUDONOSIOS PAPRIKOS', 220, [word('RAUDONOSIOS', 50, 280, 220), word('PAPRIKOS', 290, 430, 220)]),
            wl('0,470 kg X 3,4 EUR/ kg 1,64 A', 260, [word('0,470', 50, 130, 260), word('kg', 140, 175, 260), word('X', 180, 200, 260), word('3,4', 210, 270, 260), word('EUR/', 300, 380, 260), word('kg', 390, 425, 260), word('1,64', 600, 700, 260), word('A', 710, 730, 260)]),
            wl('Prekiautojo ID 15027037', 320, [word('Prekiautojo', 0, 150, 320), word('ID', 155, 200, 320)]),
        ];
        const { products } = parseIkiReceipt(lines);
        const pom = products.find((p) => /POMIDOR/i.test(p.name))!;
        const raud = products.find((p) => /RAUDONOS/i.test(p.name))!;
        // two SEPARATE products — POMIDORAI did not swallow RAUDONOSIOS
        expect(pom).toBeTruthy();
        expect(raud).toBeTruthy();
        expect(pom).not.toBe(raud);
        expect(/RAUDONOS/i.test(pom.name)).toBe(false);   // name not merged
        expect(raud.price).toBeCloseTo(3.4, 2);            // RAUDONOSIOS keeps its own €/kg
    });

    test('receipt-62: a name on the prior discount line (name words dropped) is COVERED by its band, not cut', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('LIETUVISKI POMIDORAI', 100, [word('LIETUVISKI', 50, 250, 100), word('POMIDORAI', 260, 430, 100)]),
            wl('0,720 kg X 3,99 EUR/ kg 2,87 A', 140, [word('0,720', 50, 130, 140), word('kg', 140, 175, 140), word('X', 180, 200, 140), word('3,99', 210, 300, 140), word('EUR/', 310, 390, 140), word('kg', 400, 435, 140), word('2,87', 600, 700, 140), word('A', 710, 730, 140)]),
            wl('NUOLAIDA', 180, [word('NUOLAIDA', 50, 200, 180)]),
            // POMIDORAI discount + RAUDONOSIOS name fused; MLKit kept ONLY the amount WORDS,
            // but its LINE frame still spans the full row (xLeft 50) — so the recovered name
            // is synthesised on the LEFT, where it physically sits, not over the amount.
            {
                text: '-0,72 A RAUDONOSIOS PAPRIKOS', yTop: 220, yBottom: 244,
                xLeft: 50, xRight: 730, yLeftTop: 220, yRightTop: 220, yLeftBottom: 244, yRightBottom: 244,
                words: [word('-0,72', 600, 700, 220), word('A', 710, 730, 220)],
            },
            wl('0,470 kg X 3,4 EUR/ kg 1,64 A', 260, [word('0,470', 50, 130, 260), word('kg', 140, 175, 260), word('X', 180, 200, 260), word('3,4', 210, 270, 260), word('EUR/', 300, 380, 260), word('kg', 390, 425, 260), word('1,64', 600, 700, 260), word('A', 710, 730, 260)]),
            wl('Prekiautojo ID 15027037', 320, [word('Prekiautojo', 0, 150, 320), word('ID', 155, 200, 320)]),
        ];
        const { products } = parseIkiReceipt(lines);
        const pom = products.find((p) => /POMIDOR/i.test(p.name))!;
        const raud = products.find((p) => /RAUDONOS/i.test(p.name))!;
        expect(pom).toBeTruthy();
        expect(raud).toBeTruthy();
        // RAUDONOSIOS's band reaches UP to its name line (~y220), so the name (left) is inside it
        expect(raud.region.yTop).toBeLessThanOrEqual(225);
        // VALUE: POMIDORAI's -0,72 discount still applies → promo = (2,87 − 0,72) / 0,719 ≈ 2,99
        expect(pom.promoPrice).toBeCloseTo(2.99, 1);
        // GEOMETRY: POMIDORAI's band is a parallelogram (seam tilt == top tilt → never twists)
        const topTilt = pom.region.yRightTop! - pom.region.yLeftTop!;
        const seamTilt = pom.region.yRightBottom! - pom.region.yLeftBottom!;
        expect(seamTilt).toBeCloseTo(topTilt, 5);
        // and the seam is gapless on BOTH corners
        expect(pom.region.yLeftBottom).toBeCloseTo(raud.region.yLeftTop!, 5);
        expect(pom.region.yRightBottom).toBeCloseTo(raud.region.yRightTop!, 5);
    });

    test('receipt-63: a discount label with O→D OCR rot ("NUDLAIDA") binds to its product, not the next name', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 332, [word('PVM', 199, 254, 332), word('kodas', 452, 547, 332), word('LT101937219', 569, 781, 332)]),
            wl('NAMINIS 2, 5% i', 559, [word('NAMINIS', 82, 214, 559), word('2,', 236, 262, 559), word('5%', 275, 311, 559), word('i', 333, 337, 559)]),
            wl('1, 49 A', 558, [word('1,', 786, 806, 558), word('49', 819, 857, 558), word('A', 878, 895, 558)]),
            // NAMINIS's "NUOLAIDA SU KORTELE" discount, OCR'd O→D as "NUDLAIDA"; MLKit dropped the -0,30 amount words
            wl('NUDLAIDA SU KOk. 1E -0,30 A', 593, [word('NUDLAIDA', 82, 233, 593), word('SU', 255, 291, 593), word('KOk.', 313, 394, 593), word('1E', 411, 446, 593)]),
            wl('ZEMAITIJOS TEPAM, SUHELI', 628, [word('ZEMAITIJOS', 81, 270, 628), word('TEPAM,', 293, 406, 628), word('SUHELI', 448, 556, 628)]),
            wl('1,99 A', 635, [word('1,99', 784, 857, 635), word('A', 877, 895, 635)]),
            wl('Prekiautojo ID 15027037', 700, [word('Prekiautojo', 78, 288, 700), word('ID', 312, 345, 700)]),
        ];
        const { products } = parseIkiReceipt(lines);
        // no phantom product made out of the garbled discount label
        expect(products.some((p) => /NUDLAIDA|NUOLAIDA|KOk/i.test(p.name))).toBe(false);
        // ZEMAITIJOS's name is clean — the discount label did NOT fuse into it
        const zem = products.find((p) => /ZEMAIT/i.test(p.name));
        expect(zem).toBeTruthy();
        expect(zem!.name).not.toMatch(/NUDLAIDA|NUOLAIDA|KOk/i);
    });

    test('receipt-65: non-Lithuanian diacritics in a name are folded to base letters; Lithuanian ones kept', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            // "ÜKIS" (Ü is NOT Lithuanian) must become "UKIS"; "Žemaitijos sūrelį" keeps Ž/ū/į
            wl('Fasuoti obuoliai IKI ÜKIS', 100, [word('Fasuoti', 50, 150, 100), word('obuoliai', 160, 280, 100), word('IKI', 290, 340, 100), word('ÜKIS', 350, 430, 100)]),
            wl('3, 87 A', 100, [word('3,87', 600, 700, 100), word('A', 710, 730, 100)]),
            wl('Žemaitijos sūrelį', 150, [word('Žemaitijos', 50, 230, 150), word('sūrelį', 240, 360, 150)]),
            wl('1, 99 A', 150, [word('1,99', 600, 700, 150), word('A', 710, 730, 150)]),
            wl('Prekiautojo ID 15027037', 220, [word('Prekiautojo', 0, 150, 220), word('ID', 155, 200, 220)]),
        ];
        const { products } = parseIkiReceipt(lines);
        const fas = products.find((p) => /Fasuoti/i.test(p.name))!;
        expect(fas.name).toContain('UKIS');
        expect(fas.name).not.toMatch(/Ü/);
        const zem = products.find((p) => /emaitijos/i.test(p.name))!;
        expect(zem.name).toMatch(/Žemaitijos sūrelį/);   // Lithuanian Ž, ū, į preserved
    });

    test('receipt-65: a weight line whose × was OCR-read as "Y" is a WEIGHT row, not fused into the name', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl("AT' INES LASISOS BE GAL", 100, [word("AT'", 50, 90, 100), word('INES', 100, 180, 100), word('LASISOS', 190, 320, 100), word('BE', 330, 370, 100), word('GAL', 380, 440, 100)]),
            // OCR read "X" as "Y" in the weight separator
            wl('1, 068 kg Y 16, 99 EUR/ kg', 140, [word('1,068', 50, 150, 140), word('kg', 160, 195, 140), word('Y', 205, 225, 140), word('16,99', 235, 340, 140), word('EUR/', 350, 430, 140), word('kg', 440, 475, 140)]),
            wl('18, 15 A', 140, [word('18,15', 600, 700, 140), word('A', 710, 730, 140)]),
            wl('NAMINIS 2,5%', 200, [word('NAMINIS', 50, 200, 200), word('2,5%', 210, 290, 200)]),
            wl('1, 49 A', 200, [word('1,49', 600, 700, 200), word('A', 710, 730, 200)]),
            wl('Prekiautojo ID 15027037', 280, [word('Prekiautojo', 0, 150, 280), word('ID', 155, 200, 280)]),
        ];
        const { products } = parseIkiReceipt(lines);
        const salmon = products.find((p) => /LASISOS/i.test(p.name))!;
        expect(salmon).toBeTruthy();
        // the weight line did NOT leak into the name
        expect(salmon.name).not.toMatch(/kg|EUR/i);
        expect(salmon.name.trim()).toBe("AT' INES LASISOS BE GAL");
        // and it parsed as a weighed item (€/kg recognised)
        expect(salmon.unit).toBe('kg');
        expect(salmon.pricePerUnit).toBeCloseTo(16.99, 2);
    });

    test('receipt-66: a fused discount+name line — discount VALUE recovered AND a single untwisted, gapless seam', () => {
        // salmon's discount AMOUNT (-7,48, right) and NAMINIS's NAME (left) print on ONE
        // line; MLKit kept only the amount words but the LINE frame spans the full row.
        // VALUE recovery (parsing) and band geometry (seam) are INDEPENDENT — both must
        // work: the discount still applies, and the band stays a consistent parallelogram.
        const fusedLine: IkiLine = {
            text: '-7,48 A NAMINIS', yTop: 180, yBottom: 204,
            xLeft: 50, xRight: 730, yLeftTop: 180, yRightTop: 180, yLeftBottom: 204, yRightBottom: 204,
            words: [word('-7,48', 600, 700, 180), word('A', 710, 730, 180)],
        };
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('ATLANTINĖS LAŠIŠOS', 100, [word('ATLANTINĖS', 50, 250, 100), word('LAŠIŠOS', 260, 430, 100)]),
            wl('1,068 kg X 16,99 EUR/ kg 18,15 A', 140, [word('1,068', 50, 130, 140), word('kg', 140, 175, 140), word('X', 180, 200, 140), word('16,99', 210, 300, 140), word('EUR/', 310, 390, 140), word('kg', 400, 435, 140), word('18,15', 600, 700, 140), word('A', 710, 730, 140)]),
            fusedLine,
            wl('1, 49 A', 220, [word('1,49', 600, 700, 220), word('A', 710, 730, 220)]),
            wl('Prekiautojo ID 15027037', 300, [word('Prekiautojo', 0, 150, 300), word('ID', 155, 200, 300)]),
        ];
        const { products } = parseIkiReceipt(lines);
        const salmon = products.find((p) => /LAŠIŠ/i.test(p.name))!;
        const naminis = products.find((p) => /NAMINIS/i.test(p.name))!;
        expect(salmon).toBeTruthy();
        expect(naminis).toBeTruthy();
        // VALUE: the -7,48 discount still applies → promo = (18,15 − 7,48) / 1,068 ≈ 9,99 €/kg
        expect(salmon.promoPrice).toBeCloseTo(9.99, 1);
        // NAMINIS's recovered name (left, ~y180) is covered by its band, not cut
        expect(naminis.region.yLeftTop!).toBeLessThanOrEqual(185);
        // GEOMETRY: salmon's band is a parallelogram — its seam (bottom) has the SAME tilt
        // as its top edge, so the band can never twist or invert
        const topTilt = salmon.region.yRightTop! - salmon.region.yLeftTop!;
        const seamTilt = salmon.region.yRightBottom! - salmon.region.yLeftBottom!;
        expect(seamTilt).toBeCloseTo(topTilt, 5);
        // gapless on BOTH corners
        expect(salmon.region.yLeftBottom).toBeCloseTo(naminis.region.yLeftTop!, 5);
        expect(salmon.region.yRightBottom).toBeCloseTo(naminis.region.yRightTop!, 5);
    });

    test('receipt-69: under a real receipt TILT, every band stays a parallelogram (no twist/inversion) and seams tile gaplessly', () => {
        // Reproduces the receipt-69 layout (weighed products + a fused discount+name line)
        // on a TILTED receipt — the case where the old per-column seam twisted/inverted the
        // lower bands. A flat test can't catch that; this one can.
        const S = 0.04;                                   // receipt tilt (right side lower)
        const cx = (xL: number, xR: number) => (xL + xR) / 2;
        const tw = (text: string, xL: number, xR: number, baseT: number) =>
            ({ text, xLeft: xL, xRight: xR, yTop: Math.round(baseT + S * cx(xL, xR)), yBottom: Math.round(baseT + 24 + S * cx(xL, xR)) });
        const twl = (text: string, words: ReturnType<typeof tw>[]): IkiLine => ({
            text, yTop: Math.min(...words.map((w) => w.yTop)), yBottom: Math.max(...words.map((w) => w.yBottom)),
            xLeft: Math.min(...words.map((w) => w.xLeft)), xRight: Math.max(...words.map((w) => w.xRight)), words,
        });
        // full-frame fused line: name words dropped, only the amount survived; frame still spans the row
        const fused = (text: string, baseT: number, amt: ReturnType<typeof tw>[]): IkiLine =>
            ({ text, xLeft: 50, xRight: 730, yTop: Math.round(baseT + S * 50), yBottom: Math.round(baseT + 24 + S * 730), words: amt });
        const lines: IkiLine[] = [
            twl('PVM mokėtojo kodas LT101937219', [tw('PVM', 0, 60, 0), tw('kodas', 205, 300, 0), tw('LT101937219', 310, 500, 0)]),
            twl('LIETUVISKI POMIDORAI', [tw('LIETUVISKI', 50, 250, 100), tw('POMIDORAI', 260, 430, 100)]),
            twl('0,720 kg X 3,99 EUR/ kg 2,87 A', [tw('0,720', 50, 130, 140), tw('kg', 140, 175, 140), tw('X', 180, 200, 140), tw('3,99', 210, 300, 140), tw('EUR/', 310, 390, 140), tw('kg', 400, 435, 140), tw('2,87', 600, 700, 140), tw('A', 710, 730, 140)]),
            twl('NUOLAIDA', [tw('NUOLAIDA', 50, 200, 185)]),
            fused('-0,72 A RAUDONOSIOS PAPRIKOS', 185, [tw('-0,72', 600, 700, 185), tw('A', 710, 730, 185)]),
            twl('0,470 kg X 3,49 EUR/ kg 1,64 A', [tw('0,470', 50, 130, 230), tw('kg', 140, 175, 230), tw('X', 180, 200, 230), tw('3,49', 210, 300, 230), tw('EUR/', 310, 390, 230), tw('kg', 400, 435, 230), tw('1,64', 600, 700, 230), tw('A', 710, 730, 230)]),
            twl('Prekiautojo ID 15027037', [tw('Prekiautojo', 0, 150, 300), tw('ID', 155, 200, 300)]),
        ];
        const { products } = parseIkiReceipt(lines);
        expect(products.length).toBeGreaterThanOrEqual(2);
        const sorted = products.sort((a, b) => a.region.yTop - b.region.yTop);
        for (const p of sorted) {
            // PARALLELOGRAM: bottom edge has the SAME tilt as the top edge → cannot twist
            const topTilt = p.region.yRightTop! - p.region.yLeftTop!;
            const botTilt = p.region.yRightBottom! - p.region.yLeftBottom!;
            expect(botTilt).toBeCloseTo(topTilt, 3);
            // tilt has the correct SIGN (right edge lower, like the receipt) — never inverted
            expect(topTilt).toBeGreaterThan(0);
        }
        for (let i = 1; i < sorted.length; i++) {
            // gapless on both corners
            expect(sorted[i].region.yLeftTop!).toBeCloseTo(sorted[i - 1].region.yLeftBottom!, 3);
            expect(sorted[i].region.yRightTop!).toBeCloseTo(sorted[i - 1].region.yRightBottom!, 3);
        }
    });

    test('receipt-71: a DEPOSIT line (DEPOZITAS) and the Prekiautojo ID line are skipped, not phantom products', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('NATURALUS MINERALINIS VANDUO', 100, [word('NATURALUS', 50, 250, 100), word('MINERALINIS', 260, 500, 100), word('VANDUO', 510, 640, 100)]),
            wl('1,05 A', 100, [word('1,05', 800, 900, 100), word('A', 910, 940, 100)]),
            // deposit: OCR kept only the "0,10" amount as words; "DEPOZITAS" is in the line text only
            wl('0, 10 DEPOZITAS', 150, [word('0,', 800, 840, 150), word('10', 850, 900, 150)]),
            // Prekiautojo ID — OCR-garbled "Prekiato o,ID"
            wl('Prekiato o,ID 15001934', 200, [word('Prekiato', 0, 150, 200), word('o,ID', 160, 240, 200), word('15001934', 250, 430, 200)]),
            wl('Laikas 11:58:06 Data 2026-06-19', 250, [word('Laikas', 0, 120, 250), word('11:58:06', 130, 320, 250)]),
        ];
        const { products } = parseIkiReceipt(lines);
        expect(products).toHaveLength(1);
        expect(products[0].name).toMatch(/MINERALINIS|NATURAL/i);
        // no deposit / Prekiautojo phantoms
        expect(products.some((p) => p.price === 0.1 || /DEPOZ|Prekia|15001934/i.test(p.name))).toBe(false);
    });

    test('receipt-71: footer bands hug their VALUE word tightly (match OCR), not full-width', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('VANDUO', 100, [word('VANDUO', 50, 200, 100)]),
            wl('1,05 A', 100, [word('1,05', 600, 700, 100), word('A', 710, 730, 100)]),
            wl('Prekiautojo ID 15001934', 160, [word('Prekiautojo', 0, 200, 160), word('ID', 210, 250, 160)]),
            // FLAT total line — all words at the same y
            wl('SUMA 1,05 EUR', 220, [word('SUMA', 50, 150, 220), word('1,05', 300, 400, 220), word('EUR', 410, 490, 220)]),
            // strongly TILTED receipt-no line — words descend left→right (y 380 → 285)
            wl('Term. 15001934 Kvitas 7317 Atsk 000', 320, [word('Term.', 50, 150, 380), word('15001934', 200, 400, 355), word('Kvitas', 450, 560, 330), word('7317', 600, 690, 310), word('Atsk', 720, 820, 295), word('000', 850, 920, 285)]),
        ];
        const { footer } = parseIkiReceipt(lines);
        const total = footer.lineRegions.find((r) => r.kind === 'total')!;
        const receiptNo = footer.lineRegions.find((r) => r.kind === 'receiptNo')!;
        expect(total).toBeTruthy();
        expect(receiptNo).toBeTruthy();
        // total hugs the "1,05" value word (x300–400), tight not full-width
        expect(total.xLeft).toBeGreaterThan(250);
        expect(total.xRight).toBeLessThan(450);
        // receiptNo hugs the "7317" value word (x600–690), tight not full-width
        expect(receiptNo.xLeft).toBeGreaterThan(550);
        expect(receiptNo.xRight).toBeLessThan(720);
    });

    test('receipt-72: a deposit line garbled O→0 ("DEP0ZIAS"), amount has no trailing A, is still skipped', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('NATURALUS VANDUO', 100, [word('NATURALUS', 50, 250, 100), word('VANDUO', 260, 430, 100)]),
            wl('1,05 A', 100, [word('1,05', 800, 900, 100), word('A', 910, 940, 100)]),
            // deposit: "DEPOZITAS" → "DEP0ZIAS" (O→0, T dropped); only "0,10" survived as words, no "A"
            wl('0, 10 DEP0ZIAS', 150, [word('0,', 800, 840, 150), word('10', 850, 900, 150)]),
            wl('Prekiautojo ID 15001934', 200, [word('Prekiautojo', 0, 200, 200), word('ID', 210, 250, 200)]),
        ];
        const { products } = parseIkiReceipt(lines);
        expect(products).toHaveLength(1);
        expect(products.some((p) => p.price === 0.1)).toBe(false);
    });

    test('receipt-76 (REAL OCR coords): total band reaches the dropped "1,15 EUR"; receiptNo band covers the dropped "Kvitas 7317"', () => {
        // Exact word boxes from the receipt-76 wordsDump. The "1,15 EUR" amount and the
        // "Kvitas 7317" number were DROPPED by OCR; only label words survived on those
        // lines, so the band must cover the line FRAME (which contains the value).
        const ln = (
            text: string, xLeft: number, xRight: number, yTop: number, yBottom: number,
            words: { text: string; xLeft: number; xRight: number; yTop: number; yBottom: number }[],
        ): IkiLine => ({ text, xLeft, xRight, yTop, yBottom, yLeftTop: yTop, yRightTop: yTop, yLeftBottom: yBottom, yRightBottom: yBottom, words });
        const lines: IkiLine[] = [
            ln('VMketojo kodas LT101937219', 295, 1196, 457, 548, [
                { text: 'VMkètojo', xLeft: 295, xRight: 630, yTop: 470, yBottom: 545 },
                { text: 'kodas', xLeft: 668, xRight: 821, yTop: 465, yBottom: 536 },
                { text: 'LT101937219', xLeft: 858, xRight: 1196, yTop: 457, yBottom: 532 },
            ]),
            ln('NATŪRAUS KINERALINIS VAN', 72, 867, 586, 672, [
                { text: 'NATŪRAUS', xLeft: 72, xRight: 359, yTop: 600, yBottom: 671 },
                { text: 'KINERALINIS', xLeft: 396, xRight: 734, yTop: 590, yBottom: 662 },
                { text: 'VAN', xLeft: 768, xRight: 867, yTop: 586, yBottom: 650 },
            ]),
            ln('1,05 A', 1203, 1374, 582, 647, [
                { text: '1,05', xLeft: 1203, xRight: 1314, yTop: 584, yBottom: 647 },
                { text: 'A', xLeft: 1347, xRight: 1374, yTop: 583, yBottom: 643 },
            ]),
            ln('Prekia to oID 15001934', 80, 822, 835, 943, [
                { text: 'Prekia', xLeft: 80, xRight: 260, yTop: 856, yBottom: 932 },
                { text: 'to', xLeft: 285, xRight: 364, yTop: 853, yBottom: 924 },
                { text: 'oID', xLeft: 377, xRight: 518, yTop: 846, yBottom: 920 },
                { text: '15001934', xLeft: 579, xRight: 822, yTop: 834, yBottom: 913 },
            ]),
            // amount line — "1, 15 EUR" DROPPED, only "Par davimas" survived (ends x886)
            ln('Par davimas 1, 15 EUR', 591, 1377, 1154, 1255, [
                { text: 'Par', xLeft: 591, xRight: 674, yTop: 1158, yBottom: 1223 },
                { text: 'davimas', xLeft: 682, xRight: 886, yTop: 1154, yBottom: 1221 },
            ]),
            // bare SUMA line — only "SUMA" survived
            ln('SUMA Patvirtintas', 44, 914, 1247, 1367, [
                { text: 'SUMA', xLeft: 44, xRight: 173, yTop: 1247, yBottom: 1302 },
            ]),
            // receiptNo line — "Kvitas 7317 …" DROPPED, only "Contactless." survived (ends x965)
            ln('Contactless. Term. 15001934 Kvitas 7317 Atsk 000', 138, 1262, 1337, 1487, [
                { text: 'Contactless.', xLeft: 565, xRight: 965, yTop: 1337, yBottom: 1399 },
            ]),
        ];
        const { footer } = parseIkiReceipt(lines);
        expect(footer.total).toBeCloseTo(1.15, 2);
        expect(footer.receiptNo).toBe('7317');
        const total = footer.lineRegions.find((r) => r.kind === 'total')!;
        const rn = footer.lineRegions.find((r) => r.kind === 'receiptNo')!;
        // TOTAL sits on the AMOUNT line (y~1154–1255, not the SUMA line at y1247+) and
        // reaches the dropped "1,15 EUR" on the right (x → ~1377).
        expect(total.yTop).toBeLessThan(1240);
        expect(total.xRight).toBeGreaterThan(1200);
        // receiptNo covers the line frame so the dropped "Kvitas 7317" is included
        // (x → ~1262), not stuck on the "Contactless." word that ended at x965.
        expect(rn.xRight).toBeGreaterThan(1100);
    });

    test('footBand match: a total whose decimal part dropped ("26" of "26,52") does NOT hug the fragment — covers the line frame', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('VANDUO', 100, [word('VANDUO', 50, 200, 100)]),
            wl('1,05 A', 100, [word('1,05', 600, 700, 100), word('A', 710, 730, 100)]),
            wl('Prekiautojo ID 15027037', 160, [word('Prekiautojo', 0, 150, 160), word('ID', 155, 200, 160)]),
            // SUMA line: "26,52 EUR" mostly dropped — only the integer "26" survived (left); ",52" gone
            {
                text: 'SUMA 26, 52 EUR', xLeft: 50, xRight: 900, yTop: 220, yBottom: 256,
                yLeftTop: 220, yRightTop: 220, yLeftBottom: 256, yRightBottom: 256,
                words: [word('SUMA', 50, 150, 220), word('26', 300, 360, 220)],
            },
        ];
        const { footer } = parseIkiReceipt(lines);
        const total = footer.lineRegions.find((r) => r.kind === 'total')!;
        // must NOT collapse onto the "26" fragment (x300–360); covers the line frame (x50–900)
        expect(total.xRight).toBeGreaterThan(800);
    });

    test('receipt-77: a garbled Prekiautojo line ("OID 15001934 Prekiato g1D", I→1) ends products — no phantom OID/Data/Laikas item', () => {
        const lines: IkiLine[] = [
            wl('ketojo kodas LT101937219', 0, [word('ketojo', 0, 200, 0), word('kodas', 210, 360, 0), word('LT101937219', 370, 700, 0)]),
            wl('NATURAUS MNERALINIS VAN', 100, [word('NATURAUS', 50, 350, 100), word('MNERALINIS', 360, 700, 100), word('VAN', 710, 800, 100)]),
            wl('1,05 A', 100, [word('1,05', 1200, 1320, 100), word('A', 1350, 1390, 100)]),
            // garbled Prekiautojo line — "Prekiato g1D" (OCR read the I of ID as 1); only OID/15001934 survived as words
            {
                text: 'OID 15001934 Prekiato g1D', xLeft: 47, xRight: 828, yTop: 200, yBottom: 280,
                yLeftTop: 200, yRightTop: 200, yLeftBottom: 280, yRightBottom: 280,
                words: [word('OID', 373, 508, 210), word('15001934', 577, 828, 200)],
            },
            wl('Data 2026-D-19', 260, [word('Data', 63, 178, 260), word('2026-D-19', 220, 550, 260)]),
            wl('Laikas 11:58:06', 260, [word('Laikas', 931, 1117, 260), word('11:58:06', 1156, 1395, 260)]),
        ];
        const { products } = parseIkiReceipt(lines);
        expect(products).toHaveLength(1);
        expect(products[0].name).toMatch(/MNERALINIS|NATURAUS/i);
    });

    test('receipt-80: a "SUMA … 1,15 EUR" total band (value on the RIGHT) covers the amount, not just its top edge', () => {
        const lines: IkiLine[] = [
            wl('kodas LT101937219', 0, [word('kodas', 200, 360, 0), word('LT101937219', 400, 700, 0)]),
            wl('VANDUO', 100, [word('VANDUO', 50, 250, 100)]),
            wl('1,05 A', 100, [word('1,05', 1000, 1100, 100), word('A', 1110, 1140, 100)]),
            wl('Prekiautojo ID 15001934', 160, [word('Prekiautojo', 0, 200, 160), word('ID', 210, 250, 160)]),
            // total line: "1, 15 EUR SUMA" — SUMA dropped (far left, frame x35), amount on the RIGHT
            {
                text: '1, 15 EUR SUMA', xLeft: 35, xRight: 1315, yTop: 1155, yBottom: 1244,
                yLeftTop: 1155, yRightTop: 1155, yLeftBottom: 1244, yRightBottom: 1244,
                words: [
                    { text: '1,', xLeft: 1092, xRight: 1126, yTop: 1162, yBottom: 1216 },
                    { text: '15', xLeft: 1150, xRight: 1198, yTop: 1159, yBottom: 1214 },
                    { text: 'EUR', xLeft: 1231, xRight: 1315, yTop: 1156, yBottom: 1211 },
                ],
            },
            // a wide TILTED footer line → establishes a negative reference tilt
            wl('Aut kodas 001412828455', 1400, [word('Aut', 105, 219, 1459), word('kodas', 272, 427, 1449), word('001412828455', 910, 1257, 1407)]),
        ];
        const { footer } = parseIkiReceipt(lines);
        expect(footer.total).toBeCloseTo(1.15, 2);
        const total = footer.lineRegions.find((r) => r.kind === 'total')!;
        // the band's RIGHT edge (where 1,15 EUR is) sits ON the amount text (y~1156–1216),
        // not lifted ~30px above it the way a band-centre pivot did (yRightTop ~1126). The
        // small ~6px padding raises the top a touch so the glyphs aren't flush.
        expect(total.yRightTop!).toBeGreaterThan(1135);
        expect(total.yRightBottom!).toBeGreaterThan(1195);
    });

    test('receipt-81: the total band is padded so the leading "1" of "1,15 EUR" sits INSIDE it, not flush against the left edge', () => {
        const lines: IkiLine[] = [
            wl('kodas LT101937219', 0, [word('kodas', 200, 360, 0), word('LT101937219', 400, 700, 0)]),
            wl('VANDUO', 100, [word('VANDUO', 50, 250, 100)]),
            wl('1,05 A', 100, [word('1,05', 1000, 1100, 100), word('A', 1110, 1140, 100)]),
            wl('Prekiautojo ID 15001934', 160, [word('Prekiautojo', 0, 200, 160), word('ID', 210, 250, 160)]),
            // amount on its own line (leftmost glyph "1," at x1097), then a bare SUMA → look-behind
            wl('1, 15 EUR', 300, [word('1,', 1097, 1133, 300), word('15', 1152, 1203, 300), word('EUR', 1220, 1309, 300)]),
            wl('SUMA Patvirtintas', 360, [word('SUMA', 27, 156, 360)]),
        ];
        const { footer } = parseIkiReceipt(lines);
        expect(footer.total).toBeCloseTo(1.15, 2);
        const total = footer.lineRegions.find((r) => r.kind === 'total')!;
        // band's left edge is LEFT of the first glyph (x1097) → the "1" is inside, with margin
        expect(total.xLeft).toBeLessThan(1097);
    });

    test('receipt-83: a 1-word header band uses the LOCAL slope at its Y (flat near the top), not the steep global median', () => {
        const ln = (
            text: string, xLeft: number, xRight: number, yTop: number, yBottom: number,
            words: { text: string; xLeft: number; xRight: number; yTop: number; yBottom: number }[],
        ): IkiLine => ({ text, xLeft, xRight, yTop, yBottom, yLeftTop: yTop, yRightTop: yTop, yLeftBottom: yBottom, yRightBottom: yBottom, words });
        const lines: IkiLine[] = [
            // FLAT address at the top → a flat local sample at y~440
            ln('Sauletekio al. Vilnius', 240, 1305, 440, 516, [
                { text: 'Sauletekio', xLeft: 240, xRight: 616, yTop: 440, yBottom: 516 },
                { text: 'al.', xLeft: 673, xRight: 762, yTop: 440, yBottom: 516 },
                { text: 'Vilnius', xLeft: 1077, xRight: 1305, yTop: 440, yBottom: 516 },
            ]),
            // storeCode line: only "PUM" survived; value "LT101937219" dropped → fallback slope
            ln('PUM kodas LT101937219', 262, 1303, 499, 575, [{ text: 'PUM', xLeft: 262, xRight: 380, yTop: 499, yBottom: 575 }]),
            wl('VANDUO', 640, [word('VANDUO', 50, 250, 640)]),
            wl('1,05 A', 640, [word('1,05', 1000, 1100, 640), word('A', 1110, 1140, 640)]),
            wl('Prekiautojo ID 15001934', 700, [word('Prekiautojo', 0, 200, 700), word('ID', 210, 250, 700)]),
            // STEEP bottom lines (would dominate a global median → −0.1)
            ln('PVM saskaitos israsomos', 254, 1353, 2137, 2231, [
                { text: 'PVM', xLeft: 254, xRight: 369, yTop: 2231, yBottom: 2308 },
                { text: 'saskaitos', xLeft: 619, xRight: 1027, yTop: 2169, yBottom: 2274 },
                { text: 'israsomos', xLeft: 1068, xRight: 1353, yTop: 2137, yBottom: 2231 },
            ]),
            ln('Su IKI KORTELE suteikta', 75, 1326, 2661, 2819, [
                { text: 'Su', xLeft: 75, xRight: 153, yTop: 2819, yBottom: 2892 },
                { text: 'IKI', xLeft: 189, xRight: 296, yTop: 2800, yBottom: 2876 },
                { text: 'suteikta', xLeft: 1060, xRight: 1326, yTop: 2661, yBottom: 2759 },
            ]),
        ];
        const { header } = parseIkiReceipt(lines);
        const code = header.lineRegions.find((r) => r.kind === 'storeCode')!;
        // local slope at y~500 (interpolating the flat address) → near-flat band, not the
        // steep global median (−0.1) that swung the old band up ~37px
        expect(Math.abs(code.yLeftTop! - code.yRightTop!)).toBeLessThan(20);
    });

    test('receipt-78: header bands follow their OWN (flat) line slope on a CURVED receipt, not the steep global tilt', () => {
        const lines: IkiLine[] = [
            // FLAT wide address + PVM/storeCode lines (their own words barely tilt)…
            {
                text: 'etekio al. 36-101, Vilnius', xLeft: 350, xRight: 1169, yTop: 400, yBottom: 460,
                yLeftTop: 400, yRightTop: 400, yLeftBottom: 460, yRightBottom: 460,
                words: [word('etekio', 350, 545, 400), word('al.', 583, 655, 400), word('36-101,', 710, 907, 400), word('Vilnius', 962, 1169, 400)],
            },
            wl('PUM Oketojo kodas LT101937219', 470, [word('PUM', 241, 327, 470), word('Oketojo', 392, 618, 470), word('kodas', 647, 800, 470), word('LT101937219', 836, 1169, 470)]),
            wl('VANDUO', 560, [word('VANDUO', 50, 250, 560)]),
            wl('1,05 A', 560, [word('1,05', 1000, 1100, 560), word('A', 1110, 1140, 560)]),
            wl('Prekiautojo ID 15001934', 640, [word('Prekiautojo', 0, 200, 640), word('ID', 210, 250, 640)]),
            // …while the BOTTOM of the receipt is STEEPLY tilted (curl) — would skew a global tilt
            wl('Su IKI KORTELE suteikta', 2420, [word('Su', 59, 123, 2508), word('IKI', 161, 249, 2497), word('suteikta', 942, 1183, 2420)]),
            wl('Sveikiname iveikete IKI', 2598, [word('Sveikiname', 252, 585, 2752), word('iveikete', 640, 881, 2700), word('IKI', 916, 1100, 2618)]),
        ];
        const { header } = parseIkiReceipt(lines);
        const addr = header.lineRegions.find((r) => r.kind === 'storeAddress')!;
        const code = header.lineRegions.find((r) => r.kind === 'storeCode')!;
        // both stay (near) FLAT — their own line words don't tilt — despite the steep
        // bottom-of-receipt lines that would pull a receipt-wide refTilt steep
        expect(Math.abs(addr.yLeftTop! - addr.yRightTop!)).toBeLessThan(6);
        expect(Math.abs(code.yLeftTop! - code.yRightTop!)).toBeLessThan(6);
    });

    test('receipt-77: a WIDE value-dropped footer band BENDS with the receipt tilt (not flat)', () => {
        const lines: IkiLine[] = [
            // wide TILTED line (descending y) → establishes the reference tilt
            wl('ketojo kodas LT101937219', 0, [word('ketojo', 50, 250, 60), word('kodas', 400, 560, 45), word('LT101937219', 600, 1100, 30)]),
            wl('VANDUO', 120, [word('VANDUO', 50, 250, 120)]),
            wl('1,05 A', 120, [word('1,05', 1000, 1100, 110), word('A', 1110, 1140, 108)]),
            wl('Prekiautojo ID 15001934', 200, [word('Prekiautojo', 0, 200, 200), word('ID', 210, 250, 200)]),
            wl('SUMA 1,05 EUR', 260, [word('SUMA', 50, 150, 260), word('1,05', 300, 420, 260), word('EUR', 440, 560, 260)]),
            // receiptNo: value "7317" dropped, only "Contactless" survived → wide line frame
            {
                text: 'Contactless Term 15001934 Kvitas 7317 Atsk 000', xLeft: 122, xRight: 1281, yTop: 1382, yBottom: 1500,
                yLeftTop: 1382, yRightTop: 1382, yLeftBottom: 1500, yRightBottom: 1500,
                words: [word('Contactless', 539, 895, 1390)],
            },
        ];
        const { footer } = parseIkiReceipt(lines);
        const rn = footer.lineRegions.find((r) => r.kind === 'receiptNo')!;
        expect(rn.xRight - rn.xLeft).toBeGreaterThan(800); // wide line frame
        // bends with the receipt tilt instead of sitting flat (left/right tops differ)
        expect(Math.abs(rn.yLeftTop! - rn.yRightTop!)).toBeGreaterThan(15);
    });

    test('footBand match: a total ("15,00") does NOT hug a longer id sharing its digits (term-id "15001934") — covers the line frame', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('VANDUO', 100, [word('VANDUO', 50, 200, 100)]),
            wl('1,05 A', 100, [word('1,05', 600, 700, 100), word('A', 710, 730, 100)]),
            wl('Prekiautojo ID 15027037', 160, [word('Prekiautojo', 0, 150, 160), word('ID', 155, 200, 160)]),
            // SUMA line: amount "15,00 EUR" dropped; a stray terminal id "15001934" survived (shares "1500")
            {
                text: 'SUMA 15, 00 EUR Term 15001934', xLeft: 50, xRight: 1000, yTop: 220, yBottom: 256,
                yLeftTop: 220, yRightTop: 220, yLeftBottom: 256, yRightBottom: 256,
                words: [word('SUMA', 50, 150, 220), word('15001934', 700, 950, 220)],
            },
        ];
        const { footer } = parseIkiReceipt(lines);
        const total = footer.lineRegions.find((r) => r.kind === 'total')!;
        // must NOT hug the term-id "15001934" (x700–950); covers the line frame (x50–1000)
        expect(total.xLeft).toBeLessThan(100);
        expect(total.xRight).toBeGreaterThan(900);
    });

    test('receipt-74: a DEPOSIT folds into the product above (one band, no value); the merged coupon is skipped', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 50, 150, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('NATURALUS MINERALINIS VANDUO', 100, [word('NATURALUS', 50, 250, 100), word('MINERALINIS', 260, 560, 100), word('VANDUO', 570, 700, 100)]),
            wl('1,05 A', 100, [word('1,05', 1000, 1100, 100), word('A', 1110, 1140, 100)]),
            // bottle deposit — folds into the water's band, value NOT added
            wl('0, 10 DEPOZIAS', 150, [word('0,', 1000, 1040, 150), word('10', 1050, 1100, 150)]),
            // merged coupon "xPiginoRuponas" (no space) — hard skip
            wl('xPiginoRuponas', 200, [word('xPiginoRuponas', 50, 550, 200)]),
            wl('0, 00 A', 200, [word('0,', 1000, 1040, 200), word('00', 1050, 1100, 200), word('A', 1110, 1140, 200)]),
            wl('Prekiautojo ID 15001934', 260, [word('Prekiautojo', 0, 200, 260), word('ID', 210, 250, 260)]),
        ];
        const { products } = parseIkiReceipt(lines);
        expect(products).toHaveLength(1);
        const water = products[0];
        expect(water.name).toMatch(/MINERALINIS|NATURAL/i);
        expect(water.price).toBe(1.05); // deposit 0,10 NOT added
        // the band extends DOWN over the deposit line (~y150-174), not stopping at the price (~y124)
        expect(water.region.yBottom).toBeGreaterThan(160);
        // deposit doesn't pollute rawLines
        expect(water.rawLines.join(' ')).not.toMatch(/DEPOZ|0,?\s?10/);
    });

    test('receipt-74/84: a value-dropped receiptNo on a MERGED 2-row line bands the LOWER (Kvitas) row, not the Contactless row above', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 50, 150, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('VANDUO', 100, [word('VANDUO', 50, 250, 100)]),
            wl('1,05 A', 100, [word('1,05', 1000, 1100, 100), word('A', 1110, 1140, 100)]),
            wl('Prekiautojo ID 15001934', 160, [word('Prekiautojo', 0, 200, 160), word('ID', 210, 250, 160)]),
            // receiptNo line: OCR kept only "Contactless" (top-left); "Kvitas 7317 …" dropped.
            // The MLKit line frame still spans y300→420.
            {
                text: 'Contactless Term. 15001934 Kvitas 7317 Atsk 000', yTop: 300, yBottom: 420,
                xLeft: 50, xRight: 1100, yLeftTop: 300, yRightTop: 300, yLeftBottom: 420, yRightBottom: 420,
                words: [word('Contactless', 100, 400, 305)],
            },
        ];
        const { footer } = parseIkiReceipt(lines);
        const rn = footer.lineRegions.find((r) => r.kind === 'receiptNo')!;
        expect(footer.receiptNo).toBe('7317');
        // WIDTH: spans the line frame (x50–1100) so it CONTAINS "Kvitas 7317" wherever
        // OCR scrambled it — not stuck on the "Contactless" word at x100–400.
        expect(rn.xRight).toBeGreaterThan(1000);
        // ROW: the frame (y300–420) extends a full text-row BELOW the only-surviving
        // "Contactless" (y305–329), so the value ("Kvitas 7317") is on the LOWER row. The
        // band sits THERE — below the Contactless word and reaching the frame bottom —
        // NOT thin on the Contactless row above (which was one row too high).
        expect(rn.yTop).toBeGreaterThan(315);
        expect(rn.yBottom).toBeGreaterThan(390);
    });

    test('receipt-74: a split SUMA bands the AMOUNT line and hugs the "1,15" value (when its words survived)', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 50, 150, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('VANDUO', 100, [word('VANDUO', 50, 250, 100)]),
            wl('1,05 A', 100, [word('1,05', 1000, 1100, 100), word('A', 1110, 1140, 100)]),
            wl('Prekiautojo ID 15001934', 160, [word('Prekiautojo', 0, 200, 160), word('ID', 210, 250, 160)]),
            wl('Pardavimas 1, 15 EUR', 300, [word('Pardavimas', 50, 300, 300), word('1,15', 1000, 1100, 300), word('EUR', 1110, 1200, 300)]),
            wl('SUMA', 360, [word('SUMA', 50, 150, 360)]), // bare SUMA, BELOW the amount line
        ];
        const { footer } = parseIkiReceipt(lines);
        const total = footer.lineRegions.find((r) => r.kind === 'total')!;
        expect(footer.total).toBeCloseTo(1.15, 2);
        // amount "1,15" survived on the Pardavimas line (y300) → band hugs it there,
        // ON the amount (x1000–1100), NOT down on the bare SUMA line (y360)
        expect(total.yTop).toBeLessThan(340);
        expect(total.xLeft).toBeGreaterThan(900);
    });

    test('receipt-73: a split SUMA hugs the recovered "1,15" amount on the amount line (right side), value recovered', () => {
        const lines: IkiLine[] = [
            // wide, tilted header line (descending y) → contributes to the reference tilt
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 50, 150, 60), word('kodas', 400, 550, 50), word('LT101937219', 600, 1100, 40)]),
            wl('VANDUO', 100, [word('VANDUO', 50, 250, 110)]),
            wl('1,05 A', 100, [word('1,05', 1000, 1100, 95), word('A', 1110, 1140, 93)]),
            wl('Prekiautojo ID 15001934', 160, [word('Prekiautojo', 0, 200, 160), word('ID', 210, 250, 160)]),
            wl('Pardavimas', 200, [word('Pardavimas', 400, 600, 200)]),
            // the SUMA amount: a NARROW right-corner cluster (< 15% of width) — too narrow
            // to define its own tilt
            wl('1, 15 EUR', 230, [word('1,', 1010, 1042, 235), word('15', 1050, 1100, 233), word('EUR', 1110, 1180, 231)]),
            wl('SUMA', 260, [word('SUMA', 50, 150, 260)]),
            // a WIDE tilted footer line (descending y) → establishes the reference tilt
            wl('Term. 15001934 Kvitas 7317 Atsk 000', 320, [word('Term.', 50, 150, 360), word('15001934', 200, 400, 345), word('Kvitas', 450, 560, 330), word('7317', 600, 690, 318), word('Atsk', 720, 820, 305), word('000', 850, 1150, 290)]),
        ];
        const { footer } = parseIkiReceipt(lines);
        const total = footer.lineRegions.find((r) => r.kind === 'total')!;
        expect(footer.total).toBeCloseTo(1.15, 2);
        expect(total).toBeTruthy();
        // band hugs the recovered amount "15" on the amount line (x ~1050–1100, right
        // side) — ON the value, not on the bare "SUMA" keyword far left
        expect(total.xLeft).toBeGreaterThan(1000);
    });

    test('receipt-72: total is recovered when the amount is on the line BEFORE a bare "SUMA" (OCR split)', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('VANDUO', 100, [word('VANDUO', 50, 200, 100)]),
            wl('1,05 A', 100, [word('1,05', 600, 700, 100), word('A', 710, 730, 100)]),
            wl('Prekiautojo ID 15001934', 160, [word('Prekiautojo', 0, 200, 160), word('ID', 210, 250, 160)]),
            wl('Pardavimas', 200, [word('Pardavimas', 400, 600, 200)]),
            // amount printed on the line BEFORE the bare "SUMA"
            wl('1. 15 EUR', 230, [word('1.', 1000, 1050, 230), word('15', 1060, 1120, 230), word('EUR', 1130, 1220, 230)]),
            wl('SUMA', 260, [word('SUMA', 50, 150, 260)]),
        ];
        const { footer } = parseIkiReceipt(lines);
        expect(footer.total).toBeCloseTo(1.15, 2);
        expect(footer.lineRegions.some((r) => r.kind === 'total')).toBe(true);
    });

    test('receipt-68: amounts MLKit dropped from word boxes but kept in the LINE text are recovered (discount + €/kg)', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('ATLANTINES LASISOS BE GAL', 100, [word('ATLANTINES', 50, 250, 100), word('LASISOS', 260, 400, 100), word('BE', 410, 450, 100), word('GAL', 460, 520, 100)]),
            // weight line: "kg X 16,99 EUR" shattered — only the "1,068" quantity survived as a word
            wl('1,068 kg X 16,99 EUR/ kg', 140, [word('1,068', 50, 150, 140)]),
            wl('18, 15 A', 140, [word('18,15', 600, 700, 140), word('A', 710, 730, 140)]),
            // discount amount "-7,48 A" dropped from words, still in the line text
            wl('NUOLAIDA -7, 48 A', 180, [word('NUOLAIDA', 50, 200, 180)]),
            wl('NAMINIS 2,5% PIENAS', 220, [word('NAMINIS', 50, 200, 220), word('2,5%', 210, 290, 220), word('PIENAS', 300, 430, 220)]),
            wl('1, 49 A', 220, [word('1,49', 600, 700, 220), word('A', 710, 730, 220)]),
            // NAMINIS discount: label words survived, "-0,30 A" only in the line text
            wl('NUOLAIDA SU KORTELE -0,30 A', 260, [word('NUOLAIDA', 50, 200, 260), word('SU', 210, 250, 260), word('KORTELE', 260, 400, 260)]),
            wl('Prekiautojo ID 15027037', 320, [word('Prekiautojo', 0, 150, 320), word('ID', 155, 200, 320)]),
        ];
        const { products } = parseIkiReceipt(lines);
        const salmon = products.find((p) => /ATLANT/i.test(p.name))!;
        const naminis = products.find((p) => /NAMINIS/i.test(p.name))!;
        expect(salmon).toBeTruthy();
        expect(naminis).toBeTruthy();
        // €/kg recovered → salmon is a WEIGHED item with the right calc
        expect(salmon.unit).toBe('kg');
        expect(salmon.pricePerUnit).toBeCloseTo(16.99, 2);
        expect(salmon.quantity).toBeCloseTo(1.068, 2);
        // discount recovered → promo = (18,15 − 7,48) / 1,068 ≈ 9,99 €/kg
        expect(salmon.promoPrice).toBeCloseTo(9.99, 1);
        // NAMINIS discount recovered from its line text → promo = 1,49 − 0,30 = 1,19
        expect(naminis.promoPrice).toBeCloseTo(1.19, 2);
    });

    test('receipt-67: a tilt/tall-box overlap between two SEPARATE named products keeps ONE straight seam (no per-column bend)', () => {
        // Both products carry their OWN name; their tall name boxes overlap in Y (curve /
        // tall OCR boxes). Since NEITHER name was recovered from the other's discount row,
        // the seam must be a single straight line — NOT a steep per-column tilt that slices
        // the names (the v8.25 regression).
        const tall = (text: string, xL: number, xR: number, yT: number, yB: number) => ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
        const mkLine = (text: string, words: ReturnType<typeof tall>[]): IkiLine => ({
            text, yTop: Math.min(...words.map((w) => w.yTop)), yBottom: Math.max(...words.map((w) => w.yBottom)),
            xLeft: Math.min(...words.map((w) => w.xLeft)), xRight: Math.max(...words.map((w) => w.xRight)), words,
        });
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            mkLine('SKANEJA RYZIAI', [tall('SKANEJA', 50, 250, 100, 150), tall('RYZIAI', 260, 430, 100, 150)]),
            mkLine('3, 29 A', [tall('3,29', 600, 700, 100, 124), tall('A', 710, 730, 100, 124)]),
            mkLine('ATLANTINES LASISOS', [tall('ATLANTINES', 50, 250, 140, 190), tall('LASISOS', 260, 430, 140, 190)]),
            mkLine('18, 15 A', [tall('18,15', 600, 700, 140, 164), tall('A', 710, 730, 140, 164)]),
            wl('Prekiautojo ID 15027037', 240, [word('Prekiautojo', 0, 150, 240), word('ID', 155, 200, 240)]),
        ];
        const { products } = parseIkiReceipt(lines);
        const a = products.find((p) => /SKAN/i.test(p.name))!;
        const b = products.find((p) => /ATLANT/i.test(p.name))!;
        expect(a).toBeTruthy();
        expect(b).toBeTruthy();
        // the seam is a SINGLE straight line: its left and right edges differ only by the
        // receipt tilt (~0 here), NOT a steep per-column bend
        expect(Math.abs(a.region.yRightBottom! - a.region.yLeftBottom!)).toBeLessThan(5);
        // gapless on both corners
        expect(a.region.yLeftBottom).toBeCloseTo(b.region.yLeftTop!, 5);
        expect(a.region.yRightBottom).toBeCloseTo(b.region.yRightTop!, 5);
    });

    test('receipt-64: the company-code band hugs the surviving "PVN" word (tight), not full-width', () => {
        const lines: IkiLine[] = [
            wl('PVN ke io kodas LT101937219', 40, [word('PVN', 210, 270, 40)]),   // OCR dropped every word but "PVN"
            wl('SKANEJA', 100, [word('SKANEJA', 50, 250, 100)]),
            wl('3, 29 A', 100, [word('3,29', 600, 700, 100), word('A', 710, 730, 100)]),
            wl('Prekiautojo ID 15027037', 180, [word('Prekiautojo', 50, 200, 180), word('ID', 210, 250, 180)]),
        ];
        const { header } = parseIkiReceipt(lines);
        const code = header.lineRegions.find((r) => r.kind === 'storeCode')!;
        expect(code).toBeTruthy();
        // hugs just the surviving "PVN" word (x210–270) — matches OCR, NOT full width
        expect(code.xRight - code.xLeft).toBeLessThan(150);
        expect(code.xLeft).toBeGreaterThan(150);
    });

    test('receipt-64: two weighed items whose totals + €/kg were OCR-destroyed still SPLIT (one band ≠ two products)', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            wl('LIETUVISKI POMIDORAI', 100, [word('LIETUVISKI', 50, 250, 100), word('POMIDORAI', 260, 430, 100)]),
            // POMIDORAI weight: €/kg garbled ("3.g9") so perKg fails, and its total (2,87) decayed to a stray "A"
            wl('0,720 kg X 3.g9 EUR/ kg', 140, [word('0,720', 50, 130, 140), word('kg', 140, 175, 140), word('X', 180, 200, 140), word('3.g9', 210, 300, 140), word('EUR/', 310, 390, 140), word('kg', 400, 435, 140)]),
            wl('A', 140, [word('A', 710, 730, 140)]),
            // RAUDONOSIOS: name + €/kg dropped; only the "0,470 kg" quantity and the line total survive
            wl('-0,', 180, [word('-0,', 600, 650, 180)]),
            wl('0,470 kg 1, 64 A', 220, [word('0,470', 50, 130, 220), word('kg', 140, 175, 220), word('1,64', 600, 700, 220), word('A', 710, 730, 220)]),
            wl('Prekiautojo ID 15027037', 300, [word('Prekiautojo', 0, 150, 300), word('ID', 155, 200, 300)]),
        ];
        const { products } = parseIkiReceipt(lines);
        const pom = products.find((p) => /POMIDOR/i.test(p.name))!;
        expect(pom).toBeTruthy();
        // POMIDORAI's content does NOT swallow the second item's "0,470 kg / 1,64" line
        expect(pom.rawLines.join(' ')).not.toMatch(/0,470/);
        // the second weighed quantity opens its OWN product — so no single band covers both
        const other = products.find((p) => p !== pom && /0,470/.test(p.rawLines.join(' ')));
        expect(other).toBeTruthy();
    });

    test('receipt-61: product bands are FULL-WIDTH and tile GAPLESSLY (no gap, no overlap)', () => {
        const lines: IkiLine[] = [
            wl('PVM mokėtojo kodas LT101937219', 0, [word('PVM', 0, 60, 0), word('kodas', 205, 300, 0), word('LT101937219', 310, 500, 0)]),
            // three one-line products with VERTICAL GAPS between them (y100, y150, y210)
            wl('SKANĖJA', 100, [word('SKANĖJA', 50, 250, 100)]),
            wl('3, 29 A', 100, [word('3,29', 600, 700, 100), word('A', 710, 730, 100)]),
            wl('PIENAS', 150, [word('PIENAS', 50, 250, 150)]),
            wl('1, 49 A', 150, [word('1,49', 600, 700, 150), word('A', 710, 730, 150)]),
            wl('SVIESTAS', 210, [word('SVIESTAS', 50, 250, 210)]),
            wl('2, 99 A', 210, [word('2,99', 600, 700, 210), word('A', 710, 730, 210)]),
            wl('Prekiautojo ID 15027037', 280, [word('Prekiautojo', 0, 150, 280), word('ID', 155, 200, 280)]),
        ];
        const { products } = parseIkiReceipt(lines);
        expect(products).toHaveLength(3);
        const sorted = products.sort((a, b) => a.region.yTop - b.region.yTop);
        for (const p of sorted) {
            // FULL WIDTH: every band spans the section left→right (X0=50 … X1=730)
            expect(p.region.xLeft).toBe(50);
            expect(p.region.xRight).toBe(730);
        }
        for (let i = 1; i < sorted.length; i++) {
            // GAPLESS + NO OVERLAP: this band's top edge == the previous band's bottom
            // edge (they meet at the seam — no white space, no overlap), per corner.
            expect(sorted[i].region.yLeftTop!).toBeCloseTo(sorted[i - 1].region.yLeftBottom!, 1);
            expect(sorted[i].region.yRightTop!).toBeCloseTo(sorted[i - 1].region.yRightBottom!, 1);
        }
    });
});
