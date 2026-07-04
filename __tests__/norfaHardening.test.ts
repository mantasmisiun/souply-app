import { parseNorfaReceipt, type NorfaLine } from '../shared/parsers/norfaParser';

// IKI-parser hardening transfers: date/time garble classes, synthetic
// receipt id, weighed price-poisoning guard + isWeighable emission,
// discount plausibility clamps, foreign-discount re-attribution and
// the name-START-anchored bag skip.

const L = (text: string, y: number): NorfaLine => ({
    text,
    yTop: y,
    yBottom: y + 20,
    xLeft: 0,
    xRight: 900,
});

describe('Norfa date/time garbles + synthetic receipt id', () => {
    // No printed "Kvito numeris" anywhere (OCR lost it), doubled hyphen
    // in the date ("2026-03--26") and a space after the time colon
    // ("17: 18") — both seen on IKI thermal prints, same garble class.
    const lines: NorfaLine[] = [
        L('UAB NORFOS MAŽMENA', 0),
        L('Pramonės 6, Šiauliai', 50),
        L('Batonas AUKSINIS, 400 g', 100),
        L('1,50 M1', 150),
        L('*******************************************', 200),
        L('KVITO SUMA 1,50 EUR', 250),
        L('2026-03--26 17: 18 KAS#38994', 300),
    ];
    const res = parseNorfaReceipt(lines);

    test('doubled-hyphen date recovers', () => {
        expect(res.footer.date).toBe('2026-03-26');
    });
    test('space-after-colon time recovers', () => {
        expect(res.footer.time).toBe('17:18');
    });
    test('synthetic receipt id built from date+time+cents', () => {
        expect(res.footer.receiptNo).toBe('20260326-1718-150-norfa-receipt');
    });
});

describe('Norfa date/time — time on its own OCR box', () => {
    const lines: NorfaLine[] = [
        L('UAB NORFOS MAŽMENA', 0),
        L('# Kvito numeris 777001 #', 50),
        L('Grietinė AB, 400 g', 100),
        L('1,19 M1', 150),
        L('*******************************************', 200),
        L('KVITO SUMA 1,19 EUR', 250),
        L('2026-01-07', 300),
        L('15: 29', 350),
    ];
    const res = parseNorfaReceipt(lines);
    test('date and split time both recover', () => {
        expect(res.footer.date).toBe('2026-01-07');
        expect(res.footer.time).toBe('15:29');
    });
    test('printed id wins over synthetic', () => {
        expect(res.footer.receiptNo).toBe('777001');
    });
});

describe('Norfa receipt-no label stem tolerance ("Koito numeris")', () => {
    const lines: NorfaLine[] = [
        L('UAB NORFOS MAŽMENA', 0),
        L('# Koito numeris 340809 #', 50), // K[v→o]ito — same rot class as IKI
        L('Varškė ŽEMAITIJOS, 13%, 300 g', 100),
        L('1,89 M1', 150),
        L('*******************************************', 200),
        L('KVITO SUMA 1,89 EUR', 250),
        L('2026-02-15 15:15 KAS#17600', 300),
    ];
    const res = parseNorfaReceipt(lines);
    test('garbled label still yields the printed id', () => {
        expect(res.footer.receiptNo).toBe('340809');
    });
});

describe('Norfa isWeighable + weighed price-poisoning guard', () => {
    // Product 1+2: weighed names (", 1 kg" / ", lkg") whose qty×€/kg row
    // was LOST to OCR — only the bare line total survived. That total is
    // for a fraction of a kg; writing it as a unit price would poison
    // the per-kg reference price. Product 3: ordinary per-piece item.
    const lines: NorfaLine[] = [
        L('UAB NORFOS MAŽMENA', 0),
        L('# Kvito numeris 111222 #', 50),
        L('Šviežia viščiukų filė, 1 kg', 100),
        L('9,38 M1', 150),
        L('Karštai rūkytų lašišų papilvės, lkg', 200), // OCR: 1kg → lkg
        L('2,24 M1', 250),
        L('PIEMENĖLIO pienas 3.5%, 1l, butelis', 300),
        L('1,09 M1', 350),
        L('*******************************************', 400),
        L('KVITO SUMA 12,71 EUR', 450),
        L('2026-01-15 18:02 KAS#10021', 500),
    ];
    const res = parseNorfaReceipt(lines);
    const [file, papilves, pienas] = res.products;

    test('all three products survive', () => {
        expect(res.products).toHaveLength(3);
    });
    test('weighed-but-unpriceable: price zeroed, ppu null, still kg ("show it, never write price")', () => {
        expect(file.name).toMatch(/viščiukų/);
        expect(file.price).toBe(0);
        expect(file.pricePerUnit).toBeNull();
        expect(file.promoPrice).toBeNull();
        expect(file.unit).toBe('kg');
        expect(file.isWeighable).toBe(true);
    });
    test('OCR "lkg" name tail also trips the guard', () => {
        expect(papilves.price).toBe(0);
        expect(papilves.pricePerUnit).toBeNull();
        expect(papilves.unit).toBe('kg');
        expect(papilves.isWeighable).toBe(true);
    });
    test('per-piece item keeps its price and isWeighable=false (", 1l," is not a kg signal)', () => {
        expect(pienas.price).toBe(1.09);
        expect(pienas.unit).toBe('vnt');
        expect(pienas.isWeighable).toBe(false);
    });
});

