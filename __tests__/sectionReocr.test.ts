import { sectionReocrAcceptable, graftRicherFields, preserveDroppedRows } from '../utils/sectionReocr';

// Photo product-section re-OCR acceptance: the receipt's own arithmetic is
// the judge — a candidate wins only by reconciling (or measurably shrinking
// the recon gap) without losing products or names.
const P = (n: number, reconciled: boolean | null, reconDelta: number | null, junk = 0) => ({
    products: Array.from({ length: n }, (_, i) => ({ name: i < n - junk ? `Prekė ${i}` : null })),
    footer: { reconciled, reconDelta },
});

describe('sectionReocrAcceptable', () => {
    const flagged = P(13, false, -1.8);

    test('a reconciling candidate wins', () => {
        expect(sectionReocrAcceptable(flagged, P(13, true, 0))).toBe(true);
    });

    test('a smaller recon gap wins even without full reconciliation', () => {
        expect(sectionReocrAcceptable(flagged, P(13, false, -0.4))).toBe(true);
    });

    test('losing a product loses, no matter the arithmetic', () => {
        expect(sectionReocrAcceptable(flagged, P(12, true, 0))).toBe(false);
    });

    test('more junk names loses', () => {
        expect(sectionReocrAcceptable(flagged, P(13, true, 0, 2))).toBe(false);
    });

    test('an equal-or-worse gap keeps the original', () => {
        expect(sectionReocrAcceptable(flagged, P(13, false, -1.8))).toBe(false);
        expect(sectionReocrAcceptable(flagged, P(13, false, 2.5))).toBe(false);
    });
});

describe('preserveDroppedRows', () => {
    // Real ios-55 geometry: the section re-read dropped "MILLER, 250 g".
    // The neighbour AVIZU box y-overlaps its row (skew), but the WORDS don't
    // match — token similarity is what decides coverage.
    const B = (text: string, yTop: number, yBottom: number, xLeft: number, xRight: number) =>
        ({ text, yTop, yBottom, xLeft, xRight });
    const fresh = [
        B('Smulkinti linu sėmenys OLD', 426, 461, 13, 420),
        B('1,99 A', 461, 497, 815, 940),
        B('AVIZU SeLe0OS MALSENA, 300 g', 461, 533, 8, 450),
    ];

    test('a row the re-read dropped survives; rows it re-read do not duplicate', () => {
        const out = preserveDroppedRows([
            B('Smulkinti linu šėmenys OLD', 426, 462, 13, 420),   // covered (same words)
            B('MILLER, 250 g', 458, 497, 13, 300),                 // DROPPED by re-read → preserved
            B('AVIZU SeLe0OS MALSENA, 300 g', 470, 542, 8, 450),   // covered
            B('1,99 A', 462, 498, 815, 940),                       // covered
        ], fresh);
        expect(out.map((l) => l.text)).toEqual(['MILLER, 250 g']);
    });

    test('specks and empty strings never survive', () => {
        const out = preserveDroppedRows([
            B('--', 500, 520, 13, 60),
            B('%..', 510, 528, 500, 540),
        ], fresh);
        expect(out).toHaveLength(0);
    });
});

describe('graftRicherFields', () => {
    // ios-55: the re-read healed every price but DROPPED the "MILLER, 250 g"
    // name row the primary read had. Arithmetic winner keeps the money, the
    // original keeps the words.
    const F = { reconciled: true as const, reconDelta: 0 };

    test('the original longer name + lost pack size graft onto the matched product', () => {
        const original: any = {
            products: [{ name: 'Smulkinti linu šėmenys OLD MILLER', price: 1.99, quantity: 1, parsedAmount: 250, parsedUnit: 'g' }],
            footer: { reconciled: false, reconDelta: -1.8 },
        };
        const candidate: any = {
            products: [{ name: 'Smulkinti linu sėmenys OLD', price: 1.99, quantity: 1, parsedAmount: null, parsedUnit: null }],
            footer: F,
        };
        const out = graftRicherFields(original, candidate);
        expect(out.products[0].name).toBe('Smulkinti linu šėmenys OLD MILLER');
        expect(out.products[0].parsedAmount).toBe(250);
        expect(out.products[0].parsedUnit).toBe('g');
    });

    test('unrelated products at the same price never swap names', () => {
        const original: any = {
            products: [{ name: 'Pienas DVARO', price: 1.99, quantity: 1, parsedAmount: null, parsedUnit: null }],
            footer: { reconciled: false, reconDelta: -1.8 },
        };
        const candidate: any = {
            products: [{ name: 'Sūrelis MAGIJA su vanile ir kakava', price: 1.99, quantity: 1, parsedAmount: null, parsedUnit: null }],
            footer: F,
        };
        const out = graftRicherFields(original, candidate);
        expect(out.products[0].name).toBe('Sūrelis MAGIJA su vanile ir kakava');
    });

    test('the candidate healing a QUANTITY keeps its own product untouched', () => {
        // Citrinos: original q=8.39 (garble), candidate q=0.39 (healed) — the
        // (price, qty) match fails on purpose, nothing grafts.
        const original: any = {
            products: [{ name: 'Citrinos Verna, 1kl', price: 2.49, quantity: 8.39, parsedAmount: 1, parsedUnit: 'kg' }],
            footer: { reconciled: false, reconDelta: -19.9 },
        };
        const candidate: any = {
            products: [{ name: 'Citrinos Verna, 1kl', price: 2.49, quantity: 0.39, parsedAmount: 1, parsedUnit: 'kg' }],
            footer: F,
        };
        const out = graftRicherFields(original, candidate);
        expect(out.products[0].quantity).toBe(0.39);
    });
});
