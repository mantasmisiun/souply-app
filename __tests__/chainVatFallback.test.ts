import { detectChainByVatCode } from '../shared/parsers/chainVatFallback';

describe('detectChainByVatCode', () => {
    it('matches each chain by its printed PVM/VAT code', () => {
        expect(detectChainByVatCode(['PVM mokėtojo kodas LT117910113'])).toEqual({ chainId: 5, chainName: 'LIDL' });
        expect(detectChainByVatCode(['LT230335113'])).toEqual({ chainId: 1, chainName: 'MAXIMA' });
        expect(detectChainByVatCode(['kodas: LT237153113'])).toEqual({ chainId: 2, chainName: 'RIMI' });
        expect(detectChainByVatCode(['LT101937219'])).toEqual({ chainId: 3, chainName: 'IKI' });
    });

    it('tolerates OCR spaces inside the code', () => {
        expect(detectChainByVatCode(['PVM kodas LT 117 910 113'])?.chainName).toBe('LIDL');
    });

    it('is case-insensitive', () => {
        expect(detectChainByVatCode(['lt230335113'])?.chainId).toBe(1);
    });

    it('returns null when no VAT code is present (e.g. Norfa)', () => {
        expect(detectChainByVatCode(['NORFA', 'Suma 5,00 EUR', 'Kvito Nr. 123'])).toBeNull();
    });

    it('returns null for empty input', () => {
        expect(detectChainByVatCode([])).toBeNull();
    });
});
