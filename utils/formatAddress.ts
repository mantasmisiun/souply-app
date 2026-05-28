/**
 * Store addresses come in the format `<Street>, <City>` (sometimes with an
 * extra sublocality segment). The chain logo + chip already convey which
 * brand the user is looking at, so for list cards and headers we only need
 * the street segment — that's the actual differentiator between two
 * "IKI Vilnius" rows.
 *
 * IKI also stores street names in ALL CAPS (`UKMERGĖS G. 221`). We
 * normalize to title-case using Lithuanian locale so diacritics survive.
 */

export function formatStoreStreet(address: string | null | undefined): string {
    if (!address) return '';
    const street = address.split(',')[0].trim();
    return normalizeCasing(street);
}

// Street-type abbreviations stay lowercase even when the word itself was caps
// (gatvė, prospektas, plentas, alėja, aikštė, kelias).
const LOWERCASE_ABBREVS = new Set(['g.', 'pr.', 'pl.', 'al.', 'a.', 'kl.', 'k.', 'r.']);

function normalizeCasing(s: string): string {
    const letters = s.replace(/[^A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/g, '');
    if (letters.length === 0) return s;
    const isAllCaps = letters === letters.toLocaleUpperCase('lt');
    if (!isAllCaps) return s;

    return s
        .toLocaleLowerCase('lt')
        .split(/(\s+)/)
        .map(part => {
            if (/^\s+$/.test(part)) return part;
            if (LOWERCASE_ABBREVS.has(part)) return part;
            return part.charAt(0).toLocaleUpperCase('lt') + part.slice(1);
        })
        .join('');
}
