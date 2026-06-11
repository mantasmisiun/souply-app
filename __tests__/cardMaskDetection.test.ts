import {
    detectCardMaskBands,
    redactReceiptText,
    type MaskLineInput,
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

    it('classifies a loyalty card line as loyalty', () => {
        const bands = detectCardMaskBands([L('AČIU kortelė 944000********* 5645')]);
        expect(bands).toHaveLength(1);
        expect(bands[0].kind).toBe('loyalty');
        expect(bands[0].text).not.toMatch(/\d/);
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

    it('leaves separator walls untouched', () => {
        expect(redactReceiptText('************')).toBe('************');
    });

    it('handles empty / null / undefined', () => {
        expect(redactReceiptText('')).toBe('');
        expect(redactReceiptText(null)).toBe('');
        expect(redactReceiptText(undefined)).toBe('');
    });
});
