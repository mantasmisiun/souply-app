import {
    isWeightDisplay, productStep, productUsesPicker, productAmountParts,
    formatProductAmount, formatItemAmount, fmtSize, unitLabel,
} from '../utils/amountDisplay';

// A stub `t` mirroring the units.* i18n block.
const t = (k: string) => ({ 'units.vnt': 'vnt', 'units.pak': 'pak.', 'units.rit': 'rit.' } as Record<string, string>)[k] ?? k;
const pa = (sig: any, q: number) => formatProductAmount(sig, q, t);

describe('fmtSize — grams / ml polish boundaries', () => {
    it('mass: <1kg shows grams, ≥1kg shows kg', () => {
        expect(fmtSize(500, 'g')).toEqual({ value: 500, unit: 'g' });
        expect(fmtSize(0.5, 'kg')).toEqual({ value: 500, unit: 'g' });
        expect(fmtSize(1500, 'g')).toEqual({ value: 1.5, unit: 'kg' });
        expect(fmtSize(1, 'kg')).toEqual({ value: 1, unit: 'kg' });      // exactly 1kg → kg, not 1000 g
        expect(fmtSize(0.333, 'kg')).toEqual({ value: 333, unit: 'g' });
    });
    it('volume: <1l shows ml, ≥1l shows l', () => {
        expect(fmtSize(500, 'ml')).toEqual({ value: 500, unit: 'ml' });
        expect(fmtSize(0.33, 'l')).toEqual({ value: 330, unit: 'ml' });
        expect(fmtSize(1.5, 'l')).toEqual({ value: 1.5, unit: 'l' });
    });
    it('count/unknown passes through', () => {
        expect(fmtSize(6, 'vnt')).toEqual({ value: 6, unit: 'vnt' });
        expect(fmtSize(2, null)).toEqual({ value: 2, unit: 'vnt' });
    });
});

// ── CATALOG cases (Product, canonical quantity) ─────────────────────────────
describe('CATALOG — the confirmed cases', () => {
    // C1: all SPs weighable → weight, step 0.1, picker.
    it('C1 all-weighable: 0.5 kg → "500 g", step 0.1, picker on', () => {
        const p = { isWeighable: true, canonicalUnit: 'kg', canonicalFamily: 'fluid' };
        expect(pa(p, 0.5)).toBe('500 g');
        expect(productStep(p)).toBe(0.1);
        expect(productUsesPicker(p)).toBe(true);
    });
    // C2/C3: packed varying / weighable+packed mix → 'fluid' → weight.
    it('C3 packed varying (250g & 500g), family fluid: 0.5 → "500 g", 1.2 → "1.2 kg", step 0.1', () => {
        const p = { isWeighable: false, canonicalUnit: 'kg', canonicalFamily: 'fluid', canonicalStep: 0.5 };
        expect(pa(p, 0.5)).toBe('500 g');
        expect(pa(p, 1.2)).toBe('1.2 kg');
        expect(productStep(p)).toBe(0.1);           // 0.1, NOT the server's 0.5 widen
        expect(productUsesPicker(p)).toBe(true);
    });
    // C4: single/same-weight packed → 'count' → "N vnt", step 1, NO picker.
    it('C4 single-size packed (family count): 2 → "2 vnt", step 1, picker off', () => {
        const p = { isWeighable: false, canonicalUnit: 'vnt', canonicalFamily: 'count' };
        expect(pa(p, 2)).toBe('2 vnt');
        expect(productStep(p)).toBe(1);
        expect(productUsesPicker(p)).toBe(false);
    });
    // C5: litres → weight in l/ml.
    it('C5 litres, family fluid: 0.5 → "500 ml", 1.5 → "1.5 l"', () => {
        const p = { canonicalUnit: 'l', canonicalFamily: 'fluid', isWeighable: false, canonicalStep: 0.5 };
        expect(pa(p, 0.5)).toBe('500 ml');
        expect(pa(p, 1.5)).toBe('1.5 l');
    });
    // C6: the DOMINANT case — null family, non-weighable → count "N vnt", no division ever.
    it('C6 null family, non-weighable: 2 → "2 vnt", step 1, no picker (never "5 vnt")', () => {
        const p = { isWeighable: false, canonicalUnit: null, canonicalFamily: null, canonicalStep: null };
        expect(pa(p, 2)).toBe('2 vnt');
        expect(productStep(p)).toBe(1);
        expect(productUsesPicker(p)).toBe(false);
    });
    // C7: null family but weighable → weight.
    it('C7 null family but isWeighable: 0.3 → "300 g", step 0.1, picker on', () => {
        const p = { isWeighable: true, canonicalUnit: null, canonicalFamily: null };
        expect(pa(p, 0.3)).toBe('300 g');
        expect(productStep(p)).toBe(0.1);
        expect(productUsesPicker(p)).toBe(true);
    });
    // The original Lavazza bug: family fluid, step 0.5 in cache, 500g pick — must
    // be "500 g", NEVER "5 vnt" and NEVER "1 vnt".
    it('regression (Lavazza 7263): fluid + 0.5 pick → "500 g", never "5 vnt"', () => {
        const p = { isWeighable: false, canonicalUnit: 'kg', canonicalFamily: 'fluid', canonicalStep: 0.5 };
        expect(pa(p, 0.5)).toBe('500 g');
        const stale = { isWeighable: false, canonicalUnit: 'kg', canonicalFamily: 'fluid', canonicalStep: null };
        expect(pa(stale, 0.5)).toBe('500 g');   // even with a null step (stale cache)
    });
});

