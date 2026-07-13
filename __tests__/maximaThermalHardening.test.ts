import {
    parseMaximaReceipt,
    type MaximaLine,
    type MaximaProduct,
} from '../shared/parsers/maximaParser';

/**
 * Hardening transfers from the battle-tested IKI thermal parser:
 *   1. receiptNo stem-garble tolerance ("Kuito Nr,"/"Avito N.") +
 *      "Dokumento numeris" alternative + synthetic date-time-total id
 *      — one rotten character must no longer hard-bail the whole scan
 *      at the app's ensureKeyReceiptFields gate.
 *   2. isWeighable emission + weighed price-poisoning guard: a kg row
 *      whose €/kg is unrecoverable ships price=0 / ppu=null instead of
 *      the fraction-of-a-kg line total ("show it, never write price").
 *   3. Discount plausibility clamps (paid ≥ 0, discount ≤ price) — a
 *      stranded/misread minus never anchors a negative promo.
 *   4. Total sanity: itemSum fallback when the printed total is missing
 *      or implausibly small, plus Grynieji − Grąža cash last resort.
 *
 * Fixture lines follow the ikiThermal style: realistic OCR-garbled
 * texts with plain bboxes, one physical row per line.
 */

const mkLines = (texts: string[]): MaximaLine[] =>
    texts.map((text, i) => ({
        text,
        yTop: i * 40,
        yBottom: i * 40 + 24,
        xLeft: 40,
        xRight: 620,
    }));

const HEADER = [
    'MAXIMA LT, UAB',
    'PVM mokėtojo kodas LT230335113',
    'Savanorių pr. 16, Vilnius, Kasa Nr. 5',
    'Kvitas bazėje: 0088004030',
];
const SEP = '================================';

const receipt = (products: string[], footer: string[]): MaximaLine[] =>
    mkLines([...HEADER, ...products, SEP, ...footer]);

// Two well-formed products used across the total/discount tests:
// cheese pays 2,19 − 0,50 = 1,69; bread pays 1,50 → itemSum 3,19.
const CHEESE = [
    'SŪRIS DŽIUGAS KIETASIS 2,19 A',
    'AČIŪ nuolaida prekei:SŪRIS DŽIUGAS',
    '-0,50 A',
];
const BREAD = ['DUONA BOČIŲ PLIKYTA 1,50 A'];

const byName = (products: MaximaProduct[], frag: string): MaximaProduct => {
    const p = products.find((x) => x.name.includes(frag));
    if (!p) throw new Error(`product "${frag}" not parsed: ${products.map((x) => x.name).join(' | ')}`);
    return p;
};

// ───────── 1. receiptNo bail hardening ─────────

describe('Maxima receiptNo — stem-garble tolerance + synthetic fallback', () => {
    test('baseline: clean "Kvito Nr. 3775" still wins (regression)', () => {
        const res = parseMaximaReceipt(receipt(BREAD, [
            'Kvito suma 1,50',
            '2026-01-12 18:33:52 Kvito Nr. 3775',
        ]));
        expect(res.footer.receiptNo).toBe('3775');
    });

    test('garbled stem "Kuito Nr, 3775" recovers (v→u, dot→comma)', () => {
        const res = parseMaximaReceipt(receipt(BREAD, [
            'Kvito suma 1,50',
            '2026-01-12 18:33:52',
            'Kuito Nr, 3775',
        ]));
        expect(res.footer.receiptNo).toBe('3775');
    });

    test('garbled stem "Koito N. 377/512" recovers (v→o, dropped r)', () => {
        const res = parseMaximaReceipt(receipt(BREAD, [
            'Kvito suma 1,50',
            '2026-01-12 18:33:52',
            'Koito N. 377/512',
        ]));
        expect(res.footer.receiptNo).toBe('377/512');
    });

    test('garbled stem "Avito Nr.3775" recovers (K→A, fused digits)', () => {
        const res = parseMaximaReceipt(receipt(BREAD, [
            'Kvito suma 1,50',
            '2026-01-12 18:33:52',
            'Avito Nr.3775',
        ]));
        expect(res.footer.receiptNo).toBe('3775');
    });

    test('garbled label on its own line + digits on the next', () => {
        const res = parseMaximaReceipt(receipt(BREAD, [
            'Kvito suma 1,50',
            '2026-01-12 18:33:52',
            'Kuito Nr.',
            '3775 Kasa 0022',
        ]));
        expect(res.footer.receiptNo).toBe('3775');
    });

    test('"Dokumento numeris" alternative source, OCR-split stem ("numer i s")', () => {
        const res = parseMaximaReceipt(receipt(BREAD, [
            'Kvito suma 1,50',
            '2026-01-12 18:33:52',
            'KVITO PATIKRINIMUI VMI',
            'Dokumento numer i s:',
            '94717',
        ]));
        expect(res.footer.receiptNo).toBe('94717');
    });

    test('synthetic fallback id from date+time+printed total when no id survived', () => {
        const res = parseMaximaReceipt(receipt(BREAD, [
            'Kvito suma 71,44',
            'Mokėtina suma 71,44',
            '2026-01-12 18:33:52',
        ]));
        expect(res.footer.receiptNo).toBe('20260112-183352-7144-maxima-receipt');
    });

    test('synthetic fallback uses the item-sum total when the printed total is also lost', () => {
        const res = parseMaximaReceipt(receipt([...CHEESE, ...BREAD], [
            '2026-01-12 18:33:52',
        ]));
        expect(res.footer.total).toBe(3.19);
        expect(res.footer.receiptNo).toBe('20260112-183352-319-maxima-receipt');
    });

    test('no synthetic id when the date is missing (app date-gate handles it)', () => {
        const res = parseMaximaReceipt(receipt(BREAD, [
            'Kvito suma 1,50',
            '18:33:52',
        ]));
        expect(res.footer.receiptNo).toBe('');
        expect(res.footer.time).toBe('18:33:52');
    });
});

