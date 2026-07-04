import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 234 — a short smudged receipt (1 product) whose whole payment TRAILER assembled into a
// phantom second product: "wuniuy uU KURTELA Pr ckiautojo ID 15088032 Data 2026-07-02 Laikas
// 08:47:50", price 0. Three garbles compounded:
//   1. The trader-id boundary line printed "Prekiautojo" with a rotted e ("Pr ckiautojo") — the
//      strict /Prekia/ stem missed it, so the product zone did not END there. Fixed by
//      T_TRADER_GARBLED_RE (/Pr.?kiaut/ on the despaced text), which only counts WITH the
//      trader number / uppercase-ID confirmation.
//   2. The "Data YYYY-MM-DD Laikas HH:MM:SS" line is now a products-end BACKSTOP wall in
//      T_PRODUCTS_END_RE — even if the trader stem rots past both skeletons, the zone ends here.
//   3. The smudged discount label read "…KURTELA" (O→U): T_KORTELE_RE now folds K[O0U]RT[EF][LI1],
//      so the label residue left after its "-2,75 A" attached to the product is recognised as a
//      label tail instead of seeding a phantom product name.
//
// First receipt whose wordsDump carries line CORNERS (`c: [yLT,yRT,yLB,yRB]`) — mapping them onto
// IkiLine reproduces the device parse byte-for-byte offline.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt234.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 234 — garbled trailer must not assemble into a phantom product', () => {
    test('exactly ONE product: the Colgate with its card discount applied', () => {
        expect(res.products).toHaveLength(1);
        expect(res.products[0].name).toMatch(/COL\s?GATE/i);
        expect(res.products[0].price).toBeCloseTo(5.49, 2);
        expect(res.products[0].promoPrice).toBeCloseTo(2.74, 2);
    });

    test('no product carries trailer text (trader id / Data / Laikas / the KURTELA label garble)', () => {
        for (const p of res.products) {
            expect(p.name).not.toMatch(/kiautojo|Laikas|KURTELA|\b20\d{2}-\d{2}/i);
        }
    });

    test('the smudged discount LINE is inside the product band (amount captured → row captured)', () => {
        // Discount line frame: y357-411. The single product's band must extend over it.
        expect(res.products[0].region.yBottom).toBeGreaterThan(400);
        expect(res.products[0].region.yTop).toBeLessThan(357);
    });

    test('footer still parses past the walls: total 2,74 + date/time from the trailer line', () => {
        expect(res.footer.total).toBeCloseTo(2.74, 2);
        expect(res.footer.date).toBe('2026-07-02');
        expect(res.footer.time).toBe('08:47');
    });
});
