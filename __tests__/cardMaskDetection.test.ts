import {
    detectCardMaskBands,
    redactReceiptText,
    clampMaskBandsToProtected,
    type MaskLineInput,
    type MaskBand,
} from '../shared/parsers/cardMaskDetection';

// Minimal OCR line builder. Default x-span 0..1000 so x-bound assertions are easy.
const L = (text: string, yTop = 100, xLeft = 0, xRight = 1000): MaskLineInput => ({
    text,
    yTop,
    yBottom: yTop + 24,
    xLeft,
    xRight,
});

describe('detectCardMaskBands', () => {
    it('masks a bank card PAN — label stays, number redacted, no digits leaked', () => {
        const bands = detectCardMaskBands([L('bankine kortele 454792******1937 2,24')]);
        expect(bands).toHaveLength(1);
        expect(bands[0].kind).toBe('bank');
        expect(bands[0].text).toBe('bankine kortele [•••]');
        expect(bands[0].text).not.toMatch(/\d/); // PAN never surfaced
        // Box starts after the label (x-bounded), runs to the line's right edge.
        expect(bands[0].xLeft).toBeGreaterThan(0);
        expect(bands[0].xRight).toBeGreaterThanOrEqual(1000);
    });

    it('anchors the redaction box to the actual PAN word when word boxes exist', () => {
        const line: MaskLineInput = {
            text: 'bankine kortele 454792******1937',
            yTop: 100, yBottom: 130, xLeft: 0, xRight: 1000,
            words: [
                { text: 'bankine', xLeft: 0, xRight: 120, yTop: 100, yBottom: 124 },
                { text: 'kortele', xLeft: 130, xRight: 250, yTop: 101, yBottom: 125 },
                { text: '454792******1937', xLeft: 300, xRight: 620, yTop: 103, yBottom: 127 },
            ],
        };
        const [b] = detectCardMaskBands([line]);
        expect(b.text).toBe('bankine kortele [•••]');
        // Box hugs the PAN word (300–620, padded) — does NOT run to the line edge
        // (1000) like the char→x fallback, and starts after the visible label.
        expect(b.xLeft).toBeGreaterThan(250);
        expect(b.xLeft).toBeLessThan(305);
        expect(b.xRight).toBeGreaterThanOrEqual(620);
        expect(b.xRight).toBeLessThan(720);
        // Y comes from the PAN word itself (padded), so it bends with that word.
        expect(b.yLeftTop).toBeLessThanOrEqual(103);
        expect(b.yLeftBottom).toBeGreaterThanOrEqual(127);
    });

    it('classifies a loyalty card line as loyalty', () => {
        const bands = detectCardMaskBands([L('AČIU kortelė 944000********* 5645')]);
        expect(bands).toHaveLength(1);
        expect(bands[0].kind).toBe('loyalty');
        expect(bands[0].text).not.toMatch(/\d/);
    });

    it('masks an IKI loyalty number printed in FULL (label kept, digits gone)', () => {
        const bands = detectCardMaskBands([L('IKI KORTELĖS NR. 99110000000005068582')]);
        expect(bands).toHaveLength(1);
        expect(bands[0].kind).toBe('loyalty');
        expect(bands[0].text).toBe('IKI KORTELĖS NR. [•••]');
        expect(bands[0].text).not.toMatch(/\d/); // the full number never surfaces
        // Box starts at the number, label to the left stays visible.
        expect(bands[0].xLeft).toBeGreaterThan(0);
    });

    it('masks the cashier name as PII (label kept, value blanked)', () => {
        const bands = detectCardMaskBands([L('Kasininkas Jonas Jonaitis')]);
        expect(bands).toHaveLength(1);
        expect(bands[0].kind).toBe('cashier');
        expect(bands[0].text).toBe('Kasininkas [•••]');
    });

    it('does NOT mask asterisk separator walls (no digit = nothing to hide)', () => {
        expect(detectCardMaskBands([L('************************')])).toHaveLength(0);
        expect(detectCardMaskBands([L('* * * * * * * *')])).toHaveLength(0);
    });

    it('does NOT mask amount / savings / bare-digit lines', () => {
        expect(detectCardMaskBands([L('Atsiskaitymo suma 2,24')])).toHaveLength(0);
        expect(detectCardMaskBands([L('Su AČIU kortele sutaupėte -2,24')])).toHaveLength(0);
        expect(detectCardMaskBands([L('Inv. Nr. 1912-0110-0320-2357')])).toHaveLength(0);
    });

    it('masks a bare masked-PAN line, inheriting bank context from above', () => {
        const bands = detectCardMaskBands([
            L('MOKĖJIMAS KORTELE', 100),
            L('************1937', 140),
        ]);
        expect(bands).toHaveLength(1); // the header line itself is not masked
        expect(bands[0].kind).toBe('bank');
        expect(bands[0].text).toBe('[•••]'); // whole line is the number
    });

    it('merges overlapping same-kind boxes (OCR splitting one row into two)', () => {
        const bands = detectCardMaskBands([
            L('Lojalumo kortelė ****1234', 100),
            L('Lojalumo kortelė ****1234', 110),
        ]);
        expect(bands).toHaveLength(1);
        expect(bands[0].kind).toBe('loyalty');
    });

    it('returns no bands for empty input', () => {
        expect(detectCardMaskBands([])).toEqual([]);
    });

    it('pads the box vertically around the source line', () => {
        const [band] = detectCardMaskBands([L('bankine kortele ****1234', 200)]);
        expect(band.yTop).toBeLessThan(200);
        expect(band.yBottom).toBeGreaterThan(224);
    });
});

