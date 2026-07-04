import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Segment-corroboration witness: IKI prints the slashed id's last segment separately in
// the VMI block. When the two DISAGREE (one is OCR-garbled) the parser must not guess —
// it adds the VMI-corrected variant to receiptNos[] as an extra dedup witness so the
// overlap duplicate check catches a re-scan through either form.
const L = (text: string, i: number): IkiLine =>
    ({ text, xLeft: 40, xRight: 900, yTop: 200 + i * 50, yBottom: 240 + i * 50 });
const lines = (rows: string[]): IkiLine[] => rows.map(L);

const base = [
    'IKI Lietuva, UAB',
    'Vilniaus 9, Šiauliai',
    'BANANAI BON VIA',
    '1,19 A',
    'SUMA 1,19 EUR',
];

describe('IKI receiptNo segment-corroboration witness', () => {
    test('mismatching VMI segment adds the corrected variant to receiptNos', () => {
        const res: any = parseIkiReceipt(lines([
            ...base,
            'Kvito Nr. 168/645/704148 Kasa 0022',   // garbled: 1→7
            'Kvito numeris 104148',                   // VMI copy clean
            '2026-06-29 10:40:11',
        ]));
        expect(res.footer.receiptNo).toBe('168/645/704148');           // canonical NEVER rewritten
        expect(res.footer.receiptNos).toContain('168/645/104148');     // the witness
        expect(res.footer.receiptNos).toContain('104148');
    });

    test('agreeing segments add no witness (no duplication)', () => {
        const res: any = parseIkiReceipt(lines([
            ...base,
            'Kvito Nr. 168/645/104148 Kasa 0022',
            'Kvito numeris 104148',
            '2026-06-29 10:40:11',
        ]));
        const slashed = res.footer.receiptNos.filter((n: string) => n.includes('/'));
        expect(slashed).toEqual(['168/645/104148']);
    });
});
