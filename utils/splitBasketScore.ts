// ---------------------------------------------------------------------------
// Types (mirror the shapes from the results screen)
// ---------------------------------------------------------------------------

export interface ItemResult {
    productId: number;
    totalPrice: number | null;
    isMissing: boolean;
}

export interface StoreResult {
    storeId: number;
    storeName: string;
    chainName: string;
    chainId: number;
    chainLogoUrl: string | null;
    chainMiniLogoUrl?: string | null;
    storeAddress: string;
    latitude: number | null;
    longitude: number | null;
    distance: number;   // km from search center
    total: number;
    isApproximated: boolean;
    missingItemNames: string[];
    items: ItemResult[];
}

export interface ScoredCombo {
    storeIds: number[];
    stores: StoreResult[];
    splitTotal: number;
    singleStoreBestTotal: number;
    saving: number;
    extraDistanceKm: number;
    eurosPerKm: number | null;
    isViable: boolean;
    hasMissingCritical: boolean;
    itemAssignments: Record<number, number>; // productId → storeId
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const MIN_SAVING_EUROS = 1.5;
const MIN_EUROS_PER_KM = 5;

// ---------------------------------------------------------------------------
// Combination generator
// ---------------------------------------------------------------------------

function combinations<T>(arr: T[], k: number): T[][] {
    if (k === 0) return [[]];
    if (k > arr.length) return [];
    const [first, ...rest] = arr;
    const withFirst = combinations(rest, k - 1).map(c => [first, ...c]);
    const withoutFirst = combinations(rest, k);
    return [...withFirst, ...withoutFirst];
}

// ---------------------------------------------------------------------------
// Scoring logic
// ---------------------------------------------------------------------------

/**
 * Given a set of stores (from the calculate API) and a set of critical
 * productIds (from the basket-items API), returns scored split combinations
 * for all store counts from 1 up to maxStoreCount, sorted best savings first.
 *
 * Only combinations that meet the viability thresholds are marked isViable.
 * All combinations are returned so the caller can show "more" options.
 */
export function scoreAllCombinations(
    stores: StoreResult[],
    criticalProductIds: Set<number>,
    maxStoreCount: 1 | 2 | 3,
): ScoredCombo[] {
    if (stores.length === 0) return [];

    // Build price matrix: productId → storeId → totalPrice
    const priceMatrix = new Map<number, Map<number, number | null>>();
    for (const store of stores) {
        for (const item of store.items) {
            if (!priceMatrix.has(item.productId)) {
                priceMatrix.set(item.productId, new Map());
            }
            priceMatrix.get(item.productId)!.set(
                store.storeId,
                item.isMissing ? null : item.totalPrice,
            );
        }
    }

    const allProductIds = [...priceMatrix.keys()];
    const nearestStoreDistance = Math.min(...stores.map(s => s.distance));
    const bestSingleTotal = Math.min(...stores.map(s => s.total));

    const results: ScoredCombo[] = [];

    for (let k = 1; k <= maxStoreCount; k++) {
        const combos = combinations(stores, k);
        for (const combo of combos) {
            const comboStoreIds = combo.map(s => s.storeId);
            const comboStoreIdSet = new Set(comboStoreIds);

            let splitTotal = 0;
            let hasMissingCritical = false;
            const itemAssignments: Record<number, number> = {};

            for (const productId of allProductIds) {
                const prices = priceMatrix.get(productId)!;
                let bestPrice: number | null = null;
                let bestStore: number | null = null;

                for (const storeId of comboStoreIds) {
                    const p = prices.get(storeId) ?? null;
                    if (p !== null && (bestPrice === null || p < bestPrice)) {
                        bestPrice = p;
                        bestStore = storeId;
                    }
                }

                if (bestPrice === null) {
                    // Item not available in this combo
                    if (criticalProductIds.has(productId)) {
                        hasMissingCritical = true;
                    }
                } else {
                    splitTotal += bestPrice;
                    itemAssignments[productId] = bestStore!;
                }
            }

            // Skip combos where any store ends up with 0 assigned items —
            // that store would be visited for nothing, making it a degenerate split.
            if (k > 1) {
                const assignedStores = new Set(Object.values(itemAssignments));
                if (comboStoreIds.some(sid => !assignedStores.has(sid))) continue;
            }

            const saving = bestSingleTotal - splitTotal;

            // Extra distance: sum of store distances - nearest store distance
            // (proxy for additional travel to multi-store trip)
            const comboTotalDist = combo.reduce((s, st) => s + st.distance, 0);
            const extraDistanceKm = Math.max(0, comboTotalDist - nearestStoreDistance);

            let eurosPerKm: number | null = null;
            if (extraDistanceKm > 0.01) {
                eurosPerKm = saving / extraDistanceKm;
            } else if (k === 1) {
                // Single store — distance is just the one store, no "extra"
                eurosPerKm = null;
            } else {
                eurosPerKm = Infinity; // stores are co-located, any saving is free
            }

            const isViable =
                saving >= MIN_SAVING_EUROS &&
                (eurosPerKm === null || eurosPerKm === Infinity || eurosPerKm >= MIN_EUROS_PER_KM);

            results.push({
                storeIds: comboStoreIds,
                stores: combo,
                splitTotal,
                singleStoreBestTotal: bestSingleTotal,
                saving,
                extraDistanceKm,
                eurosPerKm,
                isViable,
                hasMissingCritical,
                itemAssignments,
            });
        }
    }

    // Sort: viable first, then by saving descending
    return results.sort((a, b) => {
        if (a.isViable !== b.isViable) return a.isViable ? -1 : 1;
        return b.saving - a.saving;
    });
}
