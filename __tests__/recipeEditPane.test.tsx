/**
 * RecipeCreatePane EDIT MODE — the two pinned contracts:
 *
 *   1. edit mode can NEVER submit (or even start) a URL import, although the
 *      frozen field holds a perfectly importable address: the auto-import
 *      debounce is gated off, and Išsaugoti routes to `edit.onSubmit` — never
 *      to the /recipe-import review hand-off or the blank-create POST;
 *   2. a hand-made recipe (no sourceUrl) renders NO URL row at all — an empty
 *      permanently-disabled field would read as a broken input.
 *
 * CoverIdentityControls is stubbed out (its colour wheel / keyboard-controller
 * stack has no jest transform); the identity draft is exercised through the
 * edit prefill instead, which is exactly what edit mode submits.
 */
import React from 'react';
import { render, act } from '@testing-library/react-native';

import { RecipeCreatePane, type PaneSubmitControls } from '../components/recipe/RecipeCreatePane';
import { importRecipe } from '../utils/recipeImportApi';
import { createTemplate } from '../utils/basketTemplatesApi';
import { useRecipeImportState } from '../state/recipeImportState';

jest.mock('../components/TemplateCoverEditor', () => ({
    // Must equal the real palette's first swatch — the pane's colour default.
    DEFAULT_COVER_DRAFT_COLOR: '#EB6784',
    CoverIdentityControls: () => null,
}));
jest.mock('@/components/MaterialProgress', () => ({ MaterialProgress: () => null }));
jest.mock('expo-clipboard', () => ({ getStringAsync: jest.fn(async () => '') }));
jest.mock('../utils/recipeImportApi', () => ({ importRecipe: jest.fn() }));
jest.mock('../utils/basketTemplatesApi', () => ({ createTemplate: jest.fn() }));
jest.mock('../config/api', () => ({ API_BASE_URL: 'http://test.local' }));
jest.mock('../config/user', () => ({ getUserId: jest.fn(async () => 'user-1') }));
// Partial mock: keep initReactI18next real (i18n/index.ts runs via the theme →
// settingsStore chain), but pin t() to raw keys so assertions survive copy edits.
jest.mock('react-i18next', () => ({
    ...jest.requireActual('react-i18next'),
    useTranslation: () => ({ t: (k: string) => k }),
}));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const SOURCE = 'https://www.lamaistas.lt/receptas/cepelinai';

beforeEach(() => {
    jest.clearAllMocks();
    useRecipeImportState.getState().clear();
});

/** Captures the pane's reported submit controls — the host-bar pill's feed
 *  (the Sukurti/Išsaugoti pill lives in the HOST's bar row, not the pane). */
const controlsRecorder = () => {
    const ref: { current: PaneSubmitControls | null } = { current: null };
    return { ref, onSubmitControls: (c: PaneSubmitControls) => { ref.current = c; } };
};

describe('RecipeCreatePane edit mode', () => {
    it('shows the frozen source URL, never imports it, and submits to edit.onSubmit only', () => {
        jest.useFakeTimers();
        const onSubmit = jest.fn();
        const collapse = jest.fn();
        const ctl = controlsRecorder();

        const { getByDisplayValue } = render(
            <RecipeCreatePane
                collapse={collapse}
                onSubmitControls={ctl.onSubmitControls}
                edit={{
                    name: 'Cepelinai',
                    coverColor: '#4FAE52',
                    coverImage: { kind: 'emoji', emoji: '🥟' },
                    sourceUrl: SOURCE,
                    onSubmit,
                }}
            />,
        );

        // The greyed URL row shows the recipe's source address.
        expect(getByDisplayValue(SOURCE)).toBeTruthy();

        // Let the auto-import debounce window pass well beyond 700ms — the
        // importable address in the field must not trigger a request.
        act(() => { jest.advanceTimersByTime(3000); });
        expect(importRecipe).not.toHaveBeenCalled();

        // Submit via the reported controls — the host bar's Išsaugoti pill.
        // A prefilled name means the pane reports the pill ENABLED and idle.
        expect(ctl.ref.current).toEqual(
            expect.objectContaining({ disabled: false, busy: false }),
        );
        act(() => { ctl.ref.current!.submit(); });

        // The prefilled identity goes to the host's save — nothing else.
        expect(onSubmit).toHaveBeenCalledWith({
            name: 'Cepelinai',
            coverColor: '#4FAE52',
            coverImage: { kind: 'emoji', emoji: '🥟' },
        });
        expect(collapse).toHaveBeenCalled();
        // No import review hand-off, no staged preview, no create POST.
        expect(mockPush).not.toHaveBeenCalled();
        expect(useRecipeImportState.getState().preview).toBeNull();
        expect(createTemplate).not.toHaveBeenCalled();
        expect(importRecipe).not.toHaveBeenCalled();

        jest.useRealTimers();
    });

    it('renders no URL row for a hand-made recipe (no sourceUrl)', () => {
        const { queryByPlaceholderText } = render(
            <RecipeCreatePane
                collapse={() => {}}
                onSubmitControls={() => {}}
                edit={{
                    name: 'Rankinis',
                    coverColor: null,
                    coverImage: null,
                    sourceUrl: null,
                    onSubmit: jest.fn(),
                }}
            />,
        );
        expect(queryByPlaceholderText('basketTab.templates.urlPlaceholder')).toBeNull();
    });

    it('create mode still shows the editable URL field with its paste affordance', () => {
        const ctl = controlsRecorder();
        const { getByPlaceholderText, getByLabelText } = render(
            <RecipeCreatePane collapse={() => {}} onSubmitControls={ctl.onSubmitControls} />,
        );
        expect(getByPlaceholderText('basketTab.templates.urlPlaceholder').props.editable).not.toBe(false);
        expect(getByLabelText('basketTab.templates.urlPasteA11y')).toBeTruthy();
        // …and the host pill starts DISABLED: no name typed yet (the old
        // full-width Sukurti's exact gate, now reported to the host bar).
        expect(ctl.ref.current).toEqual(
            expect.objectContaining({ disabled: true, busy: false }),
        );
    });
});
