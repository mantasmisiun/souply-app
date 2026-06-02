import { ltPluralSuffix } from '../utils/ltPlural';

describe('ltPluralSuffix (Lithuanian noun-count agreement)', () => {
    it('uses "other" (genitive plural) for 0', () => {
        expect(ltPluralSuffix(0)).toBe('other'); // 0 prekių
    });

    it('uses "one" for 1, 21, 31, 101 (n%10==1, not 11)', () => {
        for (const n of [1, 21, 31, 41, 101, 121]) expect(ltPluralSuffix(n)).toBe('one'); // 1 prekė
    });

    it('uses "few" for 2–9, 22–29, 99 (n%10 2..9, not teens)', () => {
        for (const n of [2, 3, 4, 9, 22, 23, 99, 104]) expect(ltPluralSuffix(n)).toBe('few'); // 4 prekės
    });

    it('uses "other" for 10–20 and the teens 11–19', () => {
        for (const n of [10, 11, 12, 15, 19, 20, 111, 112]) expect(ltPluralSuffix(n)).toBe('other'); // 11 prekių
    });
});
