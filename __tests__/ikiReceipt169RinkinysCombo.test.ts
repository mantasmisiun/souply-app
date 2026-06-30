import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 169 — a tightly-printed IKI receipt (ACTO + 2× TICHĖ water, each with a bottle DEPOZITAS,
// plus a "RINKINYS -1,90" combo-set discount). Two distinct concerns:
//   1. RINKINYS: a BARE "RINKINYS" line is IKI's combo/set deal DISCOUNT, not a product — it must be
//      dropped (a real product always qualifies the word: "ŽALUMYNŲ RINKINYS"). The recognition layer
//      otherwise matched it to a real "Žalumynų rinkinys" (high confidence), so the prod confidence
//      filter wouldn't catch it — it has to be skipped in the parser. (This is what THIS test pins.)
//   2. The overlapping product names band-merge ("TICHĖ" fuses into the ACTO band) and a deposit drops
//      to a stray "?" — these are the OCR/band-clustering ceiling. They come out as band-S3
//      (low-confidence) lines, which the receipt-process flow hides on PRODUCTION (shown on
//      dev/staging with a "hidden on production" marker). That filter is verified in the flow, not here.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt169.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 169 — a bare RINKINYS combo discount is dropped, not a product', () => {
    test('no product is the bare "RINKINYS" combo line', () => {
        expect(res.products.some((p: any) => p.name.trim().toUpperCase() === 'RINKINYS')).toBe(false);
    });

    test('the real TICHĖ water survives at €1,69', () => {
        const tiche = res.products.find((p: any) => /NEGAZUOTA/i.test(p.name) && Math.abs(p.price - 1.69) < 0.01);
        expect(tiche).toBeTruthy();
    });
});