describe('Maxima date/time — OCR separator tolerance', () => {
    test('dotted date "2026.01.12" parses', () => {
        const res = parseMaximaReceipt(receipt(BREAD, [
            'Kvito suma 1,50',
            '2026.01.12 18:33:52 Kvito Nr. 3775',
        ]));
        expect(res.footer.date).toBe('2026-01-12');
    });

    test('doubled-hyphen date "2026--01-12" parses', () => {
        const res = parseMaximaReceipt(receipt(BREAD, [
            'Kvito suma 1,50',
            '2026--01-12 18:33:52 Kvito Nr. 3775',
        ]));
        expect(res.footer.date).toBe('2026-01-12');
    });

    test('time with OCR space after the colon "18: 33:52" recovers', () => {
        const res = parseMaximaReceipt(receipt(BREAD, [
            'Kvito suma 1,50',
            '2026-01-12 18: 33:52 Kvito Nr. 3775',
        ]));
        expect(res.footer.time).toBe('18:33:52');
        // …and the date digits were not mistaken for a time
        expect(res.footer.date).toBe('2026-01-12');
    });
});

// ───────── 2. isWeighable + weighed price-poisoning guard ─────────

describe('Maxima weighed rows — isWeighable + price-poisoning guard', () => {
    const FOOTER = ['Kvito suma 10,00', '2026-01-12 18:33:52 Kvito Nr. 3775'];

    test('clean weighed row: unit kg, isWeighable, per-kg price', () => {
        const res = parseMaximaReceipt(receipt(
            ['BANANAI CHIQUITA 2,23 A', '1,99 X 1,118 kg', ...BREAD],
            FOOTER,
        ));
        const p = byName(res.products, 'BANANAI');
        expect(p.unit).toBe('kg');
        expect(p.isWeighable).toBe(true);
        expect(p.price).toBe(1.99);          // per-unit convention: €/kg
        expect(p.pricePerUnit).toBe(1.99);
        expect(p.quantity).toBe(1.118);
    });

    test('per-piece multipack: isWeighable false', () => {
        const res = parseMaximaReceipt(receipt(
            ['KIAUŠINIAI M10 2,36 A', '0,59 X 4 vnt.', ...BREAD],
            FOOTER,
        ));
        const p = byName(res.products, 'KIAUŠINIAI');
        expect(p.unit).toBe('vnt');
        expect(p.isWeighable).toBe(false);
        expect(p.price).toBe(0.59);
        expect(p.quantity).toBe(4);
        expect(byName(res.products, 'DUONA').isWeighable).toBe(false);
    });

    test('unit suffix dropped by OCR: fractional qty ⇒ weighed kg row', () => {
        const res = parseMaximaReceipt(receipt(
            ['MORKOS FASUOTOS 1,12 A', '0,99 X 1,133', ...BREAD],
            FOOTER,
        ));
        const p = byName(res.products, 'MORKOS');
        expect(p.unit).toBe('kg');
        expect(p.isWeighable).toBe(true);
        expect(p.price).toBe(0.99);
    });

    test('garbled €/kg but readable kg qty: €/kg re-derived from lineTotal ÷ kg', () => {
        // "1,99" rotted to "l,9J" — beyond UNIT_QTY_RE's tolerances; the
        // printed kg survives, so €/kg = 2,23 ÷ 1,118 = 1,99.
        const res = parseMaximaReceipt(receipt(
            ['BANANAI CHIQUITA 2,23 A', 'l,9J X 1,118 kq', ...BREAD],
            FOOTER,
        ));
        const p = byName(res.products, 'BANANAI');
        expect(p.unit).toBe('kg');
        expect(p.isWeighable).toBe(true);
        expect(p.pricePerUnit).toBe(1.99);
        expect(p.price).toBe(1.99);
        expect(p.quantity).toBe(1.118);
    });

    test('fully unrecoverable €/kg: price zeroed, never the line total (poisoning guard)', () => {
        const res = parseMaximaReceipt(receipt(
            ['BANANAI CHIQUITA 2,23 A', 'l,9J X ?,?? kq', ...BREAD],
            FOOTER,
        ));
        const p = byName(res.products, 'BANANAI');
        expect(p.unit).toBe('kg');
        expect(p.isWeighable).toBe(true);
        expect(p.price).toBe(0);             // server skips price <= 0
        expect(p.pricePerUnit).toBeNull();
        expect(p.promoPrice).toBeNull();
        // …and the garbled qty row did NOT leak into the next band's name
        expect(byName(res.products, 'DUONA').name).toBe('DUONA BOČIŲ PLIKYTA');
    });

    test('poisoning guard + trailing discount: no negative promo on a zeroed item', () => {
        const res = parseMaximaReceipt(receipt(
            [
                'BANANAI CHIQUITA 2,23 A',
                'l,9J X ?,?? kq',
                'AČIŪ nuolaida prekei:BANANAI',
                '-0,50 A',
                ...BREAD,
            ],
            FOOTER,
        ));
        const p = byName(res.products, 'BANANAI');
        expect(p.price).toBe(0);
        expect(p.promoPrice).toBeNull();
    });
});

