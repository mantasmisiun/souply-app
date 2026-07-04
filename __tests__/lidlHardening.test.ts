import { parseLidlReceipt, type LidlLine } from '../shared/parsers/lidlParser';

const toLines = (raw: string): LidlLine[] =>
    raw.split('\n').map((text, i) => ({ text, yTop: i * 30, yBottom: i * 30 + 24, xLeft: 0, xRight: 400 }));

// IKI-hardening transfers into the Lidl parser:
//   1. date/time scanned INDEPENDENTLY with OCR-garble tolerance (one
//      garbled char used to lose BOTH → app-level RETAKE bail),
//      plus the synthetic receipt-id fallback.
//   2. isWeighable emission + weighed price-poisoning guard
//      ("show it, never write price").
//   3. discount plausibility clamps (paid>=0, d<=price).
//   4. lenient unit/price regex wiring (Cat HH / Cat X / PRICE_LIKE).

describe('Lidl date/time bail hardening', () => {
    test('control: clean combined "YYYY-MM-DD HH:MM" line still wins', () => {
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Pienas rinktinis',
            '1,09 A',
            'Tarpinė suma',
            '1,09',
            'Mokėti',
            '1,09',
            '2025-06-18 18:33',
            'Dokumento numeris:',
            '12345',
        ].join('\n')));
        expect(res.footer.date).toBe('2025-06-18');
        expect(res.footer.time).toBe('18:33');
    });

    test('doubled-hyphen date garble: date AND time both recovered independently', () => {
        // "2025-06--18" kills the old single combined regex → date AND
        // time were both lost → RETAKE bail for the whole receipt.
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Pienas rinktinis',
            '1,09 A',
            'Tarpinė suma',
            '1,09',
            'Mokėti',
            '1,09',
            '2025-06--18 18:33',
            'Dokumento numeris:',
            '12345',
        ].join('\n')));
        expect(res.footer.date).toBe('2025-06-18');
        expect(res.footer.time).toBe('18:33');
    });

    test('MLKit splits date and time into separate boxes (+ OCR space after colon)', () => {
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Pienas rinktinis',
            '1,09 A',
            'Tarpinė suma',
            '1,09',
            'Mokėti',
            '1,09',
            '2025-06-18',
            '18: 33',
            'Dokumento numeris:',
            '12345',
        ].join('\n')));
        expect(res.footer.date).toBe('2025-06-18');
        expect(res.footer.time).toBe('18:33');
    });

    test('seconds-bearing time with a garbled first colon ("18-33:05")', () => {
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Pienas rinktinis',
            '1,09 A',
            'Tarpinė suma',
            '1,09',
            'Mokėti',
            '1,09',
            '2025.06.18',
            'Laikas 18-33:05',
            'Dokumento numeris:',
            '12345',
        ].join('\n')));
        expect(res.footer.date).toBe('2025-06-18'); // dotted separators tolerated
        expect(res.footer.time).toBe('18:33');
    });

    test('footer codes can never masquerade as a date or time', () => {
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Pienas rinktinis',
            '1,09 A',
            'Tarpinė suma',
            '1,09',
            'Mokėti',
            '1,09',
            'SM-000022355',
            'R-000152976',
            '0017300621',
            'Dokumento numeris:',
            '12345',
        ].join('\n')));
        expect(res.footer.date).toBe('');
        expect(res.footer.time).toBe('');
    });

    test('implausible month/day is rejected rather than shipped ("2025-96-18")', () => {
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Pienas rinktinis',
            '1,09 A',
            'Tarpinė suma',
            '1,09',
            'Mokėti',
            '1,09',
            '2025-96--18',
            'Dokumento numeris:',
            '12345',
        ].join('\n')));
        expect(res.footer.date).toBe('');
    });
});

describe('Lidl synthetic receipt-id fallback (IKI idiom)', () => {
    test('no printed id survived but date+time+total did → synthetic id', () => {
        const res = parseLidlReceipt(toLines([
            'UAB "Lidl Lietuva"',
            'Gedimino g. 35, Radviliškis',
            'Pienas rinktinis',
            '1,09 A',
            'Tarpinė suma',
            '1,09',
            'Mokėti',
            '1,09',
            '2025-06-18 18:33',
        ].join('\n')));
        expect(res.footer.receiptNo).toBe('20250618-1833-109-lidl-receipt');
    });

    test('printed id still wins over the synthetic fallback', () => {
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Pienas rinktinis',
            '1,09 A',
            'Tarpinė suma',
            '1,09',
            'Mokėti',
            '1,09',
            '2025-06-18 18:33',
        ].join('\n')));
        expect(res.footer.receiptNo).toBe('12345');
    });
});

