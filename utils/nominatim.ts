const BASE = 'https://nominatim.openstreetmap.org';
const HEADERS = {
    'Accept-Language': 'lt,en',
    'User-Agent': 'Souply/1.0 (souply.lt)',
};

export interface NominatimResult {
    lat: number;
    lng: number;
    displayName: string;
    /** false = only a street-level / wrong-city fallback matched a query that
     *  DID specify a house number or city — the caller should treat the pin as
     *  APPROXIMATE (prompt the user to nudge it) rather than an exact hit. */
    precise: boolean;
}

// Major Lithuanian cities we can confidently peel off the end of a free-typed
// address ("Saulėtekio al. 15 Vilnius") to feed Nominatim's STRUCTURED search
// (street + city), which parses LT abbreviations + house numbers far better
// than the free-text q=. Diacritic-stripped for matching.
const LT_CITIES = new Set([
    'vilnius', 'kaunas', 'klaipeda', 'siauliai', 'panevezys', 'alytus',
    'marijampole', 'mazeikiai', 'jonava', 'utena', 'kedainiai', 'telsiai',
    'visaginas', 'taurage', 'ukmerge', 'plunge', 'kretinga', 'silute',
    'radviliskis', 'palanga', 'gargzdai', 'druskininkai',
]);

/** Lowercase + strip diacritics (ė→e, š→s, ž→z…) for tolerant matching. */
const norm = (s: string) =>
    s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** Pull a house number ("15", "15a") out of a street string. */
const houseNumberOf = (street: string): string | null => {
    const m = street.match(/\b(\d+[a-zA-Z]?)\b/);
    return m ? m[1].toLowerCase() : null;
};

/** "Saulėtekio al. 15, Vilnius" / "Dvaro 46 Vilnius" → { street, city }. */
function splitAddress(input: string): { street: string; city: string | null } {
    const t = input.trim();
    if (t.includes(',')) {
        const parts = t.split(',').map(s => s.trim()).filter(Boolean);
        if (parts.length >= 2) return { street: parts.slice(0, -1).join(', '), city: parts[parts.length - 1] };
        return { street: parts[0] ?? t, city: null };
    }
    // No comma: peel a trailing known-city token if there's a street before it.
    const words = t.split(/\s+/);
    if (words.length >= 3 && LT_CITIES.has(norm(words[words.length - 1]))) {
        return { street: words.slice(0, -1).join(' '), city: words[words.length - 1] };
    }
    return { street: t, city: null };
}

interface RawResult {
    lat: number;
    lng: number;
    displayName: string;
    houseNumber: string | null;
    /** City/town/village/municipality/county, joined + diacritic-stripped. */
    locality: string;
    importance: number;
}

async function fetchResults(
    params: Record<string, string>,
    near?: { lat: number; lng: number },
): Promise<RawResult[]> {
    const usp = new URLSearchParams({
        format: 'json',
        countrycodes: 'lt',
        addressdetails: '1',
        limit: near ? '10' : '3',
        ...params,
    });
    if (near) {
        // ~±0.35° (≈25-40 km) soft bias box — unbounded, so distant matches
        // still return when nothing is near.
        const d = 0.35;
        usp.set('viewbox', `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`);
    }
    try {
        const res = await fetch(`${BASE}/search?${usp.toString()}`, { headers: HEADERS });
        if (!res.ok) return [];
        const data = await res.json();
        if (!Array.isArray(data)) return [];
        return data
            .map((r: any): RawResult => {
                const a = r.address ?? {};
                return {
                    lat: parseFloat(r.lat),
                    lng: parseFloat(r.lon),
                    displayName: r.display_name,
                    houseNumber: a.house_number ? String(a.house_number).toLowerCase() : null,
                    locality: norm([a.city, a.town, a.village, a.municipality, a.county].filter(Boolean).join(' ')),
                    importance: typeof r.importance === 'number' ? r.importance : 0,
                };
            })
            .filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng));
    } catch {
        return [];
    }
}

/** Forward geocode: address string → coordinates. Returns null on failure.
 *
 *  `near` biases ambiguous queries to the caller's area (street names repeat
 *  across Lithuanian cities). We STRUCTURE the query (street + city) when a city
 *  is present — the free-text q= drops house numbers and mangles the "g."/"al."
 *  abbreviations — then RANK results so a real house-number/city match beats a
 *  street-level fallback, using distance only as a tie-break. (The old code
 *  picked the nearest candidate unconditionally, which confidently zoomed to
 *  the WRONG same-named street whenever the number/city didn't actually match.)
 *  `precise=false` flags those weak matches so the caller can warn instead of
 *  pretending the pin is exact. */
export async function geocodeAddress(
    address: string,
    near?: { lat: number; lng: number },
): Promise<NominatimResult | null> {
    const { street, city } = splitAddress(address);
    const wantNumber = houseNumberOf(street);
    const cityNorm = city ? norm(city) : null;

    // Structured search first; fall back to the raw string only if it's empty.
    let results = await fetchResults(city ? { street, city } : { street }, near);
    if (results.length === 0) results = await fetchResults({ q: address }, near);
    if (results.length === 0) return null;

    const houseOk = (r: RawResult) => wantNumber != null && r.houseNumber === wantNumber;
    const cityOk = (r: RawResult) => cityNorm != null && r.locality.includes(cityNorm);
    const dist2 = (r: RawResult) => near ? (r.lat - near.lat) ** 2 + (r.lng - near.lng) ** 2 : 0;

    const best = [...results].sort((a, b) => {
        if (houseOk(a) !== houseOk(b)) return houseOk(a) ? -1 : 1;   // real house number wins
        if (cityOk(a) !== cityOk(b)) return cityOk(a) ? -1 : 1;       // right city wins
        if (near) return dist2(a) - dist2(b);                        // then nearest (tie-break)
        return b.importance - a.importance;                          // else Nominatim's rank
    })[0];

    const precise =
        (wantNumber == null || houseOk(best)) &&
        (cityNorm == null || cityOk(best));

    return { lat: best.lat, lng: best.lng, displayName: best.displayName, precise };
}

/** Reverse geocode: coordinates → a clean "official" address label, Google-style
 *  ("Plytinės g. 2, Vilnius"): street + house number, then locality. Returns
 *  null on failure. NOTE: callers that want only the street part take
 *  `split(',')[0]` — the street stays first so that keeps working. */
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
    try {
        const url = `${BASE}/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) return null;
        const data = await res.json();
        const a = data.address ?? {};
        const street = [a.road, a.house_number].filter(Boolean).join(' ');
        const locality = a.city || a.town || a.village || a.municipality || null;
        const label = [street || null, locality].filter(Boolean).join(', ');
        return label || data.display_name || null;
    } catch {
        return null;
    }
}
