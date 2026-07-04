import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 229 (re-scan of 228's physical receipt) — the payment block prints with a one-line
// OCR SHEAR: "Apvalinimo suma 2,33" / "Mokėti suapvalinus 0,02" / "Mokestis Suma su PVM 2, 35".
// Two release fixes pinned here:
//   1. TOTAL: the Mokėti branch used to take the sheared rounding delta 0,02 as the total and
//      anchor the kind='total' band on it (then reject the value → Σproducts fallback 4.03).
//      Now a sub-5ct Mokėti amount is a rounding artefact (Lithuanian cash rounding ≤ 4ct):
//      the authoritative "Suma su PVM 2,35" wins, and the band sits on ITS line.
//   2. COMBO: the bare "RINKINYS -1,90" row is a receipt-level set-deal discount. It is not a
//      product and must not become the open product's promo — its magnitude is captured into
//      footer.comboDiscount so totals/savings/comparison can subtract what was actually paid.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt229.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 229 — sheared payment block: total + band land on the real total', () => {
    test('total is the printed Suma-su-PVM 2,35 — not the 0,02 rounding delta, not Σproducts 4.03', () => {
        expect(res.footer.total).toBeCloseTo(2.35, 2);
    });

    test('exactly one total band, anchored on the Suma-su-PVM line (y≈2883-2953), not the 0,02 line', () => {
        const bands = (res.footer.lineRegions || []).filter((r: any) => r.kind === 'total');
        expect(bands).toHaveLength(1);
        // The 0,02 words sit at y2867-2912 on the "Mokėti suapvalinus" line (y2848-2918);
        // the Suma-su-PVM line frame is y2883-2953. Anchor mid-band below the 0,02 words' top.
        const mid = (bands[0].yTop + bands[0].yBottom) / 2;
        expect(mid).toBeGreaterThan(2880);
    });
});

describe('IKI receipt 229 — bare RINKINYS deal → footer.comboDiscount', () => {
    test('comboDiscount captures the -1,90 set-deal amount', () => {
        expect(res.footer.comboDiscount).toBeCloseTo(1.9, 2);
    });

    test('the 3 real products keep clean prices — no product absorbed the deal discount', () => {
        expect(res.products).toHaveLength(3);
        expect(res.products.map((p: any) => p.price).sort()).toEqual([0.65, 1.69, 1.69]);
        expect(res.products.every((p: any) => p.promoPrice == null)).toBe(true);
    });

    test('no bare RINKINYS product; the row survives as a grey skip band', () => {
        expect(res.products.some((p: any) => /^RINK/i.test(p.name.trim()))).toBe(false);
        expect((res.skippedRegions || []).length).toBeGreaterThanOrEqual(1);
    });
});
