import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 214 — a dense IKI thermal scan captured via the DEV Re-OCR tool (so this is the
// FAITHFUL parse input, not the slimmed stored blob). Two defects were reported off the image:
//   1. The plastic bag "MAIŠELIS PLASTIKINIS LENG" (€0,01) leaked in as a PHANTOM product that
//      inherited the PRIOR product's name ("Žaliosios cukinijos" @0,01). The bag row is a skip,
//      but its OWN price on the next row was left untouched → minted + name-recovered. FIXED: the
//      bag-price fold drops that row (mirrors the bottle-deposit price fold).
//   2. The multi-buy "Žaliosios cukinijos / 2 vnt. X 1,49 EUR/ vr = 2,98" — the "vr" (vienetui)
//      OCR'd as "VI", and the column engine merged the name row + calc row, interleaving the words
//      ("Žaliosios 2 vnt. X cukinijos 1,49 EUR/ VI"). The T_UNIT_CALC_RE suffix now tolerates the
//      Vr→VI garble, but the WORD-INTERLEAVE from clustering still needs a fix (see test.todo).
const baseLines: IkiLine[] = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt214.json'), 'utf8'),
);
const res: any = parseIkiReceipt(JSON.parse(JSON.stringify(baseLines)));

describe('IKI receipt 214 — bag does not leak in as a product', () => {
    test('no phantom product from the "MAIŠELIS PLASTIKINIS" plastic bag', () => {
        for (const p of res.products) {
            expect(p.name).not.toMatch(/MAI[SŠ]EL|PLASTIKIN/i);
        }
    });

    test('no €0,01 bag-priced phantom line survives', () => {
        const pennyLines = res.products.filter(
            (p: any) => typeof p.price === 'number' && p.price > 0 && p.price <= 0.02,
        );
        expect(pennyLines).toHaveLength(0);
    });

    test('the real "Žaliosios cukinijos" appears once, not duplicated by the bag row', () => {
        const cuk = res.products.filter((p: any) => /cukinij/i.test(p.name));
        expect(cuk).toHaveLength(1);
    });

    test('multi-buy "Žaliosios cukinijos" resolves to a clean name, qty 2, per-unit price', () => {
        const cuk = res.products.find((p: any) => /cukinij/i.test(p.name));
        expect(cuk).toBeTruthy();
        // Name is clean — the interleaved "2 vnt. X 1,49 EUR/ VI" calc is stripped out.
        expect(cuk.name).not.toMatch(/vnt|EUR|\dX|X\s*\d/i);
        expect(cuk.name.replace(/\s+/g, ' ').trim()).toBe('Žaliosios cukinijos');
        // 2 units at €1,49 each; the −1,80 loyalty discount → €0,59 per unit paid.
        expect(cuk.quantity).toBe(2);
        expect(cuk.price).toBeCloseTo(1.49, 2);
        expect(cuk.promoPrice).toBeCloseTo(0.59, 2);
    });
});
