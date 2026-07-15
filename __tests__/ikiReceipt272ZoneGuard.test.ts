import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 272 — the products-end walls BOTH garbled past their patterns ("IKI KORTELES NA",
// R→A; "PVM saskaLtos-fakt", i→l) and 15 marketing/trailer lines glued into one price-0
// phantom product whose 200-char name then hung the matcher. Pinned here:
//   • the garble-tolerant walls (N[RA], s[aą]ska[il1]t);
//   • the STRUCTURAL ZONE GUARD: whatever the keyword walls miss, the zone is trimmed to
//     shortly after the LAST amount-bearing line — trailer text can never become products;
//   • the "SU -0,26 A <NAME>" lead-discount shape (the label row sheds its "SU" onto the
//     discount line) parses as a discount + next name, not a name swallow.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt272.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 272 — trailer can never become a product', () => {
    test('no product carries trailer/marketing text', () => {
        for (const p of res.products) {
            expect(p.name).not.toMatch(/saskait|sutaup|Sveikiname|programele|telefonu|informacij/i);
        }
    });

    test('no mega-product: every product covers a sane number of lines', () => {
        for (const p of res.products) {
            expect((p.rawLines ?? []).length).toBeLessThanOrEqual(6);
            expect(p.name.length).toBeLessThanOrEqual(80);
        }
    });

    test('footer still parses fully from the trailer (walls only bound the PRODUCT zone)', () => {
        expect(res.footer.total).toBeCloseTo(18.45, 2);
        expect(res.footer.totalSavings).toBeCloseTo(8.96, 2);
        expect(res.footer.date).toBe('2026-06-20');
        expect(res.footer.receiptNo).toContain('114972');
    });

    test('reconciliation flags the known dense-pitch miss instead of silently passing', () => {
        // This scan's second Magija is lost to a name+label cluster merge (open clustering
        // class) — the receipt must NOT reconcile, and the delta must point at the miss.
        expect(res.footer.reconciled).toBe(false);
        expect(Math.abs(res.footer.reconDelta)).toBeGreaterThan(0.3);
    });
});
