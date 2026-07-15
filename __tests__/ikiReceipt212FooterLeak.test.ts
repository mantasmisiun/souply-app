import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 212 — a small IKI thermal scan (2 products totalling €2.03). OCR split the
// "Prekiautojo" trader/payment-block header into "Pr ekiaut o" (a space after "Pr"), so the
// product-end boundary regex missed it and the whole payment block ("Pr ekiaut o", "Data …
// Laikas …", the card AID + PAN) leaked in as a THIRD product. The boundary is now matched on
// the whitespace-stripped text and accepts a bare (ID-dropped) trader header, so the product
// list ends at that line.
const baseLines: IkiLine[] = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt212.json'), 'utf8'),
);
const res: any = parseIkiReceipt(JSON.parse(JSON.stringify(baseLines)));

describe('IKI receipt 212 — payment block does not leak in as a product', () => {
    test('parses exactly the two real products, no footer/payment junk line', () => {
        expect(res.products).toHaveLength(2);
        for (const p of res.products) {
            // No product name may carry payment-block / trader tokens.
            expect(p.name).not.toMatch(/Prekiaut|Data\s|Laikas|aikas|EC\/MC|Kvito|Kasa/i);
        }
    });

    test('both real products keep their prices (2.03 total reconciles)', () => {
        const paid = res.products.reduce(
            (s: number, p: any) => s + (p.promoPrice != null ? p.promoPrice : p.price) * (p.quantity || 1),
            0,
        );
        expect(paid).toBeCloseTo(2.03, 2);
    });
});
