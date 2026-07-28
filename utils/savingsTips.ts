import type { TripComparison, TripBasketComparison } from './tripsApi';
import { chainBrandName, chainNameById } from './chainBrandName';

/** The single tip under the savings sheet — picks the i18n key + params by where
 *  your store landed among the compared stores. Pure (component does the t()). */
export interface SavingsTip {
    key: string;
    params: Record<string, string | number>;
}

const eur = (n: number) => (Math.round(Math.abs(n) * 100) / 100).toFixed(2);

/** Tips are anchored to the CHEAPEST (top) bar — where the eye lands and the one
 *  actionable reference. All the "vs cheapest" numbers are the headroom (what you
 *  paid over the best), and name the store to beat. */
export function savingsTip(c: TripComparison): SavingsTip {
    const store = c.cheaperStoreName ?? '';
    const headroom = eur(c.headroom);
    if (c.equalPrices) return { key: 'savingsSheet.tip.equal', params: {} };
    if (c.headroom < 0.005) return { key: 'savingsSheet.tip.cheapest', params: {} };
    const maxTotal = c.stores.length ? c.stores[c.stores.length - 1].total : c.yoursTotal;
    if (c.yoursTotal >= maxTotal - 0.005) return { key: 'savingsSheet.tip.worst', params: { headroom, store } };
    if (c.headroom < 1) return { key: 'savingsSheet.tip.near', params: { headroom, store } };
    return { key: 'savingsSheet.tip.overpaid', params: { headroom, store } };
}

/**
 * The same tip, from the TRIP-level comparison. Your total is what you actually
 * paid (across every store of the trip) and the reference is the cheapest single
 * shop — so on a one-store trip this reads exactly as it always did, and on a
 * split trip it answers "was one shop cheaper?" without inventing a second scale.
 */
export function tripSavingsTip(c: TripBasketComparison): SavingsTip {
    const cheapest = c.candidates[0];
    if (!cheapest) return { key: 'savingsSheet.tip.equal', params: {} };
    const headroom = c.paidTotal - cheapest.total;
    // The BRAND, not the legal entity: "Maxima" reads like a shop, "MAXIMA LT,
    // UAB" reads like a contract.
    const store = chainNameById(cheapest.chainId) ?? chainBrandName(cheapest.chainName ?? '');
    if (headroom < 0.005) return { key: 'savingsSheet.tip.cheapest', params: {} };
    const maxTotal = c.candidates[c.candidates.length - 1]?.total ?? c.paidTotal;
    if (c.paidTotal >= maxTotal - 0.005) return { key: 'savingsSheet.tip.worst', params: { headroom: eur(headroom), store } };
    if (headroom < 1) return { key: 'savingsSheet.tip.near', params: { headroom: eur(headroom), store } };
    return { key: 'savingsSheet.tip.overpaid', params: { headroom: eur(headroom), store } };
}
