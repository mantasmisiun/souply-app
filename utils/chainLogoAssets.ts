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
