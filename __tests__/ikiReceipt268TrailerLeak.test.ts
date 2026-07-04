import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';
import { detectCardMaskBands, redactReceiptText } from '../shared/parsers/cardMaskDetection';

// Receipt 268 (a worse re-scan of 242's vegetables receipt) — three tolerance gaps:
//
// 1. "EUR" with the U DROPPED ("2,99 ER/ kg"): the agurkai calc row went unrecognized as
//    a weight row, the product never closed, and it swallowed the calc line + the next
//    product (the oil) into one name. T_EUR now accepts the U-less form ANCHORED to the
//    following slash ("ER/") so a stray "er" inside a word can never qualify.
//
// 2. Card-number line "IKI KOR(ELĖS NR. 944…" — the T read as '(' (non-word), escaping
//    both the products-end wall (KOR\w? → KOR.?) AND the PII mask label (fold() now
//    NFD-strips ALL diacritics; kor.?el; the digit-run class includes the ^ junk) —
//    it used to become a price-0 phantom product exposing the full loyalty number.
//
// 3. Weighed total with BOTH the integer and separator dropped ("EUR/ kg 86 A" for
//    "0,86 A"): the bare-digit→cents lane now backstops weight rows, so the paprika
//    keeps its amount AND recovers the promo €/kg.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt268.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);
const byName = (frag: string) => res.products.find((p: any) => p.name.includes(frag));

describe('IKI receipt 268 — "ER/" weight row closes the product (no double-capture)', () => {
    test('agurkai is a clean weighed product; the oil is separate', () => {
        const agurkai = byName('AGURKAI');
        expect(agurkai).toBeTruthy();
        expect(agurkai.name).not.toMatch(/BILLA|LINŲ/);
        expect(agurkai.price).toBeCloseTo(2.99, 2);
        expect(agurkai.quantity).toBeCloseTo(0.245, 3);
        const oil = byName('LINŲ SEMENŲ');
        expect(oil).toBeTruthy();
        expect(oil.promoPrice).not.toBeNull(); // its -0,70 discount stays its own
    });

    test('exactly 7 products — no merge, no phantom', () => {
        expect(res.products).toHaveLength(7);
    });
});

describe('IKI receipt 268 — garbled card-number line ("KOR(ELĖS NR")', () => {
    test('never becomes a product (products-end wall catches the "(" garble)', () => {
        for (const p of res.products) {
            expect(p.name).not.toMatch(/KOR.?EL.S|9440006300214/i);
        }
    });

    test('PII mask detects the garbled label and covers the number END TO END (incl. the ^ junk)', () => {
        const cardLine = lines.find((l) => l.text.includes('9440006300214'));
        expect(cardLine).toBeTruthy();
        const bands = detectCardMaskBands([cardLine as any]);
        expect(bands).toHaveLength(1);
        expect(bands[0].kind).toBe('loyalty');
        expect(redactReceiptText(cardLine!.text)).not.toContain('32954'); // the post-^ tail masks too
    });
});

describe('IKI receipt 268 — bare-digit weighed total ("86 A")', () => {
    test('the paprika keeps its amount and recovers the promo', () => {
        const paprika = byName('PAPKLKOS');
        expect(paprika).toBeTruthy();
        expect(paprika.quantity).toBeCloseTo(0.245, 3);
        expect(paprika.price).toBeCloseTo(3.49, 2);
        // total 0.86 − discount 0.35 = 0.51 paid for 0.245 kg → 2.08 €/kg
        expect(paprika.promoPrice).toBeCloseTo(2.08, 2);
    });

    test('footer total survives', () => {
        expect(res.footer.total).toBeCloseTo(7.10, 2);
    });
});
