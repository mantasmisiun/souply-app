import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';
// Simulates the FIXED app-side row-merge OUTPUT: when MLKit fuses two stacked print-rows into one
// "line", the merge now keeps EVERY word box. This fixture is ONE line whose text spans two products
// but whose words[] carries both rows' boxes at their true y. The IKI parser re-clusters words by
// their own y (it ignores MLKit's line grouping), so it must split them back into TWO products.
// (Before the fix, the second row's boxes were dropped -> the parser saw an un-splittable text blob
//  -> two products collapsed into one: the receipt-160 failure.)
const W = (t: string, xL: number, xR: number, yT: number, yB: number) => ({ text: t, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const merged: IkiLine = {
    text: 'MAGIJA GLAISTYTAS VANILIN 0, 65 A KETO LENGVAI DUONA SU SEK 2, 59 A',
    xLeft: 47, xRight: 875, yTop: 505, yBottom: 582,
    words: [
        W('MAGIJA', 69, 176, 505, 546), W('GLAISTYTAS', 197, 374, 505, 546), W('VANILIN', 409, 530, 505, 546),
        W('0,65', 742, 816, 504, 545), W('A', 836, 854, 504, 545),
        W('KETO', 59, 142, 547, 591), W('LENGVAI', 152, 290, 547, 591), W('DUONA', 300, 405, 547, 591), W('SU', 420, 460, 547, 591), W('SEK', 470, 528, 547, 591),
        W('2,59', 744, 818, 547, 588), W('A', 837, 856, 547, 588),
    ],
};
const anchor: IkiLine = { text: 'IKI KORTELĖS NR. 999000111222', xLeft: 90, xRight: 753, yTop: 1200, yBottom: 1248, words: [W('IKI', 90, 146, 1200, 1248), W('999000111222', 401, 753, 1200, 1248)] };
describe('IKI — a merged-but-fully-boxed line splits back into separate products', () => {
    const res: any = parseIkiReceipt([merged, anchor]);
    test('two distinct products are recovered from the one merged line', () => {
        expect(res.products.length).toBeGreaterThanOrEqual(2);
        const names = res.products.map((p: any) => p.name).join(' | ');
        expect(names).toMatch(/MAGIJA/);
        expect(names).toMatch(/KETO/);
    });
});
