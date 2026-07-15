import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';
const L = (t: string, x: [number, number], y: [number, number], ws: any[][]): IkiLine => ({
    text: t, xLeft: x[0], xRight: x[1], yTop: y[0], yBottom: y[1],
    words: ws.map(([wt, a, b, c, d]) => ({ text: wt, xLeft: a, xRight: b, yTop: c, yBottom: d })),
});
// Receipt 161 — OCR dropped the leading "-" on LAVAZZA's loyalty discount, so the line read
// "NUOLAIDA SU KORTELE 4,50 A" (positive). A clean positive decimal classifies as a TOTAL, so the
// pure discount-label line minted a phantom "?" product (price 4,50) and LAVAZZA lost its promo.
// A POST-PASS over the Y-sorted products folds such a nameless discount-label phantom into the
// PRECEDING product as its discount — but only when nothing downstream is orphaned (see Case B
// below), the signal the streaming assembler can't see.
describe('IKI — a minus-dropped "NUOLAIDA SU KORTELE 4,50 A" folds into the product, not a phantom', () => {
    const lines: IkiLine[] = [
        L('LAVAZZA QUA ITA ORO MALTA', [69, 530], [348, 387], [['LAVAZZA', 69, 200, 348, 387], ['QUA', 230, 276, 348, 387], ['ITA', 296, 347, 348, 387], ['ORO', 367, 421, 348, 387], ['MALTA', 440, 530, 348, 387]]),
        L('9,99 A', [735, 840], [339, 379], [['9,99', 735, 806, 340, 380], ['A', 824, 840, 340, 379]]),
        L('NUOLAIDA SU KORTELE', [86, 422], [387, 428], [['NUOLAIDA', 86, 228, 387, 428], ['SU', 246, 281, 387, 428], ['KORTELE', 293, 422, 387, 428]]),
        L('4,50 A', [740, 839], [376, 415], [['4,50', 740, 809, 376, 415], ['A', 826, 839, 376, 415]]),
        L('DVARO GRIETINĖ 30% RIEBUM', [69, 532], [421, 463], [['DVARO', 69, 176, 421, 458], ['GRIETINĖ', 184, 330, 421, 458], ['30%', 349, 405, 421, 458], ['RIEBUM', 423, 532, 421, 458]]),
        L('2,79 A', [735, 842], [410, 448], [['2,79', 735, 807, 411, 449], ['A', 824, 842, 410, 448]]),
        L('IKI KORTELĖS NR. 999000111222', [101, 753], [1145, 1201], [['IKI', 101, 152, 1145, 1191], ['999000111222', 409, 753, 1149, 1197]]),
    ];
    const res: any = parseIkiReceipt(lines);

    test('LAVAZZA keeps its 9,99 price AND gets the 4,50 discount → promo 5,49', () => {
        const lav = res.products.find((p: any) => /LAVAZZA/.test(p.name));
        expect(lav.price).toBeCloseTo(9.99, 2);
        expect(lav.promoPrice).toBeCloseTo(5.49, 2);
    });
    test('no phantom "?" product priced at the 4,50 discount', () => {
        expect(res.products.some((p: any) => p.name === '?' && Math.abs(p.price - 4.5) < 0.01)).toBe(false);
    });
});

// Case B — the SAME "NUOLAIDA SU KORTELE <positive> A" shape, but the amount (18,15) is a real
// product's total that MLKit tilt-displaced onto the discount line (the next product, JACOBS, is
// now total-less). Folding it would DELETE a real product and write a bogus promo. The post-pass
// must NOT fold here: the following product is an orphan (price 0), so the amount is its displaced
// total. (Guards the fix above against the parser comment's "NUOLAIDA ŠU 18,15" mis-group warning.)
describe('IKI — a tilt-mis-grouped foreign total on a NUOLAIDA line is NOT folded as a discount', () => {
    const lines: IkiLine[] = [
        L('ALAUS GĖRIMAS SPRINGAR', [69, 540], [340, 380], [['ALAUS', 69, 180, 340, 380], ['GERIMAS', 195, 360, 340, 380], ['SPRINGAR', 375, 540, 340, 380]]),
        L('19,99 A', [735, 845], [339, 379], [['19,99', 735, 810, 340, 380], ['A', 828, 845, 340, 379]]),
        L('NUOLAIDA SU KORTELE', [86, 422], [387, 428], [['NUOLAIDA', 86, 228, 387, 428], ['SU', 246, 281, 387, 428], ['KORTELE', 293, 422, 387, 428]]),
        L('18,15 A', [728, 845], [376, 415], [['18,15', 728, 810, 376, 415], ['A', 828, 845, 376, 415]]),
        L('JACOBS KAVA TIRPI 200G', [69, 540], [421, 462], [['JACOBS', 69, 200, 421, 462], ['KAVA', 215, 320, 421, 462], ['TIRPI', 335, 430, 421, 462], ['200G', 445, 540, 421, 462]]),
        L('IKI KORTELĖS NR. 999000111222', [101, 753], [1145, 1201], [['IKI', 101, 152, 1145, 1191], ['999000111222', 409, 753, 1149, 1197]]),
    ];
    const res: any = parseIkiReceipt(lines);

    test('preceding product keeps its full price and gets NO bogus promo', () => {
        const p = res.products.find((q: any) => /ALAUS/.test(q.name));
        expect(p.price).toBeCloseTo(19.99, 2);
        expect(p.promoPrice).toBeNull();
    });
    test('the 18,15 total survives (the real product is not deleted)', () => {
        expect(res.products.some((q: any) => Math.abs((q.price ?? 0) - 18.15) < 0.01)).toBe(true);
    });
});