describe('Lidl isWeighable emission + weighed price-poisoning guard', () => {
    test('clean weighable line → isWeighable true; per-piece → false', () => {
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Bananai',
            '0,99 x 1,254 kg',
            '1,24 A',
            'Pienas rinktinis',
            '1,09 A',
            'Tarpinė suma',
            '2,33',
            'Mokėti',
            '2,33',
            'Dokumento numeris:',
            '12345',
        ].join('\n')));
        const banana = res.products.find((p) => /bananai/i.test(p.name));
        const pienas = res.products.find((p) => /pienas/i.test(p.name));
        expect(banana).toBeTruthy();
        expect(banana!.isWeighable).toBe(true);
        expect(banana!.unit).toBe('kg');
        expect(banana!.price).toBeCloseTo(0.99, 2); // €/kg, per-unit contract
        expect(banana!.quantity).toBeCloseTo(1.254, 3);
        expect(pienas).toBeTruthy();
        expect(pienas!.isWeighable).toBe(false);
        expect(pienas!.unit).toBe('vnt');
    });

    test('split kg tail, ppu lost, FRACTION of a kg: €/kg derived as total ÷ qty', () => {
        // Old behaviour: quantity 0.343 failed the `> 1` derive gate, so
        // the 0,59 LINE TOTAL (for a third of a kg) shipped as the
        // "price" — a poisoned €/kg reference.
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Krapai',
            '0,343 kg',
            '0,59 A',
            'Tarpinė suma',
            '0,59',
            'Mokėti',
            '0,59',
            'Dokumento numeris:',
            '12345',
        ].join('\n')));
        const p = res.products.find((x) => /krapai/i.test(x.name));
        expect(p).toBeTruthy();
        expect(p!.isWeighable).toBe(true);
        expect(p!.unit).toBe('kg');
        expect(p!.quantity).toBeCloseTo(0.343, 3);
        expect(p!.price).toBeCloseTo(1.72, 2);          // 0.59 ÷ 0.343 — NOT 0.59
        expect(p!.pricePerUnit).toBeCloseTo(1.72, 2);
    });

    test('weighed line whose numbers all rotted (orphan "€/kg"): price=0, never the line total', () => {
        // "show it, never write price": server skips price<=0 writes, so
        // a fraction-of-kg line total can't become a unit reference price.
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Vynuogės be kaulų',
            '€/kg',
            '1,15 A',
            'Pienas rinktinis',
            '1,09 A',
            'Tarpinė suma',
            '2,24',
            'Mokėti',
            '2,24',
            'Dokumento numeris:',
            '12345',
        ].join('\n')));
        const p = res.products.find((x) => /vynuog/i.test(x.name));
        expect(p).toBeTruthy();
        expect(p!.price).toBe(0);
        expect(p!.pricePerUnit).toBeNull();
        expect(p!.promoPrice).toBeNull();
        expect(p!.unit).toBe('kg');
        expect(p!.isWeighable).toBe(true);
    });

    test('implausible derived €/kg (garbled qty) trips the guard instead of shipping', () => {
        // qty OCR-rotted to 0,001 kg → total ÷ qty = 2990 €/kg — nonsense.
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Obuoliai fasuoti',
            '0,001 kg',
            '2,99 A',
            'Tarpinė suma',
            '2,99',
            'Mokėti',
            '2,99',
            'Dokumento numeris:',
            '12345',
        ].join('\n')));
        const p = res.products.find((x) => /obuoliai/i.test(x.name));
        expect(p).toBeTruthy();
        expect(p!.price).toBe(0);
        expect(p!.pricePerUnit).toBeNull();
        expect(p!.isWeighable).toBe(true);
    });

    test('packaged size in the NAME ("1 kg" / "1,5 kg") never flips to weighable', () => {
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Grikių kruopos 1 kg',
            '1,89 A',
            'Kvietiniai miltai 1,5 kg',
            '1,19 A',
            'Tarpinė suma',
            '3,08',
            'Mokėti',
            '3,08',
            'Dokumento numeris:',
            '12345',
        ].join('\n')));
        const kruopos = res.products.find((x) => /kruopos/i.test(x.name));
        const miltai = res.products.find((x) => /miltai/i.test(x.name));
        expect(kruopos).toBeTruthy();
        expect(kruopos!.isWeighable).toBe(false);
        expect(kruopos!.price).toBeCloseTo(1.89, 2);
        expect(miltai).toBeTruthy();
        expect(miltai!.isWeighable).toBe(false);
        expect(miltai!.price).toBeCloseTo(1.19, 2);
    });

    test('weighed 3-decimal weight mashed INTO the name line still counts as a kg signal', () => {
        // Unit line too rotted for the unit regexes — OCR merged the
        // weight into the name row. The 3-decimal "0,466 kg" is the
        // surviving signal: weighed + €/kg derived from total ÷ qty.
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Pomidorai svertiniai 0,466 kg',
            '1,12 A',
            'Tarpinė suma',
            '1,12',
            'Mokėti',
            '1,12',
            'Dokumento numeris:',
            '12345',
        ].join('\n')));
        const p = res.products.find((x) => /pomidorai/i.test(x.name));
        expect(p).toBeTruthy();
        expect(p!.isWeighable).toBe(true);
        expect(p!.unit).toBe('kg');
        expect(p!.quantity).toBeCloseTo(0.466, 3);
        expect(p!.price).toBeCloseTo(2.4, 2); // 1.12 ÷ 0.466
    });
});

