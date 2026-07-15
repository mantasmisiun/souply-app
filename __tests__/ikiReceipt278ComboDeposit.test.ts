import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 278 — a 2-waters bundle deal. MLKit glued the NEXT printed row's deposit label
// onto the combo line ("RINKINYS -1,90 A DEPOZITAS" — one source line, two printed rows),
// and the source-line deposit test swallowed the whole rebuilt row as a value-less deposit
// skip: the -1,90 vanished, the set was priced in full, and reconciliation ran -1,68 short.
// Pinned mechanisms:
//   • COMBO-vs-DEPOSIT: a bare combo word ahead of a trailing negative is the combo row —
//     a deposit hint living only in the glued source line must not claim it;
//   • deposit charges riding the deposit row's own text ("DEPOZITAS 0, 10") are booked
//     into recon.adjust (they are part of the printed total);
//   • the cash-rounding delta ("Apvalinimo suma 0,02", here sheared onto the "Mokėti
//     suapvalinus" line) is booked too — Σ 4,03 + 0,20 deposits + 0,02 rounding − 1,90
//     combo = the printed 2,35 exactly.
// Layout quirk pinned in passing: this store prints date/time ONLY in the bottom VMI
// fiscal line ("2026-06-29 10:40:11 …") — no "Data … Laikas …" line exists.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt278.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 278 — RINKINYS glued with a deposit label', () => {
    test('exactly the 3 real products, full regular prices, no phantom', () => {
        expect(res.products).toHaveLength(3);
        const prices = res.products.map((p: any) => p.price);
        expect(prices).toEqual([0.65, 1.69, 1.69]);
        for (const p of res.products) {
            expect(p.name).not.toBe('?');
            expect(p.name).not.toMatch(/RINKIN|DEPOZ/i);
        }
    });

    test('the -1,90 lands in footer.comboDiscount — never a product promo', () => {
        expect(res.footer.comboDiscount).toBeCloseTo(1.9, 2);
        for (const p of res.products) expect(p.promoPrice == null).toBe(true);
    });

    test('fully reconciled: deposits (2×0,10) + rounding (0,02) + combo balance to 2,35', () => {
        expect(res.footer.total).toBeCloseTo(2.35, 2);
        expect(res.footer.reconciled).toBe(true);
        expect(Math.abs(res.footer.reconDelta)).toBeLessThanOrEqual(0.011);
    });

    test('date + time recovered from the bottom VMI fiscal line', () => {
        expect(res.footer.date).toBe('2026-06-29');
        expect(res.footer.time).toBe('10:40');
        expect(res.footer.receiptNo).toBe('24/679/86151');
    });
});
