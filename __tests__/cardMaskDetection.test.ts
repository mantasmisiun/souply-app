import {
    detectCardMaskBands,
    redactReceiptText,
    clampMaskBandsToProtected,
    wordCentreInMaskBand,
    looksLikePiiText,
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

    it('a WIDE protected band Y-overlapping the PAN cannot expose the card number (per-corner containment + PII cap)', () => {
        // PAN mask x26–607; the card digits run y1150..1231 (piiTop/piiBottom).
        const panMask: MaskBand = {
            yTop: 1140, yBottom: 1245, xLeft: 26, xRight: 607, kind: 'bank',
            label: 'BANKAS', reasons: ['masked-number'], text: '[•••]',
            yLeftTop: 1150, yRightTop: 1130, yLeftBottom: 1241, yRightBottom: 1221,
            piiTop: 1150, piiBottom: 1231,
        };
        // (1) a band that SPANS the whole PAN (x0–700) and overlaps below: both corners
        // are inside, the clamp runs, but the PII cap stops the bottom above y1231.
        const spanning = { yTop: 1200, yBottom: 1290, xLeft: 0, xRight: 700 };
        const [a] = clampMaskBandsToProtected([panMask], [spanning]);
        expect(a.yLeftBottom).toBeGreaterThanOrEqual(1231);
        expect(a.yRightBottom).toBeGreaterThanOrEqual(1231);
        // (2) a band covering the PAN's right portion (x300–1401): the far-left corner
        // (x26, outside x300–1401) is PINNED — never extrapolated up off the card number.
        const rightPart = { yTop: 1200, yBottom: 1290, xLeft: 300, xRight: 1401 };
        const [b] = clampMaskBandsToProtected([panMask], [rightPart]);
        expect(b.yLeftBottom).toBe(1241); // pinned
        expect(b.yRightBottom).toBeGreaterThanOrEqual(1231); // PAN still covered
    });

    it('does NOT clamp a mask that only EDGE-clips a protected band (PII stays fully covered)', () => {
        // PAN mask x26–607; a "total" band x575–1401 overlaps only the mask's right edge
        // (~32px, <35% of either band). Clamping there would pull the whole mask up off
        // the card number — receipt-77's exposed-bottom bug. Must leave the mask intact.
        const panMask: MaskBand = {
            yTop: 1100, yBottom: 1240, xLeft: 26, xRight: 607, kind: 'bank',
            label: 'BANKAS', reasons: ['masked-number'], text: '[•••]',
            yLeftTop: 1110, yRightTop: 1095, yLeftBottom: 1240, yRightBottom: 1225,
        };
        const total = { yTop: 1194, yBottom: 1303, xLeft: 575, xRight: 1401 };
        const [out] = clampMaskBandsToProtected([panMask], [total]);
        expect(out.yLeftBottom).toBe(1240); // full PAN still covered, bottom not pulled up
        expect(out.yRightBottom).toBe(1225);
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
    it('mask box bends by the masked WORDS / receipt tilt (line cornerPoints are unreliable)', () => {
        // MLKit reports the LINE corners FLAT even though the printed row tilts — the
        // bend must come from the per-WORD boxes (or the receipt reference tilt) instead.
        const line: MaskLineInput = {
            text: 'Kasininkas Jonas Petraitis',
            yTop: 100, yBottom: 140, xLeft: 0, xRight: 1000,
            yLeftTop: 100, yRightTop: 100, yLeftBottom: 140, yRightBottom: 140, // FLAT line corners
            words: [
                { text: 'Kasininkas', xLeft: 0, xRight: 200, yTop: 100, yBottom: 124 },
                { text: 'Jonas', xLeft: 300, xRight: 450, yTop: 112, yBottom: 136 },
                { text: 'Petraitis', xLeft: 700, xRight: 950, yTop: 124, yBottom: 148 },
            ],
        };
        const [b] = detectCardMaskBands([line]);
        expect(b.kind).toBe('cashier');
        const slopeTop = (b.yRightTop! - b.yLeftTop!) / (b.xRight - b.xLeft);
        const slopeBot = (b.yRightBottom! - b.yLeftBottom!) / (b.xRight - b.xLeft);
        // bends following the WORDS even though the line corners are flat; edges parallel
        expect(slopeTop).toBeGreaterThan(0.015);
        expect(slopeBot).toBeCloseTo(slopeTop, 3);
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

describe('curved-receipt local-slope masks (receipt-83)', () => {
    it('bank PAN mask uses the LOCAL (gentle) slope near a curved receipt\'s top and fully covers the PAN', () => {
        const lines: MaskLineInput[] = [
            // WIDE flat top sample (y~454) + WIDE steep bottom sample (y~2740) → local slope at
            // y~1207 interpolates to a GENTLE tilt, not the steep global median
            {
                text: 'oketojo kodas LT101937219', yTop: 454, yBottom: 516, xLeft: 372, xRight: 1215,
                words: [{ text: 'oketojo', xLeft: 372, xRight: 634, yTop: 454, yBottom: 516 }, { text: 'LT101937219', xLeft: 870, xRight: 1215, yTop: 454, yBottom: 516 }],
            },
            {
                text: 'Su IKI KORTELE suteikta', yTop: 2661, yBottom: 2892, xLeft: 75, xRight: 1326,
                words: [{ text: 'Su', xLeft: 75, xRight: 153, yTop: 2819, yBottom: 2892 }, { text: 'suteikta', xLeft: 1060, xRight: 1326, yTop: 2661, yBottom: 2759 }],
            },
            // bank context so the PAN classifies as 'bank'
            { text: 'A0000000041010 - MASTERCARD', yTop: 1056, yBottom: 1155, xLeft: 17, xRight: 990 },
            // the masked PAN — a single starred word at y1207-1297
            {
                text: 'X*XXXX*X*9003', yTop: 1207, yBottom: 1297, xLeft: 17, xRight: 615,
                words: [{ text: 'X*XXXX*X*9003', xLeft: 17, xRight: 615, yTop: 1207, yBottom: 1297 }],
            },
        ];
        const bank = detectCardMaskBands(lines).find((b) => b.kind === 'bank')!;
        expect(bank).toBeTruthy();
        // The band is now a tilted GLYPH strip (not the inflated bbox), so it spans from above
        // the highest glyph (the bbox top, 1207, at the up-tilted right) to below the lowest
        // (the bbox bottom, 1297, at the down-tilted left) — fully covering the PAN. The steep
        // global tilt used to lift the right edge and barely-expose the end; this closes it.
        expect(bank.yTop).toBeLessThanOrEqual(1207);
        expect(bank.yBottom).toBeGreaterThanOrEqual(1297);
    });

    it('loyalty mask with STAGGERED fragments uses a FLAT envelope — focused on the digits, not lifted above', () => {
        const lines: MaskLineInput[] = [
            // loyalty number split into two STAGGERED fragments (tops differ 72px > 0.5·height)
            {
                text: 'kortele nr 99110000 000005068582', yTop: 1995, yBottom: 2147, xLeft: 80, xRight: 1360,
                words: [
                    { text: 'kortele', xLeft: 80, xRight: 300, yTop: 2120, yBottom: 2200 },
                    { text: 'nr', xLeft: 320, xRight: 400, yTop: 2110, yBottom: 2185 },
                    { text: '99110000', xLeft: 500, xRight: 633, yTop: 2067, yBottom: 2147 },     // left frag, LOWER
                    { text: '000005068582', xLeft: 686, xRight: 1340, yTop: 1995, yBottom: 2133 }, // right frag, HIGHER
                ],
            },
        ];
        const loyalty = detectCardMaskBands(lines).find((b) => b.kind === 'loyalty')!;
        expect(loyalty).toBeTruthy();
        // staggered fragments → FLAT envelope (no tilt that would lift a corner off a fragment)
        expect(Math.abs(loyalty.yLeftTop! - loyalty.yRightTop!)).toBeLessThan(2);
        // FOCUSED: top sits just above the PII top (~1995, only the pad), NOT lifted ~120px
        // above the way the min-anchor + steep tilt did (the bug's top was 1872).
        expect(loyalty.yTop).toBeGreaterThan(1940);
        // …and still COVERS every fragment (top ≤ highest fragment top, bottom ≥ lowest)
        expect(loyalty.yTop).toBeLessThanOrEqual(1995);
        expect(loyalty.yBottom).toBeGreaterThanOrEqual(2147);
    });

    it('loyalty mask is a THIN strip hugging the digits — not inflated over the line above (receipt-84)', () => {
        const lines: MaskLineInput[] = [
            // a line printed directly ABOVE the loyalty number that must stay uncovered
            { text: 'Pirkimo data 2026-06-22', yTop: 1080, yBottom: 1160, xLeft: 80, xRight: 1100 },
            // the IKI loyalty number — clean single row, near-flat
            {
                text: 'IKI korteles nr. 99110000000005068582', yTop: 1200, yBottom: 1280, xLeft: 80, xRight: 1340,
                words: [
                    { text: 'IKI', xLeft: 80, xRight: 180, yTop: 1200, yBottom: 1280 },
                    { text: 'korteles', xLeft: 200, xRight: 420, yTop: 1200, yBottom: 1280 },
                    { text: 'nr.', xLeft: 440, xRight: 520, yTop: 1200, yBottom: 1280 },
                    { text: '99110000000005068582', xLeft: 560, xRight: 1340, yTop: 1200, yBottom: 1280 },
                ],
            },
        ];
        const loyalty = detectCardMaskBands(lines).find((b) => b.kind === 'loyalty')!;
        expect(loyalty).toBeTruthy();
        // COVERS the digits (1200-1280)…
        expect(loyalty.yTop).toBeLessThanOrEqual(1200);
        expect(loyalty.yBottom).toBeGreaterThanOrEqual(1280);
        // …but is THIN: only the value height (80) + small pad, NOT inflated up into the
        // line above (1080-1160). Glyph-strip height should stay well under 1.7× the digits.
        const h = loyalty.yBottom! - loyalty.yTop!;
        expect(h).toBeLessThan(80 * 1.7);
        // and its top never reaches the line above
        expect(loyalty.yTop).toBeGreaterThan(1160);
    });
});

describe('wordsDump PII redaction (wordsDump ships in staging+prod)', () => {
    it('wordCentreInMaskBand flags a word whose CENTRE is inside the band, not an edge-clipper', () => {
        const band: MaskBand = {
            yTop: 1000, yBottom: 1100, xLeft: 20, xRight: 580, kind: 'bank',
            label: 'BANKAS', reasons: ['masked-number'], text: '[•••]',
            yLeftTop: 1010, yRightTop: 990, yLeftBottom: 1100, yRightBottom: 1080,
            piiTop: 1005, piiBottom: 1095,
        };
        // the PAN word, centre squarely inside
        expect(wordCentreInMaskBand({ xLeft: 30, xRight: 540, yTop: 1020, yBottom: 1090 }, [band])).toBe(true);
        // centre reaches the band only via the skew-corner union top (yRightTop 990)
        expect(wordCentreInMaskBand({ xLeft: 30, xRight: 540, yTop: 980, yBottom: 1000 }, [band])).toBe(true);
        // a product word far above → centre outside
        expect(wordCentreInMaskBand({ xLeft: 30, xRight: 540, yTop: 500, yBottom: 560 }, [band])).toBe(false);
        // x-disjoint → outside
        expect(wordCentreInMaskBand({ xLeft: 700, xRight: 900, yTop: 1020, yBottom: 1090 }, [band])).toBe(false);
        // "Pardavimas"-style: EDGE-clips the band x by a few px but its centre is well to the
        // right (x685) → NOT redacted. This is the receipt-81 over-redaction fix.
        expect(wordCentreInMaskBand({ xLeft: 537, xRight: 833, yTop: 1040, yBottom: 1095 }, [band])).toBe(false);
    });

    it('looksLikePiiText catches loyalty/card numbers but NOT trader IDs or product words', () => {
        expect(looksLikePiiText('99110000000005068582')).toBe(true);  // 20-digit loyalty number
        expect(looksLikePiiText('X*****xX***9003')).toBe(true);        // star-masked PAN
        expect(looksLikePiiText('15001934')).toBe(false);              // 8-digit trader ID stays clear
        expect(looksLikePiiText('NATURALUS')).toBe(false);
        expect(looksLikePiiText('1,05')).toBe(false);
    });

    it('end-to-end: a real loyalty-number word is flagged PII (band overlap OR text), the label is not', () => {
        const lines: MaskLineInput[] = [
            {
                text: 'IKI KORTELĖS NR. 99110000000005068582', yTop: 1800, yBottom: 1920, xLeft: 80, xRight: 1240,
                words: [
                    { text: 'IKI', xLeft: 80, xRight: 175, yTop: 1880, yBottom: 1950 },
                    { text: 'KORTELĖS', xLeft: 200, xRight: 470, yTop: 1865, yBottom: 1945 },
                    { text: 'NR.', xLeft: 500, xRight: 570, yTop: 1860, yBottom: 1925 },
                    { text: '99110000000005068582', xLeft: 620, xRight: 1240, yTop: 1815, yBottom: 1920 },
                ],
            },
        ];
        const bands = detectCardMaskBands(lines);
        expect(bands.length).toBeGreaterThan(0);
        const num = lines[0].words![3];
        expect(wordCentreInMaskBand(num, bands) || looksLikePiiText(num.text)).toBe(true);
        const label = lines[0].words![0]; // "IKI"
        expect(looksLikePiiText(label.text)).toBe(false);
    });
});