describe('redactReceiptText', () => {
    it('blanks card numbers but keeps surrounding lines intact', () => {
        const input = [
            'MOKĖJIMAS KORTELE',
            'bankine kortele 454792******1937',
            'Kvito nr. 12345',
            '2025-11-05',
        ].join('\n');
        const out = redactReceiptText(input);
        expect(out).toContain('bankine kortele [•••]');
        expect(out).not.toContain('454792');
        expect(out).toContain('Kvito nr. 12345'); // bare digits untouched
        expect(out).toContain('2025-11-05');
    });

    it('blanks the cashier name', () => {
        expect(redactReceiptText('Kasininkas Ona')).toBe('Kasininkas [•••]');
    });

    it('blanks an IKI full loyalty number but keeps the label + bare digits', () => {
        const input = [
            'IKI KORTELĖS NR. 99110000000005068582',
            'Inv. Nr. 1912-0110-0320-2357',
        ].join('\n');
        const out = redactReceiptText(input);
        expect(out).toContain('IKI KORTELĖS NR. [•••]');
        expect(out).not.toContain('99110000000005068582');
        expect(out).toContain('Inv. Nr. 1912-0110-0320-2357'); // dashed id untouched
    });

    it('leaves separator walls untouched', () => {
        expect(redactReceiptText('************')).toBe('************');
    });

    it('handles empty / null / undefined', () => {
        expect(redactReceiptText('')).toBe('');
        expect(redactReceiptText(null)).toBe('');
        expect(redactReceiptText(undefined)).toBe('');
    });
});

describe('clampMaskBandsToProtected', () => {
    const mask = (over: Partial<MaskBand> = {}): MaskBand => ({
        yTop: 3145, yBottom: 3197, xLeft: 240, xRight: 544,
        kind: 'cashier', label: 'KASININKAS', reasons: ['kasininkas'], text: '[•••]',
        ...over,
    });

    it('pulls a cashier mask off the receipt-number band above it', () => {
        // receipt-21 geometry: receiptNo band y3118–3159 x83–672, cashier mask
        // y3145–3197 x240–544 → mask top bleeds into the receiptNo band.
        const receiptNo = { yTop: 3118, yBottom: 3159, xLeft: 83, xRight: 672 };
        const [out] = clampMaskBandsToProtected([mask()], [receiptNo]);
        expect(out.yTop).toBe(3159);          // top pushed down to the band's bottom
        expect(out.yBottom).toBe(3197);        // bottom untouched
        // no overlap left with the receiptNo band
        expect(Math.min(out.yBottom, receiptNo.yBottom) - Math.max(out.yTop, receiptNo.yTop))
            .toBeLessThanOrEqual(0);
    });

    it('never clamps past the mask mid-line (PII stays covered)', () => {
        // A protected band that overlaps almost the whole mask must not collapse it.
        const huge = { yTop: 3100, yBottom: 3190, xLeft: 0, xRight: 1000 };
        const [out] = clampMaskBandsToProtected([mask()], [huge]);
        expect(out.yTop).toBe((3145 + 3197) / 2); // capped at mid-line
        expect(out.yBottom).toBe(3197);
    });

    it('ignores protected bands that do not overlap horizontally', () => {
        const elsewhere = { yTop: 3145, yBottom: 3197, xLeft: 600, xRight: 800 };
        const [out] = clampMaskBandsToProtected([mask()], [elsewhere]);
        expect(out.yTop).toBe(3145); // unchanged
        expect(out.yBottom).toBe(3197);
    });

    it('pulls the bottom up when the protected band sits below', () => {
        const below = { yTop: 3185, yBottom: 3230, xLeft: 100, xRight: 600 };
        const [out] = clampMaskBandsToProtected([mask()], [below]);
        expect(out.yBottom).toBe(3185);
        expect(out.yTop).toBe(3145);
    });

    it('keeps the skew corners inside the clamped envelope', () => {
        const tilted = mask({ yLeftTop: 3140, yRightTop: 3150, yLeftBottom: 3200, yRightBottom: 3195 });
        const receiptNo = { yTop: 3118, yBottom: 3159, xLeft: 83, xRight: 672 };
        const [out] = clampMaskBandsToProtected([tilted], [receiptNo]);
        // top corners must not poke above the clamped top (3159)
        expect(out.yLeftTop!).toBeGreaterThanOrEqual(out.yTop);
        expect(out.yRightTop!).toBeGreaterThanOrEqual(out.yTop);
    });

    it('follows a TILTED protected band edge instead of over-pushing to its flat max', () => {
        // receipt-23: receiptNo band tilts (bottom 3120 @x82 → 3100 @x644). A flat
        // clamp to yBottom=3120 pushes the cashier mask down too far and reveals
        // the cashier number's top. Tilt-aware clamp pushes each corner only to
        // the band's interpolated edge at that x.
        const receiptNo = {
            yTop: 3069, yBottom: 3120, xLeft: 82, xRight: 644,
            yLeftTop: 3089, yRightTop: 3069, yLeftBottom: 3120, yRightBottom: 3100,
        };
        const cashier = mask({
            yTop: 3110, yBottom: 3160, xLeft: 238, xRight: 519,
            yLeftTop: 3110, yRightTop: 3110, yLeftBottom: 3160, yRightBottom: 3160,
        });
        const [out] = clampMaskBandsToProtected([cashier], [receiptNo]);
        // left corner nests to the band's bottom edge at x238 (~3114.5), not 3120.
        expect(out.yLeftTop!).toBeCloseTo(3114.4, 0);
        // mask top overall pushed LESS than the flat max (3120) → less PII revealed.
        expect(out.yTop).toBeLessThan(3120);
    });
});

