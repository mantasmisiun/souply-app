import { create } from 'zustand';
import type { CoverDraft } from '../components/TemplateCoverEditor';
import type { RecipeImportPreview } from '../utils/recipeImportApi';

/**
 * Hand-off between the Receptai tab (where the link is pasted and the cover is
 * confirmed) and the /recipe-import review screen.
 *
 * A store rather than route params: the preview carries every matched product,
 * its alternatives and the skipped lines — kilobytes of JSON that would have to
 * be serialised into the URL and re-parsed, and that expo-router would keep in
 * navigation history. The review screen is the only consumer, and it clears the
 * staged import once it has created the template (or on unmount), so a stale
 * preview can never resurface behind a later import.
 */
interface State {
    preview: RecipeImportPreview | null;
    /** Name + cover the shopper confirmed in TemplateCoverEditor. */
    draft: CoverDraft | null;
    stage: (preview: RecipeImportPreview, draft: CoverDraft) => void;
    clear: () => void;
}

export const useRecipeImportState = create<State>((set) => ({
    preview: null,
    draft: null,
    stage: (preview, draft) => set({ preview, draft }),
    clear: () => set({ preview: null, draft: null }),
}));
