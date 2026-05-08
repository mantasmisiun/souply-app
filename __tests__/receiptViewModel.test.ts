import { normalizeParsedData, buildReceiptViewModel } from '../utils/receiptViewModel';

// ---------------------------------------------------------------------------
// normalizeParsedData
// ---------------------------------------------------------------------------

describe('normalizeParsedData', () => {
    it('returns null for null/undefined/empty', () => {
        expect(normalizeParsedData(null)).toBeNull();
        expect(normalizeParsedData(undefined)).toBeNull();
        expect(normalizeParsedData('')).toBeNull();
    });

    it('passes through a plain object', () => {
        const obj = { foo: 'bar' };
        expect(normalizeParsedData(obj)).toBe(obj);
    });

    it('parses a valid JSON string', () => {
        const result = normalizeParsedData('{"key":"value"}');
        expect(result).toEqual({ key: 'value' });
    });

    it('returns null for an invalid JSON string', () => {
        expect(normalizeParsedData('not json')).toBeNull();
    });

    it('returns null for a primitive (number, boolean)', () => {
        expect(normalizeParsedData(42)).toBeNull();
        expect(normalizeParsedData(true)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// buildReceiptViewModel
// ---------------------------------------------------------------------------

const FULL_PARSED = {
    header: { chainName: 'Maxima', storeName: 'Maxima Vilnius', storeAddress: 'Gedimino pr. 9' },
    footer: { receiptNo: 'R-001', date: '2024-03-15', time: '14:30', total: 12.50 },
    products: [
        { name: 'Pienas', matchedName: 'Pienas Dvaras', matchConfirmed: true, price: 1.29, promoPrice: null, quantity: 2, unit: 'vnt' },
        { name: 'Sūris', matchedName: null, matchConfirmed: false, price: 3.99, promoPrice: 2.99, quantity: 1, unit: null },
    ],
};

describe('buildReceiptViewModel — happy path', () => {
    const vm = buildReceiptViewModel(FULL_PARSED);

    it('extracts header fields', () => {
        expect(vm.header.chainName).toBe('Maxima');
        expect(vm.header.storeName).toBe('Maxima Vilnius');
        expect(vm.header.storeAddress).toBe('Gedimino pr. 9');
    });

    it('extracts footer fields', () => {
        expect(vm.footer.receiptNo).toBe('R-001');
        expect(vm.footer.date).toBe('2024-03-15');
        expect(vm.footer.time).toBe('14:30');
        expect(vm.footer.total).toBe(12.50);
    });

    it('maps product fields correctly', () => {
        expect(vm.products).toHaveLength(2);
        const p0 = vm.products[0];
        expect(p0.name).toBe('Pienas');
        expect(p0.matchedName).toBe('Pienas Dvaras');
        expect(p0.matchConfirmed).toBe(true);
        expect(p0.price).toBe(1.29);
        expect(p0.promoPrice).toBeNull();
        expect(p0.quantity).toBe(2);
        expect(p0.unit).toBe('vnt');
    });

    it('handles null promoPrice and unit', () => {
        const p1 = vm.products[1];
        expect(p1.promoPrice).toBe(2.99);
        expect(p1.unit).toBeNull();
    });
});

describe('buildReceiptViewModel — fallbacks', () => {
    it('uses fallback chainName when header has none', () => {
        const vm = buildReceiptViewModel(
            { header: {}, footer: {}, products: [] },
            { chainName: 'Rimi' }
        );
        expect(vm.header.chainName).toBe('Rimi');
    });

    it('uses fallback receiptNo when footer has none', () => {
        const vm = buildReceiptViewModel(
            { header: {}, footer: {}, products: [] },
            { receiptNo: 'FB-001' }
        );
        expect(vm.footer.receiptNo).toBe('FB-001');
    });

    it('uses fallback receiptDate when footer has no date', () => {
        const vm = buildReceiptViewModel(
            { header: {}, footer: {}, products: [] },
            { receiptDate: '2024-01-01' }
        );
        expect(vm.footer.date).toBe('2024-01-01');
    });

    it('prefers storeAddressMatched over storeAddress', () => {
        const vm = buildReceiptViewModel({
            header: { storeAddress: 'Old', storeAddressMatched: 'Matched' },
            footer: {}, products: [],
        });
        expect(vm.header.storeAddress).toBe('Matched');
    });

    it('returns empty products array when products is absent', () => {
        const vm = buildReceiptViewModel({ header: {}, footer: {} });
        expect(vm.products).toEqual([]);
    });

    it('handles JSON string input', () => {
        const vm = buildReceiptViewModel(JSON.stringify(FULL_PARSED));
        expect(vm.header.chainName).toBe('Maxima');
        expect(vm.products).toHaveLength(2);
    });

    it('handles null/undefined input gracefully', () => {
        const vm = buildReceiptViewModel(null);
        expect(vm.header.chainName).toBeNull();
        expect(vm.footer.receiptNo).toBeNull();
        expect(vm.products).toEqual([]);
    });

    it('defaults quantity to 1 when missing', () => {
        const vm = buildReceiptViewModel({ header: {}, footer: {}, products: [{ name: 'X', price: 1 }] });
        expect(vm.products[0].quantity).toBe(1);
    });

    it('defaults price to 0 when missing', () => {
        const vm = buildReceiptViewModel({ header: {}, footer: {}, products: [{ name: 'X' }] });
        expect(vm.products[0].price).toBe(0);
    });
});
