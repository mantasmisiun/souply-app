import { countFusedRows, type EnsembleGeomLine } from '../utils/parseEnsemble';

// 0AE04F24 (Rimi app-share wrapper PDF, 346px embedded JPEG): Vision fused
// "RIMI SMART, 1 l" + "be glitimo BARILLA" into ONE double-height garbled
// line. The parse still reconciled, so only this geometric signal can force
// the ML Kit second opinion.
const L = (text: string, yTop: number, h = 50): EnsembleGeomLine => ({ text, yTop, yBottom: yTop + h });

describe('countFusedRows', () => {
    const healthyBody = [
        L('UAB RIMI LIETUVA, T709', 342),
        L('Tilžės g. 109, Siauliai', 383),
        L('PVM mokėtojo kodas LT237153113', 434),
        L('-- Elektroninis kvitas', 490),
        L('Rafinuotas kukuruzy aliejus', 638, 57),
        L('FUSILLI, 400 g', 795, 54),
        L('2 vnt. X 4,99 EUR', 843, 50),
        L('SUTEIKTOS NUOLAIDOS:', 943, 44),
        L('Panaudoti MANO RIMI pinigai', 987, 57),
        L('Mokėti po nuolaidos', 1100, 48),
    ];

    test('a double-height body line counts as fused (0AE04F24)', () => {
        expect(countFusedRows([...healthyBody, L('Raaronal be glitimo BARILIA', 691, 104)])).toBe(1);
    });

    test('a healthy receipt counts zero', () => {
        expect(countFusedRows(healthyBody)).toBe(0);
    });

    test('logo art and short fragments never count (filtered before the median too)', () => {
        // "Rimi)" logo box is 168px tall but <8 chars / no space; a bare price
        // fragment is short too. Neither counts nor skews the median.
        expect(countFusedRows([...healthyBody, L('Rimi)', 21, 168), L('2,99 A', 691, 104)])).toBe(0);
    });

    test('decorative blocks past 3.5× median are not row fusions', () => {
        expect(countFusedRows([...healthyBody, L('Verta rinktis kasdien banner', 100, 300)])).toBe(0);
    });

    test('too little geometry → 0 (never forces the second opinion)', () => {
        expect(countFusedRows(healthyBody.slice(0, 4))).toBe(0);
    });
});