describe('Norfa weighed anchor — leading qty digit garble (l→1)', () => {
    const lines: NorfaLine[] = [
        L('UAB NORFOS MAŽMENA', 0),
        L('# Kvito numeris 333444 #', 50),
        L('Baltagūžiai kopūstai, lkg', 100),
        L('l,924x0,77 1,48 M1', 150), // leading 1 read as l on faded print
        L('*******************************************', 200),
        L('KVITO SUMA 1,48 EUR', 250),
        L('2026-03-19 11:11 KAS#10021', 300),
    ];
    const res = parseNorfaReceipt(lines);
    const p = res.products[0];

    test('anchor recovered as weighed 1,924 kg × 0,77 €/kg', () => {
        expect(p.quantity).toBe(1.924);
        expect(p.pricePerUnit).toBe(0.77);
        expect(p.price).toBe(0.77); // normalized to per-unit
        expect(p.unit).toBe('kg');
        expect(p.isWeighable).toBe(true);
    });
});

describe('Norfa discount plausibility clamps', () => {
    // Item 1: implausible own-band discount (-1,80 on a 0,99 line) —
    // paid would be negative, so the promo is DROPPED, base price kept.
    // Item 2: plausible discount applies normally.
    const lines: NorfaLine[] = [
        L('UAB NORFOS MAŽMENA', 0),
        L('# Kvito numeris 222333 #', 50),
        L('Batonėlis SNICKERS, 50 g', 100),
        L('0,99 M1', 150),
        L('Nuolaida -1,80 EUR', 200),
        L('Sultys CIDO, 1 l', 250),
        L('1,50 M1', 300),
        L('Nuolaida 20% -0,30 EUR', 350),
        L('*******************************************', 400),
        L('KVITO SUMA 2,19 EUR', 450),
        L('2026-04-02 10:10 KAS#10021', 500),
    ];
    const res = parseNorfaReceipt(lines);
    const [snickers, cido] = res.products;

    test('implausible discount dropped — no negative promo', () => {
        expect(snickers.price).toBe(0.99);
        expect(snickers.promoPrice).toBeNull();
    });
    test('plausible discount still applies', () => {
        expect(cido.price).toBe(1.5);
        expect(cido.promoPrice).toBe(1.2);
    });
    test('savings still counts every printed body discount line', () => {
        expect(res.footer.totalSavings).toBe(2.1);
    });
});

describe('Norfa foreign-discount re-attribution (discount y-sorted below next name)', () => {
    // The -1,80 discount box sorted BELOW product B\'s name, landing in
    // B\'s band. It belongs to A (its own discounts print right under
    // its anchor row). Old behaviour: B got promo 0,99−1,80 → wrong
    // product AND wrong maths. New behaviour: A gets promo 0,70; B is
    // untouched.
    const lines: NorfaLine[] = [
        L('UAB NORFOS MAŽMENA', 0),
        L('# Kvito numeris 888999 #', 50),
        L('Sūris DŽIUGAS, 180 g', 100),
        L('2,50 M1', 150),
        L('Pienas NORFA, 1 l', 200),
        L('Nuolaida -1,80 EUR', 250), // foreign — belongs to DŽIUGAS above
        L('0,99 M1', 300),
        L('*******************************************', 350),
        L('KVITO SUMA 1,69 EUR', 400),
        L('2026-03-26 17:20 KAS#38994', 450),
    ];
    const res = parseNorfaReceipt(lines);
    const [dziugas, pienas] = res.products;

    test('discount lands on the PREVIOUS product', () => {
        expect(dziugas.name).toMatch(/DŽIUGAS/);
        expect(dziugas.promoPrice).toBe(0.7);
    });
    test('current product no longer inherits the foreign discount', () => {
        expect(pienas.price).toBe(0.99);
        expect(pienas.promoPrice).toBeNull();
    });
    test('the discount is counted once in savings', () => {
        expect(res.footer.totalSavings).toBe(1.8);
    });
});

describe('Norfa foreign-discount clamp — implausible for the previous product too', () => {
    const lines: NorfaLine[] = [
        L('UAB NORFOS MAŽMENA', 0),
        L('# Kvito numeris 999000 #', 50),
        L('Kramtomoji guma ORBIT', 100),
        L('0,99 M1', 150),
        L('Pienas NORFA, 1 l', 200),
        L('Nuolaida -1,80 EUR', 250), // exceeds BOTH lines' totals
        L('1,09 M1', 300),
        L('*******************************************', 350),
        L('KVITO SUMA 2,08 EUR', 400),
        L('2026-03-26 17:25 KAS#38994', 450),
    ];
    const res = parseNorfaReceipt(lines);

    test('nobody gets an implausible promo', () => {
        for (const p of res.products) {
            expect(p.promoPrice).toBeNull();
            if (p.promoPrice !== null) {
                expect(p.promoPrice).toBeGreaterThanOrEqual(0);
            }
        }
    });
});

describe('Norfa bag skip — name-START anchored', () => {
    const lines: NorfaLine[] = [
        L('UAB NORFOS MAŽMENA', 0),
        L('# Kvito numeris 444555 #', 50),
        L('NORFA PE maišelis su kodu 21/11x45', 100),
        L('0,01 M1', 150),
        L('Maišytos salotos su morkomis, 400 g', 200), // real product!
        L('1,89 M1', 250),
        L('Maiğelis su kodu', 300), // garbled bag, NORFA PE prefix lost
        L('0,01 M1', 350),
        L('*******************************************', 400),
        L('KVITO SUMA 1,91 EUR', 450),
        L('2026-04-02 12:12 KAS#10021', 500),
    ];
    const res = parseNorfaReceipt(lines);

    test('bags skipped, mixed salad kept', () => {
        expect(res.products).toHaveLength(1);
        expect(res.products[0].name).toMatch(/Maišytos salotos/);
        expect(res.products[0].price).toBe(1.89);
        expect(res.products[0].isWeighable).toBe(false);
    });
});
