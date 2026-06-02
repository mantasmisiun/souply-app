/**
 * Curated food/grocery emoji catalog for the cover picker. Mirrors the
 * website's EMOJI_GROUPS (souply-web/src/data/emojiCatalog.ts) so both
 * surfaces offer the same options — keep the two in sync. Flattened into a
 * single scrollable list; the leading 5 match the legacy preset glyphs.
 */
export const EMOJI_CATALOG: string[] = [
    // beetroot first — Souply's brand glyph, the default cover emoji
    '🫜',
    // fruit
    '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🥭', '🍑', '🍒', '🍍', '🥥', '🥝',
    // veg
    '🍅', '🥑', '🥦', '🥬', '🥒', '🌶️', '🌽', '🥕', '🥔', '🧅', '🧄', '🍠', '🍆', '🫑',
    // protein
    '🥚', '🥩', '🍗', '🍖', '🥓', '🐟', '🦐', '🦀', '🦞', '🥜', '🫘', '🧀',
    // grain
    '🍞', '🥐', '🥖', '🥯', '🥨', '🧇', '🥞', '🍳', '🥣', '🍙', '🍚',
    // meal
    '🥗', '🥘', '🍲', '🍜', '🍝', '🍱', '🍣', '🌮', '🌯', '🥙', '🍔', '🍕', '🌭', '🍟', '🥪', '🍤',
    // sweet
    '🍰', '🧁', '🥧', '🍫', '🍩', '🍪', '🍭', '🍮', '🍯', '🍡', '🍧', '🍨', '🍦',
    // drink
    '🥤', '🧃', '🧋', '🥛', '☕', '🍵', '🥃', '🍹', '🍸', '🍷', '🍺', '🍶', '🥂',
];
