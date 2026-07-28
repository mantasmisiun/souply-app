/**
 * Recipe-create pane model — the auto-prefill and URL-gate rules
 * (utils/recipeCreateDraft.ts), kept pure so the pane's contract is testable:
 *
 *  1. an import prefills every UNTOUCHED field;
 *  2. a field the shopper edited themselves is NEVER overwritten by a later
 *     auto-prefill;
 *  3. typed input only fires an import once it actually looks like a URL.
 */
import {
    MAX_TEMPLATE_NAME, UNTOUCHED, mergePreviewIntoFields, looksLikeRecipeUrl,
    type CoverFields,
} from '../utils/recipeCreateDraft';

const DEFAULT_COLOR = '#EB6784';
const start: CoverFields = { name: '', color: DEFAULT_COLOR, emoji: '🥗' };
const preview = { title: 'Cepelinai su spirgučiais', suggestedEmoji: '🥟' };

describe('mergePreviewIntoFields', () => {
    it('prefills name, emoji and colour when nothing is touched', () => {
        const out = mergePreviewIntoFields(start, { ...UNTOUCHED }, preview, DEFAULT_COLOR);
        expect(out).toEqual({ name: 'Cepelinai su spirgučiais', emoji: '🥟', color: DEFAULT_COLOR });
    });

    it('caps a long imported title at MAX_TEMPLATE_NAME', () => {
        const long = { title: 'x'.repeat(MAX_TEMPLATE_NAME + 40), suggestedEmoji: '🥟' };
        const out = mergePreviewIntoFields(start, { ...UNTOUCHED }, long, DEFAULT_COLOR);
        expect(out.name).toHaveLength(MAX_TEMPLATE_NAME);
    });

    it('does NOT clobber a name the shopper typed themselves', () => {
        const edited: CoverFields = { ...start, name: 'Mano receptas' };
        const out = mergePreviewIntoFields(edited, { ...UNTOUCHED, name: true }, preview, DEFAULT_COLOR);
        expect(out.name).toBe('Mano receptas');
        // ...while the untouched fields still take the suggestion.
        expect(out.emoji).toBe('🥟');
    });

    it('does NOT clobber a shopper-picked emoji or colour', () => {
        const edited: CoverFields = { name: '', color: '#5571E1', emoji: '🍕' };
        const out = mergePreviewIntoFields(
            edited, { name: false, color: true, emoji: true }, preview, DEFAULT_COLOR,
        );
        expect(out.emoji).toBe('🍕');
        expect(out.color).toBe('#5571E1');
        expect(out.name).toBe('Cepelinai su spirgučiais');
    });

    it('leaves everything alone when all fields are touched', () => {
        const edited: CoverFields = { name: 'A', color: '#4FAE52', emoji: '🍰' };
        const out = mergePreviewIntoFields(
            edited, { name: true, color: true, emoji: true }, preview, DEFAULT_COLOR,
        );
        expect(out).toEqual(edited);
    });
});

describe('looksLikeRecipeUrl', () => {
    it.each([
        'https://www.lamaistas.lt/receptas/cepelinai-123',
        'http://allrecipes.com/recipe/1',
        '  https://a.io/x  ', // surrounding whitespace is trimmed
    ])('accepts %s', (s) => expect(looksLikeRecipeUrl(s)).toBe(true));

    it.each([
        '',            // empty
        'cepelinai',   // bare words — mid-typing
        'https://',    // scheme alone
        'https://x',   // no dotted host yet
        'www.lamaistas.lt/receptas', // no scheme — the server would reject it
        'ftp://x.lt/a',
    ])('rejects %j', (s) => expect(looksLikeRecipeUrl(s)).toBe(false));
});
