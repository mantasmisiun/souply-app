import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';
const L = (t: string, x: [number, number], y: [number, number], ws: any[][]): IkiLine => ({
    text: t, xLeft: x[0], xRight: x[1], yTop: y[0], yBottom: y[1],
    words: ws.map(([wt, a, b, c, d]) => ({ text: wt, xLeft: a, xRight: b, yTop: c, yBottom: d })),
});

// Receipt 159 — the only place the to-pay (12,90) appears is beside "Suma su PVM" (no clean
// "Mokėti suapvalinus" line). That total-with-VAT line is now recognised. Also: OCR can drop the
// "r" of "Kvito Nr." -> "Kvito N." (receipt-160), which must still yield the receipt number.
describe('IKI — "Suma su PVM" total + "Kvito N." receipt number', () => {
    test('the total comes from the "<amt> Suma su PVM" line (12,90), first POSITIVE amount', () => {
        const lines: IkiLine[] = [
            L('KETO LENGVAI DUONA SU SEK 2,59 A', [59, 875], [318, 390], [['KETO', 59, 139, 318, 363], ['2,59', 761, 836, 356, 395], ['A', 856, 875, 356, 393]]),
            L('IKI KORTELĖS NR. 999000111222', [74, 780], [1133, 1204], [['IKI', 74, 130, 1134, 1175], ['999000111222', 402, 780, 1146, 1200]]),
            L('Moketi', [73, 182], [2919, 2972], [['Mokèti', 73, 182, 2919, 2960]]),
            L('12, 90 Mokest is Suma su PVM', [59, 904], [2951, 3025], [['12,', 722, 818, 2951, 3001], ['90', 824, 904, 2961, 3009]]),
            L('20, 00 Grąža', [54, 906], [3083, 3133], [['20,', 804, 855, 3083, 3125], ['00', 866, 906, 3087, 3128]]),
            L('Kvito Nr. 13/621/116646 Kasa 0022', [54, 722], [3164, 3240], [['Kvito', 54, 153, 3164, 3211], ['Nr.', 189, 239, 3170, 3214], ['13/621/116646', 259, 521, 3173, 3227]]),
        ];
        const res: any = parseIkiReceipt(lines);
        expect(res.footer.total).toBeCloseTo(12.9, 2);
    });

    test('"Kvito N. <num>" (OCR dropped the r) yields the receipt number', () => {
        const lines: IkiLine[] = [
            L('SUNOKE AVOKADAI 1,99 A', [59, 875], [318, 390], [['SUNOKE', 59, 139, 318, 363], ['1,99', 761, 836, 356, 395], ['A', 856, 875, 356, 393]]),
            L('IKI KORTELĖS NR. 999000111222', [74, 780], [1133, 1204], [['IKI', 74, 130, 1134, 1175], ['999000111222', 402, 780, 1146, 1200]]),
            L('Grąža Kvito N. 71/612/114973 Kasa 0022', [39, 722], [2536, 2654], [['Grąża', 43, 126, 2536, 2576], ['Kvito', 200, 300, 2536, 2576], ['N.', 320, 360, 2536, 2576], ['71/612/114973', 380, 600, 2536, 2576]]),
        ];
        const res: any = parseIkiReceipt(lines);
        expect(res.footer.receiptNos).toContain('71/612/114973');
    });
});
