import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipts 401/383/390/402/387 regressions (mechanism tests with clean spacing —
// real coordinates can't be replayed verbatim, see ikiReceipt129 note):
//   401 — "KvitAS Nr. 157/213118" (older label inflection) fell through to the
//         synthetic date-time-total id.
//   383 — "Kvito Nr. 529 /62A/22A416": the spaced slash truncated the capture
//         to "529" and the A-for-4 rot survived. Healed → 529/624/224416.
//   390 — "Kvito Nr. 5/622/RASA0": last group rotted to letters; the VMI
//         trailer's independent "Kvito numeris 86649" supplies it.
//   402 — "IKI MAISŠELIAI 40/10X65" (doubled S/Š + plural -IAI) escaped the
//         bag skip stem and minted a product.
//   387 — "IKI KORITELĖS NR" (inserted char) missed the products-end wall, so
//         the zone ran to the sąskaitos line and the last band swallowed it.

const W = (text: string, xL: number, xR: number, yT: number, yB: number) => ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const L = (text: string, xL: number, xR: number, yT: number, yB: number): IkiLine => {
    // Pack the word boxes inside [xL, xR] so a long left-column line never
    // bleeds synthetic words into the price column (word interleaving is
    // x-ordered; a fixture must respect the receipt's column layout).
    const parts = text.split(/\s+/);
    const step = Math.max(20, Math.floor((xR - xL) / parts.length));
    return {
        text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB,
        words: parts.map((w, i) => W(w, xL + i * step, xL + i * step + step - 8, yT, yB)),
    };
};

/** Minimal thermal receipt: header + one product + configurable trailer lines. */
const thermalWith = (trailer: string[]): IkiLine[] => {
    const base: IkiLine[] = [
        L('IKI Lietuva, UAB', 60, 360, 20, 50),
        L('PVM mokėtojo kodas LT101937219', 60, 600, 100, 130),
        L('PIENAS DVARO 2,5%', 60, 420, 200, 240),
        L('1,29 A', 800, 940, 200, 240),
        L('Pardavimas SUMA', 60, 600, 460, 500),
        L('Mokėti 1,29', 60, 400, 520, 560),
    ];
    return base.concat(trailer.map((t, i) => L(t, 60, 700, 600 + i * 60, 640 + i * 60)));
};

describe('IKI receipt-id healing + label tolerance', () => {
    test('401: "Kvitas Nr." label form captures the printed id (no synthetic fallback)', () => {
        const { footer } = parseIkiReceipt(thermalWith([
            'Kvitas Nr. 157/213118 Kasa 0021',
            '2022-03-02 18:02:27',
        ]));
        expect(footer.receiptNo).toBe('157/213118');
    });

    test('383: spaced slash + A→4 rot heals to the full id', () => {
        const { footer } = parseIkiReceipt(thermalWith([
            'Kvito Nr. 529 /62A/22A416 Kaca 0001',
            '2026-05-19 19:36:13',
        ]));
        expect(footer.receiptNo).toBe('529/624/224416');
    });

    test('390: unreadable last group spliced from the VMI "Kvito numeris" print', () => {
        const { footer } = parseIkiReceipt(thermalWith([
            'Kvito Nr. 5/622/RASA0 Kaca 0022',
            '2026-07-03 08:48:01',
            'Kvito numer is 86649',
        ]));
        expect(footer.receiptNo).toBe('5/622/86649');
    });

    test('clean printed ids pass through untouched', () => {
        const { footer } = parseIkiReceipt(thermalWith([
            'Kvito Nr. 42/610/114559 Kasa 0022',
            '2026-06-18 11:47:37',
        ]));
        expect(footer.receiptNo).toBe('42/610/114559');
    });
});

describe('IKI bag skip — plural/doubled-sibilant garble (receipt-402)', () => {
    test('IKI MAISŠELIAI never becomes a product', () => {
        const { products } = parseIkiReceipt(thermalWith([]).concat([
            // bag row between products and footer, priced like the real receipt
            L('IKI MAISŠELIAI 40/10X65', 60, 520, 300, 340),
            L('0,25 A', 800, 940, 300, 340),
        ]).sort((a, b) => a.yTop - b.yTop));
        expect(products.some((p) => /MAI.?[SŠ]/i.test(p.name))).toBe(false);
        expect(products.some((p) => /PIENAS/i.test(p.name))).toBe(true);
    });
});

describe('IKI weight-calc fused into the name (receipt-387)', () => {
    test('garbled k9/EJR calc tail recovers the weighed structure when arithmetic confirms', () => {
        const { products } = parseIkiReceipt(thermalWith([]).concat([
            L('TRUMPAVAISIAI AGURKAI 0, 245 k9 2, 99 EJR/ kg', 60, 700, 300, 340),
            L('0, 73 A', 800, 940, 300, 340),
        ]).sort((a, b) => a.yTop - b.yTop));
        const cuke = products.find((p) => /AGURK/i.test(p.name));
        expect(cuke).toBeDefined();
        expect(cuke!.name).toBe('TRUMPAVAISIAI AGURKAI');
        expect(cuke!.isWeighable).toBe(true);
        expect(cuke!.quantity).toBeCloseTo(0.245, 3);
        expect(cuke!.pricePerUnit).toBeCloseTo(2.99, 2);
        expect(cuke!.price).toBeCloseTo(2.99, 2);
        expect(cuke!.parsedAmount).toBe(1);
        expect(cuke!.parsedUnit).toBe('kg');
    });

    test('a calc-shaped tail whose arithmetic does NOT reconcile is left untouched', () => {
        const { products } = parseIkiReceipt(thermalWith([]).concat([
            L('TRUMPAVAISIAI AGURKAI 0, 245 k9 2, 99 EJR/ kg', 60, 700, 300, 340),
            L('1, 73 A', 800, 940, 300, 340), // 0.245×2.99 ≈ 0.73 ≠ 1.73
        ]).sort((a, b) => a.yTop - b.yTop));
        const cuke = products.find((p) => /AGURK/i.test(p.name));
        expect(cuke).toBeDefined();
        expect(cuke!.quantity).toBe(1); // no rescue — numbers don't confirm
    });
});

describe('IKI pack size from the name (receipt-394)', () => {
    test('fused trailing litre "5L" → parsedAmount 5 l', () => {
        const { products } = parseIkiReceipt(thermalWith([]).concat([
            L('SENEL IO KOMPOSTAS 5L', 60, 520, 300, 340),
            L('1,99 A', 800, 940, 300, 340),
        ]).sort((a, b) => a.yTop - b.yTop));
        const komp = products.find((p) => /KOMPOSTAS/i.test(p.name));
        expect(komp).toBeDefined();
        expect(komp!.parsedAmount).toBe(5);
        expect(komp!.parsedUnit).toBe('l');
        expect(komp!.price).toBeCloseTo(1.99, 2);
        // Display rule (norfa parity): the captured size token leaves the name.
        expect(komp!.name).toBe('SENEL IO KOMPOSTAS');
    });
});

describe('IKI wrapped-name first word on the discount label row (receipt-402)', () => {
    test('a single word LEVEL with NUOLAIDA does not leak into the next product name', () => {
        // Print layout: KIAULIENOS product, its "NUOLAIDA FILĖ" label row (FILĖ =
        // the NEXT product's wrapped first word, sharing the label's print row),
        // then the fish name row + weight calc. Words on the label row sit LEVEL.
        const { products } = parseIkiReceipt([
            L('IKI Lietuva, UAB', 60, 360, 20, 50),
            L('PVM mokėtojo kodas LT101937219', 60, 600, 100, 130),
            L('KARSTAI RUKYTA KIAULIENOS', 60, 620, 200, 240),
            L('1,28 A', 800, 940, 200, 240),
            L('NUOLAIDA FILI', 60, 340, 300, 340),
            L('-0,26 A', 800, 940, 300, 340),
            L('ATŠALDYTOS SKROSTOS ATLAN', 60, 620, 400, 440),
            L('1,266 kg X 16,99 EUR/kg', 60, 620, 460, 500),
            L('21,51 A', 800, 940, 460, 500),
            L('Pardavimas SUMA', 60, 600, 560, 600),
            L('Mokėti 22,53', 60, 400, 620, 660),
        ]);
        const fish = products.find((p) => /ATLAN/i.test(p.name));
        expect(fish).toBeDefined();
        expect(fish!.name.startsWith('FILI')).toBe(false);
        expect(fish!.name).toMatch(/^ATŠALDYTOS/);
    });
});

describe('IKI terminal I→1 name rot (receipt-388)', () => {
    test('"RYŽIA1" folds to "RYŽIAI" at parse entry', () => {
        const { products } = parseIkiReceipt(thermalWith([]).concat([
            L('SKANĖ JA RYŽIA1 BASMAlI, 8', 60, 620, 300, 340),
            L('3,29 A', 800, 940, 300, 340),
        ]).sort((a, b) => a.yTop - b.yTop));
        const rice = products.find((p) => /BASMA/i.test(p.name));
        expect(rice).toBeDefined();
        expect(rice!.name).toContain('RYŽIAI');
        expect(rice!.name).not.toContain('RYŽIA1');
        expect(rice!.price).toBeCloseTo(3.29, 2);
    });

    test('size tokens and codes stay unfolded', () => {
        const { products } = parseIkiReceipt(thermalWith([]).concat([
            L('KOMPOSTAS 40/10X65 2,5%', 60, 620, 300, 340),
            L('1,99 A', 800, 940, 300, 340),
        ]).sort((a, b) => a.yTop - b.yTop));
        const p = products.find((x) => /KOMPOSTAS/i.test(x.name));
        expect(p).toBeDefined();
        expect(p!.name).toContain('40/10X65');
    });
});

describe('IKI products-end wall — KORITELĖS insertion garble (receipt-387)', () => {
    test('the card-number line ends the product zone (no trailer leak past it)', () => {
        const { products } = parseIkiReceipt(thermalWith([
            'IKI KORITELĖS NR',
            'Šiuo pirkimu su IKI kortele',
            'sutaupėte 1.46 EUR',
        ]));
        // Nothing from the trailer may assemble into a product.
        expect(products.some((p) => /KORITEL|kortele|sutaup/i.test(p.name))).toBe(false);
        expect(products).toHaveLength(1);
    });
});
