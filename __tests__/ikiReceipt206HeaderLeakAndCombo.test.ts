import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 206 — a low-quality thermal IKI scan (2× "VIRTA PANERIO DEŠRA" @2,49 with a combo
// "-2,70 RINKINYS" discount). The device's live OCR read the VAT line's "kodas" as "kolas"
// (d→l), so the header/product boundary detection missed it (pStart stayed 0) and the store
// line + address + VAT-code line all folded into PRODUCT 1's name:
//   "IKI L  Vilniaus g. l 2, Siauliai  PVM mokėtojo kolas I[1019%7219  VIRTA PANERIO DEŠRA".
// The combo "RINKINYS" also leaked as a zero-price product ("RINKTN)S" — the Y OCR-dropped, so
// the original skeleton missed it). Two defenses are pinned here:
//   1. a LEADING-header-junk guard strips store/address/VAT lines out of a product name even when
//      pStart fails (belt-and-suspenders on top of the boundary detection);
//   2. an OCR-tolerant combo-set filter drops the bare "RINKINYS" line (dropped/garbled Y).
const fixture = path.join(__dirname, 'fixtures_ikiReceipt206.json');
const baseLines: IkiLine[] = JSON.parse(fs.readFileSync(fixture, 'utf8'));

const clone = (): IkiLine[] => JSON.parse(JSON.stringify(baseLines));

const HEADER_JUNK = /PVM|Vilniaus|kodas|mok[eė]tojo|Lietuva|^IKI\s+L\b/i;

describe('IKI receipt 206 — header does not leak into product 1, combo RINKINYS dropped', () => {
    test('baseline (clean "kodas"): exactly the two real dešra products, no combo, no header leak', () => {
        const res: any = parseIkiReceipt(clone());
        expect(res.products).toHaveLength(2);
        for (const p of res.products) {
            expect(p.name).not.toMatch(HEADER_JUNK);
            expect(p.name.replace(/[^A-Za-z]/g, '').toUpperCase()).not.toMatch(/^R[IT1L]NK[IT1L]N[YT1V]?S$/);
        }
        // Product 1 is the dešra itself, not the header block.
        expect(res.products[0].name).toMatch(/NERIO/i);
        expect(res.products[0].price).toBeCloseTo(2.49, 2);
    });

    test('boundary failure ("kodas"→"kolas"): header STILL stripped, product 1 stays clean', () => {
        // Garble the VAT line TEXT the same way the device OCR did, so none of the pStart
        // fallbacks fire and pStart stays 0. The word BOXES keep their text, so the parser's
        // header-junk guard is the only thing preventing the leak — which is the point.
        const lines = clone();
        for (const l of lines) l.text = l.text.replace(/kodas/gi, 'kolas');
        // also break the "starts with PVM" fallback so the whole header folds in without the guard
        for (const l of lines) l.text = l.text.replace(/^\s*PVM\s+mok/i, 'Pyw mok');

        const res: any = parseIkiReceipt(lines);
        expect(res.products).toHaveLength(2);
        for (const p of res.products) {
            expect(p.name).not.toMatch(HEADER_JUNK);
        }
        expect(res.products[0].name).toMatch(/NERIO/i);
    });
});
