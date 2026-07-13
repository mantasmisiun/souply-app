import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 309 — the payment block glyph-shredded every printed copy of the total
// ("Mokėti IU,1", "suapvalinus 10 1O 1"), so the value came from the CASH lane
// (Grynieji 20,00 − Grąža 9,90 = 10,10). That lane derives the total from TWO lines
// and used to push NO band — the photo view showed every band except 'total'.
// Pinned: the cash-lane total now anchors its band on the unreadable Mokėti line.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt309.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 309 — cash-lane total gets a band', () => {
    test('total 10,10 via Grynieji−Grąža, reconciled', () => {
        expect(res.footer.total).toBeCloseTo(10.1, 2);
        expect(res.footer.reconciled).toBe(true);
    });

    test("a 'total' band exists, anchored in the payment block", () => {
        const t = (res.footer.lineRegions ?? []).filter((r: any) => r.kind === 'total');
        expect(t.length).toBeGreaterThanOrEqual(1);
        expect(t[0].yTop).toBeGreaterThan(2000);   // the Mokėti line's zone, not a product row
    });
});
