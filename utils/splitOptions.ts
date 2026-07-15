import { type ScoredCombo } from './splitBasketScore';
import { type StoreResult } from './basketPricing';
import { haversineKm } from './locationStorage';

/**
 * Pure helpers that turn scored combos + priced stores into the ranked option
 * list the results bottom-sheet shows for a tapped store. Extracted from the
 * screen so the ranking/guard logic is unit-testable.
 */
export type SheetOption = {
    key: string;
    storeIds: number[];
    stores: StoreResult[];
    combo: ScoredCombo | null; // null = single-store option
    total: number;
    saving: number;
    /** Extra travel a SPLIT adds over the single-store option: route through its
     *  stores − the single store's distance. null for the single-store option. */
    detourKm: number | null;
};

/** One-shopping-trip radius. Combos whose extra travel exceeds this are not
 *  offered — prevents absurd cross-city "splits" (e.g. a store in Šiauliai
 *  paired with one in Vilnius when results were computed around Šiauliai). */
export const TRIP_RADIUS_KM = 10;
/** Max distinct split options shown per store (plus the single baseline). */
const MAX_OPTIONS = 4;

export const comboKey = (storeIds: number[]) => [...storeIds].sort((a, b) => a - b).join('-');

/**
 * Baseline for the "Sutaupote €X" figure: the average total of FULL-COVERAGE
 * single stores (falls back to all stores, then null). We compare a split
 * against the average single trip — not the theoretical cheapest store — so the
 * saving reflects "you're not overpaying at a random shop" and reads as a real
 * win. The goal is to validate the user's decision to split, not to benchmark
 * against the optimum.
 */
