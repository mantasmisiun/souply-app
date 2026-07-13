/**
 * Rimi parser hardening — IKI-parser idiom transfers.
 *
 * Covers (in the audit's priority order):
 *   1. receiptNo bail hardening: [KA][vouy]ito stem tolerance + the
 *      synthetic `${date}-${time}-${cents}-rimi-receipt` fallback id.
 *   2. isWeighable emission + weighed price-poisoning guard
 *      ("show it, never write price") — incl. the receipt-55/56
 *      weighed shapes documented in rimiParser.ts's own comments.
 *   3. EUR→FUR glyph class in WEIGHT_RE / WEIGHT_RATE_ONLY_RE.
 *   4. Deposit widening: DEPOSIT_PATTERN tolerates ž/z/2.
 *   5. Discount plausibility clamps (paid >= 0, discount <= price).
 *   6. Total fallbacks: itemSum plausibility + Grynieji − Grąža.
 *
 * Fixtures are realistic OCR-garbled lines in the ikiThermal style:
 * arrays of { text, xLeft, xRight, yTop, yBottom }. Rows are spaced
 * 40 px apart (> the 30 px mergeRowFragments same-row threshold);
 * same-row column boxes share yTop.
 */
import {
    parseRimiReceipt,
    parseFooter,
    DEPOSIT_PATTERN,
    type RimiLine,
} from '../shared/parsers/rimiParser';

const L = (
    text: string,
    yTop: number,
    xLeft = 20,
    xRight = 500,
    h = 25,
): RimiLine => ({ text, yTop, yBottom: yTop + h, xLeft, xRight });

/** Standard Rimi header block (y 0–145). Products may start at y=160. */
const HEADER: RimiLine[] = [
    L('UAB RIMI LIETUVA, T709', 0),
    L('Tilžės g. 109, Šiauliai', 40),
    L('PVM mokėtojo kodas LT123456789012', 80),
    L('PIRKĖJAS XXXXXXXXXXXX1234', 120),
];

/** Standard footer block starting at the given y. */
const footerRows = (y: number, moketi = 'Mokėti 25,04'): RimiLine[] => [
    L('SUTEIKTOS NUOLAIDOS:', y),
    L(moketi, y + 40),
    L('Kvito Nr. 80/162/36162 Kasa 0037', y + 80),
    L('LAIKAS 2026-06-30 18:45:12', y + 120),
];

// ─────────────────────────────────────────────────────────────────
// Receipt-55/56 weighed shapes (the file's own documented fixtures)
// ─────────────────────────────────────────────────────────────────

describe('Rimi weighed shapes from receipt-55/56 comments', () => {
    test('receipt-55: dropped E of EUR ("1,69UR/K_3. 1") still parses as weighed', () => {
        const lines = [
            ...HEADER,
            L('Vynuogės žaliosios', 160),
            L('0,978 kg X 1,69UR/K_3. 1', 200, 20, 300),
            L('1,65 A', 200, 600, 700),
            ...footerRows(280, 'Mokėti 1,65'),
        ];
        const { products } = parseRimiReceipt(lines);
        expect(products).toHaveLength(1);
        const p = products[0];
        expect(p.unit).toBe('kg');
        expect(p.quantity).toBeCloseTo(0.978, 3);
        expect(p.price).toBeCloseTo(1.69, 2); // €/kg, not the 1,65 line total
        expect(p.pricePerUnit).toBeCloseTo(1.69, 2);
        expect(p.isWeighable).toBe(true);
        expect(p.name).not.toMatch(/kg|UR/);
    });

    test('receipt-56 band 7: stray "?" after kg ("0,494 kg? X 7,99 EUR/kg")', () => {
        const lines = [
            ...HEADER,
            L('Kiaulienos šoninė', 160),
            L('0,494 kg? X 7,99 EUR/kg', 200, 20, 300),
            L('3,95 A', 200, 600, 700),
            ...footerRows(280, 'Mokėti 3,95'),
        ];
        const { products } = parseRimiReceipt(lines);
        expect(products).toHaveLength(1);
        const p = products[0];
        expect(p.unit).toBe('kg');
        expect(p.quantity).toBeCloseTo(0.494, 3);
        expect(p.price).toBeCloseTo(7.99, 2);
        expect(p.isWeighable).toBe(true);
    });

    test('receipt-56 band 10 salmon: dropped kg before X ("0,524 .24 x 23,99 EUR/kg")', () => {
        const lines = [
            ...HEADER,
            L('Šviežia lašiša', 160),
            L('0,524 .24 x 23,99 EUR/kg', 200, 20, 300),
            L('12,57 A', 200, 600, 700),
            ...footerRows(280, 'Mokėti 12,57'),
        ];
        const { products } = parseRimiReceipt(lines);
        expect(products).toHaveLength(1);
        const p = products[0];
        expect(p.unit).toBe('kg');
        expect(p.quantity).toBeCloseTo(0.524, 3);
        expect(p.price).toBeCloseTo(23.99, 2);
        expect(p.isWeighable).toBe(true);
        expect(p.name).not.toMatch(/kg|EUR/i);
    });
});

