import { planFusedStrips, planDroppedRowStrips, planMissingFirstLineStrips, stripReadAcceptable, filterStripEdgeSlivers } from '../utils/receiptOcrPipeline';

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

    test('a two-full-rows fusion with NOTHING else inside still plans (rimi-30-04-2026-2 Cukrus discount)', () => {
        // "Lazdyny riesutu aetas RiMI 0,65" h=166 (2.12× median 78) — the
        // Cukrus Nuol row and the Lazdynų name row fused with no surviving
        // contained line; only sheer height can qualify it.
        const filler2 = Array.from({ length: 10 }, (_, i) => ({
            text: `Filler body line nr ${i}`, yTop: 3000 + i * 110, yBottom: 3000 + i * 110 + 78,
        }));
        const plans = planFusedStrips([
            L('Cukrus PANEVEZIO PLIUS, 1 kg', 1843, 1946),
            L('1,19 A', 1859, 1946),
            L('Lazdyny riesutu aetas RiMI 0,65', 1909, 2075),
            L('BASIC, 400 g', 2071, 2145),
            L('1,54 A', 2070, 2150),
            ...filler2,
        ], 6728);
        expect(plans.some((p) => p.fusedText === 'Lazdyny riesutu aetas RiMI 0,65')).toBe(true);
    });

    test('the strip crop covers the fusion FIRST row fully (rimi-30-04-2026-23 ALPRO)', () => {
        // Real geometry: Vision fused "ALPRO, 1 l" + "Šok. sk. sojos gėr.
        // ALPRO" into "I'T ALPRO" whose bbox STARTS mid-glyph inside the
        // ALPRO row. A crop at the bbox top beheaded that row — every
        // engine either refused it or re-glued the zone. The crop must
        // extend up past the previous LEFT-COLUMN line's bottom: the
        // right-column price "3,29 А" legitimately sits ON the fusion's
        // first row (bottom y1042, inside it), and anchoring the extension
        // to it re-beheaded the row on the second -23 run.
        const XL = (text: string, yTop: number, yBottom: number, xLeft: number, xRight: number) =>
            ({ text, yTop, yBottom, xLeft, xRight });
        const filler23 = Array.from({ length: 10 }, (_, i) => XL(`Filler body line nr ${i}`, 2000 + i * 100, 2000 + i * 100 + 83, 30, 700));
        const plans = planFusedStrips([
            XL('Nesald. avižu skonio gėrimas', 885, 968, 26, 1325),
            XL('3,29 А', 962, 1042, 1695, 1979),   // price ON the fusion's first row
            XL("I'T ALPRO", 1021, 1178, 699, 1188), // the fused box (2 rows tall)
            XL('PLANT PROTEIN,', 1097, 1167, 32, 851),
            XL('3,79 A', 1100, 1164, 1698, 1970),
            ...filler23,
        ], 6000);
        expect(plans).toHaveLength(1);
        // Extends above the fused bbox top (1021) to just past the previous
        // left-column row's bottom (968), so the ALPRO row keeps its
        // ascenders — NOT clamped at the price box's bottom (1042)…
        expect(plans[0].top).toBeLessThanOrEqual(968 - 8);
        // …but never swallows the previous row itself.
        expect(plans[0].top).toBeGreaterThan(895);
        expect(plans[0].replacedIdx.map((i) => i)).not.toContain(0);
    });

    test('a fusion that CONSUMED its second row still plans (78B94F81: one contained line)', () => {
        // 'LinG Beng yS 1R10 R00g' h157 = weighed line + Linu row fused; the
        // only surviving line inside is the price anchor, so the two-disjoint-
        // rows test alone missed it. One contained line + double height plans.
        const filler78 = Array.from({ length: 10 }, (_, i) => L(`Filler body line nr ${i}`, 2000 + i * 90, 2000 + i * 90 + 80));
        const plans = planFusedStrips([
            L('Bananai Cavendish, 20+cm , 1kg', 890, 968),
            L('LinG Beng yS 1R10 R00g', 951, 1108),
            L('0,89 A', 964, 1047),
            L('2 vnt. X 1,75 EUR', 1099, 1177),
            ...filler78,
        ], 4994);
        expect(plans).toHaveLength(1);
        expect(plans[0].fusedText).toBe('LinG Beng yS 1R10 R00g');
    });
});

