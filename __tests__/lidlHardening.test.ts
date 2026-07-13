import { parseLidlReceipt, isLidlReceipt, type LidlLine } from '../shared/parsers/lidlParser';

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
        // Weighable → 1 kg reference pack size (rimi parity) so the
        // receipt renders "1 kg" and the matcher prefers the weighable SP.
        expect(banana!.parsedAmount).toBe(1);
        expect(banana!.parsedUnit).toBe('kg');
        expect(pienas).toBeTruthy();
        expect(pienas!.isWeighable).toBe(false);
        expect(pienas!.unit).toBe('vnt');
        // Per-piece line carries no pack-size reference.
        expect(pienas!.parsedAmount ?? null).toBeNull();
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

describe('Lidl weighable calc-leak strip + Cyrillic-kha marker', () => {
    test('mashed "name  ppu х qty kg" (Cyrillic kha) → clean name, weighable qty/ppu', () => {
        // Device OCR mashes the weighed calc onto the name row and reads the
        // "×" as Cyrillic kha (U+0445): "Arbūzai mažai sėklų 0,59 х 4,032 kg".
        const res = parseLidlReceipt(toLines([
            'Kvitas 44496/181',
            '#0044496',
            'Arbūzai mažai sėklų 0,59 х 4,032 kg',
            '2,38 A',
            'Tarpinė suma',
            '2,38',
            'Mokėti',
            '2,38',
            '2025-08-04 17:35',
            'Dokumento numeris:',
            '44496',
        ].join('\n')));
        const p = res.products[0];
        expect(p.name).toBe('Arbūzai mažai sėklų');   // calc stripped
        expect(p.unit).toBe('kg');
        expect(p.isWeighable).toBe(true);
        expect(p.quantity).toBe(4.032);
        expect(p.pricePerUnit).toBe(0.59);
    });
    test('a "…, 1kg" pack size in a name is NOT stripped (needs 3-decimal weighed qty)', () => {
        const res = parseLidlReceipt(toLines([
            'Kvitas 5/5',
            '#0000005',
            'Cukrus baltas, 1kg',
            '0,99 A',
            'Mokėti',
            '0,99',
            '2025-08-04 17:35',
            'Dokumento numeris:',
            '5',
        ].join('\n')));
        expect(res.products[0].name).toContain('1kg');
    });
});

describe('Lidl chain detection — multi-signal', () => {
    test('matches on the LIDL word or lidl.lt', () => {
        expect(isLidlReceipt(['www.lidl.lt', 'Ačiū'])).toBe(true);
        expect(isLidlReceipt(['UAB "Lidl Lietuva"'])).toBe(true);
    });
    test('matches on the PVM code alone when every LIDL token is garbled', () => {
        expect(isLidlReceipt(['UAB parduotuvė', 'PVM mok. kodas LT117910113'])).toBe(true);
        expect(isLidlReceipt(['PVM LT1179I0113'])).toBe(true); // I-for-1 confusion
    });
    test('does not false-positive on other chains', () => {
        expect(isLidlReceipt(['UAB MAXIMA LT100004', 'Vilniaus g. 5'])).toBe(false);
        expect(isLidlReceipt(['UAB NORFOS MAŽMENA', 'Pramonės 6'])).toBe(false);
    });
});

describe('Lidl total: same-row Mokėti amount, never the cash-tendered figure', () => {
    test('"Mokėti" + same-row 23,25, then next-row "50,00 (grynieji)" → total is 23,25', () => {
        // The amount box sorts just BEFORE the label (lower yTop) on the same
        // physical row; the following row is the cash tendered. The old
        // next-line scan grabbed the 50,00 cash as the total (08.08).
        const res = parseLidlReceipt([
            { text: 'Kvitas 5/5', yTop: 0, yBottom: 24, xLeft: 0, xRight: 200 },
            { text: '#0000005', yTop: 30, yBottom: 54, xLeft: 0, xRight: 200 },
            { text: 'Duona', yTop: 100, yBottom: 124, xLeft: 0, xRight: 200 },
            { text: '23,25 A', yTop: 130, yBottom: 154, xLeft: 700, xRight: 900 },
            { text: '23,25', yTop: 300, yBottom: 322, xLeft: 700, xRight: 900 },  // amount (lower y)
            { text: 'Mokėti', yTop: 302, yBottom: 326, xLeft: 40, xRight: 200 },   // label (higher y)
            { text: '50,00', yTop: 340, yBottom: 362, xLeft: 700, xRight: 900 },
            { text: '(grynieji)', yTop: 342, yBottom: 366, xLeft: 120, xRight: 400 },
            { text: '2025-08-08 12:00', yTop: 400, yBottom: 424, xLeft: 0, xRight: 400 },
        ]);
        expect(res.footer.total).toBe(23.25);
    });
});

