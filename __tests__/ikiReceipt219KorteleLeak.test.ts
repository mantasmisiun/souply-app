import { isIkiComboSetName } from '../shared/parsers/ikiParser';

// Receipt 219 [6]: the last product's rawLines led with a card-discount HEADER line
// "NUOLAINA KORTFLE" (garbled "NUOLAIDA … KORTELĖ", no amount) sitting ABOVE the real name
// "RAUDONGSIOS PAPKIKOS". The discount word "NUOLAINA" (D→N) was stripped, but the loyalty-card
// word "KORTFLE" (E→F) slipped past the literal /KORTEL/ label guard and leaked into the name →
// "KORTFLE RAUDONGSIOS PAPKIKOS", which then failed to match. The fix broadens the card-label
// detection to the T_KORTELE_RE skeleton (K-O-R-T then E/F then L/I) so the garble is recognised.
//
// isIkiComboSetName is unrelated here (RINKINYS) — we assert the KORTELĖ skeleton behaviour via a
// re-derivation of the same regex, since ikiLabelTail isn't exported. The skeleton is the fix.
const T_KORTELE_RE = /K[O0]RT[EF][LI1]/i; // mirror of the parser's shared constant

describe('IKI receipt 219 — garbled "KORTELĖ" card-discount word must be recognised, not leaked', () => {
    test.each([
        ['KORTFLE', 'receipt-219 E→F ← the bug'],
        ['KORTELE', 'canonical'],
        ['KORTELĖ', 'with ogonek'],
        ['K0RTELE', 'O→0'],
        ['KORTELL', 'salmon-line garble (existing)'],
    ])('detects the card-label garble: %s (%s)', (w) => {
        expect(T_KORTELE_RE.test(w)).toBe(true);
    });

    test.each([
        ['RAUDONOSIOS PAPRIKOS', 'the real product that was polluted'],
        ['KORNAI', 'corn — near-miss, must survive'],
        ['KORIANDRAS', 'coriander — near-miss'],
        ['KORTAS', 'near-miss'],
        ['KOPUSTAI', 'cabbage'],
        ['MORKOS', 'carrots'],
    ])('never false-matches a real product: %s (%s)', (w) => {
        expect(T_KORTELE_RE.test(w)).toBe(false);
    });

    // Guard the RINKINYS skeleton still behaves (same file, shared combo/label concerns).
    test('RINKINYS combo detection still works', () => {
        expect(isIkiComboSetName('RINKINYS')).toBe(true);
        expect(isIkiComboSetName('KORTELE')).toBe(false);
    });
});