// ─────────────────────────────────────────────────────────────────
// 3. EUR→FUR glyph class (E↔F thermal confusion, IKI T_EUR parity)
// ─────────────────────────────────────────────────────────────────

describe('Rimi WEIGHT_RE / WEIGHT_RATE_ONLY_RE FUR tolerance', () => {
    test('"FUR/kg" rate suffix parses as a weight line', () => {
        const lines = [
            ...HEADER,
            L('Morkos fasuotos', 160),
            L('0,340 kg X 7,59 FUR/kg', 200, 20, 300),
            L('2,58 A', 200, 600, 700),
            ...footerRows(280, 'Mokėti 2,58'),
        ];
        const { products } = parseRimiReceipt(lines);
        expect(products).toHaveLength(1);
        const p = products[0];
        expect(p.unit).toBe('kg');
        expect(p.quantity).toBeCloseTo(0.34, 3);
        expect(p.price).toBeCloseTo(7.59, 2);
        expect(p.isWeighable).toBe(true);
        expect(p.name).toBe('Morkos fasuotos');
    });

    test('"FUR" without /kg suffix (plain WEIGHT_RE branch)', () => {
        const lines = [
            ...HEADER,
            L('Svogūnai geltonieji', 160),
            L('0,286 kg X 4,89 FUR', 200, 20, 300),
            L('1,40 A', 200, 600, 700),
            ...footerRows(280, 'Mokėti 1,40'),
        ];
        const { products } = parseRimiReceipt(lines);
        expect(products).toHaveLength(1);
        expect(products[0].unit).toBe('kg');
        expect(products[0].price).toBeCloseTo(4.89, 2);
    });
});

// ─────────────────────────────────────────────────────────────────
// 2. Weighed price-poisoning guard + isWeighable emission
// ─────────────────────────────────────────────────────────────────

