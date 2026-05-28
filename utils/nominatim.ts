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

/** Forward geocode: address string → coordinates. Returns null on failure. */
export async function geocodeAddress(address: string): Promise<NominatimResult | null> {
    try {
        const url = `${BASE}/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=lt`;
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data.length) return null;
        return {
            lat: parseFloat(data[0].lat),
            lng: parseFloat(data[0].lon),
            displayName: data[0].display_name,
        };
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
