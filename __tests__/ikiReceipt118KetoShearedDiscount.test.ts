import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 118 — a SHEARED IKI receipt. MAGIJA #2's card discount "-0,26" (right column) de-skews to
// almost exactly KETO #1's NAME row (norm 617 vs 617) and got x-interleaved into it as a "soup row"
// (name + total + discount on one row), minting a phantom KETO promo 2,33. But IKI prints a card
// discount on the line BELOW its price, so a genuine soup's negative sits AT/BELOW its positive
// total; here the -0,26 sits a whole row ABOVE KETO's own 2,59 → it's the PREVIOUS product's,
// sheared down. ikiClassifyRow now keeps the total but hands that above-the-price negative to the
// previous product (trailDisc, deduped) instead of KETO. Neither KETO is discounted on this receipt.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt118.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 118 — sheared card discount does not phantom onto the next product', () => {
    const keto = () => res.products.filter((p: any) => /KETO/i.test(p.name));

    test('both KETO DUONA are €2,59 with NO promo (each bought at full price)', () => {
        const ks = keto();
        expect(ks.length).toBe(2);
        for (const k of ks) {
            expect(k.price).toBeCloseTo(2.59, 2);
            expect(k.promoPrice).toBeNull();   // the sheared -0,26 must NOT land here
        }
    });

    test('MAGIJA #2 keeps its OWN -0,26 (price 0,65 → promo 0,39)', () => {
        // The MAGIJA that parsed cleanly (the other copy is an OCR garble the re-OCR heals on-device).
        const magija = res.products.find((p: any) => /MAGI/i.test(p.name) && p.price != null && p.price > 0);
        expect(magija).toBeTruthy();
        expect(magija.price).toBeCloseTo(0.65, 2);
        expect(magija.promoPrice).toBeCloseTo(0.39, 2);
    });

    test('band bottom-left never dips below the next product name-top (per-column seam)', () => {
        // The per-column tiling: each band's left edge (names live there) tiles seam-to-seam with the
        // next band's left-top, so a name is never clipped. Check every consecutive banded pair.
        const withBand = res.products.filter((p: any) => p.region && p.region.yBottom > p.region.yTop);
        for (let i = 1; i < withBand.length; i++) {
            const upper = withBand[i - 1].region, lower = withBand[i].region;
            const uLB = upper.yLeftBottom ?? upper.yBottom, lLT = lower.yLeftTop ?? lower.yTop;
            expect(uLB).toBeLessThanOrEqual(lLT + 1);
        }
    });
});
