import AsyncStorage from '@react-native-async-storage/async-storage';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PresetKey = 'home' | 'work' | 'custom';
export type TransportMode = 'bus' | 'car';
export type LocationMode = 'current' | 'specific' | 'route';

export interface LocationPreset {
    label: string;
    address?: string;   // human-readable address from geocoding/search
    lat: number;
    lng: number;
}

export interface LocationSettings {
    transport: TransportMode;
    mode: LocationMode;
    specificPreset: PresetKey | null;
    routeFrom: PresetKey | null;
    routeTo: PresetKey | null;
    storeCount: 1 | 2 | 3;
}

export interface StoreVisit {
    storeId: number;
    lat: number;
    lng: number;
    chainId: number;
    chainName: string;
    visitCount: number;
    lastVisited: string; // ISO
    inferredContext: 'home' | 'work' | 'custom' | 'unknown';
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const PRESETS_KEY = 'location_presets_v1';
const SETTINGS_KEY = 'location_settings_v1';
const VISIT_HISTORY_KEY = 'store_visit_history_v1';

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const DEFAULT_PRESETS: Record<PresetKey, LocationPreset | null> = {
    home: null,
    work: null,
    custom: null,
};

const DEFAULT_SETTINGS: LocationSettings = {
    transport: 'bus',
    mode: 'current',
    specificPreset: null,
    routeFrom: null,
    routeTo: null,
    storeCount: 1,
};

export async function getPresets(): Promise<Record<PresetKey, LocationPreset | null>> {
    try {
        const raw = await AsyncStorage.getItem(PRESETS_KEY);
        return raw ? JSON.parse(raw) : DEFAULT_PRESETS;
    } catch {
        return DEFAULT_PRESETS;
    }
}

export async function setPreset(key: PresetKey, preset: LocationPreset | null): Promise<void> {
    try {
        const current = await getPresets();
        await AsyncStorage.setItem(PRESETS_KEY, JSON.stringify({ ...current, [key]: preset }));
        // Re-evaluate visit history context whenever presets change
        await recomputeVisitContexts();
    } catch {
        // non-fatal
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Store-search settings are PER SHOPPING, not per device. Mode (GPS/place/route),
 * store count and the chosen endpoints describe *this* trip's plan, so a NEW
 * shopping must start from DEFAULT_SETTINGS ("fresh": GPS, one store) and only
 * keep what the user deliberately changed for it — previously one global blob
 * leaked 2-stores/route from an old trip into every new one, and a new shopping
 * never started clean. Saved PLACES (home/work/custom) stay global: they're
 * user-level addresses, not trip state.
 *
 * `scope` is the basket id. Omit it only for genuinely global contexts.
 */
const settingsKeyFor = (scope?: string | number | null): string =>
    scope == null ? SETTINGS_KEY : `location_settings_basket_${scope}`;

export async function getLocationSettings(scope?: string | number | null): Promise<LocationSettings> {
    try {
        const raw = await AsyncStorage.getItem(settingsKeyFor(scope));
        if (!raw) return DEFAULT_SETTINGS;
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
        return DEFAULT_SETTINGS;
    }
}

export async function saveLocationSettings(
    settings: Partial<LocationSettings>,
    scope?: string | number | null,
): Promise<void> {
    try {
        const current = await getLocationSettings(scope);
        await AsyncStorage.setItem(settingsKeyFor(scope), JSON.stringify({ ...current, ...settings }));
    } catch {
        // non-fatal
    }
}

// ---------------------------------------------------------------------------
// Visit history
// ---------------------------------------------------------------------------

export async function getVisitHistory(): Promise<StoreVisit[]> {
    try {
        const raw = await AsyncStorage.getItem(VISIT_HISTORY_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

/** Record a store visit (called after receipt upload completes with a confirmed storeId). */
export async function recordStoreVisit(
    storeId: number,
    lat: number,
    lng: number,
    chainId: number,
    chainName: string,
): Promise<void> {
    try {
        const history = await getVisitHistory();
        const existing = history.find(v => v.storeId === storeId);
        if (existing) {
            existing.visitCount += 1;
            existing.lastVisited = new Date().toISOString();
            existing.inferredContext = await inferContext(lat, lng);
        } else {
            history.push({
                storeId,
                lat,
                lng,
                chainId,
                chainName,
                visitCount: 1,
                lastVisited: new Date().toISOString(),
                inferredContext: await inferContext(lat, lng),
            });
        }
        await AsyncStorage.setItem(VISIT_HISTORY_KEY, JSON.stringify(history));
    } catch {
        // non-fatal
    }
}

/** Recompute inferredContext for all visits — called when presets change. */
async function recomputeVisitContexts(): Promise<void> {
    try {
        const [history, presets] = await Promise.all([getVisitHistory(), getPresets()]);
        if (!history.length) return;
        for (const visit of history) {
            visit.inferredContext = inferContextFromPresets(visit.lat, visit.lng, presets);
        }
        await AsyncStorage.setItem(VISIT_HISTORY_KEY, JSON.stringify(history));
    } catch {
        // non-fatal
    }
}

async function inferContext(lat: number, lng: number): Promise<StoreVisit['inferredContext']> {
    const presets = await getPresets();
    return inferContextFromPresets(lat, lng, presets);
}

function inferContextFromPresets(
    lat: number,
    lng: number,
    presets: Record<PresetKey, LocationPreset | null>,
): StoreVisit['inferredContext'] {
    const CONTEXT_RADIUS_KM = 1;
    for (const key of ['home', 'work', 'custom'] as PresetKey[]) {
        const p = presets[key];
        if (!p) continue;
        if (haversineKm(lat, lng, p.lat, p.lng) <= CONTEXT_RADIUS_KM) {
            return key as StoreVisit['inferredContext'];
        }
    }
    return 'unknown';
}

// ---------------------------------------------------------------------------
// Haversine helper (shared with candidatePool)
// ---------------------------------------------------------------------------

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg: number): number {
    return (deg * Math.PI) / 180;
}
