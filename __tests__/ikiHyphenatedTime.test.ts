import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// IKI prints "YYYY-MM-DD HH:MM:SS" on one line; OCR sometimes turns the time's FIRST colon into a
// hyphen ("2026-06-20 12-20:35"). T_TIME_RE now tolerates [:.\-] for that first separator while
// keeping the MM:SS colon literal — so the time recovers AND the date can never be read as a time.
const L = (t: string, x: [number, number], y: [number, number], ws: any[][]): IkiLine => ({
    text: t, xLeft: x[0], xRight: x[1], yTop: y[0], yBottom: y[1],
    words: ws.map(([wt, a, b, c, d]) => ({ text: wt, xLeft: a, xRight: b, yTop: c, yBottom: d })),
});
const lines: IkiLine[] = [
    L('PVM moketojo kodas LT101937219', [166, 737], [282, 324], [['PVM', 166, 225, 282, 324], ['kodas', 416, 513, 282, 324], ['LT101937219', 521, 737, 282, 324]]),
    L('KETO LENGVAI DUONA SU SEK 2, 59 A', [56, 856], [647, 693], [['KETO', 56, 128, 653, 692], ['LENGVAI', 147, 288, 651, 690], ['2,', 745, 769, 651, 693], ['59', 782, 817, 651, 692], ['A', 837, 854, 651, 692]]),
    L('IKI KORTELĖS NR. 999000111222', [90, 753], [1200, 1248], [['IKI', 90, 146, 1200, 1248], ['KORTELĖS', 153, 304, 1200, 1248], ['NR.', 326, 371, 1200, 1248], ['999000111222', 401, 753, 1200, 1248]]),
    L('Kvito Nr. 71/612/114973 Kasa 0022', [50, 672], [3133, 3202], [['Kvito', 50, 144, 3153, 3198], ['Nr.', 162, 211, 3151, 3193], ['71/612/114973', 242, 486, 3140, 3190]]),
    L('A.P. S/N SM22L0577 2026-06-20 12-20:35', [49, 839], [3362, 3427], [['A.P.', 49, 114, 3371, 3414], ['S/N', 146, 202, 3368, 3410], ['SM22L0577', 222, 390, 3362, 3408]]),
];

describe('IKI — hyphen-garbled time "12-20:35" recovers', () => {
    const res: any = parseIkiReceipt(lines);
    test('time is recovered as 12:20', () => { expect(res.footer.time).toBe('12:20'); });
    test('date is still 2026-06-20 (not mistaken for the time)', () => { expect(res.footer.date).toBe('2026-06-20'); });
    test('a combined dateTime band is drawn', () => {
        expect((res.footer.lineRegions || []).some((r: any) => r.kind === 'dateTime')).toBe(true);
    });
});
