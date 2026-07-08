import { parseNorfaReceipt, findReceiptBandsNorfa, type NorfaLine } from '../shared/parsers/norfaParser';

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

describe('iOS split-box layouts (Pramonės-2026-01-15, real geometry)', () => {
    // Three split-box classes on one receipt, all from iOS MLKit:
    //   - the "# Kvito numeris N" label split into two same-row boxes →
    //     findHeaderEnd fell to the first-price fallback and buried the
    //     first product's (3-fragment) name row inside the header — band
    //     #1 had an anchor but no name and the product vanished;
    //   - the first name row split into THREE boxes arriving in yTop
    //     order ("*Žuvies…"(x78) + "1kg"(x1622) + "su daržovėmis,"(x1044))
    //     — pairwise concat glued "1kg" into the middle;
    //   - "KVITO SUMA" + "81, 30" + "EUR" as three boxes → total null.
    const B = (text: string, yTop: number, yBottom: number, xLeft: number, xRight: number): NorfaLine =>
        ({ text, yTop, yBottom, xLeft, xRight });
    const lines: NorfaLine[] = [
        B('D1 UAB NORFOS MAŽMENA', 60, 112, 75, 1000),
        B('Pramonės 6, Šiauliai', 155, 204, 75, 800),
        B('Visada laukiame JUSŲ,', 227, 280, 71, 866),
        B('# Kvito', 372, 418, 117, 375),
        B('numeris 326114', 373, 418, 422, 952),
        B('*Žuvies filės kepsneliai', 441, 502, 78, 992),
        B('1kg', 448, 505, 1622, 1732),
        B('su daržovėmis,', 450, 512, 1044, 1562),
        B('0,544x8,49', 523, 586, 75, 449),
        B('4,62 M1', 523, 568, 1660, 1917),
        B('Burokėliai su mango padažu, 1 kg', 596, 643, 74, 1098),
        B('0, 382x4, 05', 596, 643, 1161, 1727),
        B('1,55 M1', 664, 712, 1659, 1914),
        B('*******************************************', 3804, 3850, 78, 1726),
        B('KVITO SUMA', 3882, 3925, 72, 455),
        B('81, 30', 3883, 3928, 1393, 1571),
        B('EUR', 3886, 3930, 1621, 1731),
        B('2026-01-15 17:58', 5926, 5967, 76, 681),
    ];
    const res = parseNorfaReceipt(lines);

    test('first product survives the split kvito label, name in reading order', () => {
        expect(res.products.length).toBeGreaterThanOrEqual(2);
        expect(res.products[0].name).toBe('Žuvies filės kepsneliai su daržovėmis');
        expect((res.products[0] as any).parsedAmount).toBe(1);
        expect((res.products[0] as any).parsedUnit).toBe('kg');
        expect(res.products[0].pricePerUnit).toBe(8.49);
        expect(res.products[0].quantity).toBe(0.544);
    });
    test('three-box KVITO SUMA row reads the total', () => {
        expect(res.footer.total).toBe(81.3);
    });
    test('split receipt-no label still captures the printed number', () => {
        expect(res.footer.receiptNo).toBe('326114');
    });
});

