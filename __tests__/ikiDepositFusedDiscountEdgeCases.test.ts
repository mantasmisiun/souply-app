import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Edge cases for the receipt-139 "fused discount + DEPOZITAS label" handling, each surfaced by
// adversarial red-teaming of that fix. The fix reinterprets a word-boxed NEGATIVE amount whose
// source line carries a deposit label as a loyalty DISCOUNT (not a deposit) and folds the
// deposit's bare price on the next row. Two discriminators keep it from over-reaching:
//   (1) a deposit REFUND ("…GRĄŽINIMAS"/"IŠIMTA") is genuinely negative → never a discount;
//   (2) only a VAT-LETTERLESS bare amount ("0,10") is a deposit price — a VAT-lettered total
//       ("1,29 A") is a real product and must never be folded away.
const L = (t: string, x: [number, number], y: [number, number], ws: any[][]): IkiLine => ({
    text: t, xLeft: x[0], xRight: x[1], yTop: y[0], yBottom: y[1],
    words: ws.map(([wt, a, b, c, d]) => ({ text: wt, xLeft: a, xRight: b, yTop: c, yBottom: d })),
});
const PVM: IkiLine = L('PVM m 7219', [205, 858], [60, 110], [['PVM', 205, 270, 60, 110]]);
const TRADER = (y: number): IkiLine =>
    L('Prekiautojo ID 150', [71, 508], [y, y + 50], [['Prekiautojo', 71, 314, y, y + 50], ['ID', 336, 378, y, y + 50], ['150', 425, 507, y, y + 50]]);

describe('IKI deposit fused-discount edge cases (red-team regressions)', () => {
    test('a deposit REFUND ("-1,00 A UŽSTATO GRAŽINIMAS") is NOT attributed as a discount', () => {
        const res: any = parseIkiReceipt([
            PVM,
            L('DUONA RUGINE', [71, 400], [150, 200], [['DUONA', 71, 200, 150, 200], ['RUGINE', 210, 400, 150, 200]]),
            L('1, 29 A', [859, 986], [150, 200], [['1,', 859, 888, 150, 200], ['29', 903, 942, 150, 200], ['A', 966, 986, 150, 200]]),
            L('-1,00 A UZSTATO GRAZINIMAS', [72, 987], [200, 250], [['-1,00', 840, 945, 200, 250], ['A', 968, 987, 200, 250]]),
            TRADER(300),
        ]);
        const duona = res.products.find((p: any) => /DUONA/i.test(p.name));
        expect(duona).toBeDefined();
        expect(duona.price).toBeCloseTo(1.29, 2);
        expect(duona.promoPrice).toBeNull();           // the -1,00 refund must NOT become a discount
    });

    test('a name-DROPPED product (VAT-lettered "1,29 A") after a fused deposit row is NOT eaten', () => {
        const res: any = parseIkiReceipt([
            PVM,
            L('AKVILE GAZ..', [71, 321], [150, 200], [['AKVILE', 71, 204, 150, 200], ['GAZ..', 226, 321, 150, 200]]),
            L('0, 65 A', [859, 986], [150, 200], [['0,', 859, 888, 150, 200], ['65', 903, 942, 150, 200], ['A', 966, 986, 150, 200]]),
            L('-0,33 A DEP0ZITAS', [72, 987], [210, 260], [['-0,33', 840, 945, 210, 260], ['A', 968, 987, 210, 260]]),
            L('1, 29 A', [859, 986], [270, 320], [['1,', 859, 888, 270, 320], ['29', 903, 942, 270, 320], ['A', 966, 986, 270, 320]]),
            TRADER(400),
        ]);
        const akvile = res.products.find((p: any) => /AKVIL/i.test(p.name));
        expect(akvile.promoPrice).toBeCloseTo(0.32, 2);  // the discount still attributes to AKVILĖ
        // the VAT-lettered 1,29 survives as its own product (nameless "?" for server resolution)
        expect(res.products.some((p: any) => Math.abs(p.price - 1.29) < 1e-6)).toBe(true);
    });

    test('a DOUBLE-dropped product (bare "0,45", name AND VAT letter gone) after a fused deposit is NOT eaten', () => {
        // The worst case: the next product lost its name AND its VAT letter, so it survives only
        // as a bare "0,45". The VAT-letterless guard alone can't save it; the 0,10 deposit
        // denomination (a multiple of 0,10, ≤0,30) does — 0,45 is not deposit-shaped → not folded.
        const res: any = parseIkiReceipt([
            PVM,
            L('AKVILE GAZ..', [71, 321], [150, 200], [['AKVILE', 71, 204, 150, 200], ['GAZ..', 226, 321, 150, 200]]),
            L('0, 65 A', [859, 986], [150, 200], [['0,', 859, 888, 150, 200], ['65', 903, 942, 150, 200], ['A', 966, 986, 150, 200]]),
            L('-0,33 A DEP0ZITAS', [72, 987], [210, 260], [['-0,33', 840, 945, 210, 260], ['A', 968, 987, 210, 260]]),
            L('0, 45', [859, 986], [270, 320], [['0,', 859, 888, 270, 320], ['45', 903, 942, 270, 320]]),
            TRADER(400),
        ]);
        const akvile = res.products.find((p: any) => /AKVIL/i.test(p.name));
        expect(akvile.promoPrice).toBeCloseTo(0.32, 2);
        expect(res.products.some((p: any) => Math.abs(p.price - 0.45) < 1e-6)).toBe(true); // the 0,45 product is NOT swallowed
    });

    test('a WEAK-named product ("OLA 1,29 A") after a fused deposit row (deposit price dropped) is NOT eaten', () => {
        const res: any = parseIkiReceipt([
            PVM,
            L('AKVILE GAZ..', [71, 321], [150, 200], [['AKVILE', 71, 204, 150, 200], ['GAZ..', 226, 321, 150, 200]]),
            L('0, 65 A', [859, 986], [150, 200], [['0,', 859, 888, 150, 200], ['65', 903, 942, 150, 200], ['A', 966, 986, 150, 200]]),
            L('-0,33 A DEP0ZITAS', [72, 987], [210, 260], [['-0,33', 840, 945, 210, 260], ['A', 968, 987, 210, 260]]),
            L('OLA 1, 29 A', [71, 986], [270, 320], [['OLA', 71, 160, 270, 320], ['1,', 859, 888, 270, 320], ['29', 903, 942, 270, 320], ['A', 966, 986, 270, 320]]),
            TRADER(400),
        ]);
        const akvile = res.products.find((p: any) => /AKVIL/i.test(p.name));
        expect(akvile.promoPrice).toBeCloseTo(0.32, 2);
        expect(res.products.some((p: any) => /OLA/i.test(p.name) && Math.abs(p.price - 1.29) < 1e-6)).toBe(true);
    });
});
