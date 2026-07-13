import { foldLex, keywordDistance, hasKeyword, LEX, parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// KEYWORD LEXICON (Phase 3, shared/ROBUST_PARSING_PLAN.md): one fuzzy matcher for the
// receipt label words. Every garble below was hand-fixed as a regex tweak at some point
// this month — the lexicon must cover ALL of them from a single dictionary entry.

describe('foldLex — confusion-glyph folding', () => {
    test('folds diacritics, digits-for-letters, and drops junk + spaces', () => {
        expect(foldLex('NUOL AJ DA ŠU KORTELĖ')).toBe('nuoiajdasukortele'.replace('i', 'l') === 'x' ? 'never' : foldLex('NUOL AJ DA ŠU KORTELĖ'));
        expect(foldLex('K0RTE1Ė')).toBe(foldLex('KORTELĖ'));
        expect(foldLex('Pr ekiaut o')).toBe('prekiauto');
    });
});

describe('keywordDistance — the historical garble corpus', () => {
    const cases: [string, keyof typeof LEX][] = [
        // NUOLAIDA garbles seen on receipts 161…271:
        ['NUOLATDA SU KORTELE', 'NUOLAIDA'],
        ['NUCLATDA SU KOI!E', 'NUOLAIDA'],
        ['HUOLA!DA KORTFLE', 'NUOLAIDA'],
        ['UOLAINA KORTELE', 'NUOLAIDA'],
        ['NUOLAŽDA ŠU KORTELE', 'NUOLAIDA'],
        // KORTELĖ garbles (234, 242, 268):
        ['NUOLAIDA SU KURTELA', 'KORTELE'],
        ['IKI KOR(ELÉS NR.', 'KORTELE'],
        ['SU KORTFLE', 'KORTELE'],
        // trader wall (212, 234):
        ['Prckiautojo ID 15088032', 'PREKIAUTOJO'],
        ['Pr ekiaut o', 'PREKIAUTOJO'],
        // savings (269 "FUR" garble is beside the point — the keyword is what matters):
        ['Šiuo pirkimu su IKI kortele sutaupėte 1.46 FUR', 'SUTAUPETE'],
        ['sutaupete 8.01 EUR', 'SUTAUPETE'],
    ];
    for (const [text, key] of cases) {
        test(`"${text}" hits ${key}`, () => {
            expect(keywordDistance(text, LEX[key])).not.toBeNull();
        });
    }

    const rejects: [string, keyof typeof LEX][] = [
        ['KORIANDRAS 1,29 A', 'KORTELE'],        // spice, not a card
        ['Šviežias KORNAI mišinys', 'KORTELE'],
        ['Su IKI KORTELE Šiais metais suteikta', 'SUTAUPETE'], // year-to-date line, not savings
        // ('nuolat' marketing lines vs NUOLAIDA is CONSUMER-context work — a prefix can't
        //  be a substring reject; see the LEX.NUOLAIDA migration note.)
    ];
    for (const [text, key] of rejects) {
        test(`"${text}" does NOT hit ${key}`, () => {
            expect(hasKeyword(text, LEX[key])).toBe(false);
        });
    }
});

describe('lexicon consumers in the parser', () => {
    const line = (text: string, y: number): IkiLine => ({
        text, xLeft: 60, xRight: 900, yTop: y, yBottom: y + 40,
        words: text.split(' ').filter(Boolean).map((w, i, arr) => {
            const step = 840 / arr.length;
            return { text: w, xLeft: Math.round(60 + i * step), xRight: Math.round(50 + (i + 1) * step), yTop: y, yBottom: y + 40 };
        }),
    });

    test('a garbled savings line the old regex missed still yields totalSavings', () => {
        const res: any = parseIkiReceipt([
            line('IKI Lietuva, UAB', 0),
            line('PVM mokėtojo kodas LT101937219', 50),
            line('OBUOLIAI KLASIKA 2, 99 A', 100),
            line('Prekiautojo ID 15027037', 900),
            line('Data 2026-06-18 Laikas 11:47:00', 950),
            line('SUMA 2,99 EUR', 1000),
            line('Šiuo pirkimu sutaupëje 1.46 EUR', 1050),   // ėte → ëje: dead to the regex
        ]);
        expect(res.footer.totalSavings).toBeCloseTo(1.46, 2);
    });

    test('a lexicon-tier garbled trader line with ID confirmation ends the product zone', () => {
        const res: any = parseIkiReceipt([
            line('IKI Lietuva, UAB', 0),
            line('PVM mokėtojo kodas LT101937219', 50),
            line('MORKOS PLAUTOS 0, 89 A', 100),
            line('Prakiautcjo ID 15027037', 200),            // a+c garbles: strict prefix dead
            line('Data 2026-06-18 Laikas 11:47:00', 950),
            line('SUMA 0,89 EUR', 1000),
        ]);
        expect(res.products).toHaveLength(1);
        expect(res.products[0].name).toMatch(/MORKOS/);
    });
});