describe('double-read suppression + weighed pack default (Pramonės-01-15, real geometry)', () => {
    const B = (text: string, yTop: number, yBottom: number, xLeft: number, xRight: number): NorfaLine =>
        ({ text, yTop, yBottom, xLeft, xRight });
    // MLKit re-read the Beatos row THREE times (full read, right-shifted
    // read with the anchor jammed in, and a lone '"Beatos' fragment), and
    // the CHAMPION row twice at a 37 px vertical offset. Without
    // suppression the reads concatenate and the names double. The
    // standalone "1,89 M1" anchor is token-contained in the jammed read —
    // it must NEVER dedupe away (a band without its anchor collapses into
    // the neighbour).
    const r = parseNorfaReceipt([
        B('D1 UAB NORFOS MAŽMENA', 60, 112, 75, 1000),
        B('# Kvito numeris 326114 #', 372, 418, 117, 952),
        B('Kepti bulviniai vėdarai, 1 kg 0, 486x5,25 2,55 M1', 2713, 2758, 73, 1919),
        B('1,89 M1', 2785, 2831, 1664, 1917),
        B("Beatos Virtuvė' juod.duon.su sėk.,300g", 2785, 2832, 113, 1571),
        B("Virtuve' juod.duon.su sėk., 300g 1,89 M1", 2787, 2828, 388, 1919),
        B('"Beatos', 2787, 2833, 84, 335),
        B('Fas. obuoliai CHAMPION 65+, 1kg 1,55xl, 15', 2822, 2874, 75, 1651),
        B('obuoliai CHAMPION 65t, 1kg 1,55x1, 15', 2859, 2899, 269, 1649),
        B('Fas.', 2863, 2907, 74, 209),
        B('1,78 M1', 2924, 2972, 1660, 1916),
        B('Kepta strimėlė garstyčių marinate 0,214x6, 35', 3006, 3083, 74, 1765),
        B('1,36 M1', 3073, 3120, 1660, 1912),
        B('KVITO SUMA 4,44 EUR', 3882, 3925, 72, 900),
        B('2026-01-15 17:58', 5926, 5967, 76, 681),
    ]);

    test('triple-read Beatos row keeps ONE clean name and its own anchor', () => {
        const beatos = r.products.find((p) => /Beatos/.test(p.name));
        expect(beatos?.name).toBe("Beatos Virtuvė' juod.duon.su sėk.");
        expect((beatos as any)?.parsedAmount).toBe(300);
        expect((beatos as any)?.parsedUnit).toBe('g');
        expect(beatos?.price).toBe(1.89);
    });
    test('offset double-read CHAMPION row keeps the fuller name, weighable calc survives', () => {
        const champ = r.products.find((p) => /CHAMPION/.test(p.name));
        expect(champ?.name).toBe('Fas. obuoliai CHAMPION 65+');
        expect((champ as any)?.parsedAmount).toBe(1);
        expect(champ?.quantity).toBe(1.55);
        expect(champ?.pricePerUnit).toBe(1.15);
    });
    test('weighed item without a size token in the name defaults to 1 kg pack', () => {
        const strim = r.products.find((p) => /strimėlė/.test(p.name));
        expect(strim?.isWeighable).toBe(true);
        expect(strim?.quantity).toBe(0.214);
        expect((strim as any)?.parsedAmount).toBe(1);
        expect((strim as any)?.parsedUnit).toBe('kg');
    });
});

describe('same-row fragments split by a structural splice rejoin in reading order', () => {
    const B = (text: string, yTop: number, yBottom: number, xLeft: number, xRight: number): NorfaLine =>
        ({ text, yTop, yBottom, xLeft, xRight });
    test('kiauliena wrap: "nis nei"(x74) + "35%), 1 kg"(x384) around the weighed calc', () => {
        const r = parseNorfaReceipt([
            B('D1 UAB NORFOS MAŽMENA', 60, 112, 75, 1000),
            B('# Kvito numeris 326114 #', 372, 418, 117, 952),
            B('Atšaldyta smulkinta kiauliena (riebumas ne dides', 2129, 2174, 70, 1919),
            B('35%), 1 kg', 2195, 2251, 384, 763),
            B('1,114x4,69 5,22 M1', 2202, 2248, 1235, 1917),
            B('nis nei', 2205, 2243, 74, 333),
            B('KVITO SUMA 5,22 EUR', 3882, 3925, 72, 900),
            B('2026-01-15 17:58', 5926, 5967, 76, 681),
        ]);
        expect(r.products).toHaveLength(1);
        expect(r.products[0].name).toBe('Atšaldyta smulkinta kiauliena (riebumas ne dides nis nei 35%)');
        expect(r.products[0].quantity).toBe(1.114);
        expect(r.products[0].pricePerUnit).toBe(4.69);
    });
});

describe('M-suffix garble: "MI" reads as M1 (downloadfile_3_ NEPTUNAS)', () => {
    const B = (text: string, yTop: number, yBottom: number, xLeft: number, xRight: number): NorfaLine =>
        ({ text, yTop, yBottom, xLeft, xRight });
    test('a "0,85 MI" anchor still anchors its band — the product does not vanish', () => {
        const r = parseNorfaReceipt([
            B('D1 UAB NORFOS MAŽMENA', 60, 112, 75, 1000),
            B('# Kvito numeris 60748 #', 444, 500, 109, 1000),
            B('Negaz. nat. mineral. vand. NEPTUNAS, 1,5 l', 519, 579, 68, 1692),
            B('0,85 MI', 591, 658, 1658, 1925),
            B('*Užstatas už pakuotę PET', 662, 720, 71, 997),
            B('0,10 M5', 669, 726, 1662, 1925),
            B('KVITO SUMA 0,95 EUR', 900, 950, 72, 900),
            B('2025-11-01 13:44', 1000, 1040, 76, 681),
        ]);
        expect(r.products).toHaveLength(1);
        expect(r.products[0].name).toBe('Negaz. nat. mineral. vand. NEPTUNAS');
        expect(r.products[0].price).toBe(0.85);
        expect((r.products[0] as any).parsedAmount).toBe(1.5);
        expect((r.products[0] as any).parsedUnit).toBe('l');
    });
});

