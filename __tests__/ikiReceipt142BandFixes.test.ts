import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 142 — a TILTED IKI receipt that exposed three band-geometry bugs:
//  1. The skipped (coupon/bag/points) bands were drawn FLAT, not following the receipt tilt.
//  2. The last product (Fasuoti obuoliai) had its price "3,87 A" OCR-land on the next coupon's
//     row (xKUPONAS), so the seam cut the product band at the coupon's top and the grey skip band
//     "abducted" the product's own price.
//  3. The store-address band covered the company code, because the address is OCR-fused with the
//     PVM-code line ("…Siaul iai PV moketojo kodas LT101937219") and the band took the whole line.
// Geometry is faithful to the receipt's wordsDump (real tilt baked into the word boxes).
const L = (t: string, x: [number, number], y: [number, number], ws: any[][]): IkiLine => ({
    text: t, xLeft: x[0], xRight: x[1], yTop: y[0], yBottom: y[1],
    words: ws.map(([wt, a, b, c, d]) => ({ text: wt, xLeft: a, xRight: b, yTop: c, yBottom: d })),
});

const lines: IkiLine[] = [
    L('IKI Lietuva, UA8', [320, 617], [217, 269], [['IKI', 320, 369, 217, 258], ['Lietuva,', 390, 531, 220, 264], ['UA8', 545, 617, 225, 266]]),
    L('bardino g. 2-2, Siaul iai PV moketojo kodas LT101937219', [183, 748], [251, 344], [['bardino', 243, 373, 251, 295], ['g.', 390, 418, 256, 296], ['2-2,', 448, 513, 257, 299], ['Siaul', 539, 634, 260, 302], ['iai', 638, 693, 263, 304]]),
    L('LIETUVISKI POMIDORAI', [85, 444], [640, 701], [['LIETUVISKI', 85, 268, 640, 690], ['POMIDORAI', 276, 444, 648, 697]]),
    L('1,99 A', [752, 860], [631, 675], [['1,99', 752, 822, 631, 671], ['A', 842, 860, 631, 671]]),
    L('0,720 kg X3.9a EUR/ kg', [89, 557], [676, 732], [['0,720', 89, 180, 676, 718], ['kg', 218, 256, 681, 720], ['X3.9a', 276, 406, 682, 725], ['EUR/', 426, 500, 686, 728], ['kg', 519, 557, 689, 729]]),
    L('NUOLAI DA', [70, 219], [711, 760], [['NUOLAI', 70, 178, 711, 755], ['DA', 183, 219, 715, 756]]),
    L('2, 87 A', [749, 860], [708, 747], [['2,', 749, 774, 708, 743], ['87', 787, 822, 708, 743], ['A', 841, 860, 708, 743]]),
    L('RAUDONOSIOS PAPRIKOS -0, 72 A', [68, 859], [744, 806], [['RAUDONOSIOS', 68, 276, 744, 791], ['PAPRIKOS', 295, 445, 753, 797]]),
    L('0, 470 kg X 3,49 EUR/ kg', [100, 558], [781, 844], [['0,', 100, 116, 781, 823], ['470', 129, 188, 782, 827], ['kg', 218, 257, 786, 829], ['X', 311, 324, 791, 833], ['3,49', 331, 409, 792, 837], ['EUR/', 431, 512, 796, 842], ['kg', 521, 557, 801, 844]]),
    L('NUOLAIDA SU KORTEL.', [65, 422], [815, 880], [['NUOLAIDA', 65, 222, 815, 865], ['SU', 230, 276, 823, 867], ['KORTEL.', 292, 422, 827, 875]]),
    L('1,64 A', [750, 860], [820, 860], [['1,64', 750, 821, 820, 855], ['A', 841, 860, 822, 855]]),
    L('-0, 23 A Fasuoti obuol1 ai IKI UKIS', [67, 861], [851, 935], [['-0,', 737, 786, 851, 894], ['23', 785, 822, 853, 896], ['A', 841, 861, 856, 898]]),
    L('2,090 kg X 1,85 EUR/ kg', [99, 555], [891, 958], [['2,090', 99, 192, 891, 937], ['kg', 218, 257, 899, 941], ['X', 292, 312, 903, 944], ['1,85', 335, 407, 906, 951], ['EUR/', 426, 500, 912, 956], ['kg', 521, 555, 918, 959]]),
    L('xKUPONAS', [74, 221], [925, 976], [['xKUPONAS', 74, 221, 925, 971]]),
    L('3, 87 A', [749, 860], [925, 972], [['3,', 749, 786, 925, 969], ['87', 785, 822, 926, 970], ['A', 841, 860, 928, 971]]),
    L('*KUPONAS', [68, 218], [972, 1028], [['*KUPONAS', 68, 218, 972, 1016]]),
    L('0,00 A', [747, 859], [962, 1013], [['0,00', 747, 822, 962, 1006], ['A', 840, 859, 967, 1008]]),
    L('MAISELIS PLASTIKINIS LENG', [67, 538], [1001, 1075], [['MAISELIS', 67, 220, 1001, 1049], ['PLASTIKINIS', 235, 445, 1009, 1061], ['LENG', 463, 538, 1021, 1066]]),
    L('0,00 A', [746, 859], [1000, 1048], [['0,00', 746, 821, 1000, 1042], ['A', 839, 859, 1005, 1043]]),
    L('Prekiautojo ID 15027037', [66, 517], [1116, 1174], [['Prekiautojo', 66, 276, 1116, 1163], ['ID', 296, 330, 1124, 1164], ['15027037', 371, 517, 1127, 1171]]),
];

describe('IKI receipt-142 band fixes (tilted receipt)', () => {
    const res: any = parseIkiReceipt(lines);
    const fasuoti = res.products.find((p: any) => /Fasuoti/i.test(p.name));
    const skips = res.skippedRegions ?? [];

    test('the last product keeps its OWN price row — band reaches the "3,87 A" at y≈972', () => {
        expect(fasuoti).toBeDefined();
        // price row bottom ≈ 972; the band must reach it (was cut at 925 → price abducted by the skip)
        expect(fasuoti.region.yBottom).toBeGreaterThanOrEqual(965);
    });

    test('skip bands BEND with the receipt tilt (left-top ≠ right-top, like the product bands)', () => {
        expect(skips.length).toBeGreaterThanOrEqual(3);
        for (const s of skips) {
            expect(Math.abs((s.yRightTop ?? s.yTop) - (s.yLeftTop ?? s.yTop))).toBeGreaterThan(10);
        }
    });

    test('every product + skip band tiles seam-to-seam (no overlap, no gap)', () => {
        const top = (r: any) => Math.min(r.yLeftTop ?? r.yTop, r.yRightTop ?? r.yTop);
        const bottomR = (r: any) => r.yRightBottom ?? r.yBottom;
        const topR = (r: any) => r.yRightTop ?? r.yTop;
        const all = [...res.products.map((p: any) => p.region), ...skips].sort((a, b) => top(a) - top(b));
        for (let i = 1; i < all.length; i++) {
            expect(Math.abs(bottomR(all[i - 1]) - topR(all[i]))).toBeLessThanOrEqual(2);  // per-corner flush
        }
    });

    test('the store-address band hugs the address, NOT the fused company code', () => {
        expect(res.header.storeAddress).toMatch(/bardino/i);
        const addr = (res.header.lineRegions ?? []).find((r: any) => r.kind === 'storeAddress');
        expect(addr).toBeDefined();
        // address words end at x≈693; the band must not stretch to the line frame (≈748) over the code
        expect(addr.xRight).toBeLessThanOrEqual(710);
    });
});
