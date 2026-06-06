import { resolveCanonicalStep } from '../utils/canonicalStep';

describe('resolveCanonicalStep', () => {
    it('uses the server canonicalStep when present', () => {
        expect(resolveCanonicalStep({ canonicalStep: 0.5, canonicalUnit: 'l' })).toBe(0.5);
        expect(resolveCanonicalStep({ canonicalStep: 1, canonicalUnit: 'vnt' })).toBe(1);
    });

    it('steps 0.1 for weighable items', () => {
        expect(resolveCanonicalStep({ isWeighable: true })).toBe(0.1);
        expect(resolveCanonicalStep({ hasWeighable: 1 })).toBe(0.1);
    });

    it('steps 0.1 for a computed fluid/weight canonical unit', () => {
        expect(resolveCanonicalStep({ canonicalUnit: 'l' })).toBe(0.1);
        expect(resolveCanonicalStep({ canonicalUnit: 'kg' })).toBe(0.1);
    });

    it('steps 1 for a count canonical unit', () => {
        expect(resolveCanonicalStep({ canonicalUnit: 'vnt' })).toBe(1);
    });

    it('steps 1 when there is no canonical unit, ignoring the hardcoded raw unit=g (the COCA-COLA can bug)', () => {
        // single-SP 330 ml can, no amount/unit → canonicalize returns null, but
        // the browse endpoint still sends unit:'g'. Must NOT become 0.1.
        expect(resolveCanonicalStep({ unit: 'g', canonicalUnit: null, canonicalStep: null })).toBe(1);
        expect(resolveCanonicalStep({ unit: 'g' })).toBe(1);
        expect(resolveCanonicalStep({})).toBe(1);
    });
});
