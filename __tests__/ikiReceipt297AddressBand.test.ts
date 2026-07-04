import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 297 — the header was almost destroyed ("Inius Saulėt", "7219 PVM" — the VAT
// code fragment BEFORE its label). Two band bugs:
//   • the VAT boundary was missed (the old fallback required the line to START with
//     "PVM"), so the address scan's 4-line fallback reached the FIRST PRODUCT and
//     accepted "0,65 AKVILE GAZ" as the store address — banding the product's row as
//     the header, and pushing the product band down onto the discount/deposit rows;
//   • an address candidate is now rejected when it is PRICE-SHAPED (a decimal amount
//     at the line's start or end) — a product shape, never an address.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt297.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 297 — product line must never become the address band', () => {
    test('no product text in storeAddress, no storeAddress band on a product row', () => {
        expect(res.header.storeAddress).not.toMatch(/AKVILE|0,65/i);
        const addrBands = (res.header.lineRegions ?? []).filter((r: any) => r.kind === 'storeAddress');
        // The header is genuinely unreadable here — the honest answer is NO address band.
        expect(addrBands).toHaveLength(0);
    });

    test('the product keeps its own rows: name + discount + deposit under ONE band', () => {
        expect(res.products).toHaveLength(1);
        const p = res.products[0];
        expect(p.name).toMatch(/AKVILE/i);
        expect(p.price).toBeCloseTo(0.65, 2);
        expect(p.promoPrice).toBeCloseTo(0.32, 2);        // -0,33 discount
        // Band tops at the product's own name row (~y372), not above it in the header.
        expect(p.region.yTop).toBeGreaterThan(330);
    });

    test('reconciled to the printed 0,42', () => {
        expect(res.footer.total).toBeCloseTo(0.42, 2);
        expect(res.footer.reconciled).toBe(true);
    });
});
