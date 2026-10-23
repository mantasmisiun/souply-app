/**
 * Recipe edit save (utils/templateIdentitySave) — the optimistic contract.
 *
 * The edit pane's Išsaugoti applies the new identity to the screen BEFORE the
 * PATCH round-trip, so the pinned behaviour is the revert: a failed PATCH must
 * put the previous identity back (the old inline `.catch(() => {})` call sites
 * kept a phantom name/cover on screen), and the boolean return is what lets
 * the screen alert on failure.
 */
import { saveTemplateIdentity, type TemplateIdentity } from '../utils/templateIdentitySave';
import { patchTemplate } from '../utils/basketTemplatesApi';

jest.mock('../utils/basketTemplatesApi', () => ({
    patchTemplate: jest.fn(),
}));

const prev: TemplateIdentity = {
    name: 'Šaltibarščiai', coverColor: '#5571E1', coverImage: { kind: 'emoji', emoji: '🍲' },
};
const next: TemplateIdentity = {
    name: 'Cepelinai', coverColor: '#4FAE52', coverImage: { kind: 'emoji', emoji: '🥟' },
};

beforeEach(() => jest.clearAllMocks());

describe('saveTemplateIdentity', () => {
    it('applies the new identity BEFORE the PATCH settles, then patches exactly those fields', async () => {
        let settle!: () => void;
        (patchTemplate as jest.Mock).mockImplementationOnce(
            () => new Promise<void>(res => { settle = res; }),
        );
        const apply = jest.fn();

        const done = saveTemplateIdentity(7, prev, next, apply);

        // Optimistic: the screen already shows `next` while the request flies.
        expect(apply).toHaveBeenCalledTimes(1);
        expect(apply).toHaveBeenCalledWith(next);
        expect(patchTemplate).toHaveBeenCalledWith(7, {
            name: 'Cepelinai', coverColor: '#4FAE52', coverImage: { kind: 'emoji', emoji: '🥟' },
        });

        settle();
        await expect(done).resolves.toBe(true);
        // Success leaves the optimistic apply in place — no second call.
        expect(apply).toHaveBeenCalledTimes(1);
    });

    it('a failed PATCH reverts the optimistic apply and reports false', async () => {
        (patchTemplate as jest.Mock).mockRejectedValueOnce(new Error('HTTP 500'));
        const apply = jest.fn();

        await expect(saveTemplateIdentity(7, prev, next, apply)).resolves.toBe(false);

        // next applied optimistically, then prev put back — in that order.
        expect(apply.mock.calls).toEqual([[next], [prev]]);
    });
});
