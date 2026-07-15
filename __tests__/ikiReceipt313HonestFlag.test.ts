import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 313 — two pinned behaviours:
//   • REVERSED COMPANY ORDER: "UAB IKI Lietuva, Vilniaus g. 220-1, Siauliai" — the old
//     strip only consumed a "…Lietuva, UAB" suffix, so the fused line was vetoed by the
//     "Lietuva" reject and the address (clearly printed) had no band and never matched.
//   • HONEST FLAG over FALSE SOLVE: Vision scattered grietinė's "-0,84" and KETO#1's
//     fragments into Magija#1's row group ("MAGIJA … 0,65 84 A A"). The single-unknown
//     reconciliation solve used to absorb the swallowed neighbour's money (3,25) and
//     declare the receipt reconciled — masking the mis-segmentation from the user AND
//     from the Phase-5 ensemble gate. A name with embedded amount tokens now blocks the
//     solve: the receipt flags honestly and the ensemble owns the structural repair.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt313.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 313 — reversed company address + honest mis-segmentation flag', () => {
    test('address extracted from the "UAB IKI Lietuva, <addr>" fused line, with its own band', () => {
        expect(res.header.storeAddress).toMatch(/Vilniaus g\. 220-1/);
        const kinds = (res.header.lineRegions ?? []).map((r: any) => r.kind);
        expect(kinds).toContain('storeAddress');
        expect(kinds).toContain('storeCode');
    });

    test('the mis-segmented unknown is NOT solved — receipt flags instead of falsely reconciling', () => {
        expect(res.footer.reconciled).toBe(false);
        expect(Math.abs(res.footer.reconDelta)).toBeGreaterThan(1);
        const junk = res.products.find((p: any) => /\d[.,]\s?\d{2}/.test(p.name ?? ''));
        expect(junk).toBeDefined();
        expect(junk.price).toBe(0);   // honest unknown, never a fabricated 3,25
    });

    test('the clean products still parse fully', () => {
        const lav = res.products.find((p: any) => /LAVAZZA/i.test(p.name));
        expect(lav.price).toBeCloseTo(9.99, 2);
        expect(lav.promoPrice).toBeCloseTo(5.49, 2);
        const cuk = res.products.find((p: any) => /cukinijos/i.test(p.name));
        expect(cuk.promoPrice).toBeCloseTo(0.59, 2);
    });
});