// ───────── 3. discount plausibility clamps ─────────

describe('Maxima AČIŪ discounts — plausibility clamps', () => {
    const FOOTER = ['Kvito suma 10,00', '2026-01-12 18:33:52 Kvito Nr. 3775'];

    test('plausible discount still applies (regression)', () => {
        const res = parseMaximaReceipt(receipt([...CHEESE, ...BREAD], FOOTER));
        const p = byName(res.products, 'SŪRIS');
        expect(p.price).toBe(2.19);
        expect(p.promoPrice).toBe(1.69);
    });

    test('discount larger than the price is dropped (keeps base price)', () => {
        const res = parseMaximaReceipt(receipt(
            [
                'PIENAS ŽEMAITIJOS 2,5% 1,89 A',
                'AČIŪ nuolaida prekei:PIENAS ŽEMAITIJOS',
                '-2,50 A',                       // digit-garbled savings (real: -0,50)
                ...BREAD,
            ],
            FOOTER,
        ));
        const p = byName(res.products, 'PIENAS');
        expect(p.price).toBe(1.89);
        expect(p.promoPrice).toBeNull();
    });

    test('stranded bare minus never anchors a negative promo', () => {
        const res = parseMaximaReceipt(receipt(
            [
                'PIENAS ŽEMAITIJOS 2,5% 1,29 A',
                '-3,00 A',                       // foreign/misread negative row
                ...BREAD,
            ],
            FOOTER,
        ));
        const p = byName(res.products, 'PIENAS');
        expect(p.price).toBe(1.29);
        expect(p.promoPrice).toBeNull();
    });

    test('implausible INLINE discount is dropped too', () => {
        const res = parseMaximaReceipt(receipt(
            [
                'PIENAS ŽEMAITIJOS 2,5% 1,29 A',
                'AČIŪ nuolaida prekei:PIENAS -5,00 A',
                ...BREAD,
            ],
            FOOTER,
        ));
        const p = byName(res.products, 'PIENAS');
        expect(p.price).toBe(1.29);
        expect(p.promoPrice).toBeNull();
    });
});

// ───────── 4. total sanity fallbacks ─────────

describe('Maxima total — itemSum plausibility + Grynieji−Grąža last resort', () => {
    test('missing total falls back to Σ(paid line totals)', () => {
        const res = parseMaximaReceipt(receipt([...CHEESE, ...BREAD], [
            '2026-01-12 18:33:52 Kvito Nr. 3775',
        ]));
        expect(res.footer.total).toBe(3.19);   // 1,69 + 1,50
    });

    test('implausibly small misread total (< half the item sum) is replaced', () => {
        const res = parseMaximaReceipt(receipt([...CHEESE, ...BREAD], [
            'Kvito suma 0,44',                  // OCR ate the leading digits
            '2026-01-12 18:33:52 Kvito Nr. 3775',
        ]));
        expect(res.footer.total).toBe(3.19);
    });

    test('plausible printed total is never overwritten', () => {
        const res = parseMaximaReceipt(receipt([...CHEESE, ...BREAD], [
            'Kvito suma 3,44',                  // ≥ itemSum: deposits etc.
            '2026-01-12 18:33:52 Kvito Nr. 3775',
        ]));
        expect(res.footer.total).toBe(3.44);
    });

    test('cash receipt last resort: total = Grynieji − Grąža', () => {
        const res = parseMaximaReceipt(receipt(
            ['MEDUS NATŪRALUS 5,72 A', 'SULTINYS VIŠTIENOS 5,72 A'],
            [
                'Grynieji 20,00',
                'Grąža 8,56',
                '2026-01-12 18:33:52 Kvito Nr. 3775',
            ],
        ));
        expect(res.footer.total).toBe(11.44);
    });

    test('weighed zeroed items are excluded from the item-sum fallback', () => {
        const res = parseMaximaReceipt(receipt(
            ['BANANAI CHIQUITA 2,23 A', 'l,9J X ?,?? kq', ...BREAD],
            ['2026-01-12 18:33:52 Kvito Nr. 3775'],
        ));
        expect(res.footer.total).toBe(1.5);    // bread only; zeroed kg row skipped
    });
});
