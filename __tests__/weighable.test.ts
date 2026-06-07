import { isWeighableDisplay } from '../utils/weighable';

describe('isWeighableDisplay', () => {
    it('treats a flagged item as weighable regardless of quantity', () => {
        expect(isWeighableDisplay(1, 2)).toBe(true);
        expect(isWeighableDisplay(true, 3)).toBe(true);
        expect(isWeighableDisplay('1', 1)).toBe(true); // string from driver
    });

    it('treats a fractional quantity as weighable even when the flag is 0 (the bread case)', () => {
        expect(isWeighableDisplay(0, 0.5)).toBe(true);
        expect(isWeighableDisplay(false, 1.5)).toBe(true);
        expect(isWeighableDisplay('0', 0.25)).toBe(true);
    });

    it('treats a whole-quantity unflagged item as pieces', () => {
        expect(isWeighableDisplay(0, 1)).toBe(false);
        expect(isWeighableDisplay(false, 3)).toBe(false);
        expect(isWeighableDisplay(null, 2)).toBe(false);
        expect(isWeighableDisplay(undefined, 1)).toBe(false);
    });

    it('handles string quantities', () => {
        expect(isWeighableDisplay(0, '0.5')).toBe(true);
        expect(isWeighableDisplay(0, '2')).toBe(false);
    });
});
