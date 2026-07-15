import { findProductBands, cleanProductName, extractPackSize, type MaximaLine } from '../shared/parsers/maximaParser';

// kvitas_2025-11-05 (batch log receipts/_logs/maxima/): MLKit dropped BOTH the
// price row and the "-0,56 A" of the FIRST product, leaving just its name and
// its "Sutaupėte:<name>" label before the next product's lines. The paired
// orphan rule couldn't fire (no neg-amount sibling), so the lost product's
// name fused into band 1 ("...kraby skonio, 70 g Sutaupėte:...alyvuogiy ir
// pomidory skonio") and poisoned the match. The LONE-LABEL rule carves the
// [name, matching label] group off as a phantom instead.
// Lines reconstructed from the batch log's raw.txt (y + text; x synthesized —
// names left column, prices right column, matching Maxima's PDF layout).
const L = (text: string, yTop: number, right = false): MaximaLine => ({
    text, yTop, yBottom: yTop + 22,
    xLeft: right ? 530 : 55, xRight: right ? 600 : 500,
} as MaximaLine);

const lines: MaximaLine[] = [
    L('MAXIMA', 178),
    L('MAXIMA LT, UAB', 322),
    L('Aido g. 8-1, Šiauliai, Kasa Nr. 11', 348),
    L('PVM mokėtojo kodas LT230335113', 382),
    L('#00008107', 464),
    L('Kasininkas (-ė): 00001bc876f9', 495),
    L('Kvitas bazėje: 235/32', 524),
    // product 1 — price row + "-0,56 A" MISSING from OCR:
    L('Duonos traškučiai MARETTI, kraby skonio, 70 g', 555),
    L('Sutaupėte:Duonos traškučiai MARETTI, kraby skonio,', 584),
    // product 2 (complete):
    L('Duonos traškučiai MARRETI, alyvuogiy ir pomidory', 646),
    L('skonio', 678),
    L('1,15 A', 678, true),
    L('Sutaupėte:Duonos traškučiai MARRETI, alyvuogiy ir', 707),
    L('-0,56 A', 738, true),
    // product 3 (complete):
    L('Duonos traškučiai MARETTI, gryby ir grietinėlės', 769),
    L('1,15 A', 801, true),
    L('Sutaupėte:Duonos traškučiai MARETTI, gryby ir grie', 829),
    L('-0,56 A', 863, true),
    L('==== #', 1014),
    L('Suteiktos naudos', 1045),
];

describe('Maxima V2 — lone Sutaupėte label carves off the price-dropped product', () => {
    test('the lost product becomes a phantom; the next product keeps a clean band', () => {
        const { internals } = findProductBands(lines, { iosOcr: true });
        const phantoms = internals.filter(b => b.phantom);
        const real = internals.filter(b => !b.phantom);
        expect(phantoms).toHaveLength(1);
        expect(real).toHaveLength(2);
        // The phantom covers exactly [name, matching label] of the lost product.
        const phantomEnd = phantoms[0].stop.sliceIdx;
        expect(phantomEnd).toBe(2);
        // Band for product 2 starts at ITS OWN name — no kraby fusion.
        const band2 = real[0];
        const band2Names = band2.preName.map(e => e.line.text).join(' ');
        expect(band2Names).toContain('alyvuogiy');
        expect(band2Names).not.toContain('kraby');
    });

    test('a leaked label from the PREVIOUS product never steals the next name (brand-prefix guard)', () => {
        // Gap shape: [next product's name, previous product's leaked label] with
        // no further name before the anchor — a sibling flavour shares the long
        // "Duonos traškučiai MARETTI" prefix, but the 70%-coverage rule + the
        // followed-by-name requirement both reject the phantom.
        const leak: MaximaLine[] = [
            L('Kvitas bazėje: 235/32', 524),
            L('Duonos traškučiai MARETTI, gryby ir grietinėlės', 555),
            L('Sutaupėte:Duonos traškučiai MARETTI, kraby skonio,', 584),
            L('1,15 A', 616, true),
            L('==== #', 1014),
            L('Suteiktos naudos', 1045),
        ];
        const { internals } = findProductBands(leak, { iosOcr: true });
        // The decisive assertion: the leaked label must NOT mint a phantom that
        // would swallow the next product's name. (This minimal fixture is too
        // sparse for anchor detection to band the product itself — fine; the
        // guard under test is the phantom refusal.)
        expect(internals.filter(b => b.phantom)).toHaveLength(0);
    });
});

describe('Maxima name cleanup + pack size (300-dpi PDF artifacts)', () => {
    test('trailing column-separator junk no longer defeats the size strip', () => {
        expect(cleanProductName('Duonos traškučiai MARETTI, kraby skonio, 70 g |'))
            .toBe('Duonos traškučiai MARETTI, kraby skonio');
        expect(cleanProductName('Pienas DVARO, 2,5% rieb., 1 l')).toBe('Pienas DVARO, 2,5% rieb.');
    });

    test('the stripped size is CAPTURED for matching/display, not discarded', () => {
        expect(extractPackSize('Duonos traškučiai MARETTI, kraby skonio, 70 g |')).toEqual({ amount: 70, unit: 'g' });
        expect(extractPackSize('Gira RUGILĖ')).toBeNull();
        expect(extractPackSize('Sultys 0,3 l')).toEqual({ amount: 0.3, unit: 'l' });
    });
});
