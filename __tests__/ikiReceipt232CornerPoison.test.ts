import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, robustLineSlope, type IkiLine } from '../shared/parsers/ikiParser';

/**
 * Receipt 232 (clean straight photo, third scan of the ACTO+2×TICHĖ receipt): the DEVICE
 * parse scrambled (interleaved first-product name, water #2 taking the deposit's 0,10,
 * band right edges pivoting UP) while the offline parse of the same words was clean. The
 * device-only difference: LINE CORNER data (yLeftTop/yRightTop), synthesized by mlkitOcr
 * from leftmost-vs-rightmost elements — which on cross-column GLUED lines ("DEPOZI TAS
 * 0, 10") measures the OCR column SHEAR, not the paper tilt. The parser trusted those
 * corners as its de-skew slope and scrambled rows that cluster perfectly at slope 0.
 *
 * The fix: word-derived, gap-capped adjacent-pair slopes (robustLineSlope) everywhere —
 * corners only as a fallback for word-less lines. These tests inject POISONED corners
 * onto the real receipt-232 fixture and assert the parse no longer cares.
 */
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt232.json'), 'utf8'));
const buildLines = (cornerSlope: number | null): IkiLine[] =>
    (pd.wordsDump as any[]).map((d) => {
        const base: IkiLine = {
            text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
            words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
        };
        if (cornerSlope != null) {
            const w = d.x[1] - d.x[0];
            // Poisoned corners: right side lifted by slope×width (negative = up-right).
            (base as any).yLeftTop = d.y[0];
            (base as any).yRightTop = d.y[0] + cornerSlope * w;
            (base as any).yLeftBottom = d.y[1];
            (base as any).yRightBottom = d.y[1] + cornerSlope * w;
        }
        return base;
    });

const expectCleanParse = (res: any) => {
    expect(res.products).toHaveLength(3);
    expect(res.products.map((p: any) => p.price).sort()).toEqual([0.65, 1.69, 1.69]);
    // No interleaved monster name; no product with the deposit's 0,10.
    expect(res.products.some((p: any) => /ACTO/i.test(p.name) && /TICHE/i.test(p.name))).toBe(false);
    expect(res.footer.comboDiscount).toBeCloseTo(1.9, 2);
};

describe('IKI receipt 232 — corner-slope poisoning can no longer scramble the parse', () => {
    test('baseline: corner-less parse is clean (3 products, both waters 1,69)', () => {
        expectCleanParse(parseIkiReceipt(buildLines(null)) as any);
    });

    test('poisoned corners (shear read as tilt, −0.04 up-right) — parse stays clean', () => {
        expectCleanParse(parseIkiReceipt(buildLines(-0.04)) as any);
    });

    test('exaggerated poisoned corners (+0.10) — parse stays clean', () => {
        expectCleanParse(parseIkiReceipt(buildLines(0.10)) as any);
    });

    test('product bands do not pivot upward on the right under poisoned corners', () => {
        const res: any = parseIkiReceipt(buildLines(-0.04));
        for (const p of res.products) {
            const r = p.region;
            // The print tilts DOWN-right (+0.02): the right edge must never sit more
            // than a few px ABOVE the left edge (the stored device bands were 29-40px up).
            expect((r.yRightTop ?? r.yTop) - (r.yLeftTop ?? r.yTop)).toBeGreaterThan(-8);
        }
    });
});

describe('robustLineSlope — shear-proof per-line slope', () => {
    test('measures the true tilt from intra-column adjacent pairs', () => {
        // Three words tilting down-right at +0.02 within one column.
        const words = [
            { xLeft: 50, xRight: 150, yTop: 100 },
            { xLeft: 170, xRight: 300, yTop: 103 },
            { xLeft: 320, xRight: 450, yTop: 106 },
        ];
        expect(robustLineSlope(words)!).toBeCloseTo(0.021, 2);
    });

    test('a cross-column glue pair is excluded — shear does not register as tilt', () => {
        // Name column flat at y100; price column 40px HIGHER across a 400px gap.
        const words = [
            { xLeft: 50, xRight: 150, yTop: 100 },
            { xLeft: 160, xRight: 250, yTop: 101 },
            { xLeft: 700, xRight: 780, yTop: 60 },   // price column, sheared up
            { xLeft: 790, xRight: 840, yTop: 59 },
        ];
        const s = robustLineSlope(words)!;
        expect(Math.abs(s)).toBeLessThan(0.02);      // shear (-40/550 ≈ -0.07) rejected
    });

    test('word-less / single-word lines return null (corner fallback allowed)', () => {
        expect(robustLineSlope(undefined)).toBeNull();
        expect(robustLineSlope([{ xLeft: 0, xRight: 10, yTop: 5 }])).toBeNull();
    });
});
