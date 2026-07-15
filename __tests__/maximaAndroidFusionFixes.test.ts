import {
    parseMaximaReceipt,
    mergeRowFragmentsMaxima,
    type MaximaLine,
} from '../shared/parsers/maximaParser';

/**
 * Fixes from the 2026-07-11 Android truth review (Android's document-mode
 * tiled+fused OCR fragments and double-reads rows just like iOS MLKit):
 *   1. Double-read DEDUP in the row merger: two x-OVERLAPPING reads of the
 *      same physical row keep only the cleaner one — but ONLY when the two
 *      spans have comparable coverage. A tiny stray tail re-read x-contained
 *      inside a full row is NOT a duplicate of it (dropping the full row
 *      deleted a Sutaupėte savings line: promo lost + the orphaned "-0,30 A"
 *      polluted the next band's name).
 *   2. Deposit-block absorption accepts the deposit's qty row and bare total
 *      in EITHER order ("PET (depozitinis) 0,10 EUR" | "0,60" | "0,10 X 6
 *      vnt.") so the deposit's unit-qty can never leak out as the PRODUCT's
 *      price line (AKVILĖ water shipped at €0.10/vnt). With the product's own
 *      qty row lost, the deposit count recovers qty + €/unit = total ÷ count.
 *   3. ">X" separator tolerance in unit-qty rows ("12,94 >X 0,236 kg") — the
 *      garbled weighed row used to leak into the NEXT product's name.
 *   4. Amount/unit display rules: weighed rows carry parsedAmount 1 kg; a
 *      ", vnt"/", N vnt" name suffix strips into parsedAmount N × vnt.
 */

const row = (text: string, y: number, xLeft = 40, xRight = 620): MaximaLine => ({
    text,
    yTop: y,
    yBottom: y + 24,
    xLeft,
    xRight,
});

const seq = (texts: string[]): MaximaLine[] => texts.map((t, i) => row(t, i * 40));

const HEADER = [
    'MAXIMA LT, UAB',
    'PVM mokėtojo kodas LT230335113',
    'Savanorių pr. 16, Vilnius, Kasa Nr. 5',
];
const FOOTER = [
    'Mokėtina suma 9,99',
    'Kvito Nr. 123456',
    '2026-07-11 12:00:00',
];

describe('double-read dedup in mergeRowFragmentsMaxima', () => {
    it('keeps ONE copy when the same row is read twice at near-equal spans', () => {
        const merged = mergeRowFragmentsMaxima([
            row('Švieži broilerių, užaugintų be ant ibiot ikų, filė', 100, 40, 600),
            row('Švieži broilerių, užaugintų be antibiotikų, filė', 102, 45, 598),
        ]);
        expect(merged).toHaveLength(1);
        // The cleaner read (fewer word breaks) wins.
        expect(merged[0].text).toBe('Švieži broilerių, užaugintų be antibiotikų, filė');
    });

    it('does NOT treat a tiny contained tail re-read as a duplicate of the full row', () => {
        const merged = mergeRowFragmentsMaxima([
            row('22,', 100, 300, 336), // stray re-read of the row's tail
            row('Sutaupėte: Majonezo padažas VILNIUS mesainiams, 22,', 101, 40, 340),
        ]);
        expect(merged).toHaveLength(1); // same-row cluster still merges by x-order…
        // …but the FULL row's text must survive (containment ≠ duplicate).
        expect(merged[0].text).toContain('Sutaupėte: Majonezo padažas');
    });

    it('keeps x-disjoint same-row fragments (name left, price right) untouched', () => {
        const merged = mergeRowFragmentsMaxima([
            row('Pienas DVARO', 100, 40, 300),
            row('1,49 A', 101, 520, 620),
        ]);
        expect(merged).toHaveLength(1);
        expect(merged[0].text).toBe('Pienas DVARO 1,49 A');
    });
});

describe('deposit block: either-order absorption + count fallback', () => {
    it('recovers qty and €/unit from the deposit row when the product has no own qty row', () => {
        const parsed = parseMaximaReceipt(
            seq([
                ...HEADER,
                'Negazuotas vanduo AKVILĖ, 2 l 5,70 A',
                'PET (depozitinis) 0,10 EUR',
                '0,60',
                '0, 10 X 6 vnt.',
                ...FOOTER,
            ]),
            { iosOcr: true },
        );
        expect(parsed.products).toHaveLength(1);
        const p = parsed.products[0];
        expect(p.quantity).toBe(6);
        expect(p.price).toBeCloseTo(0.95, 2); // 5.70 ÷ 6 — never the deposit's 0.10
    });

    it('skips a garble-padded standalone deposit row ("(depozitinis )")', () => {
        const parsed = parseMaximaReceipt(
            seq([
                ...HEADER,
                'Sultys TYMBARK 1,99 A',
                'PET (depozitinis ) 0,10 EUR 0,10 A',
                ...FOOTER,
            ]),
            { iosOcr: true },
        );
        expect(parsed.products.map((p) => p.name)).toEqual(['Sultys TYMBARK']);
    });
});

describe('">X" unit-qty separator tolerance', () => {
    it('parses "12,94 >X 0,236 kg" as the weighed row it is', () => {
        const parsed = parseMaximaReceipt(
            seq([
                ...HEADER,
                'Marinuotos alyvuogės su medumi 3,05 A',
                '12,94 >X 0,236 kg',
                'Tarkuotas sūris DŽIUGAS 3,09 A',
                ...FOOTER,
            ]),
            { iosOcr: true },
        );
        const [olives, cheese] = parsed.products;
        expect(olives.price).toBeCloseTo(12.94, 2);
        expect(olives.quantity).toBeCloseTo(0.236, 3);
        expect(olives.unit).toBe('kg');
        // The garbled qty row must NOT leak into the next product's name.
        expect(cheese.name).toBe('Tarkuotas sūris DŽIUGAS');
    });
});

describe('amount/unit display rules', () => {
    it('weighed rows carry parsedAmount 1 kg', () => {
        const parsed = parseMaximaReceipt(
            seq([...HEADER, 'Citrinos, 3-4 d. 1,25 A', '2,49 X 0,504 kg', ...FOOTER]),
            { iosOcr: true },
        );
        const p = parsed.products[0];
        expect(p.unit).toBe('kg');
        expect(p.parsedAmount).toBe(1);
        expect(p.parsedUnit).toBe('kg');
    });

    it('strips a ", N vnt." name suffix into parsedAmount N × vnt', () => {
        const parsed = parseMaximaReceipt(
            seq([...HEADER, 'Avokadai READY TO EAT WELL DONE, 2 vnt. 2,49 A', ...FOOTER]),
            { iosOcr: true },
        );
        const p = parsed.products[0];
        expect(p.name).toBe('Avokadai READY TO EAT WELL DONE');
        expect(p.parsedAmount).toBe(2);
        expect(p.parsedUnit).toBe('vnt');
    });

    it('strips a bare ", vnt" suffix into parsedAmount 1 vnt', () => {
        const parsed = parseMaximaReceipt(
            seq([...HEADER, 'NAUJA! Žiedinis kopūstas ROMANESCO, vnt 2,59 A', ...FOOTER]),
            { iosOcr: true },
        );
        const p = parsed.products[0];
        expect(p.name).toBe('NAUJA! Žiedinis kopūstas ROMANESCO');
        expect(p.parsedAmount).toBe(1);
        expect(p.parsedUnit).toBe('vnt');
    });
});