describe('Lidl OCR homoglyph fold ¿ → į', () => {
    test('the inverted question mark folds to i-ogonek in a product name', () => {
        const res = parseLidlReceipt([
            { text: 'Kvitas 5/5', yTop: 0, yBottom: 24, xLeft: 0, xRight: 200 },
            { text: '#0000005', yTop: 30, yBottom: 54, xLeft: 0, xRight: 200 },
            { text: 'Karam.ledai su karam. ¿daru', yTop: 100, yBottom: 124, xLeft: 0, xRight: 400 },
            { text: '0,39 A', yTop: 102, yBottom: 126, xLeft: 700, xRight: 900 },
            { text: 'Mokėti 0,39', yTop: 300, yBottom: 324, xLeft: 0, xRight: 400 },
            { text: '2025-07-25 12:00', yTop: 400, yBottom: 424, xLeft: 0, xRight: 400 },
        ]);
        expect(res.products[0].name).toContain('įdaru');
        expect(res.products[0].name).not.toContain('¿');
    });
});

describe('Lidl Android-path same-row double-read dedup', () => {
    test('a garbled second read of a name row is deduped (keeps the cleaner)', () => {
        // MLKit emitted the name twice on one physical row plus its barcode:
        // "Vištu kiaušiniai L" (clean, diacritics) + "7610894" (barcode) +
        // "Vistu kiausiniai L" (diacritic-stripped twin). The Android merge
        // used to concatenate all three; now it dedups to the clean read.
        const B = (text: string, yTop: number, xLeft: number, xRight: number): LidlLine =>
            ({ text, yTop, yBottom: yTop + 24, xLeft, xRight });
        const res = parseLidlReceipt([
            B('Kvitas 5/5', 0, 0, 200),
            B('#0000005', 30, 0, 200),
            B('Vištu kiaušiniai L', 100, 60, 520),
            B('7610894', 100, 540, 700),
            B('Vistu kiausiniai L', 108, 66, 526),
            B('2,55 A', 102, 760, 900),
            B('Mokėti 2,55', 300, 0, 400),
            B('2025-08-04 12:00', 400, 0, 400),
        ]);
        expect(res.products).toHaveLength(1);
        expect(res.products[0].name).toBe('Vištu kiaušiniai L');
    });
});

describe('Lidl multipack count from the deposit cluster', () => {
    test('"(4X0,1)" deposit → quantity 4, price normalized per-unit (beer 4-pack)', () => {
        // The product line "4x0,568" is count×VOLUME (not a price multibuy),
        // so no unit-line regex extracts a qty; the deposit "(4X0,1)" =
        // 4 bottles × 0,10 is the reliable count.
        const B = (text: string, yTop: number, xLeft: number, xRight: number): LidlLine =>
            ({ text, yTop, yBottom: yTop + 24, xLeft, xRight });
        const res = parseLidlReceipt([
            B('Kvitas 5/5', 0, 0, 200),
            B('#0000005', 30, 0, 200),
            B('Svyturys Ekstra a.5,2% 4x0, 568', 100, 216, 776),
            B('6,79 F', 100, 920, 1028),
            B('Idėta (Užstatas)', 140, 61, 346),
            B('0002004 Uzstatas 0,4 (4X0,1)', 176, 59, 595),
            B('0,40 !', 176, 920, 1026),
            B('Mokėti 30,00', 400, 0, 400),
            B('2025-07-25 12:00', 440, 0, 400),
        ]);
        expect(res.products[0].quantity).toBe(4);
        expect(res.products[0].price).toBe(1.70);   // 6,79 ÷ 4, per-unit
    });
    test('a single-bottle deposit "(1X0,1)" does NOT set a multipack count', () => {
        const B = (text: string, yTop: number, xLeft: number, xRight: number): LidlLine =>
            ({ text, yTop, yBottom: yTop + 24, xLeft, xRight });
        const res = parseLidlReceipt([
            B('Kvitas 5/5', 0, 0, 200),
            B('#0000005', 30, 0, 200),
            B('Alus 0,5l', 100, 216, 600),
            B('1,29 F', 100, 920, 1028),
            B('0002004 Uzstatas 0,1 (1X0,1)', 176, 59, 595),
            B('0,10 !', 176, 920, 1026),
            B('Mokėti 1,39', 400, 0, 400),
            B('2025-07-25 12:00', 440, 0, 400),
        ]);
        expect(res.products[0].quantity).toBe(1);
    });
});

