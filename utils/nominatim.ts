const BASE = 'https://nominatim.openstreetmap.org';
const HEADERS = {
    'Accept-Language': 'lt,en',
    'User-Agent': 'Souply/1.0 (souply.lt)',
};

export interface NominatimResult {
    lat: number;
    lng: number;
    displayName: string;
}

/** Forward geocode: address string → coordinates. Returns null on failure.
 *
 *  `near` biases ambiguous queries to the caller's area: street names repeat
 *  across Lithuanian cities ("Vytauto g. 20" exists in Vilnius AND Šiauliai),
 *  and Nominatim's top rank is essentially "the biggest city". With `near`,
 *  the query is viewbox-biased AND the NEAREST of several candidates wins. */
export async function geocodeAddress(
    address: string,
    near?: { lat: number; lng: number },
): Promise<NominatimResult | null> {
    try {
        let url = `${BASE}/search?q=${encodeURIComponent(address)}&format=json&countrycodes=lt&limit=${near ? 8 : 1}`;
        if (near) {
            // ~±0.35° (≈25-40 km) soft bias box around the caller's position —
            // unbounded, so distant matches still return when nothing is near.
            const d = 0.35;
            url += `&viewbox=${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`;
        }
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data.length) return null;
        const results: NominatimResult[] = data.map((r: any) => ({
            lat: parseFloat(r.lat),
            lng: parseFloat(r.lon),
            displayName: r.display_name,
        }));
        if (!near) return results[0];
        return results.reduce((best, r) =>
            ((r.lat - near.lat) ** 2 + (r.lng - near.lng) ** 2) <
            ((best.lat - near.lat) ** 2 + (best.lng - near.lng) ** 2) ? r : best);
    } catch {
        return null;
    }
}

/** Reverse geocode: coordinates → human-readable label. Returns null on failure. */
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
    try {
        const url = `${BASE}/reverse?lat=${lat}&lon=${lng}&format=json`;
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) return null;
        const data = await res.json();
        // Prefer a short readable label: road + house_number, fallback to full display_name
        const addr = data.address ?? {};
        const short = [addr.road, addr.house_number].filter(Boolean).join(' ');
        return short || data.display_name || null;
    } catch {
        return null;
    }
}
