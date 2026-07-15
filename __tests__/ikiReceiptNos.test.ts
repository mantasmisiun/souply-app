import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// A single IKI receipt prints THREE distinct identifiers: "Kvitas <n>" (terminal line, top of the
// footer), "Kvito Nr. <a/b/c>" (mid), and "Kvito numeris <n>" (VMI block, bottom). footer.receiptNos
// captures all three (canonical "Kvito Nr." FIRST so it stays the dedup key + the value shown), each
// gets its own band, and footer.receiptNo (the backwards-compatible single value) equals receiptNos[0].
const L = (t: string, x: [number, number], y: [number, number], ws: any[][]): IkiLine => ({
    text: t, xLeft: x[0], xRight: x[1], yTop: y[0], yBottom: y[1],
    words: ws.map(([wt, a, b, c, d]) => ({ text: wt, xLeft: a, xRight: b, yTop: c, yBottom: d })),
});

const lines: IkiLine[] = [
    L('IKI Lietuva, UA8', [320, 617], [217, 269], [['IKI', 320, 369, 217, 258], ['Lietuva,', 390, 531, 220, 264]]),
    L('PVM mokėtojo kodas LT101937219', [183, 748], [290, 344], [['PVM', 183, 260, 290, 344], ['kodas', 420, 560, 290, 344], ['LT101937219', 570, 748, 290, 344]]),
    L('LIETUVISKI POMIDORAI', [85, 444], [640, 701], [['LIETUVISKI', 85, 268, 640, 690], ['POMIDORAI', 276, 444, 648, 697]]),
    L('1,99 A', [752, 860], [631, 675], [['1,99', 752, 822, 631, 671], ['A', 842, 860, 631, 671]]),
    L('Prekiautojo ID 15027037', [66, 517], [1116, 1174], [['Prekiautojo', 66, 276, 1116, 1163], ['ID', 296, 330, 1124, 1164], ['15027037', 371, 517, 1127, 1171]]),
    L('Data 2026-06-11 Laikas 21:07:53', [76, 859], [1154, 1223], [['Data', 76, 152, 1154, 1200], ['2026-06-11', 168, 357, 1158, 1207]]),
    L('Contactless Term. 15027037 Kvitas 3157 Atsk 000', [128, 781], [1430, 1529], [['Contactless', 353, 557, 1430, 1478]]),
    L('Kvito Nr. 168/645/104148 Kasa 0027', [58, 698], [3139, 3210], [['Kvito', 58, 153, 3139, 3180], ['Nr.', 173, 220, 3145, 3183], ['168/645/104148', 250, 512, 3149, 3198], ['Kasa', 625, 698, 3168, 3208]]),
    L('Kvito numeris 104148', [72, 435], [3480, 3530], [['Kvito', 72, 166, 3480, 3519], ['numeris', 175, 304, 3480, 3519], ['104148', 326, 435, 3480, 3519]]),
];

describe('IKI footer.receiptNos — multiple identifiers', () => {
    const res: any = parseIkiReceipt(lines);

    test('canonical receiptNo is unchanged (Kvito Nr.) and equals receiptNos[0]', () => {
        expect(res.footer.receiptNo).toBe('168/645/104148');
        expect(res.footer.receiptNos[0]).toBe('168/645/104148');
    });

    test('all three identifiers captured, canonical first, deduped', () => {
        expect(res.footer.receiptNos).toEqual(['168/645/104148', '104148', '3157']);
    });

    test('each identifier gets its own footer band', () => {
        const bands = (res.footer.lineRegions ?? []).filter((r: any) => r.kind === 'receiptNo');
        expect(bands.length).toBe(3);
    });
});