describe('Rimi weighed price-poisoning guard', () => {
    test('garbled €/kg but readable kg qty → €/kg recovered from anchor ÷ qty', () => {
        // "1,b9" defeats every weight regex (b is not a foldable OCR
        // digit), but the printed 0,978 kg survives → 1,65 ÷ 0,978 = 1,69.
        const lines = [
            ...HEADER,
            L('Vynuogės žaliosios', 160),
            L('0,978 kg X 1,b9 EUR/kg', 200, 20, 300),
            L('1,65 A', 200, 600, 700),
            ...footerRows(280, 'Mokėti 1,65'),
        ];
        const { products } = parseRimiReceipt(lines);
        expect(products).toHaveLength(1);
        const p = products[0];
        expect(p.unit).toBe('kg');
        expect(p.quantity).toBeCloseTo(0.978, 3);
        expect(p.price).toBeCloseTo(1.69, 2);
        expect(p.isWeighable).toBe(true);
        expect(p.name).toBe('Vynuogės žaliosios'); // garbled line never in name
    });

    test('fully garbled weight line → price=0 / ppu=null, item still shows ("never write price")', () => {
        // Both the kg qty AND the €/kg are unreadable — the anchor's
        // 1,65 is a fraction-of-a-kg total and must NOT become a unit
        // reference price.
        const lines = [
            ...HEADER,
            L('Vynuogės žaliosios', 160),
            L('O,9?8 kg X 1,b9 EUR/kg', 200, 20, 300),
            L('1,65 A', 200, 600, 700),
            ...footerRows(280, 'Mokėti 1,65'),
        ];
        const { products } = parseRimiReceipt(lines);
        expect(products).toHaveLength(1);
        const p = products[0];
        expect(p.unit).toBe('kg');
        expect(p.isWeighable).toBe(true);
        expect(p.price).toBe(0);
        expect(p.pricePerUnit).toBeNull();
        expect(p.promoPrice).toBeNull();
        expect(p.name).toBe('Vynuogės žaliosios');
    });

    test('bare ", kg" name tail with OCR-dropped weight row → price=0, weighable', () => {
        // Receipt-55 "Česnakai, kg" shape: the per-kg reference suffix
        // survives in the name but the whole weight calc row is gone.
        const lines = [
            ...HEADER,
            L('Švieži kalakutų filė, kg', 160),
            L('5,53 A', 200, 600, 700),
            ...footerRows(280, 'Mokėti 5,53'),
        ];
        const { products } = parseRimiReceipt(lines);
        expect(products).toHaveLength(1);
        const p = products[0];
        expect(p.unit).toBe('kg');
        expect(p.isWeighable).toBe(true);
        expect(p.price).toBe(0);
        expect(p.pricePerUnit).toBeNull();
        expect(p.parsedAmount).toBe(1);
        expect(p.parsedUnit).toBe('kg');
        expect(p.name).toBe('Švieži kalakutų filė');
    });

    test('fixed-pack "1 kg" in the name does NOT trip the guard (per-piece keeps its price)', () => {
        const lines = [
            ...HEADER,
            L('Miltai MALSENA, 1 kg', 160),
            L('1,29 A', 200, 600, 700),
            ...footerRows(280, 'Mokėti 1,29'),
        ];
        const { products } = parseRimiReceipt(lines);
        expect(products).toHaveLength(1);
        const p = products[0];
        expect(p.unit).toBe('vnt');
        expect(p.isWeighable).toBe(false);
        expect(p.price).toBeCloseTo(1.29, 2);
        expect(p.parsedAmount).toBe(1);
        expect(p.parsedUnit).toBe('kg');
    });

    test('multi-buy and plain per-piece rows emit isWeighable=false', () => {
        const lines = [
            ...HEADER,
            L('Sultys TYMBARK apelsinų', 160),
            L('2 vnt. X 1,99 EUR', 200, 20, 300),
            L('3,98 A', 200, 600, 700),
            L('Batonėlis SNICKERS', 240),
            L('1,09 A', 280, 600, 700),
            ...footerRows(360, 'Mokėti 5,07'),
        ];
        const { products } = parseRimiReceipt(lines);
        expect(products).toHaveLength(2);
        expect(products[0].isWeighable).toBe(false);
        expect(products[0].unit).toBe('vnt');
        expect(products[0].quantity).toBe(2);
        expect(products[0].price).toBeCloseTo(1.99, 2);
        expect(products[1].isWeighable).toBe(false);
        expect(products[1].price).toBeCloseTo(1.09, 2);
    });
});

// ─────────────────────────────────────────────────────────────────
// 4. Deposit widening (ž/z/2)
// ─────────────────────────────────────────────────────────────────

