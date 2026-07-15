/**
 * Pre-composed map-pin images (logo baked onto its brand-coloured circle),
 * keyed by StoreChain.id. We use these as the native `<Marker image=...>` icon
 * because a React `<Image>` inside a custom marker view does NOT rasterise
 * reliably on Android — the native image prop always renders. Baking the
 * circle in keeps the chip look (and stops white logos vanishing on the map).
 *
 *   1 = Maxima   2 = Rimi   3 = Iki   4 = Norfa   5 = Lidl
 */
const PIN: Record<number, number> = {
    1: require('../assets/chain-logos/pin_1.png'),
    2: require('../assets/chain-logos/pin_2.png'),
    3: require('../assets/chain-logos/pin_3.png'),
    4: require('../assets/chain-logos/pin_4.png'),
    5: require('../assets/chain-logos/pin_5.png'),
};

const PIN_SELECTED: Record<number, number> = {
    1: require('../assets/chain-logos/pin_sel_1.png'),
    2: require('../assets/chain-logos/pin_sel_2.png'),
    3: require('../assets/chain-logos/pin_sel_3.png'),
    4: require('../assets/chain-logos/pin_sel_4.png'),
    5: require('../assets/chain-logos/pin_sel_5.png'),
};

/** Native marker icon (asset id) for a chain. `selected` swaps to the bigger
 *  pink-ringed pin. */
export function chainPinImage(chainId: number, selected: boolean): number | null {
    return (selected ? PIN_SELECTED[chainId] : PIN[chainId]) ?? null;
}

/**
 * Square chain-logo glyphs (transparent bg), for in-app chip/list rendering —
 * NOT the map. The PIN images above are teardrop map markers (wrong shape +
 * the logo is tiny inside them), so anything off the map should use these.
 *   1 = Maxima   2 = Rimi   3 = Iki   4 = Norfa   5 = Lidl
 */
const MINI: Record<number, number> = {
    1: require('../assets/chain-logos/maxima_mini.webp'),
    2: require('../assets/chain-logos/rimi_mini.webp'),
    3: require('../assets/chain-logos/iki_mini.webp'),
    4: require('../assets/chain-logos/norfa_mini.webp'),
    5: require('../assets/chain-logos/lidl_mini.png'), // blue square cropped off → bare yellow circle
};

/**
 * Glyph scale per chain (fraction of the chip diameter) when drawn centred on
 * the brand-coloured circle. Lidl's glyph is itself a filled yellow circle, so
 * it fills the chip; the rest are transparent marks centred on the brand disc.
 *   1 = Maxima   2 = Rimi   3 = Iki   4 = Norfa   5 = Lidl
 */
const GLYPH_SCALE: Record<number, number> = { 1: 0.56, 2: 0.58, 3: 0.72, 4: 0.6, 5: 1 };

export function chainGlyphScale(chainId: number): number {
    return GLYPH_SCALE[chainId] ?? 0.6;
}

/**
 * Pre-composed ROUND chain badge (logo baked on its brand-coloured disc + white
 * outline), keyed by StoreChain.id — used as the native `<Marker image=...>` on
 * the results map. A baked PNG is mandatory there: a React <Image> inside a
 * custom marker does NOT rasterise on Android, so the logo can only ride the
 * marker's native image prop. (@2x/@3x bundled; Metro picks the density.)
 *   1 = Maxima   2 = Rimi   3 = Iki   4 = Norfa   5 = Lidl
 */
const BADGE: Record<number, number> = {
    1: require('../assets/chain-logos/chip_1.png'),
    2: require('../assets/chain-logos/chip_2.png'),
    3: require('../assets/chain-logos/chip_3.png'),
    4: require('../assets/chain-logos/chip_4.png'),
    5: require('../assets/chain-logos/chip_5.png'),
};

export function chainBadgeImage(chainId: number): number | null {
    return BADGE[chainId] ?? null;
}

export function chainMiniLogo(chainId: number): number | null {
    return MINI[chainId] ?? null;
}
