import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 236 — MLKit emitted a GHOST line: besides the true per-row reads of the salmon
// name row ("ATLAT INĖS LAŠISOS BE GAL") and its weighed-calc row ("1,068 kg Y 16 99 EUR/ kg"),
// it produced an extra DIAGONAL line ("ATLAITINES LAan EUR/ k9") re-reading the same glyphs —
// its four words step a full row height (y-centres 478→502→518→526) while its corners are flat,
// and every word's box overlaps a word of the two real rows. The clusterer merged the ghost
// into the real rows and the product name interleaved BOTH reads:
//   "ATLAITINES ATLAT INES LAŠISOS LAan 99 BE EUR/ EUR/ GAL k9 kg"
// dropGhostLines now removes such lines pre-parse: baseline-incoherent (word-centre residual
// spread > 0.55×word height against the line's own corner baseline) AND glyph-redundant
// (every word ≥35% / mean ≥50% re-covered by baseline-coherent lines' words).
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt236.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 236 — diagonal MLKit ghost line must not interleave into a product name', () => {
    test('the salmon name is the single clean row read — no doubled words from the ghost', () => {
        const salmon = res.products[1];
        expect(salmon.name).toBe('ATLAT INES LAŠISOS BE GAL');
        // The interleave symptoms: the ghost's re-reads never appear in any product name.
        for (const p of res.products) {
            expect(p.name).not.toMatch(/ATLAITINES|LAan|EUR\/ EUR\/|k9 kg/);
        }
    });

    test('the salmon keeps its weighed pricing + card discount (ghost removal loses no data)', () => {
        const salmon = res.products[1];
        expect(salmon.price).toBeCloseTo(16.99, 2);
        expect(salmon.promoPrice).toBeCloseTo(9.99, 2);
        expect(salmon.rawLines.join(' ')).toMatch(/1,068 kg/);
        expect(salmon.rawLines.join(' ')).toMatch(/-7,48/);
    });

    test('all 8 products parse with their printed prices', () => {
        expect(res.products).toHaveLength(8);
        expect(res.products.map((p: any) => p.price)).toEqual([3.29, 16.99, 1.49, 1.99, 1.99, 3.99, 3.49, 1.85]);
    });

    test('footer total survives', () => {
        expect(res.footer.total).toBeCloseTo(26.52, 2);
    });
});
