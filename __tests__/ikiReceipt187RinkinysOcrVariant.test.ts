import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 187 — the bare combo-discount word was OCR'd "RINKTNYS" (I→T), so the EXACT-match
// RINKINYS skip ("!== 'RINKINYS'") let it through as a phantom product (stealing a 1,69 price),
// and being a product, its "-1,90 A DEPOZITAS" engaged the fused-deposit path which folded the
// trailing 0,10 into a second "?" phantom. The OCR-tolerant skeleton matcher (/^R[IT1L]NK[IT1L]NYS$/)
// drops the bare RINKINYS variant — which removes BOTH phantoms at once.
//
// NOTE: this stored wordsDump has FLAT corner points (slope 0 offline), so the heavy column-drift
// on the real receipt mis-clusters the PRODUCT NAMES off-device (the documented IKI band ceiling) —
// so we assert ONLY the slope-INDEPENDENT wins: the RINKINYS-variant is skipped and no nameless
// "?" phantom survives. The name-merge + tilt are the geometry ceiling, not asserted here.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt187.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 187 — OCR-tolerant RINKINYS skip', () => {
    test('the bare combo word (OCR "RINKTNYS") is dropped — no RINKINYS-variant product', () => {
        const rink = res.products.find((p: any) => /^R[IT1L]NK[IT1L]NYS$/.test((p.name ?? '').replace(/[^A-Za-z]/g, '').toUpperCase()));
        expect(rink).toBeUndefined();
    });

    test('no nameless "?" phantom deposit survives', () => {
        const phantom = res.products.find((p: any) => p.name === '?' || !/[a-ząčęėįšųūž]/i.test(p.name ?? ''));
        expect(phantom).toBeUndefined();
    });
});
