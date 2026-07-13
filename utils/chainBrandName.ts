const CHAIN_MINI_LOGO_FILENAMES: Record<number, string> = {
    1: 'maximaLogo_mini.webp',
    2: 'rimiLogo_mini.webp',
    3: 'ikiLogo_mini.webp',
    4: 'norfaLogo_mini.webp',
    5: 'Lidl_logo.png',
};

export function getChainMiniLogoUrl(chainId: number, fullLogoUrl: string): string {
    const filename = CHAIN_MINI_LOGO_FILENAMES[chainId];
    if (!filename) return fullLogoUrl;
    try {
        const url = new URL(fullLogoUrl);
        // Swap only the filename, keeping the URL's existing path. This works for
        // both R2 custom domains (objects at root: …/maxima.png → …/maxima_mini.webp)
        // and MinIO path-style (…/chain-logos/maxima.png → …/chain-logos/maxima_mini.webp).
        // Hardcoding "/chain-logos/" assumed MinIO and 404'd on R2.
        url.pathname = url.pathname.replace(/[^/]*$/, filename);
        return url.toString();
    } catch {
        return fullLogoUrl;
    }
}

const CHAIN_BRAND_NAMES: { match: RegExp; brand: string; miniFile?: string }[] = [
    { match: /maxima/i,  brand: 'Maxima',  miniFile: 'maximaLogo_mini.webp' },
    { match: /rimi/i,    brand: 'Rimi',    miniFile: 'rimiLogo_mini.webp'   },
    { match: /\biki\b/i, brand: 'Iki',     miniFile: 'ikiLogo_mini.webp'    },
    { match: /norf/i,    brand: 'Norfa',   miniFile: 'norfaLogo_mini.webp'  },
    { match: /lidl/i,    brand: 'Lidl',    miniFile: 'Lidl_logo.png'        },
    { match: /barbora/i, brand: 'Barbora'                                    },
];

export function chainBrandName(chainName: string): string {
    for (const entry of CHAIN_BRAND_NAMES) {
        if (entry.match.test(chainName)) return entry.brand;
    }
    return chainName;
}

export function getMiniLogoUrl(chainName: string, logoUrl: string): string {
    for (const entry of CHAIN_BRAND_NAMES) {
        if (entry.match.test(chainName) && entry.miniFile) {
            try {
                const url = new URL(logoUrl);
                // Swap only the filename (keep the path) so it works on both R2
                // (root) and MinIO (/chain-logos/) — see getChainMiniLogoUrl.
                url.pathname = url.pathname.replace(/[^/]*$/, entry.miniFile);
                return url.toString();
            } catch {
                return logoUrl;
            }
        }
    }
    return logoUrl;
}

const CHAIN_BRAND_COLORS: { match: RegExp; color: string }[] = [
    { match: /maxima/i,  color: '#003DA5' }, // blue
    { match: /rimi/i,    color: '#E2001A' }, // red
    { match: /\biki\b/i, color: '#1F8B3A' }, // green
    { match: /norf/i,    color: '#F28C00' }, // orange
    { match: /lidl/i,    color: '#FFD500' }, // yellow
];

const CHAIN_BRAND_COLORS_BY_ID: Record<number, string> = {
    1: '#003DA5', // Maxima
    2: '#E2001A', // Rimi
    3: '#1F8B3A', // Iki
    4: '#F28C00', // Norfa
    5: '#FFD500', // Lidl
};

export function chainBrandColor(chainName: string): string {
    for (const entry of CHAIN_BRAND_COLORS) {
        if (entry.match.test(chainName)) return entry.color;
    }
    return '#9E9E9E';
}

export function chainBrandColorById(chainId: number): string {
    return CHAIN_BRAND_COLORS_BY_ID[chainId] ?? '#9E9E9E';
}

const CHAIN_ID_BY_NAME: { match: RegExp; id: number }[] = [
    { match: /maxima/i,  id: 1 },
    { match: /rimi/i,    id: 2 },
    { match: /\biki\b/i, id: 3 },
    { match: /norf/i,    id: 4 },
    { match: /lidl/i,    id: 5 },
];

/** Resolve a chain's canonical id (1-5) from its name, so name-keyed screens
 *  (e.g. the shopping list) can use the chainId-based ChainLogoChip / baked
 *  chain badges. Returns null for chains outside the bundled set (e.g. Barbora). */
export function chainIdByName(chainName: string): number | null {
    for (const entry of CHAIN_ID_BY_NAME) {
        if (entry.match.test(chainName)) return entry.id;
    }
    return null;
}
