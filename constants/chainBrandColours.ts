/**
 * Chain brand colour map used by B1's comparison-card top strip.
 *
 * These are public brand colours and therefore content, not configuration —
 * hardcoding here is preferable to a DB column we'd have to keep in sync.
 * When a new chain is added (Aibė etc.), update this file and the next
 * mobile build picks it up.
 *
 * Chain IDs match the server's StoreChain.id constants:
 *   1 = MAXIMA   2 = RIMI    3 = IKI    4 = NORFA   5 = LIDL
 *
 * If a comparison row arrives with a chainId not in this map (e.g., a
 * future chain seeded server-side before mobile is updated), the
 * fallback colour keeps the strip visible without crashing — see
 * `chainBrandColour(id, fallback)`.
 */

// Kept in sync with `chainBrandColorById` in utils/chainBrandName.ts (the
// source of truth used by the Analizė chip filter). IKI is green, NORFA is
// orange — they were previously swapped here.
export const CHAIN_BRAND_COLOURS: Record<number, string> = {
    1: "#003DA5", // MAXIMA — corporate blue
    2: "#E2001A", // RIMI — corporate red
    3: "#1F8B3A", // IKI — corporate green
    4: "#F28C00", // NORFA — corporate orange
    5: "#FFD500", // LIDL — corporate yellow
};

/**
 * Look up a chain's brand colour with a safe fallback.
 *
 * @param chainId  StoreChain.id from parsedData.header.chainId
 * @param fallback Hex colour to use when chainId is unknown (typically `colors.primary`)
 */
export function chainBrandColour(
    chainId: number | null | undefined,
    fallback: string,
): string {
    if (chainId == null) return fallback;
    return CHAIN_BRAND_COLOURS[chainId] ?? fallback;
}