describe('mask skew (quad) plumbing', () => {
    const Lq = (text: string): MaskLineInput => ({
        text, yTop: 100, yBottom: 140, xLeft: 0, xRight: 1000,
        yLeftTop: 100, yRightTop: 110, yLeftBottom: 140, yRightBottom: 150, // right edge 10px lower
    });

    it('mask box bends by the LINE\'s own edge slope over its box width', () => {
        const [b] = detectCardMaskBands([Lq('Kasininkas Jonas Petraitis')]);
        expect(b.kind).toBe('cashier');
        // The box follows the line's own corner slope (10px / 1000 = 0.01),
        // interpolated across the box's own width — both edges parallel.
        const slopeTop = (b.yRightTop! - b.yLeftTop!) / (b.xRight - b.xLeft);
        const slopeBot = (b.yRightBottom! - b.yLeftBottom!) / (b.xRight - b.xLeft);
        expect(slopeTop).toBeCloseTo(0.01, 3);
        expect(slopeBot).toBeCloseTo(0.01, 3);
        // padding pushed top corners up and bottom corners down past the raw line.
        expect(b.yLeftTop!).toBeLessThan(100);
        expect(b.yLeftBottom!).toBeGreaterThan(140);
    });

    it('a SINGLE-word PAN redaction still bends with the line slope (not flat)', () => {
        const line: MaskLineInput = {
            text: 'bankine kortele 454792******1937',
            yTop: 100, yBottom: 140, xLeft: 0, xRight: 1000,
            yLeftTop: 100, yRightTop: 130, yLeftBottom: 140, yRightBottom: 170, // 0.03 slope
            words: [
                { text: 'bankine', xLeft: 0, xRight: 120, yTop: 100, yBottom: 124 },
                { text: 'kortele', xLeft: 130, xRight: 250, yTop: 103, yBottom: 127 },
                { text: '454792******1937', xLeft: 600, xRight: 900, yTop: 118, yBottom: 142 },
            ],
        };
        const [b] = detectCardMaskBands([line]);
        expect(b.kind).toBe('bank');
        // The PAN is ONE word (its own box is flat), yet the redaction tilts by the
        // LINE's slope (0.03) so it follows the curve — the reported bug.
        const slopeTop = (b.yRightTop! - b.yLeftTop!) / (b.xRight - b.xLeft);
        expect(slopeTop).toBeCloseTo(0.03, 2);
        expect(Math.abs(b.yRightTop! - b.yLeftTop!)).toBeGreaterThan(5); // bent, not flat
    });

    it('a FLAT payment row stays a rectangle (no global tilt borrowed → no cross-row slant)', () => {
        const flatCashier: MaskLineInput = {
            text: 'Kasininkas Jonas Petraitis', yTop: 400, yBottom: 440, xLeft: 200, xRight: 625,
            yLeftTop: 400, yRightTop: 400, yLeftBottom: 440, yRightBottom: 440, // FLAT
        };
        const [b] = detectCardMaskBands([flatCashier]);
        expect(b.yRightTop! - b.yLeftTop!).toBeCloseTo(0, 5); // stays flat — not slanted across rows
    });
});