describe('stranded-name reassignment + header receipt-no band (Pramonės-03-19)', () => {
    const B = (text: string, yTop: number, yBottom: number, xLeft: number, xRight: number): NorfaLine =>
        ({ text, yTop, yBottom, xLeft, xRight });
    // "*Piešt. dezodorantas…" (y1118) overlaps the "2x2,99  5,98 M1" price
    // row of the product ABOVE it, so y-center membership files it under
    // band 8 and product 9 (bare "2x2,65  5,30 M1") parses name-less and is
    // skipped. The guarded post-pass moves it down to its true owner.
    const lines: NorfaLine[] = [
        B('D1 UAB NORFOS MAŽMENA', 76, 124, 75, 1000),
        B('# Kvito numeris 365369 #', 374, 421, 117, 1037),
        B('Baltagūžiai kopūstai, lkg', 960, 1012, 75, 700),
        B('1,464x0,55 0,81 M1', 960, 1004, 1236, 1918),
        B('75 sk., 3 1', 1014, 1059, 1391, 1806),
        B('*Sk. skalbiklis PERLUX UNIVERSAL,', 1032, 1075, 78, 1328),
        B('2x2,99', 1104, 1157, 76, 297),
        B('5,98 M1', 1104, 1149, 1663, 1920),
        B('*Piešt. dezodorantas OLD SPICE ORIGINAL, 50 ml', 1118, 1175, 77, 1845),
        B('2x2,65', 1252, 1306, 76, 296),
        B('5,30 M1', 1244, 1300, 1659, 1915),
        B('Persiladas (priesk.mišinys) , 80g', 1322, 1377, 75, 1262),
        B('2x0,69 1,38 M1', 1325, 1371, 1390, 1916),
        B('KVITO SUMA 20,00 EUR', 3200, 3250, 72, 900),
        B('2026-03-19 17:25', 5268, 5311, 76, 703),
    ];
    const res = parseNorfaReceipt(lines);

    test('the dezodorantas product is recovered with its name (not skipped)', () => {
        const dez = res.products.find((p) => /dezodorantas/.test(p.name));
        expect(dez).toBeDefined();
        expect(dez!.name).toContain('Piešt. dezodorantas OLD SPICE ORIGINAL');
    });
    test('the skalbiklis product above keeps its own name', () => {
        const sk = res.products.find((p) => /skalbiklis/.test(p.name));
        expect(sk).toBeDefined();
        expect(sk!.name).not.toMatch(/dezodorantas/);
    });
    test('receipt-no band lands on the header label row, not a stray footer year', () => {
        const nr = findReceiptBandsNorfa(lines).bands.find((b) => b.kind === 'receipt-no');
        expect(nr).toBeDefined();
        expect(nr!.yTop).toBe(374);
    });
});

