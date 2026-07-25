import { tryGpsCoords } from './location';
import type { TripSummary, TripSlot } from './tripsApi';

/**
 * ONE screen per trip stage (simplified-flow rework): the trip card — and the
 * /trip/[id] redirector — resolve a trip to the single screen that matters
 * right now. Earlier stages become unreachable history by construction.
 *
 *   1 forming        → basket detail (edit items, "Find stores")
 *   2 compared       → the store-comparison map (results surface route)
 *   3 shopping       → the CLOSEST UNFINISHED store's list (store tabs inside)
 *   4 need receipt   → the final screen, Receipt tab
 *   5 done           → the final screen, Stats tab
 * (Stages 4 and 5 share ONE two-tab screen — Kvitai / Statistika.)
 */
export async function tripStageHref(trip: TripSummary): Promise<string> {
    if (trip.stage <= 1 && trip.basket) return `/basket/${trip.basket.id}`;
    if (trip.stage === 2 && trip.basket) return `/basket/results/${trip.basket.id}`;
    if (trip.stage === 3 && trip.slots.length > 0) {
        const open = trip.slots.filter(s => s.listStatus === 'active');
        const pool = open.length > 0 ? open : trip.slots;
        let pick = pool[0];
        if (pool.length > 1) {
            const gps = await tryGpsCoords().catch(() => null);
            if (gps) {
                const d = (s: TripSlot) => (s.latitude != null && s.longitude != null)
                    ? (s.latitude - gps.lat) ** 2 + (s.longitude - gps.lng) ** 2
                    : Number.POSITIVE_INFINITY;
                pick = [...pool].sort((a, b) => d(a) - d(b))[0];
            }
        }
        if (pick) return `/shopping-list/${pick.listId}?tripId=${trip.id}`;
    }
    // Stage 4's whole job is "hand in the receipt", so land with the capture
    // sheet already up (Fotografuoti / Įkelti) instead of making the user find
    // the upload button on a screen that exists only for that one action.
    if (trip.stage === 4) return `/trip/receipts/${trip.id}?upload=1`;
    return `/trip/receipts/${trip.id}?tab=stats`;
}
