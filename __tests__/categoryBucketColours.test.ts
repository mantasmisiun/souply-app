import { assignBucketColours, bucketHash } from '../components/receipt/ReceiptCategoryBreakdown';

// Two categories can hash to the same palette slot ("Daržovės ir grybai" and
// "Grietinė, grietinėlė" both rendered lilac on receipt-230's summary). The assigner
// must keep the hash slot as a cross-receipt-stable PREFERENCE but guarantee
// DISTINCT colours within one receipt by probing to the next free slot.
const theme: any = { warning: '#WARN', textMuted: '#MUTED' };
const B = (key: string, extra: object = {}) => ({ key, label: key, total: 1, ...extra });

describe('assignBucketColours', () => {
    test('every bucket gets a distinct colour even when hashes collide', () => {
        // Construct four keys, two of which genuinely collide.
        const base = ['Daržovės ir grybai', 'Grietinė, grietinėlė', 'Pieno produktai', 'Duona'];
        const map = assignBucketColours(base.map((k) => B(k)) as any, theme);
        const values = base.map((k) => map.get(k));
        expect(new Set(values).size).toBe(values.length);
    });

    test('a non-colliding bucket keeps its preferred hash slot (cross-receipt stability)', () => {
        const solo = assignBucketColours([B('Pieno produktai')] as any, theme).get('Pieno produktai');
        const inGroup = assignBucketColours(
            [B('Pieno produktai'), B('Duona')] as any, theme,
        ).get('Pieno produktai');
        expect(inGroup).toBe(solo);
    });

    test('sentinel buckets keep semantic colours and never consume palette slots', () => {
        const map = assignBucketColours(
            [B('__UNRECOGNISED__', { isUnrecognised: true }), B('__OTHER__', { isOther: true }), B('Duona')] as any,
            theme,
        );
        expect(map.get('__UNRECOGNISED__')).toBe('#WARN');
        expect(map.get('__OTHER__')).toBe('#MUTED');
        expect(map.get('Duona')).not.toBe('#WARN');
    });

    test('collision resolution is deterministic in bucket order', () => {
        const a = ['Daržovės ir grybai', 'Grietinė, grietinėlė'].map((k) => B(k));
        const m1 = assignBucketColours(a as any, theme);
        const m2 = assignBucketColours(a as any, theme);
        expect([...m1.entries()]).toEqual([...m2.entries()]);
    });
});

describe('bucketHash', () => {
    test('stays within palette bounds', () => {
        for (const k of ['a', 'Žalumynai', 'Grietinė, grietinėlė', '']) {
            const h = bucketHash(k);
            expect(h).toBeGreaterThanOrEqual(0);
            expect(h).toBeLessThan(8);
        }
    });
});