describe('planMissingFirstLineStrips (rimi-30-04-2026-8: squeezed dropped first name line)', () => {
    const X = (text: string, yTop: number, yBottom: number, xLeft: number) =>
        ({ text, yTop, yBottom, xLeft, xRight: xLeft + 500 });
    const fill = Array.from({ length: 10 }, (_, i) => X(`Filler body line nr ${i}`, 2000 + i * 110, 2000 + i * 110 + 74, 30));
    // Real geometry: "Varškės sūrelis…" vanished between the previous
    // product's Nuol row (…-1117) and its own continuation "MAGIJA, 20,7 %"
    // (1164-…) — a 47px gap that can't fit a visible hole.
    const page8 = [
        X('Greitai užšaldytos šilauogės', 890, 964, 31),
        X('Galut. kaina 2,79', 1020, 1117, 723),
        X('Nuo1. -1,20', 1031, 1106, 70),
        X('MAGIJA, 20,7 %, 40 g', 1164, 1247, 26),
        X('2 vnt. X 0,65 EUR', 1234, 1312, 74),
        ...fill,
    ];

    test('plans one INSERTION strip spanning full context rows (prev row through continuation)', () => {
        const plans = planMissingFirstLineStrips(page8, 2000, 6000);
        expect(plans).toHaveLength(1);
        expect(plans[0].insertion).toBe(true);
        // The strip INCLUDES the whole structural row above — a squeezed
        // dropped row overlaps prev's bbox, and cropping below prev's bottom
        // sliced the target row's caps/diacritics off (both engines refused
        // the legless text).
        expect(plans[0].top).toBeLessThanOrEqual(1020);
        expect(plans[0].top).toBeGreaterThanOrEqual(1000);
        expect(plans[0].bottom).toBeGreaterThan(1247);
        expect(plans[0].bottom).toBeLessThanOrEqual(1262);
        expect(plans[0].replacedIdx).toEqual([]);
    });

    test('a continuation under NAME text plans nothing (first line present — 5EEA GREATLIFE)', () => {
        const plans = planMissingFirstLineStrips([
            X('Bolivinių balandų miš. RIMI', 1030, 1105, 19),
            X('GREATLIFE, 400 g', 1103, 1177, 39),
            X('3,19 A', 1096, 1188, 1695),
            ...fill,
        ], 2000, 6000);
        expect(plans).toHaveLength(0);
    });

    test('an occupied zone plans nothing', () => {
        const occupied = [...page8, X('Varškės sūrelis su šokoladu', 1108, 1180, 26)];
        expect(planMissingFirstLineStrips(occupied, 2000, 6000)).toHaveLength(0);
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

    test('FEWER lines than replaced is accepted when the rows merged cleanly (-23 mlkit@1x)', () => {
        // A heal that joins partial-read fragments into whole rows returns
        // fewer lines than it replaces — the old count gate rejected exactly
        // the clean read and let a worse one through.
        const fragments = [
            L("I'T ALPRO", 1010, 1170),
            L('PLANT PROTEIN,', 1097, 1167),
            L('1 l', 1098, 1151),
            L('3,79 A', 1100, 1164),
            L('PLANT', 1104, 1156),
        ];
        expect(stripReadAcceptable([
            L('Šok. k. sojos gėr. ALPRO', 1010, 1090),
            L('PLANT PROTEIN, 1 1', 1097, 1167),
            L('3,79 A', 1100, 1164),
        ], fragments, 83)).toBe(true);
    });

    test('a re-glued read is rejected: word double-emitted at the SAME x from another row (-23 mlkit@1.5)', () => {
        // Real read: "PLANT" was glued into the row ABOVE's line AND emitted
        // standalone at its true row — normal line heights, so only the
        // same-x duplication betrays it.
        const XL = (text: string, yTop: number, yBottom: number, xLeft: number, xRight: number) =>
            ({ text, yTop, yBottom, xLeft, xRight });
        const fragments = [
            L("I'T ALPRO", 1010, 1170),
            L('PLANT PROTEIN,', 1097, 1167),
            L('3,79 A', 1100, 1164),
        ];
        expect(stripReadAcceptable([
            XL('PLANT Šok. sk. sojos gėr. ALPRO', 1002, 1085, 1, 1000),
            XL('PROTEIN,', 1097, 1167, 308, 640),
            XL('1 l', 1098, 1151, 732, 800),
            XL('3,79 A', 1100, 1164, 1697, 1900),
            XL('PLANT', 1104, 1156, 31, 306),
        ], fragments, 83)).toBe(false);
    });

    test('a legit cross-row brand repeat at a DIFFERENT x does NOT trip the glue guard', () => {
        // Receipts genuinely repeat tokens across adjacent rows (brand at
        // the END of a name row, continuation fragment at the LEFT margin).
        // Different x-positions = different physical words = legit.
        const XL = (text: string, yTop: number, yBottom: number, xLeft: number, xRight: number) =>
            ({ text, yTop, yBottom, xLeft, xRight });
        const fragments = [
            L('Sokoladas RIMI kazkoks ilgas', 950, 1108),
            L('1,99 A', 960, 1040),
        ];
        expect(stripReadAcceptable([
            XL('Šokoladas RIMI', 965, 1040, 30, 560),
            XL('1,99 A', 960, 1040, 1690, 1900),
            XL('RIMI,', 1045, 1110, 31, 200),
            XL('400 g', 1046, 1108, 240, 420),
        ], fragments, 75)).toBe(true);
    });
});

describe('filterStripEdgeSlivers', () => {
    // Real case: strip y941-1126; padding caught the FUSILLI row's top 20px
    // and Vision hallucinated "пTTaтттт" from the partial ascenders.
    const replaced = [page[1], page[2], page[3]]; // fused box + price + Makaronai
    const medianH = 64;

    test('a boundary-touching hallucination is dropped; interior lines survive', () => {
        const out = filterStripEdgeSlivers([
            L('RIMI SMART, 1 1', 961, 1039),
            L('2,99 A', 963, 1039),
            L('Makaronai be glitimo BARILLA', 1021, 1102),
            L('пTTaтттт', 1100, 1126),                    // touches bottom edge, sliver-short
        ], 941, 1126, replaced, medianH);
        expect(out.map((l) => l.text)).toEqual([
            'RIMI SMART, 1 1', '2,99 A', 'Makaronai be glitimo BARILLA',
        ]);
    });

    test('a full-height REAL row touching the edge is kept (dropped-row strips)', () => {
        // In a lonely-anchor strip the healed rows do NOT overlap the removed
        // anchor — height is what marks them as real content.
        const out = filterStripEdgeSlivers([
            L('bulguras RIMI, 400 g', 970, 1048),
            L('Bolivinių balandų miš. RIMI', 1030, 1106), // touches bottom, full height
        ], 958, 1109, [L('1,35 A', 961, 1044)], 75);
        expect(out).toHaveLength(2);
    });
});

describe('planDroppedRowStrips (5EEA946F: two rows deleted by the engine)', () => {
    // Real geometry: "bulguras RIMI, 400 g" (the 1,35 A row) and "Bolivinių
    // balandų miš. RIMI" are ABSENT from the OCR output — the 1,35 A anchor
    // has no left-column companion, which is physically impossible.
    const X = (text: string, yTop: number, yBottom: number, xLeft: number) =>
        ({ text, yTop, yBottom, xLeft, xRight: xLeft + 400 });
    const fill = Array.from({ length: 10 }, (_, i) => X(`Filler body line nr ${i}`, 2600 + i * 90, 2600 + i * 90 + 75, 30));
    const pageLines = [
        X('Rudasis visu grudo daliq', 890, 964, 31),
        X('1,35 A', 961, 1044, 1694),                 // LONELY anchor
        X('GREATLIFE, 400 g', 1103, 1177, 39),
        X('3,19 А', 1096, 1188, 1694),                // Cyrillic А — has companion
        X('Burnočio sėklos RIMI', 1160, 1225, 39),
        X('GREATLIFE, 400 g', 1238, 1317, 31),
        X('2,69 A', 1238, 1321, 1691),
        ...fill,
    ];

    test('plans one wide strip over the whole uncovered gap', () => {
        const plans = planDroppedRowStrips(pageLines, 2000, 4925);
        expect(plans).toHaveLength(1);
        const p = plans[0];
        // From Rudasis' bottom to GREATLIFE's top — covers BOTH missing rows.
        expect(p.top).toBe(958);
        expect(p.bottom).toBe(1109);
        expect(p.replacedIdx.map((i) => pageLines[i].text)).toEqual(['1,35 A']);
    });

    test('anchors with companions (incl. Cyrillic VAT letter) plan nothing', () => {
        const healthy = pageLines.filter((l) => l.text !== '1,35 A');
        expect(planDroppedRowStrips(healthy, 2000, 4925)).toHaveLength(0);
    });

    test('the healed strip read passes acceptance (anchor preserved)', () => {
        const strip = [
            L('bulguras RIMI, 400 g', 970, 1048),
            L('1,35 A', 961, 1044),
            L('Bolivinių balandų miš. RIMI', 1030, 1105),
        ];
        expect(stripReadAcceptable(strip, [pageLines[1]], 75)).toBe(true);
    });

    test('a strip read that LOST the price is rejected (anchor must survive)', () => {
        const strip = [
            L('bulguras RIMI, 400 g', 970, 1048),
            L('Bolivinių balandų miš. RIMI', 1030, 1105),
        ];
        expect(stripReadAcceptable(strip, [pageLines[1]], 75)).toBe(false);
    });
});