export function savingBaseline(stores: StoreResult[]): number | null {
    const full = stores.filter(r => r.missingItemNames.length === 0).map(r => r.total);
    const pool = full.length ? full : stores.map(r => r.total);
    if (!pool.length) return null;
    return pool.reduce((s, v) => s + v, 0) / pool.length;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Extra distance a split adds over just visiting the single-store option:
 * route(loc → nearest split store → next…) − (loc → single store). The first leg
 * uses each store's radial distance from the search centre; inter-store legs use
 * straight-line (haversine) between coords, falling back to radial when a store
 * has no coordinates. Communicates "how much more driving for the saving".
 */
function routeDetourKm(stores: StoreResult[], singleDistance: number | null): number | null {
    if (singleDistance == null || stores.length < 2) return null;
    const ordered = [...stores].sort((a, b) => a.distance - b.distance);
    let route = ordered[0].distance; // loc → nearest split store (radial)
    for (let i = 1; i < ordered.length; i++) {
        const prev = ordered[i - 1], cur = ordered[i];
        route += (prev.latitude != null && prev.longitude != null && cur.latitude != null && cur.longitude != null)
            ? haversineKm(prev.latitude, prev.longitude, cur.latitude, cur.longitude)
            : cur.distance; // no coords → radial fallback
    }
    return Math.max(0, round2(route - singleDistance));
}

/**
 * Ranked options for a tapped store: the splits it belongs to (best→worst,
 * capped) plus its single-store baseline last.
 *
 * - Splits surface regardless of the old €/km viability gate (if the user chose
 *   to shop 2-3 stores, we validate that) — but bounded by `tripRadiusKm` so a
 *   cross-city pairing is never offered.
 * - `saving` is vs the average full-coverage store, floored at 0, so it feels
 *   right rather than tiny/negative.
 * - Combo store-ids are resolved back to the rich StoreResult objects (combos
 *   carry a lighter shape) so the sheet + list creation keep full item data.
 */
export function buildSplitOptions(
    combos: ScoredCombo[],
    results: StoreResult[],
    lazyResults: StoreResult[],
    storeId: number,
    opts: { tripRadiusKm?: number } = {},
): SheetOption[] {
    const tripRadiusKm = opts.tripRadiusKm ?? TRIP_RADIUS_KM;

    const richById = new Map<number, StoreResult>();
    for (const r of results) richById.set(r.storeId, r);
    for (const r of lazyResults) if (!richById.has(r.storeId)) richById.set(r.storeId, r);

    // Saving is measured against the SINGLE-store option shown in this same sheet
    // (the tapped store's own total) — "is a 2nd/3rd shop actually cheaper than
    // just this one?". The old average-baseline made a split claim a saving even
    // when the 1-store option had the identical total; now an equal split = €0 =
    // no saving label.
    const single = richById.get(storeId) ?? null;
    const singleTotal = single?.total ?? null;
    const singleDistance = single?.distance ?? null;
    const displaySaving = (total: number) =>
        singleTotal != null ? Math.max(0, round2(singleTotal - total)) : 0;

    const toMulti = (c: ScoredCombo): SheetOption | null => {
        const stores = c.storeIds.map(id => richById.get(id)).filter((s): s is StoreResult => !!s);
        if (stores.length !== c.storeIds.length) return null; // missing rich data
        return {
            key: comboKey(c.storeIds),
            storeIds: c.storeIds,
            stores,
            combo: c,
            total: c.splitTotal,
            saving: displaySaving(c.splitTotal),
            detourKm: routeDetourKm(stores, singleDistance),
        };
    };

    const matching = combos.filter(c => c.storeIds.includes(storeId)); // pre-sorted: viable, then saving
    // Collapse repetitive "same offer" splits: a Maxima+Rimi split at €X is the
    // same deal regardless of WHICH physical Maxima/Rimi, so keyed by chain set
    // + total we keep only the CLOSEST variant (least extra travel) and drop the
    // further duplicates. First-seen order is preserved (combos are pre-ranked).
    const bestByOffer = new Map<string, ScoredCombo>();
    const offerOrder: string[] = [];
    for (const c of matching) {
        if (c.stores.length <= 1) continue;
        if (c.extraDistanceKm > tripRadiusKm) continue; // one-trip cap (replaces the viability gate)
        const chainSig = [...new Set(c.stores.map(s => s.chainId))].sort((a, b) => a - b).join('-');
        const key = `${chainSig}|${Math.round(c.splitTotal * 100)}`;
        const prev = bestByOffer.get(key);
        if (!prev) { bestByOffer.set(key, c); offerOrder.push(key); }
        else if (c.extraDistanceKm < prev.extraDistanceKm) bestByOffer.set(key, c);
    }
    const multis: SheetOption[] = [];
    const seenKeys = new Set<string>();
    for (const key of offerOrder) {
        const opt = toMulti(bestByOffer.get(key)!);
        // Two offers (same stores, different totals) resolve to the SAME store
        // set → same `key` (comboKey). Dedupe so the sheet never renders two
        // cards sharing one key — that made BOTH highlight and made a tap on the
        // second resolve to the first ("tap does nothing"). First-seen wins
        // (combos are pre-ranked best→worst).
        if (opt && !seenKeys.has(opt.key)) {
            seenKeys.add(opt.key);
            multis.push(opt);
        }
        if (multis.length >= MAX_OPTIONS) break;
    }

    const out = [...multis];
    const sr = richById.get(storeId);
    if (sr) {
        out.push({ key: `s-${storeId}`, storeIds: [storeId], stores: [sr], combo: null, total: sr.total, saving: 0, detourKm: null });
    }
    return out;
}

/**
 * The best split to auto-surface when the user chose 2-3 stores: the top-ranked
 * multi-store combo within the trip radius, returned as a ready SheetOption (so
 * its saving/stores match what the sheet would show). Null if none qualifies.
 */
export function bestSplitOption(
    combos: ScoredCombo[],
    results: StoreResult[],
    lazyResults: StoreResult[],
    opts: { tripRadiusKm?: number } = {},
): SheetOption | null {
    const tripRadiusKm = opts.tripRadiusKm ?? TRIP_RADIUS_KM;
    const top = combos.find(c => c.stores.length > 1 && c.extraDistanceKm <= tripRadiusKm);
    if (!top) return null;
    const anchored = buildSplitOptions(combos, results, lazyResults, top.storeIds[0], { tripRadiusKm });
    return anchored.find(o => o.key === comboKey(top.storeIds)) ?? null;
}
