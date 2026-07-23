import type { TripComparison } from './tripsApi';

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
