import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 172 — the user reported product 3 as garbage: ŽEMAITIJOS VARŠKĖ fused with its discount AND
// with CLEVER ŠVIESI RAIKYTA DUO (one band over two products). Root cause: the "50% NUOLAIDA" discount
// (-0,22) printed on ŽEMAITIJOS's NAME line ("ŽEMAITIJOS … -0,22"), so the band engine bound it to
// ŽEMAITIJOS and the rows cascaded into a merge. The lead-discount re-homing (receipt-170 fix) attaches
// the -0,22 to the CLEVER bread ABOVE it and frees ŽEMAITIJOS as its own product — verified here.
//
// NOTE: this stored wordsDump has FLAT line corner points (cornerPoints stored null), so the parser's
// tilt = 0. The real receipt is skewed (~0.05 — prices print ~30px below their names), and ON-DEVICE the
// de-skew realigns each price to its name. Without it, a lower pair (CLEVER duo #2 + cucumbers) mis-binds
// in this OFFLINE fixture only — so we assert the slope-INDEPENDENT wins (the ŽEMAITIJOS separation +
// the 50% discount attachment), not the full product list.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt172.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 172 — lead discount frees ŽEMAITIJOS from the CLEVER merge', () => {
    test('ŽEMAITIJOS VARŠKĖ is its OWN product (€6,49 → promo 3,99), not merged with CLEVER bread', () => {
        const z = res.products.find((p: any) => /ZEMAITIJ|VARSK/i.test(p.name));
        expect(z).toBeTruthy();
        expect(z.price).toBeCloseTo(6.49, 2);
        expect(z.promoPrice).toBeCloseTo(3.99, 2);                 // -2,50 NUOLAIDA SU KORTELE applied
        expect(z.name).not.toMatch(/RAIKYTA|CLEVER/i);             // the bread name is no longer fused in
    });

    test('the "50% NUOLAIDA" (-0,22) attaches to the CLEVER bread above it (promo 0,23), not lost', () => {
        const c = res.products.find((p: any) => /CLEVER/i.test(p.name) && p.promoPrice != null && Math.abs(p.promoPrice - 0.23) < 0.02);
        expect(c).toBeTruthy();
        expect(c.price).toBeCloseTo(0.45, 2);
    });
});
