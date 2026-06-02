import type { TemplateCoverImage } from './basketTemplatesApi';

/**
 * Preset iconKey → emoji glyph. Mirrors the web's COVER_PRESETS
 * (souply-web/src/data/coverPresets.ts) so a cover the creator picked on
 * the web dashboard renders identically in the app. Keep the two in sync.
 */
const PRESET_EMOJI: Record<string, string> = {
    salad: '🥗',
    avocado: '🥑',
    protein: '🥩',
    apple: '🍎',
    smoothie: '🥤',
};

/** Default cover tint when a template predates the cover columns (null). */
export const DEFAULT_COVER_COLOR = '#EB6784';

/** Resolve a cover image to its emoji glyph, or null if none. */
export function coverEmoji(image: TemplateCoverImage | null | undefined): string | null {
    if (!image) return null;
    if (image.kind === 'emoji') return image.emoji;
    return PRESET_EMOJI[image.iconKey] ?? PRESET_EMOJI.salad;
}