describe('Lidl lenient unit/price rescue (Cat HH / Cat X / PRICE_LIKE)', () => {
    test('Cat X: garbled prefix + weight tail ("CEoX 0,343 kg") recovers qty and stays out of the name', () => {
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Svogūnai geltonieji',
            'CEoX 0,343 kg',
            '0,59 A',
            'Tarpinė suma',
            '0,59',
            'Mokėti',
            '0,59',
            'Dokumento numeris:',
            '12345',
        ].join('\n')));
        const p = res.products.find((x) => /svog/i.test(x.name));
        expect(p).toBeTruthy();
        expect(p!.name).not.toMatch(/CEoX/i);
        expect(p!.isWeighable).toBe(true);
        expect(p!.quantity).toBeCloseTo(0.343, 3);
        expect(p!.price).toBeCloseTo(1.72, 2); // 0.59 ÷ 0.343
    });

    test('Cat HH: unit line with mashed suffix ("0,35 x 10,000yimo…") yields ppu+qty, garbage dropped', () => {
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Skalbimo spaustuvai',
            '0,35 x 10,000yimo spaustuvai 4',
            '3,50 A',
            'Tarpinė suma',
            '3,50',
            'Mokėti',
            '3,50',
            'Dokumento numeris:',
            '12345',
        ].join('\n')));
        const p = res.products.find((x) => /spaustuvai/i.test(x.name));
        expect(p).toBeTruthy();
        expect(p!.name).toBe('Skalbimo spaustuvai');
        expect(p!.quantity).toBe(10);
        expect(p!.price).toBeCloseTo(0.35, 2);
        expect(p!.isWeighable).toBe(false);
    });

    test('PRICE_LIKE fragment ("O, 90 A") is consumed instead of polluting the name', () => {
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Sūris Džiugas',
            'O, 90 A',
            '2,49 A',
            'Tarpinė suma',
            '2,49',
            'Mokėti',
            '2,49',
            'Dokumento numeris:',
            '12345',
        ].join('\n')));
        const p = res.products.find((x) => /džiugas/i.test(x.name));
        expect(p).toBeTruthy();
        expect(p!.name).toBe('Sūris Džiugas');
        expect(p!.price).toBeCloseTo(2.49, 2);
    });
});

describe('Lidl discount plausibility clamps', () => {
    test('discount larger than the line total is DROPPED (no negative promo)', () => {
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Sviestas 82%',
            '1,49 A',
            'Lidl Plus nuolaida',
            '-2,50 A',
            'Tarpinė suma',
            '1,49',
            'Mokėti',
            '1,49',
            'Dokumento numeris:',
            '12345',
        ].join('\n')));
        const p = res.products.find((x) => /sviestas/i.test(x.name));
        expect(p).toBeTruthy();
        expect(p!.promoPrice).toBeNull();     // was -1.01 before the clamp
        expect(p!.price).toBeCloseTo(1.49, 2);
    });

    test('plausible discount is kept (paid = price − d ≥ 0)', () => {
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Sviestas 82%',
            '2,49 A',
            'Lidl Plus nuolaida',
            '-0,50 A',
            'Tarpinė suma',
            '2,49',
            'Mokėti',
            '1,99',
            'Dokumento numeris:',
            '12345',
        ].join('\n')));
        const p = res.products.find((x) => /sviestas/i.test(x.name));
        expect(p).toBeTruthy();
        expect(p!.promoPrice).toBeCloseTo(1.99, 2);
        expect(p!.price).toBeCloseTo(2.49, 2);
    });
});
