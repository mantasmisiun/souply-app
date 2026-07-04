import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 295 — two MLKit OCR artifact classes, both folded at the parser ENTRY:
//   • CYRILLIC HOMOGLYPHS: the 2nd Clever loaf's total OCR'd as "0,45 А" with a CYRILLIC
//     А (U+0410). Every VAT-letter lane expects Latin [ABC], so the total was unreadable →
//     the loaf looked totalless → the name-continuation lane FUSED it with the cucumbers
//     ("CLEVER SVIESI RAIKYTA DUO 0,45 А LIETUVISKI ILGAVAISIAI AG", one band, two products).
//   • STRAY UNDERSCORES: "1,992 kg_ X 0,39" — underscore IS a \w char, so `kg\b` failed,
//     the printed quantity was dropped, and the total÷€/kg fallback stored qty 2.000 for a
//     1,992 kg line (a wrong stored weight). Names also carried junk ("VARŠKE,_9%").
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt295.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 295 — Cyrillic homoglyph + underscore OCR artifacts', () => {
    test('5 separate products — the 2nd loaf is NOT fused with the cucumbers', () => {
        expect(res.products).toHaveLength(5);
        const loaves = res.products.filter((p: any) => /RAIKYTA DUO/i.test(p.name));
        expect(loaves).toHaveLength(2);
        for (const l of loaves) {
            expect(l.price).toBeCloseTo(0.45, 2);
            expect(l.name).not.toMatch(/ILGAVAISIAI/i);   // no cucumber text in a loaf name
            expect(l.name).not.toMatch(/\d/);              // no amount baked into the name
        }
        const cuke = res.products.find((p: any) => /ILGAVAISIAI/i.test(p.name));
        expect(cuke).toBeDefined();
        expect(cuke.price).toBeCloseTo(0.99, 2);
        expect(cuke.promoPrice).toBeCloseTo(0.59, 2);
    });

    test('weighed potatoes keep the PRINTED 1,992 kg (not the derived 2,0)', () => {
        const pots = res.products.find((p: any) => /bulv/i.test(p.name));
        expect(pots.unit).toBe('kg');
        expect(pots.quantity).toBeCloseTo(1.992, 3);
        expect(pots.price).toBeCloseTo(0.39, 2);
    });

    test('underscore junk is folded out of product names', () => {
        for (const p of res.products) expect(p.name).not.toMatch(/_/);
        const varske = res.products.find((p: any) => /VARŠKE/i.test(p.name));
        expect(varske.name).toMatch(/VARŠKE, 9%/);
        expect(varske.price).toBeCloseTo(6.49, 2);
        expect(varske.promoPrice).toBeCloseTo(3.99, 2);
    });

    test('fully reconciled: Σ paid = printed 6,05, savings 2,50', () => {
        expect(res.footer.total).toBeCloseTo(6.05, 2);
        expect(res.footer.totalSavings).toBeCloseTo(2.5, 2);
        expect(res.footer.reconciled).toBe(true);
        expect(Math.abs(res.footer.reconDelta)).toBeLessThanOrEqual(0.011);
    });
});
