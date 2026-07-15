import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 398 — GIFT-CARD TOTAL + ORPHAN STACKED DISCOUNT.
// Two compounding failures left this receipt unbalanced and a real discount dropped:
//  1. €0,59 was paid by IKI gift card, so the card slip's "SUMA 11,77 EUR" is only
//     the BANK-paid portion — the true total prints as "Moketi EUR 12 . 36" (spaced
//     decimal). The old Mokėti regex could cross neither the "EUR" between keyword
//     and amount nor the drifting dot, so the wrong 11,77 won by first-match.
//  2. TWO consecutive standalone "-X,XX A NUOLAIDA SU KORTELE" rows: the first
//     (-1,40) attached to the open product; the second (-2,70) tripped the
//     two-A-price flush onto a fresh nameless cur that died in guarded recovery —
//     a real printed discount silently vanished.
// The fix: the assembler hands the orphan amount to reconciliation
// (recon.orphanDiscs), the footer scan remembers DISAGREEING total readings
// (altTotals), and recon switches/attaches ONLY when the books then balance to the
// cent: 6,29 + 2,49 + 2,49 + 1,09 = 12,36 = Mokėti.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt398.json'), 'utf8'));
const lines: IkiLine[] = (pd as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 398 — gift-card total pick + orphan stacked discount', () => {
    test('four products, no phantom from the dropped discount row', () => {
        expect(res.products).toHaveLength(4);
        expect(res.products.every((p: any) => p.name && p.name !== '?')).toBe(true);
    });

    test('the -2,70 orphan attaches to the only product that can absorb it', () => {
        const burnos = res.products.find((p: any) => /Burnos/i.test(p.name));
        expect(burnos.price).toBeCloseTo(8.99, 2);
        expect(burnos.promoPrice).toBeCloseTo(6.29, 2);   // 8,99 − 2,70
    });

    test('the -1,40 stays on the second makaronai (unchanged behaviour)', () => {
        const mak = res.products.filter((p: any) => /MAKARONAI/i.test(p.name));
        expect(mak).toHaveLength(2);
        expect(mak[0].promoPrice).toBeNull();
        expect(mak[1].promoPrice).toBeCloseTo(1.09, 2);   // 2,49 − 1,40
    });

    test('total is the true Mokėti 12,36 (not the bank-slip 11,77) and the books balance', () => {
        expect(res.footer.total).toBeCloseTo(12.36, 2);
        expect(res.footer.reconciled).toBe(true);
        expect(Math.abs(res.footer.reconDelta ?? 1)).toBeLessThanOrEqual(0.011);
    });
});
