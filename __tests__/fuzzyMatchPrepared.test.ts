import { fuzzyMatches, fuzzyMatchesPrepared, foldTokens } from '../utils/fuzzyMatch';

/**
 * The discounts search precompute (perf audit finding 9): `fuzzyMatches` was
 * split into `foldTokens` (cacheable per dataset / per filter run) +
 * `fuzzyMatchesPrepared` (the matcher over pre-folded tokens). This is a
 * CACHING change — the split path must return exactly what the one-shot
 * `fuzzyMatches` returns, for every input class the matcher handles.
 */

describe('foldTokens', () => {
    test('folds diacritics, lowercases, tokenises on whitespace', () => {
        expect(foldTokens('Kapų raudona žvakė')).toEqual(['kapu', 'raudona', 'zvake']);
    });
    test('empty / whitespace-only input → no tokens', () => {
        expect(foldTokens('')).toEqual([]);
        expect(foldTokens('   ')).toEqual([]);
    });
});

describe('prepared path returns exactly what the one-shot path returns', () => {
    const names = [
        'Kapų raudona žvakė',
        'žvakė',
        'Pienas ROKIŠKIO 2,5%',
        'Duona',
        'Ąžuolo gilės',
        '',
        '   ',
        'AGUONŲ vyniotinis',
    ];
    const queries = [
        '', ' ', 'zvake', 'kapu zvake', 'zvake kapu', 'zvakr', 'zvkae',
        'pie', 'pei', 'pienas rokiskio', 'duonos', 'gile', 'asuolo',
        'nonexistent thing', 'kapu raudona zvake ekstra',
    ];
    test.each(names.flatMap(n => queries.map(q => [n, q] as const)))(
        'parity for name=%j query=%j',
        (name, query) => {
            expect(fuzzyMatchesPrepared(foldTokens(name), foldTokens(query.trim())))
                .toBe(fuzzyMatches(name, query));
        },
    );
});

describe('matching semantics are unchanged', () => {
    test('diacritic fold: "zvake" finds "žvakė"', () => {
        expect(fuzzyMatches('žvakė', 'zvake')).toBe(true);
    });
    test('token-AND in any order, gaps allowed', () => {
        expect(fuzzyMatches('Kapų raudona žvakė', 'kapu zvake')).toBe(true);
        expect(fuzzyMatches('Kapų raudona žvakė', 'zvake kapu')).toBe(true);
    });
    test('one substitution within budget (len 5 → 1 edit)', () => {
        expect(fuzzyMatches('žvakė', 'zvakr')).toBe(true);
    });
    test('transposition counts as ONE edit (Damerau)', () => {
        expect(fuzzyMatches('žvakė', 'zvkae')).toBe(true);
    });
    test('short tokens get no typo budget', () => {
        expect(fuzzyMatches('Pienas', 'pie')).toBe(true);  // substring
        expect(fuzzyMatches('Pienas', 'pei')).toBe(false); // 3 chars, 0 edits allowed
    });
    test('empty query matches everything; empty name matches nothing', () => {
        expect(fuzzyMatches('Duona', '')).toBe(true);
        expect(fuzzyMatches('', 'x')).toBe(false);
    });
    test('unrelated query does not match', () => {
        expect(fuzzyMatches('Pienas', 'zvake')).toBe(false);
    });
});