describe('Rimi deposit pattern OCR widening', () => {
    test.each(['Užstatas', 'Uzstatas', 'U2statas', 'ūžstatas'])(
        'DEPOSIT_PATTERN matches %s',
        (stem) => {
            expect(DEPOSIT_PATTERN.test(`${stem} - vienkartinė plastiko pakuotė`)).toBe(true);
        },
    );

    test('DEPOSIT_PATTERN does not match ordinary product names', () => {
        expect(DEPOSIT_PATTERN.test('Sultys TYMBARK apelsinų')).toBe(false);
        expect(DEPOSIT_PATTERN.test('Užkandis su statinaitėmis')).toBe(false);
    });

    test.each(['Uzstatas', 'U2statas'])(
        '"%s" deposit row cannot mint a phantom product',
        (stem) => {
            const lines = [
                ...HEADER,
                L('VYTAUTAS mineralinis vanduo', 160),
                L('1,09 A', 200, 600, 700),
                L(`${stem} - vienkartine plastiko pakuote`, 240),
                L('0,10', 280),
                ...footerRows(360, 'Mokėti 1,19'),
            ];
            const { products } = parseRimiReceipt(lines);
            expect(products).toHaveLength(1);
            expect(products[0].name).toBe('VYTAUTAS mineralinis vanduo');
            expect(products[0].price).toBeCloseTo(1.09, 2);
        },
    );
});

// ─────────────────────────────────────────────────────────────────
// 1. receiptNo stem tolerance + synthetic fallback id
// ─────────────────────────────────────────────────────────────────

describe('Rimi receiptNo hardening', () => {
    const foot = (kvitoText?: string) =>
        parseFooter([
            L('Mokėti 25,04', 0),
            ...(kvitoText ? [L(kvitoText, 40)] : []),
            L('LAIKAS 2026-06-30 18:45:12', 80),
        ]);

    test('canonical "Kvito Nr." still parses (regression)', () => {
        expect(foot('Kvito Nr. 80/162/36162 Kasa 0037').receiptNo).toBe('80/162/36162');
    });

    test('K→A stem garble: "Avito N. 80/162/36162"', () => {
        expect(foot('Avito N. 80/162/36162 Kasa 0037').receiptNo).toBe('80/162/36162');
    });

    test('v→u stem garble + comma after Nr: "Kuito Nr, 123/45/678"', () => {
        expect(foot('Kuito Nr, 123/45/678').receiptNo).toBe('123/45/678');
    });

    test('OCR letter-digits in the id are normalised: "l0/I62/36l62" → 10/162/36162', () => {
        expect(foot('Kvito Nr. l0/I62/36l62 Kasa 0037').receiptNo).toBe('10/162/36162');
    });

    test('"Kvito numeris" path is NOT hijacked by the widened Nr stem', () => {
        expect(foot('Kvito numeris 104148').receiptNo).toBe('104148');
    });

    test('digitless garbled tail falls through to the synthetic id', () => {
        expect(foot('Kvito Nr. —').receiptNo).toBe('20260630-184512-2504-rimi-receipt');
    });

    test('bank slip number is never the receipt id', () => {
        expect(foot('BANKO KVITO NR. 999999').receiptNo).toBe(
            '20260630-184512-2504-rimi-receipt',
        );
    });

    test('no printed id at all → synthetic date-time-total id', () => {
        expect(foot().receiptNo).toBe('20260630-184512-2504-rimi-receipt');
    });

    test('synthetic id needs ALL of date+time+total (partial keys would collide)', () => {
        const f = parseFooter([L('Mokėti 25,04', 0)]);
        expect(f.receiptNo).toBe('');
    });
});

// ─────────────────────────────────────────────────────────────────
// 5. Discount plausibility clamps
// ─────────────────────────────────────────────────────────────────

