import { planGarbledAnchorStrips } from '../utils/receiptOcrPipeline';

// Real Norfa-04-23 geometry: "Žemės riešutai GAR2, 500g  2x1,49 2,98 M1"
// (pristine pixels) came back as two HALF-height garbage boxes while every
// neighbour read fine. The garbled "…M1" box isn't a valid anchor, so the
// dropped-row planner misses it; this planner targets it for re-OCR.
const B = (text: string, yTop: number, yBottom: number, xLeft: number, xRight: number) =>
    ({ text, yTop, yBottom, xLeft, xRight });
// Enough clean body rows to establish the ~50px median height.
const filler = Array.from({ length: 10 }, (_, i) =>
    B(`Prekė numeris ${i} pavadinimas`, 300 + i * 90, 350 + i * 90, 72, 900));

describe('planGarbledAnchorStrips', () => {
    test('targets the garbled riešutai row (half-height garbage + M1 suffix, no clean name)', () => {
        const page = [
            ...filler,
            B('Pienas DVARO 2,5 %, 2l plast.but.', 2128, 2178, 75, 1370), // clean row above
            B('2,89 M1', 2126, 2176, 1662, 1920),
            B('2v1 Aa ae M1', 2191, 2216, 1391, 1910),   // garbled anchor (half height)
            B('CAD', 2200, 2227, 646, 755),               // garbled name fragment (half height)
            B('NORFA PE maišelis su kodu 21/11x45', 2271, 2321, 72, 1378), // clean bag below
            B('0,01 M1', 2274, 2318, 1662, 1916),
        ];
        const plans = planGarbledAnchorStrips(page, 2000, 6350);
        expect(plans).toHaveLength(1);
        expect(plans[0].garbled).toBe(true);
        // The crop must span the real riešutai row (~y2191-2227).
        expect(plans[0].top).toBeLessThanOrEqual(2191);
        expect(plans[0].bottom).toBeGreaterThanOrEqual(2227);
    });

    test('a clean anchor row is NOT targeted (has its name + a clean price)', () => {
        const page = [
            ...filler,
            B('Bananai, 1kg', 2191, 2241, 72, 700),
            B('2,0x1,25 2,50 M1', 2191, 2241, 1354, 1920), // clean weighable anchor
        ];
        expect(planGarbledAnchorStrips(page, 2000, 6350)).toHaveLength(0);
    });

    test('a garbled box WITH a surviving clean name is NOT targeted (name is fine)', () => {
        const page = [
            ...filler,
            B('Žemės riešutai GAR2, 500g', 2191, 2241, 72, 900), // clean full-height name
            B('2v1 Aa ae M1', 2191, 2241, 1391, 1910),            // only the anchor garbled
        ];
        // Name survived → dropped-row/other planners own this; not our class.
        expect(planGarbledAnchorStrips(page, 2000, 6350)).toHaveLength(0);
    });
});
