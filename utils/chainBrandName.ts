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
        return `${url.protocol}//${url.host}/chain-logos/${filename}`;
    } catch {
        return fullLogoUrl;
    }
}

const CHAIN_BRAND_NAMES: Array<{ match: RegExp; brand: string }> = [
    { match: /maxima/i, brand: 'Maxima' },
    { match: /rimi/i,   brand: 'Rimi'   },
    { match: /\biki\b/i, brand: 'Iki'   },
    { match: /norf/i,   brand: 'Norfa'  },
    { match: /lidl/i,   brand: 'Lidl'   },
    { match: /barbora/i, brand: 'Barbora' },
];

export function chainBrandName(chainName: string): string {
    for (const entry of CHAIN_BRAND_NAMES) {
        if (entry.match.test(chainName)) return entry.brand;
    }
    return chainName;
}
