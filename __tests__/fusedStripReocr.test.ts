import { planFusedStrips, stripReadAcceptable } from '../utils/receiptOcrPipeline';

// Real geometry from 0AE04F24 (device-converted, 2000×4509): Vision fused
// "RIMI SMART, 1 l" + "Makaronai be glitimo BARILLA" into one 149px box even
// though the pixels are pristine — a line-GROUPING failure. The strip re-OCR
// isolates that y-range and replaces everything inside it with the fresh read.
const L = (text: string, yTop: number, yBottom: number) => ({ text, yTop, yBottom });
const filler = Array.from({ length: 10 }, (_, i) => L(`Filler body line nr ${i}`, 2000 + i * 90, 2000 + i * 90 + 64));

const page = [
    L('Rafinuotas kukuruzy aliejus', 890, 964),
    L('Baka SnaR be glitino BARILLA', 959, 1108), // the fused box
    L('2,99 A', 956, 1042),                        // same-row price (partial read)
    L('Makaronai', 1025, 1090),                    // partial read of row 2
    L('FUSILLI, 400 g', 1103, 1177),
    L('2 vnt. X 4,99 EUR', 1169, 1238),
    ...filler,
];

describe('planFusedStrips', () => {
    test('plans one strip over the fused box, claiming its partial-read companions', () => {
        const plans = planFusedStrips(page, 4509);
        expect(plans).toHaveLength(1);
        const p = plans[0];
        expect(p.fusedText).toBe('Baka SnaR be glitino BARILLA');
        // Replaces the fused box + the price + the lone "Makaronai" (their
        // centers fall inside the strip) but NOT the clean neighbours.
        const replacedTexts = p.replacedIdx.map((i) => page[i].text);
        expect(replacedTexts).toContain('Baka SnaR be glitino BARILLA');
        expect(replacedTexts).toContain('2,99 A');
        expect(replacedTexts).toContain('Makaronai');
        expect(replacedTexts).not.toContain('Rafinuotas kukuruzy aliejus');
        expect(replacedTexts).not.toContain('FUSILLI, 400 g');
    });

    test('a healthy page plans nothing', () => {
        const healthy = page.filter((l) => l.text !== 'Baka SnaR be glitino BARILLA');
        expect(planFusedStrips(healthy, 4509)).toHaveLength(0);
    });
});

describe('stripReadAcceptable', () => {
    const replaced = [page[1], page[2], page[3]];
    const medianH = 64;

    test('a clean two-row strip read is accepted', () => {
        expect(stripReadAcceptable([
            L('RIMI SMART, 1 l', 965, 1022),
            L('2,99 A', 960, 1040),
            L('Makaronai be glitimo BARILLA', 1029, 1099),
        ], replaced, medianH)).toBe(true);
    });

    test('a strip that fused AGAIN is rejected (quarantine keeps handling it)', () => {
        expect(stripReadAcceptable([
            L('Baka SnaR be glitino BARILLA', 959, 1108),
            L('2,99 A', 960, 1040),
        ], replaced, medianH)).toBe(false);
    });

    test('a strip that lost text mass is rejected', () => {
        expect(stripReadAcceptable([
            L('RIMI', 965, 1022),
            L('2,99 A', 960, 1040),
            L('Mak', 1029, 1099),
        ], replaced, medianH)).toBe(false);
    });

    test('a single-row read is rejected (nothing was split)', () => {
        expect(stripReadAcceptable([
            L('RIMI SMART, 1 l Makaronai be glitimo BARILLA', 965, 1040),
            L('2,99 A', 960, 1040),
        ], replaced, medianH)).toBe(false);
    });
});
