import { isIkiComboSetName } from '../shared/parsers/ikiParser';

// The bare "RINKINYS" combo-discount word (IKI multi-buy header, never a product) must be
// dropped across OCR garbles. Real products that merely CONTAIN the word ("ŽALUMYNŲ
// RINKINYS") qualify it with a prefix, so they never collapse to the bare skeleton and must
// survive. Anchored letter-only skeleton — see RINKINYS_SKEL.
describe('isIkiComboSetName — OCR-tolerant bare-RINKINYS detection', () => {
    test.each([
        ['RINKINYS', 'canonical'],
        ['RINKTNYS', 'I→T (receipt-187)'],
        ['RINKTN)S', 'Y-dropped + punctuation (receipt-206)'],
        ['RINKI:.S', 'NY-dropped → letters RINKIS (receipt-209) ← the fix'],
        ['R1NK1NYS', 'I→1'],
        ['rinkinys', 'lowercase'],
    ])('drops the bare combo word: %s (%s)', (name) => {
        expect(isIkiComboSetName(name)).toBe(true);
    });

    test.each([
        ['ŽALUMYNŲ RINKINYS', 'qualified real product'],
        ['STIKLINIŲ RINKINYS 6 vnt', 'qualified real product'],
        ['BANANAI BON VIA', 'unrelated product'],
        ['RINKS', 'too short — missing the second I'],
        ['RIMI', 'chain-ish noise'],
        ['', 'empty'],
    ])('keeps non-combo names: %s (%s)', (name) => {
        expect(isIkiComboSetName(name)).toBe(false);
    });
});