// ── LIST cases (SP row / receipt line, explicit signals) ────────────────────
describe('LIST — SP / receipt-line rows', () => {
    // L1: weighable SP → the weight.
    it('L1 weighable SP: quantity 0.5 kg → "500 g"; 1.5 → "1.5 kg"; 15 → "15 kg" (not "15 g")', () => {
        expect(formatItemAmount({ quantity: 0.5, isWeighable: true, unit: 'kg' }, t)).toBe('500 g');
        expect(formatItemAmount({ quantity: 1.5, isWeighable: true, unit: 'kg' }, t)).toBe('1.5 kg');
        expect(formatItemAmount({ quantity: 15, isWeighable: true, unit: 'kg' }, t)).toBe('15 kg');
    });
    // L2: non-weighable fluid pack → "N × pack size".
    it('L2 non-weighable packed: 2 × 500 g, 1 × 1 l', () => {
        expect(formatItemAmount({ quantity: 2, isWeighable: false, unit: 'g', packAmount: 500 }, t)).toBe('2 × 500 g');
        expect(formatItemAmount({ quantity: 1, isWeighable: false, unit: 'l', packAmount: 1 }, t)).toBe('1 × 1 l');
    });
    // L3: count-unit real multipack.
    it('L3 vnt multipack (10-pack): 1 × 10 vnt', () => {
        expect(formatItemAmount({ quantity: 1, isWeighable: false, unit: 'vnt', packAmount: 10 }, t)).toBe('1 × 10 vnt');
    });
    // L4: vnt amount 1 → collapse to "N vnt" (no "× 1").
    it('L4 vnt amount=1: 2 → "2 vnt" (never "2 × 1 vnt")', () => {
        expect(formatItemAmount({ quantity: 2, isWeighable: false, unit: 'vnt', packAmount: 1 }, t)).toBe('2 vnt');
    });
    // L5: no/unknown unit or null amount → "N vnt".
    it('L5 no unit / null amount: 3 → "3 vnt"', () => {
        expect(formatItemAmount({ quantity: 3, isWeighable: false, unit: null, packAmount: null }, t)).toBe('3 vnt');
        expect(formatItemAmount({ quantity: 3, isWeighable: false, unit: 'maiš', packAmount: 2 }, t)).toBe('3 vnt');
    });
    // Receipt line: explicit multiplier (merged-line count) + pre-formatted label.
    it('receipt line: multiplier + packLabel → "3 × 400 g"', () => {
        expect(formatItemAmount({ quantity: 1.2, isWeighable: false, unit: 'g', multiplier: 3, packLabel: '400 g' }, t)).toBe('3 × 400 g');
    });
    it('receipt weighable line: 0.85 kg → "850 g"', () => {
        expect(formatItemAmount({ quantity: 0.85, isWeighable: true, unit: 'kg' }, t)).toBe('850 g');
    });
    // The "no 0,5 vnt" guard: fractional qty with an unreliable flag → weight.
    it('fractional quantity with no weighable flag → weight, not "0.5 vnt"', () => {
        expect(formatItemAmount({ quantity: 0.5, isWeighable: false, unit: 'kg' }, t)).toBe('500 g');
    });
});

describe('unitLabel', () => {
    it('metric literal, count localised', () => {
        expect(unitLabel('kg')).toBe('kg');
        expect(unitLabel('g')).toBe('g');
        expect(unitLabel('vnt', t)).toBe('vnt');
        expect(unitLabel('pak', t)).toBe('pak.');
    });
});
