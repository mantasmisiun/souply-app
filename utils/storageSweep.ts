import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * TTL/size sweep for the per-id AsyncStorage key families that grow forever:
 *
 *   · comparison_v2_*      — one blob per scanned receipt (useReceiptComparison)
 *   · basket_results_*     — one results blob per basket (basketCalc)
 *   · basket_calc_meta_*   — written alongside basket_results_*
 *   · split_lists_*        — split-trip list map per basket (StoreResultsSurface)
 *
 * Nothing GC'd these before, and the shopping-list screen paid for the growth
 * with a full `getAllKeys()` scan on every fetch. The scan now lives ONLY
 * here, and this runs at most once per app session, deferred off the hot path.
 *
 * None of the values carry a timestamp, so age is tracked in a ledger key:
 * first time a key is seen it's stamped `now`; once its stamp passes the
 * family's TTL the key (and its ledger entry) is deleted. Ledger entries for
 * keys that no longer exist are pruned. Size cap: if a family still exceeds
 * its cap after the TTL pass, the oldest-stamped keys are deleted first.
 *
 * TTLs are deliberately generous — this is a floor-sweep, not a cache policy:
 *   · comparisons/results/meta: 45 days (stale after any real price movement);
 *   · split_lists: 180 days (a split map for a trip that old is long finished,
 *     and the group card only renders while its lists still exist server-side).
 */

const LEDGER_KEY = 'storage_sweep_ledger_v1';
const DAY_MS = 24 * 60 * 60 * 1000;

interface FamilyRule { prefix: string; ttlMs: number; maxKeys: number }

const FAMILIES: FamilyRule[] = [
    { prefix: 'comparison_v2_', ttlMs: 45 * DAY_MS, maxKeys: 60 },
    { prefix: 'basket_results_', ttlMs: 45 * DAY_MS, maxKeys: 30 },
    { prefix: 'basket_calc_meta_', ttlMs: 45 * DAY_MS, maxKeys: 30 },
    { prefix: 'split_lists_', ttlMs: 180 * DAY_MS, maxKeys: 60 },
];

let sweepStartedThisSession = false;

/** Exposed for tests. */
export const _resetSweepSessionFlag = () => { sweepStartedThisSession = false; };

export async function sweepStorageFamilies(now: number = Date.now()): Promise<void> {
    let ledger: Record<string, number> = {};
    try {
        const raw = await AsyncStorage.getItem(LEDGER_KEY);
        if (raw) ledger = JSON.parse(raw) ?? {};
    } catch { ledger = {}; }

    let allKeys: readonly string[] = [];
    try { allKeys = await AsyncStorage.getAllKeys(); } catch { return; }

    const toRemove: string[] = [];
    const nextLedger: Record<string, number> = {};

    for (const rule of FAMILIES) {
        const familyKeys = allKeys.filter(k => k.startsWith(rule.prefix));
        const stamped = familyKeys.map(k => ({ key: k, seenAt: ledger[k] ?? now }));

        const kept: { key: string; seenAt: number }[] = [];
        for (const entry of stamped) {
            if (now - entry.seenAt > rule.ttlMs) toRemove.push(entry.key);
            else kept.push(entry);
        }
        // Size cap: oldest-stamped beyond the cap go too.
        if (kept.length > rule.maxKeys) {
            kept.sort((a, b) => a.seenAt - b.seenAt);
            const excess = kept.splice(0, kept.length - rule.maxKeys);
            for (const e of excess) toRemove.push(e.key);
        }
        for (const e of kept) nextLedger[e.key] = e.seenAt;
    }

    try {
        if (toRemove.length > 0) await AsyncStorage.multiRemove(toRemove);
        await AsyncStorage.setItem(LEDGER_KEY, JSON.stringify(nextLedger));
    } catch { /* best-effort — next session sweeps again */ }
}

/**
 * Once-per-session, deferred trigger. Call from any screen on the affected
 * paths; the delay keeps the (single) getAllKeys scan away from first paint
 * and interaction.
 */
export function scheduleStorageSweep(delayMs = 4000): void {
    if (sweepStartedThisSession) return;
    sweepStartedThisSession = true;
    setTimeout(() => { void sweepStorageFamilies(); }, delayMs);
}
