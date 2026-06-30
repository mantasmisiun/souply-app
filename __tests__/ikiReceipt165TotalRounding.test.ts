import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 165 — a doubled / badly-blurred IKI scan whose PRODUCT section was unrecoverable (the
// items OCR'd as garbage) but whose footer read OK. Two separate bugs it exercises:
//   1. TOTAL: the footer prints "Mokėt i 2,28" (Mokėti, OCR-split), "Apvalinimo suma 0,02" (rounding),
//      "Mokėti suapvalinus 2,30" (rounded to pay). The OLD parser stored the total as 0,02 — it picked
//      up the rounding line. The current parser's Mokėti handler tolerates the split keyword ("Mokėt i")
//      and takes the FIRST POSITIVE amount, so the total is the real 2,28, never the 0,02 rounding.
//   2. NO PRODUCTS: the parse yields zero products → the receipt-process flow gates this with a
//      "retake the photo" prompt instead of saving an empty receipt (verified there, not here).
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt165.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 165 — total is the Mokėti amount, never the Apvalinimo rounding', () => {
    test('footer total is 2,28 (Mokėti), NOT 0,02 (Apvalinimo suma rounding)', () => {
        expect(res.footer.total).toBeCloseTo(2.28, 2);
        expect(res.footer.total).not.toBeCloseTo(0.02, 2);
    });

    test('the garbled product section yields zero products (the no-products gate catches this)', () => {
        expect(res.products).toHaveLength(0);
    });
});
