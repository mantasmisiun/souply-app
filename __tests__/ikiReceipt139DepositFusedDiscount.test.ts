import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 139 — same physical receipt as 138 (AKVILĖ GAZ sparkling water), re-scanned. The
// product/discount/deposit rows OCR'd in a SCRAMBLED column order, and crucially the loyalty
// discount AMOUNT (right column of the NUOLAIDA row) fused onto the DEPOSIT label of the row
// below: one line "-0,33 A DEP0ZITAS", with only "-0,33" + "A" carrying word boxes (DEP0ZITAS
// is boxless). The deposit's own bare price "0, 10" sits on the next line.
//
// Before the fix the column engine (1) misclassified the "-0,33 A" row as a DEPOSIT because its
// source line contained "DEP0ZITAS" → the −0,33 discount was folded away with no value (promo
// lost), and (2) turned the nameless "0, 10" deposit price into a phantom product that name
// recovery christened "DEP0ZITAS". Correct reading: ONE product, AKVILĖ GAZ at 0,65 with a
// −0,33 loyalty discount (net 0,32); the 0,10 deposit is a charge, not a product → skipped.
const L = (t: string, x: [number, number], y: [number, number], ws: any[][]): IkiLine => ({
    text: t, xLeft: x[0], xRight: x[1], yTop: y[0], yBottom: y[1],
    words: ws.map(([wt, a, b, c, d]) => ({ text: wt, xLeft: a, xRight: b, yTop: c, yBottom: d })),
});

const lines: IkiLine[] = [
    L('Saulėt Inius', [205, 857], [301, 372], [['Saulėt', 205, 327, 301, 348]]),
    L('PVM m 7219', [205, 858], [343, 411], [['PVM', 205, 270, 344, 382], ['m', 292, 309, 347, 383]]),
    L('AKVILE GAZ..', [71, 321], [417, 477], [['AKVILE', 71, 204, 417, 465], ['GAZ..', 226, 321, 427, 472]]),
    L('NUOLAIDA SU K:', [71, 365], [461, 505], [['NUOLAIDA', 71, 247, 461, 510], ['SU', 269, 313, 475, 514], ['K:', 334, 364, 479, 517]]),
    L('0, 65 A', [859, 986], [457, 508], [['0,', 859, 888, 458, 500], ['65', 903, 942, 458, 499], ['A', 966, 986, 457, 498]]),
    L('-0,33 A DEP0ZITAS', [72, 987], [499, 554], [['-0,33', 840, 945, 499, 548], ['A', 968, 987, 499, 548]]),
    L('0, 10', [861, 944], [543, 586], [['0,', 861, 890, 543, 586], ['10', 906, 944, 543, 586]]),
    L('Prekiautojo ID 150u', [71, 508], [587, 648], [['Prekiautojo', 71, 314, 587, 638], ['ID', 336, 378, 600, 641], ['150u', 425, 507, 604, 648]]),
    L('Data 2026-06-10', [72, 400], [630, 701], [['Data', 72, 160, 630, 679], ['2026-06-10', 182, 400, 635, 690]]),
];

describe('IKI receipt-139 — fused "discount + DEPOZITAS label" (deposit skipped, discount kept)', () => {
    const res: any = parseIkiReceipt(lines);
    const products = res.products;

    test('exactly ONE product — the deposit is not minted as a phantom product', () => {
        expect(products).toHaveLength(1);
    });

    test('the one product is AKVILĖ GAZ — never a "DEP0ZITAS" product', () => {
        expect(products[0].name).toMatch(/AKVIL/i);
        expect(products.some((p: any) => /DEP[O0]Z/i.test(p.name))).toBe(false);
    });

    test('the −0,33 loyalty discount is attributed to AKVILĖ (0,65 → promo 0,32)', () => {
        expect(products[0].price).toBeCloseTo(0.65, 2);
        expect(products[0].promoPrice).toBeCloseTo(0.32, 2);
    });

    test('the band covers the product NAME (starts at/above the name, not on the deposit row)', () => {
        expect(products[0].region.yTop).toBeLessThanOrEqual(470);
    });

    test('the deposit price "0,10" is folded out — not a product price anywhere', () => {
        expect(products.every((p: any) => Math.abs(p.price - 0.1) > 1e-6)).toBe(true);
    });
});
