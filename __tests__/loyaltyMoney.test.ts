import { detectLoyaltyMoney } from '@shared/parsers/loyaltyMoney';

/**
 * LOYALTY MONEY — "MAXIMOS pinigai" and friends.
 *
 * The till pays part of the bill from a balance the shopper already earned, and
 * it does so AFTER the lines: receipt 19 lists 4 × €0.59 = €2.36 and prints a
 * total of €2.24, because "Nurašyta MAXIMOS pinigų 0,12". Nothing modelled that,
 * so a perfectly captured receipt carried a €0.12 reconciliation gap.
 *
 * The three numbers must stay apart: only what was REDEEMED reduces this bill.
 * Money EARNED is a future discount, and the BALANCE is neither.
 */

describe('detectLoyaltyMoney', () => {
    test('THE CASE: receipt 19 — redeemed, earned and balance all read correctly', () => {
        const r = detectLoyaltyMoney([
            'Duonos traškučiai MARETTI 0,59',
            'Atsiskaityta MAXIMOS pinigais',
            'Nurašyta MAXIMOS pinigų 0,12',
            'Iš viso MAXIMOS pinigų už kvitą 0,02',
            'MAXIMOS pinigų likutis 0,02',
            'Mokėti 2,24',
        ])!;
        expect(r.program).toBe('maxima');
        expect(r.redeemed).toBeCloseTo(0.12, 2);   // closes the 2.36 → 2.24 gap
        expect(r.earned).toBeCloseTo(0.02, 2);
        expect(r.balance).toBeCloseTo(0.02, 2);
    });

    test('a leftover BALANCE is never mistaken for money spent', () => {
        // Both lines contain "pinigų"; only one of them is a payment.
        const r = detectLoyaltyMoney(['MAXIMOS pinigų likutis 12,40'])!;
        expect(r.redeemed).toBe(0);
        expect(r.balance).toBeCloseTo(12.40, 2);
    });

    test('money EARNED does not reduce this receipt', () => {
        const r = detectLoyaltyMoney(['Sukaupta Rimi pinigų 1,50'])!;
        expect(r.redeemed).toBe(0);
        expect(r.earned).toBeCloseTo(1.50, 2);
        expect(r.program).toBe('rimi');
    });

    test('"Panaudota … pinigų" is a redemption too', () => {
        expect(detectLoyaltyMoney(['Panaudota Mano Rimi pinigų 3,00'])!.redeemed).toBeCloseTo(3.00, 2);
    });

    test('two redemptions on one receipt add up', () => {
        const r = detectLoyaltyMoney([
            'Nurašyta MAXIMOS pinigų 0,12',
            'Panaudota MAXIMOS pinigų 1,00',
        ])!;
        expect(r.redeemed).toBeCloseTo(1.12, 2);
    });

    test('an ordinary discount line is NOT loyalty money', () => {
        // No "pinig*" stem → not this programme, whatever else the line says.
        expect(detectLoyaltyMoney(['Panaudota nuolaida -1,50'])).toBeNull();
        expect(detectLoyaltyMoney(['Nuolaida su kortele 0,80'])).toBeNull();
    });

    // ── GLUED OCR LINES, straight from dev receipts ─────────────────────────
    // ML Kit merges several printed rows into one string. Reading "the last
    // amount on the line" attributed a receipt TOTAL as loyalty money, so the
    // amount must sit IMMEDIATELY after the loyalty phrase.
    test('r91: a real Rimi redemption glued to the next product line', () => {
        const r = detectLoyaltyMoney([
            'SUTEIKTOS NUOLAIDOS: Panaudoti MANO RIMI pinigai -0,09 Mangų ir pasiflorų valg. ledai PIRŪ',
        ])!;
        expect(r.program).toBe('rimi');
        expect(r.redeemed).toBeCloseTo(0.09, 2);      // NOT a number from the glued product
    });

    test('r88: a glued total is not loyalty money', () => {
        // Receipt total was €21.90 — the old "last amount" rule reported it as
        // earned. The only adjacent amount here is the 0,10 redemption.
        const r = detectLoyaltyMoney([
            'Suteiktos naudos Atsiskaityta MAXIMOS pinigais - 0,10 A ======g -==== Sutaupėte 0,10 ----',
        ])!;
        expect(r.redeemed).toBeCloseTo(0.10, 2);
        expect(r.earned).toBeNull();
        expect(r.balance).toBeNull();
    });

    test('r87: a header glued to an unrelated discount claims nothing', () => {
        const r = detectLoyaltyMoney([
            'Suteiktos naudos -0.25 A Atsiskaityta MAXIMOS pinigais ===================================',
        ])!;
        expect(r.redeemed).toBe(0);                   // the -0.25 precedes the phrase
        expect(r.balance).toBeNull();
    });

    test('r91 for real: Rimi prints the label and the amount as SEPARATE rows', () => {
        // Same y-band, two OCR lines. Without geometry there is no amount to find;
        // with it the right-column value belongs to the label beside it.
        const r = detectLoyaltyMoney([
            { text: 'Panaudoti MANO RIMI pinigai', yTop: 100, yBottom: 130 },
            { text: '-0,09', yTop: 102, yBottom: 131 },
            { text: 'Uždirbti MANO Rimi pinigai', yTop: 140, yBottom: 170 },
            { text: '0,13', yTop: 141, yBottom: 171 },
        ])!;
        expect(r.program).toBe('rimi');
        expect(r.redeemed).toBeCloseTo(0.09, 2);
        expect(r.earned).toBeCloseTo(0.13, 2);
    });

    test('an amount two rows away is NOT paired with the label', () => {
        const r = detectLoyaltyMoney([
            { text: 'Panaudoti MANO RIMI pinigai', yTop: 100, yBottom: 130 },
            { text: '19,90', yTop: 200, yBottom: 230 },     // a total further down
        ])!;
        expect(r.redeemed).toBe(0);
    });

    test('a receipt with no loyalty lines returns null, not a zeroed object', () => {
        expect(detectLoyaltyMoney(['Pienas 1,09', 'Mokėti 1,09'])).toBeNull();
    });

    test('a bare header with no amount claims nothing', () => {
        const r = detectLoyaltyMoney(['Atsiskaityta MAXIMOS pinigais'])!;
        expect(r.redeemed).toBe(0);
        expect(r.program).toBe('maxima');
    });

    test('thousands separators and stray spacing parse', () => {
        expect(detectLoyaltyMoney(['Nurašyta MAXIMOS pinigų 1.234,50'])!.redeemed).toBeCloseTo(1234.50, 2);
        expect(detectLoyaltyMoney(['Nurašyta  MAXIMOS   pinigų   0,05'])!.redeemed).toBeCloseTo(0.05, 2);
    });
});