describe('Lidl receipt-no: header Kvitas outvotes footer noise', () => {
    test('the Security-Module "SM-000025027" is not taken as the receipt number', () => {
        // Real number 47609 (Kvitas + #00047609 = 2 corroborating sources).
        // The footer "Dokumento numeris:" is followed by "Saugos modulio
        // numeris: SM-000025027" whose SM id used to win (08.18).
        const res = parseLidlReceipt(toLines([
            'UAB "Lidl Lietuva"',
            '#00047609',
            'Kvitas 47609/256',
            'Duona',
            '0,99 A',
            'Mokėti 0,99',
            '2025-08-18 12:00',
            'Dokumento numeris:',
            'Saugos modulio numeris: SM-000025027',
        ].join('\n')));
        expect(res.footer.receiptNo).toBe('47609');
    });
});

describe('Lidl: a separator "----" row is not a product', () => {
    test('the dashes row above "Tarpinė suma" does not pair with the total', () => {
        const res = parseLidlReceipt(toLines([
            'Kvitas 5/5',
            '#0000005',
            'Duona',
            '1,00 A',
            '----',
            '3,47',
            'Tarpinė suma',
            '3,47',
            'Mokėti',
            '3,47',
            '2025-08-29 12:00',
        ].join('\n')));
        expect(res.products.every((p) => /[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/.test(p.name))).toBe(true);
        expect(res.products.some((p) => p.name.startsWith('----'))).toBe(false);
    });
});

describe('Lidl robust same-row double-read dedup (y-overlap + quality)', () => {
    const B = (text: string, yTop: number, yBottom: number, xLeft: number, xRight: number): LidlLine =>
        ({ text, yTop, yBottom, xLeft, xRight });
    const wrap = (rows: LidlLine[]): LidlLine[] => [
        B('Kvitas 5/5', 0, 24, 0, 200),
        B('#0000005', 30, 54, 0, 200),
        ...rows,
        B('Mokėti 9,99', 2000, 2024, 0, 400),
        B('2025-07-30 12:00', 2100, 2124, 0, 400),
    ];

    test('HALF-HEIGHT garble twin is deduped (clean kept) — clustering by y-overlap', () => {
        // "DausaLlILaL" is h=12 vs "Sausainiai Gaidelis" h=26; its offset
        // center used to land it in its own cluster (never compared).
        const res = parseLidlReceipt(wrap([
            B('Sausainiai Gaidelis', 100, 126, 228, 579),
            B('7607264', 102, 126, 61, 186),
            B('DausaLlILaL UaLuCLls', 112, 124, 235, 579),
            B('0,75 A', 102, 126, 920, 1026),
        ]));
        expect(res.products[0].name).toBe('Sausainiai Gaidelis');
    });

    test('SAME-LEFT-EDGE partial twin (different xRight) is deduped', () => {
        // "Val saes urlerele su" x235-581 partial re-read of the wider clean
        // "Varškes … žalumynais" x238-776 — sameColumn missed it (xRight far).
        const res = parseLidlReceipt(wrap([
            B('Varškes užtepėlė su žalumynais', 100, 130, 238, 776),
            B('7600198', 102, 126, 61, 186),
            B('Val saes urlerele su', 112, 133, 235, 581),
            B('1,59 A', 100, 133, 920, 1028),
        ]));
        expect(res.products[0].name).toBe('Varškes užtepėlė su žalumynais');
    });

    test('LOWERCASE-gibberish twin loses to a clean name with digits/% (not letter count)', () => {
        const res = parseLidlReceipt(wrap([
            B('Pienas 3,2% PET', 100, 126, 238, 560),
            B('rlellas o,corcl', 112, 133, 235, 561),
            B('0,99 A', 100, 126, 920, 1026),
        ]));
        expect(res.products[0].name).toBe('Pienas 3,2% PET');
    });

    test('a short "Pop." partial does not double the name', () => {
        const res = parseLidlReceipt(wrap([
            B('Pop. rankšluosčiai Jumbo XXL', 100, 126, 240, 737),
            B('7605104', 102, 126, 61, 184),
            B('Pop.', 112, 133, 240, 306),
            B('2,49 A', 100, 126, 920, 1026),
        ]));
        expect(res.products[0].name).toBe('Pop. rankšluosčiai Jumbo XXL');
    });
});
