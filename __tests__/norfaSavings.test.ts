import { parseNorfaReceipt, type NorfaLine } from '../shared/parsers/norfaParser';

// Norfa savings semantics (modeled on the Pramonės g. 6 receipt set):
//
//   KVITO SUMA                         78,74 EUR
//   NUOLAIDA PREKIŲ SUMAI              63,07 EUR   ← loyalty ACCRUAL BASE, *not* savings
//   Nurašyti "NORFOS pinigai"          -0,74 EUR
//   NUOLAIDA KVITUI                    -0,74 EUR   ← receipt-level discount = savings
//
// plus per-item `Nuolaida NN% -N,NN EUR` lines in the body.
// savings = Σ body discounts + |NUOLAIDA KVITUI| — NEVER the PREKIŲ
// SUMAI figure (the old parser shipped "you saved 63,07 €" on a 78 €
// receipt with a real discount of 0,74 €).

const L = (text: string, y: number): NorfaLine => ({
    text,
    yTop: y,
    yBottom: y + 20,
    xLeft: 0,
    xRight: 900,
});

describe('Norfa savings — accrual base is never savings', () => {
    // Realistic footer garbles: `78, 74` stray space, doubled hyphen in
    // the loyalty-expiry date row above the timestamp.
    const lines: NorfaLine[] = [
        L('D1_UAB NORFOS MAŽMENA', 0),
        L('Pramonės 6, Šiauliai', 50),
        L('# Kvito numeris 300223 #', 100),
        L('Kepta jūros lydeka, 1kg', 150),
        L('0,384x10,09 3,87 M1', 200),
        L('Silkių filė ZIGMAS MATES, aliejuje, 240 g', 250),
        L('1,79 M1', 300),
        L('Nuolaida 33% -0,78 EUR', 350),
        L('*******************************************', 400),
        L('KVITO SUMA 78, 74 EUR', 450),
        L('NUOLAIDA PREKIŲ SUMAI 63,07 EUR', 500),
        L('Nurašyti NORFOS pinigai -0,74 EUR', 550),
        L('NUOLAIDA KVITUI -0,74 EUR', 600),
        L('TARPINĖ SUMA 78,00 EUR', 650),
        L('NORFA pinigai galioja iki 2026-09-22', 700),
        L('2026-03-26 17:18 KAS#38994', 750),
        L('@ LTF CR-000028082 04 300223', 800),
    ];
    const res = parseNorfaReceipt(lines);

    test('savings = body discount + |NUOLAIDA KVITUI| (0,78 + 0,74)', () => {
        expect(res.footer.totalSavings).toBe(1.52);
    });
    test('savings is NOT the 63,07 accrual base', () => {
        expect(res.footer.totalSavings).not.toBe(63.07);
    });
    test('total from KVITO SUMA (stray-space decimal)', () => {
        expect(res.footer.total).toBe(78.74);
    });
    test('body discount still drives the item promo price', () => {
        const silke = res.products.find((p) => /Silkių/i.test(p.name));
        expect(silke).toBeDefined();
        expect(silke!.price).toBe(1.79);
        expect(silke!.promoPrice).toBe(1.01);
    });
    test('receiptNo from the header label line', () => {
        expect(res.footer.receiptNo).toBe('300223');
    });
    test('date/time = the timestamp row, not the loyalty-expiry date above it', () => {
        expect(res.footer.date).toBe('2026-03-26');
        expect(res.footer.time).toBe('17:18');
    });
});

describe('Norfa savings — receipt with NO discount at all', () => {
    // Vilties g. receipt shape: PREKIŲ SUMAI == KVITO SUMA == SUMA,
    // no NUOLAIDA KVITUI, no body discounts. The old parser reported
    // totalSavings = 15,59 (the full receipt total!) here.
    const lines: NorfaLine[] = [
        L('UAB NORFOS MAŽMENA', 0),
        L('# Kvito numeris 401001 #', 50),
        L('Kiaušiniai M10 vnt.', 100),
        L('2,19 M1', 150),
        L('*******************************************', 200),
        L('KVITO SUMA 15,59 EUR', 250),
        L('NUOLAIDA PREKIŲ SUMAI 15,59 EUR', 300),
        L('TARPINĖ SUMA 15,59 EUR', 350),
        L('2026-03-01 12:44 KAS#10021', 400),
    ];
    const res = parseNorfaReceipt(lines);

    test('totalSavings stays null (never the accrual base)', () => {
        expect(res.footer.totalSavings).toBeNull();
    });
    test('total intact', () => {
        expect(res.footer.total).toBe(15.59);
    });
});

describe('Norfa savings — body per-item discounts only (no NUOLAIDA KVITUI)', () => {
    const lines: NorfaLine[] = [
        L('UAB NORFOS MAŽMENA', 0),
        L('# Kvito numeris 500555 #', 50),
        L('Jogurtas braškių, 400 g', 100),
        L('1,29 M1', 150),
        L('Nuolaida 33% -0, 43 EUR', 200), // OCR stray space in the amount
        L('*******************************************', 250),
        L('KVITO SUMA 0,86 EUR', 300),
        L('NUOLAIDA PREKIŲ SUMAI 1,29 EUR', 350),
        L('2026-04-02 09:12 KAS#10021', 400),
    ];
    const res = parseNorfaReceipt(lines);

    test('savings = the single body discount', () => {
        expect(res.footer.totalSavings).toBe(0.43);
    });
    test('promo applied on the item', () => {
        expect(res.products[0].promoPrice).toBe(0.86);
    });
});

describe('Norfa savings — NUOLAIDA KVITUI amount split onto neighbour line', () => {
    const lines: NorfaLine[] = [
        L('UAB NORFOS MAŽMENA', 0),
        L('# Kvito numeris 600606 #', 50),
        L('Duona AGOTOS, 430 g', 100),
        L('1,45 M1', 150),
        L('*******************************************', 200),
        L('KVITO SUMA 1,45 EUR', 250),
        L('NUOLAIDA KVITUI', 300), // label-only box
        L('-0,45 EUR', 350), // amount box (MLKit split)
        L('2026-02-15 15:15 KAS#17600', 400),
    ];
    const res = parseNorfaReceipt(lines);

    test('savings recovered from the neighbour amount box', () => {
        expect(res.footer.totalSavings).toBe(0.45);
    });
});
