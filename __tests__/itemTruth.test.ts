import { compareItemTruth, truthFromParsed, type ItemTruthFile } from '../utils/itemTruth';

const T = (over: Partial<ReturnType<typeof truthFromParsed>> = {}) => ({
    name: 'Makaronai RIMI SMART FUSILLI', price: 4.99, promoPrice: null, quantity: 2,
    unit: 'vnt', parsedAmount: 400, parsedUnit: 'g', checkedAt: 't', ...over,
});
const file = (products: any[], footer: any = null): ItemTruthFile =>
    ({ version: 2, source: 'x.pdf', products, footer });

describe('compareItemTruth', () => {
    test('no truth → everything unchecked, summary none', () => {
        const c = compareItemTruth(null, [{ name: 'A', price: 1 }], null);
        expect(c.perProduct[0].state).toBe('unchecked');
        expect(c.summary).toBe('none');
    });

    test('assertion matches → match; unasserted stays unchecked → partial', () => {
        const c = compareItemTruth(file([T()]), [
            { name: 'Makaronai RIMI SMART FUSILLI', price: 4.99, promoPrice: null, quantity: 2, unit: 'vnt', parsedAmount: 400, parsedUnit: 'g' },
            { name: 'Pienas DVARO', price: 1.09, quantity: 1, unit: 'vnt' },
        ], null);
        expect(c.perProduct[0].state).toBe('match');
        expect(c.perProduct[1].state).toBe('unchecked');
        expect(c.summary).toBe('partial');
    });

    test('a changed field flags differ with a named diff → attention', () => {
        const c = compareItemTruth(file([T()]), [
            { name: 'Makaronai RIMI SMART FUSILLI', price: 4.99, promoPrice: null, quantity: 2, unit: 'vnt', parsedAmount: null, parsedUnit: null },
        ], null);
        expect(c.perProduct[0].state).toBe('differ');
        expect(c.perProduct[0].diffs.join()).toContain('amount');
        expect(c.summary).toBe('attention');
    });

    test('matching survives index shifts (identity = name + price/qty, not position)', () => {
        const c = compareItemTruth(file([T()]), [
            { name: 'Pienas DVARO', price: 1.09, quantity: 1, unit: 'vnt' },
            { name: 'Makaronai RIMI SMART FUSILLI', price: 4.99, promoPrice: null, quantity: 2, unit: 'vnt', parsedAmount: 400, parsedUnit: 'g' },
        ], null);
        expect(c.perProduct[1].state).toBe('match');
    });

    test('a truth product the parse LOST reports as missing → attention', () => {
        const c = compareItemTruth(file([T(), T({ name: 'Linu sėmenys RIMI', price: 1.75, quantity: 2, parsedAmount: 200 })]), [
            { name: 'Makaronai RIMI SMART FUSILLI', price: 4.99, promoPrice: null, quantity: 2, unit: 'vnt', parsedAmount: 400, parsedUnit: 'g' },
        ], null);
        expect(c.missing).toHaveLength(1);
        expect(c.missing[0].name).toContain('Linu');
        expect(c.summary).toBe('attention');
    });

    test('footer assertion: recon regression flags even when all products match', () => {
        const c = compareItemTruth(
            file([T()], { total: 12.83, date: '2026-03-10', receiptNo: '9/134', reconciled: true, checkedAt: 't' }),
            [{ name: 'Makaronai RIMI SMART FUSILLI', price: 4.99, promoPrice: null, quantity: 2, unit: 'vnt', parsedAmount: 400, parsedUnit: 'g' }],
            { total: 12.83, date: '2026-03-10', receiptNo: '9/134', reconciled: false },
        );
        expect(c.footer).toBe('differ');
        expect(c.footerDiffs.join()).toContain('recon');
        expect(c.summary).toBe('attention');
    });

    test('all asserted + all matching + footer match → ok', () => {
        const c = compareItemTruth(
            file([T()], { total: 9.98, date: '2026-03-10', receiptNo: '1', reconciled: true, checkedAt: 't' }),
            [{ name: 'Makaronai RIMI SMART FUSILLI', price: 4.99, promoPrice: null, quantity: 2, unit: 'vnt', parsedAmount: 400, parsedUnit: 'g' }],
            { total: 9.98, date: '2026-03-10', receiptNo: '1', reconciled: true },
        );
        expect(c.summary).toBe('ok');
    });

    test('mid-word space garbles still pair with their truth entry (ios-55 batatai duplicate)', () => {
        // OCR injects spaces nondeterministically across runs — token
        // similarity saw ZERO overlap between "Valgomieji batatai" and
        // "Val gomieji batat ai", so re-checkmarking APPENDED a duplicate
        // truth entry instead of replacing, and every later run flagged a
        // phantom name diff.
        const c = compareItemTruth(
            file([T({ name: 'Valgomieji batatai', price: 2.65, quantity: 0.72, unit: 'kg', parsedAmount: 1, parsedUnit: 'kg' })]),
            [{ name: 'Val gomieji batat ai', price: 2.65, promoPrice: null, quantity: 0.72, unit: 'kg', parsedAmount: 1, parsedUnit: 'kg' }],
            null,
        );
        expect(c.perProduct[0].truthIdx).toBe(0);  // paired → replace, not append
        expect(c.perProduct[0].state).toBe('match'); // spacing-only name diff suppressed
    });

    test('a REAL character garble still flags a name diff (Sojos aisto/maisto)', () => {
        const c = compareItemTruth(
            file([T({ name: 'Sojos gaminys maisto gamin. ALPRO, 14 %', price: 1.89, quantity: 4 })]),
            [{ name: 'Sojos gaminys aisto garmin. ALPRO, 14 %', price: 1.89, promoPrice: null, quantity: 4, unit: 'vnt', parsedAmount: 400, parsedUnit: 'g' }],
            null,
        );
        expect(c.perProduct[0].state).toBe('differ');
        expect(c.perProduct[0].diffs.join()).toContain('name');
    });
});
