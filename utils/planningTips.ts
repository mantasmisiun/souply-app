import type { TripScore } from './tripsApi';

/**
 * Maps a trip's planning score into the three diverging bars + their per-category
 * tips shown in the Planavimas sheet. Pure (no i18n here) — returns i18n keys +
 * params so the component can `t()` them. The overall score is NOT surfaced here
 * (it already lives on the stats screen); this is the transparent per-category
 * breakdown of how that score was judged.
 *
 * Bar value is the factor (0..1) mapped to a signed −1..+1 for the diverging
 * render (0.5 = neutral → 0). `available: false` means the category couldn't be
 * judged (no list → coverage/discipline; no cross-store comparison → store) and
 * renders as a greyed "reikia plano" / "no comparison" bar instead of red.
 */
export type PlanningTone = 'good' | 'bad' | 'neutral' | 'na';

export interface PlanningBar {
    key: 'coverage' | 'discipline' | 'store';
    labelKey: string;
    /** Factor 0..1 (null when N/A). */
    value: number | null;
    available: boolean;
    /** Signed −1..+1 for the diverging bar (0 at the neutral 0.5 midpoint). */
    bar: number;
    tone: PlanningTone;
    tipKey: string;
    tipParams: Record<string, string | number>;
}

const signed = (v: number) => Math.max(-1, Math.min(1, (v - 0.5) * 2));
const toneOf = (available: boolean, v: number): PlanningTone =>
    !available ? 'na' : v >= 0.55 ? 'good' : v <= 0.45 ? 'bad' : 'neutral';

function coverageTip(c: number, f: number): string {
    if (c >= 1) return 'planningSheet.tip.cov.perfect';
    if (c >= 0.85) return f <= 1 ? 'planningSheet.tip.cov.almostOne' : 'planningSheet.tip.cov.almostFew';
    if (c >= 0.6) return 'planningSheet.tip.cov.most';
    if (c >= 0.3) return 'planningSheet.tip.cov.half';
    if (c > 0) return 'planningSheet.tip.cov.low';
    return 'planningSheet.tip.cov.none';
}

function disciplineTip(d: number, i: number): string {
    if (d >= 1) return 'planningSheet.tip.disc.perfect';
    if (d >= 0.85) return 'planningSheet.tip.disc.almost';
    if (d >= 0.6) return i <= 1 ? 'planningSheet.tip.disc.mostlyOne' : 'planningSheet.tip.disc.mostlyFew';
    if (d >= 0.4) return 'planningSheet.tip.disc.half';
    if (d >= 0.2) return 'planningSheet.tip.disc.lots';
    return 'planningSheet.tip.disc.mostlyUnplanned';
}

function storeTip(s: number): string {
    if (s >= 0.95) return 'planningSheet.tip.store.cheapest';
    if (s >= 0.8) return 'planningSheet.tip.store.good';
    if (s >= 0.5) return 'planningSheet.tip.store.ok';
    if (s >= 0.2) return 'planningSheet.tip.store.overpaid';
    return 'planningSheet.tip.store.priciest';
}

export function planningBars(s: TripScore): PlanningBar[] {
    const eur = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

    // Coverage
    const covAvail = s.hasList;
    const cov: PlanningBar = {
        key: 'coverage', labelKey: 'planningSheet.cat.coverage',
        value: covAvail ? s.coverage : null, available: covAvail,
        bar: covAvail ? signed(s.coverage) : 0,
        tone: toneOf(covAvail, s.coverage),
        tipKey: covAvail ? coverageTip(s.coverage, s.forgottenCount) : 'planningSheet.noList.coverage',
        tipParams: { f: s.forgottenCount },
    };

    // Discipline
    const discAvail = s.hasList;
    const disc: PlanningBar = {
        key: 'discipline', labelKey: 'planningSheet.cat.discipline',
        value: discAvail ? s.discipline : null, available: discAvail,
        bar: discAvail ? signed(s.discipline) : 0,
        tone: toneOf(discAvail, s.discipline),
        tipKey: discAvail ? disciplineTip(s.discipline, s.impulseCount) : 'planningSheet.noList.discipline',
        tipParams: { i: s.impulseCount, e: eur(s.impulseEur) },
    };

    // Store choice
    const storeAvail = s.storeChoice != null;
    const sc = s.storeChoice ?? 0;
    const store: PlanningBar = {
        key: 'store', labelKey: 'planningSheet.cat.store',
        value: storeAvail ? sc : null, available: storeAvail,
        bar: storeAvail ? signed(sc) : 0,
        tone: toneOf(storeAvail, sc),
        tipKey: storeAvail ? storeTip(sc) : 'planningSheet.noCompare',
        tipParams: { h: eur(s.storeHeadroomEur ?? 0) },
    };

    return [cov, disc, store];
}