describe('fragmented receipt-no + KVITO SUMA rows (multi-box, out-of-order, garbled)', () => {
    const B = (text: string, yTop: number, yBottom: number, xLeft: number, xRight: number): NorfaLine =>
        ({ text, yTop, yBottom, xLeft, xRight });
    const base = (rows: NorfaLine[]): NorfaLine[] => [
        B('D1 UAB NORFOS MAŽMENA', 76, 124, 75, 1000),
        ...rows,
        B('Bananai, 1kg 2,0x1,25 2,50 M1', 700, 760, 72, 1900),
        B('2026-04-02 15:15', 5268, 5311, 76, 703),
    ];

    test('4-box out-of-order header "# Kvito | numeris | 300223 | #" captures 300223', () => {
        const r = parseNorfaReceipt(base([
            B('# Kvito', 445, 495, 115, 375),
            B('#', 448, 490, 1005, 1031),
            B('300223', 450, 495, 735, 953),
            B('numeris', 454, 490, 422, 681),
        ]));
        expect(r.footer.receiptNo).toBe('300223');
        const nr = findReceiptBandsNorfa(base([
            B('# Kvito', 445, 495, 115, 375),
            B('300223', 450, 495, 735, 953),
            B('numeris', 454, 490, 422, 681),
        ])).bands.find((b) => b.kind === 'receipt-no');
        expect(nr?.yTop).toBe(445);
    });

    test('reversed-order "numeris 378069" before "# Kvito" captures 378069', () => {
        const r = parseNorfaReceipt(base([
            B('numeris 378069', 374, 420, 422, 955),
            B('# Kvito', 375, 420, 116, 375),
            B('#', 375, 420, 1005, 1031),
        ]));
        expect(r.footer.receiptNo).toBe('378069');
    });

    test('"nume is" garble ("# Kvito | nume is 323884 #") captures 323884', () => {
        const r = parseNorfaReceipt(base([
            B('# Kvito', 446, 496, 115, 375),
            B('nume is 323884 #', 447, 496, 402, 1026),
        ]));
        expect(r.footer.receiptNo).toBe('323884');
    });

    test('the leaked "numeris"/"#" no longer prepends the first product name', () => {
        const r = parseNorfaReceipt(base([
            B('# Kvito', 445, 495, 115, 375),
            B('300223', 450, 495, 735, 953),
            B('numeris', 454, 490, 422, 681),
        ]));
        expect(r.products[0].name).toBe('Bananai');
        expect(r.products[0].name).not.toMatch(/numeris|Kvito|#/);
    });

    test('fragmented "KVIT | SUMA | 76,78 | EUR" (dropped O) reads total + bands it', () => {
        const lines = [
            B('D1 UAB NORFOS MAŽMENA', 76, 124, 75, 1000),
            B('# Kvito numeris 111 #', 445, 495, 115, 1030),
            B('Bananai, 1kg 2,0x1,25 2,50 M1', 700, 760, 72, 1900),
            B('*******************************', 3200, 3240, 76, 1700),
            B('KVIT', 3300, 3345, 74, 261),
            B('SUMA', 3300, 3345, 309, 456),
            B('76,78', 3298, 3343, 1391, 1572),
            B('EUR', 3300, 3345, 1621, 1732),
            B('2026-04-16 15:15', 5268, 5311, 76, 703),
        ];
        const r = parseNorfaReceipt(lines);
        expect(r.footer.total).toBe(76.78);
        const sum = findReceiptBandsNorfa(lines).bands.find((b) => b.kind === 'total');
        expect(sum).toBeDefined();
        expect(sum!.yTop).toBe(3298);
    });
});

describe('whole-bag weighable reclassification (Pramonės-04-02 potatoes)', () => {
    const B = (text: string, yTop: number, yBottom: number, xLeft: number, xRight: number): NorfaLine =>
        ({ text, yTop, yBottom, xLeft, xRight });
    const receipt = (nameRow: string, partial: string, total: string): NorfaLine[] => [
        B('D1 UAB NORFOS MAŽMENA', 76, 124, 75, 1000),
        B('# Kvito numeris 111 #', 445, 495, 115, 1030),
        B(nameRow, 443, 495, 72, 900),
        B(partial, 447, 495, 1354, 1620),
        B(total, 450, 495, 1660, 1920),
        B('KVITO SUMA 9,99 EUR', 3200, 3245, 74, 900),
        B('2026-04-02 15:15', 5268, 5311, 76, 703),
    ];

    test('"Bulves, asuotos 10kg" + "10x0,37 3,70 M1" = 10 kg weighable, not 10 vnt', () => {
        const r = parseNorfaReceipt(receipt('Bulves, asuotos 10kg', '10x0,37', '3,70 M1'));
        const p = r.products[0];
        expect(p.unit).toBe('kg');
        expect(p.isWeighable).toBe(true);
        expect(p.quantity).toBe(10);
        expect(p.pricePerUnit).toBe(0.37);
        expect((p as any).parsedAmount).toBe(10);
    });

    test('a small count multibuy whose name-kg does NOT equal the count stays vnt', () => {
        // "Miltai, 1kg" bought "2x0,99" — 2 packs of 1kg flour, NOT 2 kg.
        const r = parseNorfaReceipt(receipt('Miltai EKSTRA, 1kg', '2x0,99', '1,98 M1'));
        const p = r.products[0];
        expect(p.unit).toBe('vnt');
        expect(p.isWeighable).toBe(false);
        expect(p.quantity).toBe(2);
    });

    test('the ≥5 floor rejects a 2-pack of a 2kg item (count==name-kg but small)', () => {
        // "Miltai 2kg" × 2 = 2 packs of a 2kg bag — count 2 == name-kg 2, but
        // below the produce-bag floor, so it must stay a count multibuy.
        const r = parseNorfaReceipt(receipt('Miltai EKSTRA, 2kg', '2x0,99', '1,98 M1'));
        const p = r.products[0];
        expect(p.unit).toBe('vnt');
        expect(p.quantity).toBe(2);
    });
});
