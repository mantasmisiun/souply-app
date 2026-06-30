import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 162 — the same physical receipt as 161, re-scanned with much BETTER MLKit OCR, but three
// values were still lost. The print is crystal-clear in the image; MLKit dropped PART of three
// amounts, and one calc row was defeated by a doubled period:
//   • MAGIJA #2 loyalty discount "-0,26" → OCR "0," (minus + cents dropped) → discount lost.
//   • KETO #1 price "2,59" → OCR "59" (integer + comma dropped) → parsed as 0,59.
//   • Žaliosios cukinijos "2 vnt.. X 1,49 EUR/ Vr" → the OCR-doubled period "vnt.." defeated the
//     unit-calc regex (count + per-unit price lost, qty fell to 1) and its "-1,80" discount band-merged
//     onto the MAIŠELIS bag row.
// Fixes: T_UNIT_CALC_RE tolerates "vnt.."; a standalone NUOLAIDA label (no amount) arms discPending so
// the bag row's mis-clustered -1,80 is recovered; and a TWIN-RECOVERY pass copies the intact value
// from an identical-named twin on the same receipt (same product ⇒ same price + per-unit discount).
// Driven by the real MLKit wordsDump fixture so the band clustering is faithful.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt162.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);
const byName = (re: RegExp) => res.products.filter((p: any) => re.test(p.name));

describe('IKI receipt 162 — twin recovery + vnt.. calc + band-merged discount', () => {
    test('both MAGIJA units get the -0,26 discount (promo 0,39) — #2 recovered from its twin', () => {
        const m = byName(/MAGI ?JA/);
        expect(m).toHaveLength(2);
        m.forEach((p: any) => {
            expect(p.price).toBeCloseTo(0.65, 2);
            expect(p.promoPrice).toBeCloseTo(0.39, 2);
        });
    });

    test('both KETO units price 2,59 — #1 recovered from its twin (OCR had only "59")', () => {
        const k = byName(/KETO/);
        expect(k).toHaveLength(2);
        k.forEach((p: any) => expect(p.price).toBeCloseTo(2.59, 2));
        expect(k.some((p: any) => p.price < 1)).toBe(false);
    });

    test('Žaliosios cukinijos: per-unit 1,49 ×2 with the -1,80 discount (promo 0,59)', () => {
        const z = res.products.find((p: any) => /cukin/i.test(p.name));
        expect(z.quantity).toBe(2);
        expect(z.price).toBeCloseTo(1.49, 2);
        expect(z.promoPrice).toBeCloseTo(0.59, 2);
        expect(z.name).not.toMatch(/vnt|EUR/);   // the calc no longer leaks into the name
    });

    test('the paid item totals reconcile to the €18,47 receipt total', () => {
        const paid = res.products.reduce((s: number, p: any) => {
            const unit = p.promoPrice != null ? p.promoPrice : p.price;
            const q = p.quantity && p.quantity > 0 ? p.quantity : 1;
            return s + (unit ?? 0) * q;
        }, 0);
        // items + the €0,01 plastic bag (a skip, not a product) = 18,47
        expect(paid).toBeCloseTo(18.46, 2);
    });
});

// Safety guard for the twin PRICE recovery: a GENUINE sub-€1 price that OCR captured cleanly
// ("0,59 A") must NOT be lifted to a same-cents neighbour's higher price — only a TRUNCATED bare
// "59" (integer+comma dropped) is recovered. Pins the hasFullSubEuro guard against overwriting a
// real price (the worst outcome: writing a wrong HIGHER reference price).
describe('IKI twin recovery — a well-formed 0,59 price is NOT lifted by a 2,59 neighbour', () => {
    const L = (t: string, x: [number, number], y: [number, number], ws: any[][]): IkiLine => ({
        text: t, xLeft: x[0], xRight: x[1], yTop: y[0], yBottom: y[1],
        words: ws.map(([wt, a, b, c, d]) => ({ text: wt, xLeft: a, xRight: b, yTop: c, yBottom: d })),
    });
    const lines: IkiLine[] = [
        L('GUMA ORBIT MENTOLAS 0,59 A', [40, 866], [360, 402], [
            ['GUMA', 40, 130, 360, 400], ['ORBIT', 145, 270, 360, 400], ['MENTOLAS', 285, 470, 360, 400],
            ['0,59', 750, 825, 360, 400], ['A', 847, 866, 360, 400],
        ]),
        L('GUMA ORBIT MENTOLAS 2,59 A', [40, 866], [410, 452], [
            ['GUMA', 40, 130, 410, 450], ['ORBIT', 145, 270, 410, 450], ['MENTOLAS', 285, 470, 410, 450],
            ['2,59', 750, 825, 410, 450], ['A', 847, 866, 410, 450],
        ]),
        L('IKI KORTELĖS NR. 999000111222', [70, 762], [1248, 1293], [['IKI', 70, 120, 1249, 1289], ['999000111222', 398, 762, 1251, 1295]]),
    ];
    const out: any = parseIkiReceipt(lines);

    test('the cleanly-read 0,59 item keeps 0,59 (its line printed the full "0,59")', () => {
        const cheap = out.products.find((p: any) => Math.abs(p.price - 0.59) < 0.01 || p.rawLines.some((l: string) => /0,59/.test(l)));
        expect(cheap).toBeTruthy();
        expect(cheap.price).toBeCloseTo(0.59, 2);
    });
});
