import { looksUpsideDownRead, countAmountShaped, flipLines180, type OcrLine } from '../utils/mlkitOcr';

// Pramonės-02-15: Vision returned tile 1 as inverted glyphs ("3,87 M1" →
// "IW L8'E") while the page pixels were upright — 36 lines, not one
// amount-shaped token, and the receipt parsed 0 products.
const INVERTED = [
    'VNANZVW SOlON I', 'epesta', '# 6086 ‡', "IW L8'E 60'01X5880",
    'ązıd tıdvd', "IW 09'=", "L9'IXZ", "IW EE'E", "IW IO'O",
].map((text) => ({ text }));

const NORMAL = [
    'D1 UAB NORFOS MAŽMENA', 'Pramonės 6, Šiauliai', '# Kvito numeris 340809 #',
    'Kepta jūros lydeka, 1kg 0,384x10,09 3,87 M1', 'KVITO SUMA 16,04 EUR',
    '2026-02-15 15:15', 'NUOLAIDA KVITUI -6,04 EUR', 'TARPINĖ SUMA 10,00 EUR',
].map((text) => ({ text }));

describe('looksUpsideDownRead', () => {
    test('the real inverted tile trips the detector', () => {
        expect(countAmountShaped(INVERTED)).toBe(0);
        expect(looksUpsideDownRead(INVERTED)).toBe(true);
    });
    test('a normal read never trips it', () => {
        expect(looksUpsideDownRead(NORMAL)).toBe(false);
    });
    test('sparse crops stay below the line floor (no retry churn)', () => {
        expect(looksUpsideDownRead([{ text: '****' }, { text: '#' }])).toBe(false);
    });
});

describe('flipLines180', () => {
    test('boxes map through the rotation and back into page space', () => {
        const line: OcrLine = {
            text: '3,87 M1',
            yTop: 100, yBottom: 160, xLeft: 200, xRight: 500,
            yLeftTop: 100, yRightTop: 110, yLeftBottom: 150, yRightBottom: 160,
            words: [{ text: '3,87', xLeft: 200, xRight: 340, yTop: 100, yBottom: 160 }],
        };
        const [f] = flipLines180([line], 2000, 3000, 500);
        // 180°: y' = H - yBottom (+offset), x' = W - xRight.
        expect(f.yTop).toBe(3000 - 160 + 500);
        expect(f.yBottom).toBe(3000 - 100 + 500);
        expect(f.xLeft).toBe(2000 - 500);
        expect(f.xRight).toBe(2000 - 200);
        // Corners swap diagonally: new left-top comes from old right-bottom.
        expect(f.yLeftTop).toBe(3000 - 160 + 500);
        expect(f.yRightBottom).toBe(3000 - 100 + 500);
        expect(f.words?.[0]).toMatchObject({
            xLeft: 2000 - 340, xRight: 2000 - 200,
            yTop: 3000 - 160 + 500, yBottom: 3000 - 100 + 500,
        });
        // The flip is an involution modulo the offset: flipping back (with
        // offset removed) restores the original box.
        const [back] = flipLines180(
            [{ ...f, yTop: f.yTop - 500, yBottom: f.yBottom - 500, yLeftTop: f.yLeftTop! - 500, yRightTop: f.yRightTop! - 500, yLeftBottom: f.yLeftBottom! - 500, yRightBottom: f.yRightBottom! - 500, words: f.words?.map((w) => ({ ...w, yTop: w.yTop - 500, yBottom: w.yBottom - 500 })) }],
            2000, 3000, 0,
        );
        expect(back).toMatchObject({ yTop: 100, yBottom: 160, xLeft: 200, xRight: 500, yLeftTop: 100, yRightBottom: 160 });
    });
});
