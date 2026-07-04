import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 326 — DEEP-GARBLE stress scan (same purchase as receipts 269/315/316).
// A blurry rescan destroyed something on almost every line; six lanes together
// bring it back to an EXACTLY reconciled parse (Δ0 on the recovered 7,10 total):
//   • "1 ,250 kg" (space BEFORE the comma) reads as 1.25 (T_KG_LEAD/T_KG_QTY tolerance)
//   • "BILLA … ALI 3 49" (comma + VAT letter destroyed) → unknown total, cand 3,49,
//     recon solves it → the BILLA/BULVĖS boundary is restored (was one merged band)
//   • "NUOLAINA SI KORTFLE" + "RAUDONOSIOS PAPRIKOS" in one line, NO amount → the
//     below-the-label word filter recovers the name (dv=0 allowed); the LABEL arms
//     discPending on the product being CLOSED (kopūstai), not the new one
//   • "0,175 kg X 2,49 … 1,18 A" strict-triple contradiction → qty repaired to 0,475
//     (one OCR digit, 1↔4), the strict total untouched
//   • "NUOLAIDA SU KORTELE 25 A -0," shattered negative → head+cents pair → -0,25
//   • Mokėti destroyed → the VAT row "A 21,00 % 5,37 7, 10 1,23" self-validates
//     (7,10 × 21/121 = 1,23 to the cent) → printed total 7,10; the zone guard's
//     amount detector now sees garbled amount shapes so the last discount row
//     stays inside the product zone.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt326.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 326 — deep-garble scan reconciles exactly', () => {
    test('all seven products, separated and named', () => {
        expect(res.products).toHaveLength(7);
        expect(res.products.every((p: any) => p.name && p.name !== '?')).toBe(true);
        const billa = res.products.find((p: any) => /BILLA/.test(p.name));
        expect(billa.name).not.toMatch(/BULVES/);          // boundary restored
        const kop = res.products.find((p: any) => /KOPUSTAT/i.test(p.name));
        expect(kop.name).not.toMatch(/PAPRIK/i);           // paprikos not absorbed
    });

    test('BILLA: shattered "3 49" total solved by recon, discount applied', () => {
        const billa = res.products.find((p: any) => /BILLA/.test(p.name));
        expect(billa.price).toBeCloseTo(3.49, 2);
        expect(billa.promoPrice).toBeCloseTo(2.79, 2);
    });

    test('BULVĖS: garbled 0,175 qty repaired to 0,475 from its own arithmetic', () => {
        const bul = res.products.find((p: any) => /BULVES/.test(p.name));
        expect(bul.quantity).toBeCloseTo(0.475, 3);
        expect(bul.price).toBeCloseTo(2.49, 2);
    });

    test('kopūstai: savings equation pins the invisible -0,51 on the RIGHT product', () => {
        const kop = res.products.find((p: any) => /KOPUSTAT/i.test(p.name));
        expect(kop.quantity).toBeCloseTo(1.25, 3);
        expect(kop.promoPrice).toBeCloseTo(0.98, 2);       // (1,74 − 0,51) ÷ 1,25 — matches r269's pin
        const pap = res.products.find((p: any) => /PAPRIKOS/.test(p.name));
        expect(pap.promoPrice).toBeCloseTo(2.48, 2);       // its own shattered -0,25, not the pin
    });

    test('total 7,10 recovered from the VAT identity; receipt reconciles exactly', () => {
        expect(res.footer.total).toBeCloseTo(7.1, 2);
        expect(res.footer.reconciled).toBe(true);
        expect(Math.abs(res.footer.reconDelta ?? 1)).toBeLessThanOrEqual(0.011);
    });
});
