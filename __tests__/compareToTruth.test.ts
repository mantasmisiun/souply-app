import { compareToTruth, type TruthFile, type TruthProduct } from '../utils/compareToTruth';
import type { MaximaProduct } from '../shared/parsers/maximaParser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProduct(overrides: Partial<MaximaProduct> & { name: string; price: number }): MaximaProduct {
    return {
        promoPrice: null,
        quantity: 1,
        unit: 'vnt',
        pricePerUnit: null,
        rawLines: [],
        region: { yTop: 0, yBottom: 0, xLeft: 0, xRight: 0 },
        ...overrides,
    };
}

function makeTruth(products: TruthProduct[], totalAmount = 0): TruthFile {
    return {
        $schema: '',
        source: { pdf: 'test.pdf', annotatedAt: '2024-01-01' },
        store: { chainName: 'Maxima', storeCode: 'VNO01', name: 'Test', address: 'Test' },
        receipt: { receiptNo: '001', date: '2024-01-01', totalAmount, totalSavings: 0 },
        products,
    };
}

function makeTruthProduct(overrides: Partial<TruthProduct> & { name: string; price: number }): TruthProduct {
    return {
        promoPrice: null,
        quantity: 1,
        amount: 1,
        unit: 'vnt',
        isWeighable: false,
        pricePerUnit: null,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// compareToTruth — empty / degenerate cases
// ---------------------------------------------------------------------------

describe('compareToTruth — empty inputs', () => {
    it('returns zero counts when both parsed and truth are empty', () => {
        const result = compareToTruth([], null, makeTruth([]));
        expect(result.productCount).toBe(0);
        expect(result.productsCorrect).toBe(0);
        expect(result.productsMissed).toBe(0);
        expect(result.productsExtra).toBe(0);
        expect(result.score).toBe(0);
    });

    it('marks all truth products as missed when parsed is empty', () => {
        const truth = makeTruth([
            makeTruthProduct({ name: 'Pienas', price: 1.29 }),
            makeTruthProduct({ name: 'Sūris', price: 3.99 }),
        ]);
        const result = compareToTruth([], null, truth);
        expect(result.productsMissed).toBe(2);
        expect(result.productsCorrect).toBe(0);
        expect(result.score).toBe(0);
    });

    it('marks all parsed products as extra when truth is empty', () => {
        const result = compareToTruth(
            [makeProduct({ name: 'Pienas', price: 1.29 })],
            null,
            makeTruth([])
        );
        expect(result.productsExtra).toBe(1);
        expect(result.productsCorrect).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// compareToTruth — perfect match
// ---------------------------------------------------------------------------

describe('compareToTruth — perfect match', () => {
    const parsed = [makeProduct({ name: 'Pienas Dvaras', price: 1.29 })];
    const truth  = makeTruth([makeTruthProduct({ name: 'Pienas Dvaras', price: 1.29 })]);

    it('scores 1.0 for a perfect single-item match', () => {
        const result = compareToTruth(parsed, 1.29, truth);
        expect(result.score).toBe(1.0);
        expect(result.productsCorrect).toBe(1);
        expect(result.productsMissed).toBe(0);
        expect(result.productsExtra).toBe(0);
        expect(result.issues).toHaveLength(0);
    });

    it('pricesCorrect=1 for matching price', () => {
        const result = compareToTruth(parsed, null, truth);
        expect(result.pricesCorrect).toBe(1);
    });

    it('promoPricesCorrect=1 when both promoPrice are null', () => {
        const result = compareToTruth(parsed, null, truth);
        expect(result.promoPricesCorrect).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// compareToTruth — price mismatch
// ---------------------------------------------------------------------------

describe('compareToTruth — price mismatch', () => {
    it('records a price issue when parsed price differs by > 0.01', () => {
        const parsed = [makeProduct({ name: 'Pienas', price: 1.50 })];
        const truth  = makeTruth([makeTruthProduct({ name: 'Pienas', price: 1.29 })]);
        const result = compareToTruth(parsed, null, truth);
        expect(result.pricesCorrect).toBe(0);
        expect(result.productsCorrect).toBe(0);
        expect(result.issues.some(i => i.includes('price='))).toBe(true);
    });

    it('accepts price within 0.01 tolerance', () => {
        const parsed = [makeProduct({ name: 'Pienas', price: 1.295 })];
        const truth  = makeTruth([makeTruthProduct({ name: 'Pienas', price: 1.29 })]);
        const result = compareToTruth(parsed, null, truth);
        expect(result.pricesCorrect).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// compareToTruth — quantity / weighable
// ---------------------------------------------------------------------------

describe('compareToTruth — quantity and weighable', () => {
    it('handles weighable item: parser.quantity = truth.quantity * truth.amount', () => {
        const parsed = [makeProduct({ name: 'Vištiena', price: 4.99, quantity: 1.118, unit: 'kg' })];
        const truth  = makeTruth([makeTruthProduct({
            name: 'Vištiena', price: 4.99, quantity: 1, amount: 1.118, unit: 'kg', isWeighable: true,
        })]);
        const result = compareToTruth(parsed, null, truth);
        expect(result.quantitiesCorrect).toBe(1);
        expect(result.weighableCorrect).toBe(1);
    });

    it('handles multi-pack item: parser.quantity = pack count', () => {
        const parsed = [makeProduct({ name: 'Vanduo', price: 5.98, quantity: 2, unit: 'vnt' })];
        const truth  = makeTruth([makeTruthProduct({
            name: 'Vanduo', price: 5.98, quantity: 2, amount: 1, unit: 'vnt', isWeighable: false,
        })]);
        const result = compareToTruth(parsed, null, truth);
        expect(result.quantitiesCorrect).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// compareToTruth — promoPrice
// ---------------------------------------------------------------------------

describe('compareToTruth — promoPrice', () => {
    it('matches promo prices correctly', () => {
        const parsed = [makeProduct({ name: 'Sūris', price: 3.99, promoPrice: 2.99 })];
        const truth  = makeTruth([makeTruthProduct({ name: 'Sūris', price: 3.99, promoPrice: 2.99 })]);
        const result = compareToTruth(parsed, null, truth);
        expect(result.promoPricesCorrect).toBe(1);
    });

    it('flags mismatch when truth has promoPrice but parsed does not', () => {
        const parsed = [makeProduct({ name: 'Sūris', price: 3.99, promoPrice: null })];
        const truth  = makeTruth([makeTruthProduct({ name: 'Sūris', price: 3.99, promoPrice: 2.99 })]);
        const result = compareToTruth(parsed, null, truth);
        expect(result.promoPricesCorrect).toBe(0);
        expect(result.issues.some(i => i.includes('promoPrice='))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// compareToTruth — name similarity / greedy pairing
// ---------------------------------------------------------------------------

describe('compareToTruth — name similarity and greedy pairing', () => {
    it('pairs products with similar names (minor OCR noise)', () => {
        const parsed = [makeProduct({ name: 'Pienas Dvaras 2.5%', price: 1.29 })];
        const truth  = makeTruth([makeTruthProduct({ name: 'PIENAS DVARAS 2.5%', price: 1.29 })]);
        const result = compareToTruth(parsed, null, truth);
        expect(result.productsCorrect).toBe(1);
    });

    it('does not pair completely different products', () => {
        const parsed = [makeProduct({ name: 'Žuvis', price: 4.00 })];
        const truth  = makeTruth([makeTruthProduct({ name: 'Pienas', price: 1.29 })]);
        const result = compareToTruth(parsed, null, truth);
        expect(result.productsMissed).toBe(1);
        expect(result.productsExtra).toBe(1);
        expect(result.productsCorrect).toBe(0);
    });

    it('greedy pairing: each parsed product used at most once', () => {
        // Two truth products with the same name but different prices.
        // Parsed has two entries — should pair 1:1, not both to the same parsed row.
        const parsed = [
            makeProduct({ name: 'Pienas', price: 1.29 }),
            makeProduct({ name: 'Pienas', price: 1.49 }),
        ];
        const truth = makeTruth([
            makeTruthProduct({ name: 'Pienas', price: 1.29 }),
            makeTruthProduct({ name: 'Pienas', price: 1.49 }),
        ]);
        const result = compareToTruth(parsed, null, truth);
        expect(result.productsMissed).toBe(0);
        expect(result.productsExtra).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// compareToTruth — totalAmountDelta
// ---------------------------------------------------------------------------

describe('compareToTruth — totalAmountDelta', () => {
    it('computes correct delta between parsed and truth totals', () => {
        const truth = makeTruth([makeTruthProduct({ name: 'X', price: 10.00 })], 10.00);
        const result = compareToTruth([], 10.25, truth);
        expect(result.totalAmountDelta).toBeCloseTo(0.25);
    });

    it('returns 0 when parsedTotalAmount is null', () => {
        const truth = makeTruth([makeTruthProduct({ name: 'X', price: 10.00 })], 10.00);
        const result = compareToTruth([], null, truth);
        expect(result.totalAmountDelta).toBe(0);
    });
});
