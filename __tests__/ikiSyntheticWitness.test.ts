import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// SYNTHETIC-ID DEDUP WITNESS — a scan that LOSES the printed receipt number
// falls back to the deterministic `{date}-{time}-{cents}-iki-receipt` id as
// its only identifier. A second scan of the SAME paper that DOES capture the
// printed number must therefore ALSO carry that synthetic id in receiptNos[],
// or the two rows share no identifier and the duplicate sails through
// (observed: iOS lost the Kvito Nr., Android read it → two receipts). The
// witness is derived from the printed date/time/total, so both scans agree.
const loadLines = (fixture: string): IkiLine[] => {
    const pd = JSON.parse(fs.readFileSync(path.join(__dirname, fixture), 'utf8'));
    return (pd.wordsDump as any[]).map((d) => ({
        text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
        ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
        words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
    }));
};

describe('IKI synthetic-id dedup witness', () => {
    const res: any = parseIkiReceipt(loadLines('fixtures_ikiReceipt309.json'));

    test('receipt with a CAPTURED printed number still carries the synthetic witness', () => {
        expect(res.footer.date).toBeTruthy();
        expect(res.footer.time).toBeTruthy();
        expect(res.footer.total).not.toBeNull();
        const expectedWitness =
            `${res.footer.date.replace(/-/g, '')}-${res.footer.time.replace(/:/g, '')}-${Math.round(res.footer.total * 100)}-iki-receipt`;
        expect(res.footer.receiptNos).toContain(expectedWitness);
    });

    test('canonical stays the printed number — the witness never becomes receiptNos[0]', () => {
        // The printed id was captured on this fixture, so the canonical (which
        // feeds the receiptNoCanonical unique key) must NOT be the synthetic.
        expect(res.footer.receiptNo).not.toContain('-iki-receipt');
        expect(res.footer.receiptNos[0]).toBe(res.footer.receiptNo);
        // A failed-capture scan of the same paper synthesises exactly the
        // witness value — the overlap check meets on it in either scan order.
        expect(res.footer.receiptNos.filter((n: string) => n.endsWith('-iki-receipt')).length).toBe(1);
    });
});