describe('Rimi discount plausibility clamps', () => {
    const receiptWith = (anchor: string, discountLine: string) => [
        ...HEADER,
        L('Jogurtas DVARO natūralus', 160),
        L(anchor, 200, 600, 700),
        L(discountLine, 240),
        ...footerRows(320, 'Mokėti 3,09'),
    ];

    test('valid discount still ships (regression)', () => {
        const { products } = parseRimiReceipt(
            receiptWith('4,49 A', 'Nuol. -1,40 Galut. kaina 3,09'),
        );
        expect(products).toHaveLength(1);
        expect(products[0].price).toBeCloseTo(4.49, 2);
        expect(products[0].promoPrice).toBeCloseTo(3.09, 2);
    });

    test('promo above base price (mis-attributed row) → discount DROPPED', () => {
        const { products } = parseRimiReceipt(
            receiptWith('0,85 A', 'Nuol. -1,40 Galut. kaina 3,09'),
        );
        expect(products).toHaveLength(1);
        expect(products[0].price).toBeCloseTo(0.85, 2);
        expect(products[0].promoPrice).toBeNull();
    });

    test('savings > price (derived paid < 0) → discount DROPPED', () => {
        const { products } = parseRimiReceipt(
            receiptWith('0,85 A', 'Nuol. -1,80'),
        );
        expect(products).toHaveLength(1);
        expect(products[0].price).toBeCloseTo(0.85, 2);
        expect(products[0].promoPrice).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────
// 6. Total fallbacks: Grynieji − Grąža + itemSum plausibility
// ─────────────────────────────────────────────────────────────────

describe('Rimi total fallbacks', () => {
    test('cash receipt: total = Grynieji − Grąža when Mokėti is unreadable', () => {
        const f = parseFooter([
            L('MOKĖJIMAS GRYNAISIAIS', 0),
            L('Grynieji 10,00', 40),
            L('Grąža 2,35', 80),
            L('Kvito Nr. 11/22/33 Kasa 0001', 120),
            L('LAIKAS 2026-06-30 18:45:12', 160),
        ]);
        expect(f.total).toBeCloseTo(7.65, 2);
        expect(f.receiptNo).toBe('11/22/33');
    });

    test('Grynieji − Grąža only fires when both present and cash ≥ change', () => {
        const cashOnly = parseFooter([L('Grynieji 10,00', 0)]);
        expect(cashOnly.total).toBeNull();
        const inverted = parseFooter([
            L('Grynieji 2,35', 0),
            L('Grąža 10,00', 40),
        ]);
        expect(inverted.total).toBeNull();
    });

    const twoProductReceipt = (moketi: string, kvito = 'Kvito Nr. 80/162/36162 Kasa 0037') => [
        ...HEADER,
        L('Sultys TYMBARK apelsinų', 160),
        L('1,09 A', 200, 600, 700),
        L('Batonėlis SNICKERS', 240),
        L('2,00 A', 280, 600, 700),
        L('SUTEIKTOS NUOLAIDOS:', 360),
        L(moketi, 400),
        L(kvito, 440),
        L('LAIKAS 2026-06-30 18:45:12', 480),
    ];

    test('missing total → falls back to the item sum + mints the synthetic id', () => {
        // "Mokėti" label survived but its amount box was dropped; the
        // Kvito row is garbled beyond the stem classes too.
        const { footer } = parseRimiReceipt(
            twoProductReceipt('Mokėti', 'Kwito Hr. 80/162/36162'),
        );
        expect(footer.total).toBeCloseTo(3.09, 2);
        expect(footer.receiptNo).toBe('20260630-184512-309-rimi-receipt');
    });

    test('implausibly tiny total (stray 0,01) → replaced by the item sum', () => {
        const { footer } = parseRimiReceipt(twoProductReceipt('Mokėti 0,01'));
        expect(footer.total).toBeCloseTo(3.09, 2);
        expect(footer.receiptNo).toBe('80/162/36162'); // printed id untouched
    });

    test('a correctly-read total is never overwritten', () => {
        const exact = parseRimiReceipt(twoProductReceipt('Mokėti 3,09'));
        expect(exact.footer.total).toBeCloseTo(3.09, 2);
        // ≥ half of the item sum → trusted even if it disagrees.
        const lowButPlausible = parseRimiReceipt(twoProductReceipt('Mokėti 2,00'));
        expect(lowButPlausible.footer.total).toBeCloseTo(2.0, 2);
    });
});
