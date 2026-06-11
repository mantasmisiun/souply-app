import { ReceiptComparison } from '../../types/receipt-view';
import React, { useEffect, useMemo, useRef } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../constants/theme';
import { chainBrandColour } from '../../constants/chainBrandColours';
import { ChainLogoChip } from '../ChainLogoChip';
import { formatEuro, formatKm } from '../../utils/formatCurrency';
type Props = {
  comparison: ReceiptComparison | null;
  loading: boolean;
  error: string | null;
  summary?: {
    shopName?: string | null;
    shopAddress?: string | null;
    productCount?: number;
    receiptDate?: string | null;
    storeRecognized?: boolean;
  };
};

type Row = {
  chainId: number;
  chainName: string;
  storeId: number;
  storeName: string;
  storeAddress: string;
  /** Distance from the visited store in km. Missing on the visited row
   *  itself (handled in render). */
  distanceKm?: number;
  total: number;
  savings: number;
  note?: string;
  chainLogoUrl: string | null;
  isVisited: boolean;
};

/**
 * Stat thresholds for the B2 savings header. `SAVING_HIDE_BELOW`
 * suppresses microscopic deltas that would feel like noise rather than
 * insight (rounding artefacts when chains are effectively tied).
 */
const SAVING_HIDE_BELOW = 0.05;

export default function ReceiptComparisonSection({ comparison, loading, error, summary }: Props) {
  const colors = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const progress = useRef(new Animated.Value(0)).current;
  // Guards against the cache→fresh double-animation: `useReceiptComparison`
  // hands out the cached comparison synchronously and then revalidates in
  // the background, so `comparison` flips reference twice on every open
  // (cached object → server object), and without this guard each flip
  // would replay the 0→full entrance animation. We want the entrance to
  // play once per appearance; silent revalidations just snap the bars to
  // the new totals (the interpolated width recomputes naturally on render).
  const hasAnimatedRef = useRef(false);

  useEffect(() => {
    if (!comparison) {
      // Reset so the entrance animation plays again if the comparison
      // genuinely disappears and returns (e.g. retry after an error).
      hasAnimatedRef.current = false;
      return;
    }
    if (hasAnimatedRef.current) return;
    hasAnimatedRef.current = true;
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: 700,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [comparison, progress]);

  if (loading) {
    return (
      <View style={styles.sectionCard}>
        <View style={styles.brandStrip} />
        <View style={styles.sectionInner}>
          <View style={styles.loadingRow}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.sectionSubvalue}>{t('comparison.calculating')}</Text>
          </View>
        </View>
      </View>
    );
  }
  // No comparison yet (preview mode or pre-persist state). Shop info already
  // lives in the navbar — render nothing here until the comparison is loaded.
  if (!comparison) {
    return null;
  }

  const rows: Row[] = [
    {
      ...comparison.currentChain,
      savings: 0,
      note: undefined,
      isVisited: true,
    },
    ...comparison.alternatives.map((a) => ({ ...a, isVisited: false })),
  ].sort((a, b) => a.total - b.total);

  const cheapestTotal = rows.length ? rows[0].total : 0;
  const worstTotal = rows.length ? rows[rows.length - 1].total : 0;
  const visitedRow = rows.find((r) => r.isVisited) || null;
  const visitedIsCheapest = !!visitedRow && Math.abs(visitedRow.total - cheapestTotal) < 0.0001;
  const totals = rows.map((r) => r.total).filter((n) => Number.isFinite(n) && n >= 0);
  const maxTotal = totals.length ? Math.max(...totals) : 1;
  const animatedBarWidth = (total: number) => {
  const pct = Math.max(10, (total / Math.max(maxTotal, 1)) * 100);
    return progress.interpolate({
      inputRange: [0, 1],
      outputRange: ['0%', `${pct}%`],
    });
  };

  const productCount = summary?.productCount ?? comparison.summary.recognizedItems;
  const comparedCount = comparison.summary.recognizedItems;
  const totalCount = summary?.productCount ?? (
    comparison.summary.recognizedItems +
    comparison.summary.unrecognizedItems +
    comparison.summary.invalidItems
  );
  const hasUnrecognized = comparedCount < totalCount;
  void productCount; // surfaced via comparedCount/totalCount already

  const visitedTotal = visitedRow?.total ?? null;
  // If every row totals the same, there's nothing to celebrate or nudge
  // about — don't crown a winner, don't show deltas. The bars + totals
  // are enough; everything else would be noise.
  const anyPriceSpread = maxTotal - cheapestTotal > 0.005;

  // --- B2 savings stat ----------------------------------------------------
  //
  // Win:    visited shop IS cheapest. `delta = worst − visited` shows
  //         the most you avoided spending; positive feedback. Success colour.
  // Nudge:  visited shop is NOT cheapest. `delta = visited − cheapest`
  //         shows what you could've saved; primary colour.
  // Hidden: comparison is null OR no price spread OR delta < 0,05 €.
  //
  // The micro-delta cutoff (SAVING_HIDE_BELOW) keeps the stat from
  // boasting "0,01 € sutaupėte" — those are rounding artefacts, not
  // celebrations.
  const savingsStat = ((): { amount: string; label: string; colour: string } | null => {
    if (!anyPriceSpread || visitedTotal === null) return null;
    if (visitedIsCheapest) {
      const delta = worstTotal - visitedTotal;
      if (delta < SAVING_HIDE_BELOW) return null;
      return { amount: formatEuro(delta), label: t('comparison.saved'), colour: colors.success };
    }
    const delta = visitedTotal - cheapestTotal;
    if (delta < SAVING_HIDE_BELOW) return null;
    return { amount: formatEuro(delta), label: t('comparison.couldHaveSaved'), colour: colors.primary };
  })();

  // --- B1 brand strip -----------------------------------------------------
  const visitedChainId = comparison.currentChain?.chainId ?? null;
  const stripColour = chainBrandColour(visitedChainId, colors.primary);

  return (
    <View style={styles.sectionCard}>
      <View style={[styles.brandStrip, { backgroundColor: stripColour }]} />
      <View style={styles.sectionInner}>
      <View style={styles.sectionHeader}>
        <Ionicons name="analytics-outline" size={20} color={colors.primary} />
        <Text style={styles.sectionTitle}>
          {t('comparison.title', { compared: comparedCount, total: totalCount })}
        </Text>
        {hasUnrecognized && (
          <Ionicons name="alert-circle" size={18} color={colors.warning} />
        )}
      </View>

      {!!savingsStat && (
        <View style={styles.savingsStatWrap}>
          <Text style={[styles.savingsStatValue, { color: savingsStat.colour }]}>
            {savingsStat.amount}
          </Text>
          <Text style={styles.savingsStatLabel}>{savingsStat.label}</Text>
        </View>
      )}

      {rows.map((row) => {
        // Only label/style a row as the winner when there's an actual spread;
        // if everyone's tied, no row is "the" cheapest.
        const isCheapest =
          anyPriceSpread && Math.abs(row.total - cheapestTotal) < 0.0001;
        const visitedNotCheapest = row.isVisited && !isCheapest;
        const delta =
          anyPriceSpread && visitedTotal !== null ? row.total - visitedTotal : 0;
        const showDeltaSave = !row.isVisited && delta < -0.005;
        const showDeltaSpend = !row.isVisited && delta > 0.005;

        // Gradient: cheapest is teal (success), most expensive is beet (primary).
        const span = Math.max(maxTotal - cheapestTotal, 0.01);
        const position = (row.total - cheapestTotal) / span;
        const fillColor = lerpColor(colors.success, colors.primary, position);

        return (
          <View
            key={`${row.chainId}-${row.storeId}`}
            style={[
              styles.rowWrap,
              isCheapest && styles.rowWinner,
              visitedNotCheapest && styles.rowVisited,
            ]}
          >
            <View style={styles.rowHeader}>
              <View style={styles.storeInfo}>
                {/* Canonical baked chain badge (chip_N) — pixel-identical to the
                    chips on the map, shopping list, and every other surface. */}
                <ChainLogoChip
                  chainId={row.chainId}
                  name={row.chainName}
                  size={32}
                  logoUrl={row.chainLogoUrl}
                />

                <View style={{ flex: 1 }}>
                  <View style={styles.storeTitleRow}>
                    <Text style={styles.storeLabel}>{row.storeName}</Text>
                    {isCheapest && (
                      <View style={styles.winnerChip}>
                        <Ionicons name="trophy" size={11} color={colors.onPrimary} />
                        <Text style={styles.winnerChipText}>Pigiausia</Text>
                      </View>
                    )}
                    {row.isVisited && !isCheapest && (
                      <View style={styles.visitedBadgeInline}>
                        <Text style={styles.visitedBadgeText}>{t('comparison.youShopped')}</Text>
                      </View>
                    )}
                  </View>
                  {!!row.storeAddress && (
                    <Text style={styles.storeAddressLine}>{row.storeAddress}</Text>
                  )}
                  {/* B2.5: distance line. Visited row prints "(jūsų
                      parduotuvė)" instead of "0 km" — feels more like a
                      label than a number. Alternatives print "1,2 km"
                      or "12 km" via formatKm; the cluster-fallback case
                      naturally surfaces here as a larger number. */}
                  {row.isVisited ? (
                    <Text style={styles.storeDistanceLine}>{t('comparison.yourStore')}</Text>
                  ) : typeof row.distanceKm === 'number' ? (
                    <Text style={styles.storeDistanceLine}>{formatKm(row.distanceKm)}</Text>
                  ) : null}
                </View>
              </View>

              <View style={styles.priceColumn}>
                <Text style={styles.totalText}>{formatEuro(row.total)}</Text>
                {showDeltaSave && (
                  <Text style={styles.deltaSave}>
                    −{formatEuro(Math.abs(delta))}
                  </Text>
                )}
                {showDeltaSpend && (
                  <Text style={styles.deltaSpend}>
                    +{formatEuro(delta)}
                  </Text>
                )}
                {row.isVisited && isCheapest && (
                  <Text style={styles.deltaNeutral}>{t('comparison.boughtHere')}</Text>
                )}
              </View>
            </View>

            <View style={styles.compareBarTrack}>
              <Animated.View
                style={[
                  styles.compareBarFill,
                  { width: animatedBarWidth(row.total), backgroundColor: fillColor },
                ]}
              />
            </View>
          </View>
        );
      })}
      </View>
    </View>
  );
}

/** Lerp between two hex colours. `t` is clamped to [0, 1]. */
function lerpColor(hex1: string, hex2: string, t: number): string {
  const clamp = Math.max(0, Math.min(1, t));
  const parse = (h: string) => {
    const s = h.replace('#', '');
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  };
  const [r1, g1, b1] = parse(hex1);
  const [r2, g2, b2] = parse(hex2);
  const r = Math.round(r1 + (r2 - r1) * clamp);
  const g = Math.round(g1 + (g2 - g1) * clamp);
  const b = Math.round(b1 + (b2 - b1) * clamp);
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
  // B1 hero card: same horizontal margin + shadow as before, but the inner
  // padding moves to sectionInner so the brand strip can run edge-to-edge
  // along the top.
  sectionCard: {
    backgroundColor: c.cardBackground,
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 12,
    overflow: 'hidden',
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
  },
  sectionInner: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 24,
  },
  brandStrip: {
    height: 4,
    width: '100%',
    backgroundColor: c.borderSubtle, // overridden by the actual brand colour
  },

  rowWrap: {
    gap: 8,
    backgroundColor: c.cardBackground,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: c.borderSubtle,
    marginTop: 10,
  },
  rowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 10,
  },
  storeInfo: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    flex: 1,
    gap: 10,
    paddingRight: 8,
  },
  compareBarTrack: {
    marginTop: 2,
    height: 18,
    borderRadius: 999,
    backgroundColor: c.border,
    overflow: 'hidden',
    width: '100%',
  },
  // B1 typography bump: 14 → 16 pt 600 weight. The bar's totals are the
  // numbers users compare, so they deserve to read as the loudest figure
  // in the row, just under the savings stat.
  totalText: {
    fontSize: 16,
    fontWeight: '600',
    color: c.textPrimary,
    minWidth: 72,
    textAlign: 'right',
  },

  // B2 savings stat
  savingsStatWrap: {
    alignItems: 'center',
    paddingVertical: 14,
  },
  savingsStatValue: {
    fontSize: 32,
    fontWeight: '600',
    color: c.textPrimary, // overridden per-state to success or primary
  },
  savingsStatLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: c.textMuted,
    letterSpacing: 0.5,
    marginTop: 6,
    textTransform: 'uppercase',
  },

  // Match receipt-process.tsx's own section styling exactly so this card
  // sits among the others without an odd border or a larger heading.
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: c.textPrimary },
  sectionSubvalue: { fontSize: 13, color: c.textSecondary, marginTop: 6 },
  warningText: { fontSize: 12, color: c.warning, marginTop: 6 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },


  storeLabel: { fontSize: 13, color: c.textPrimary, fontWeight: '600' },

  visitedBadge: {
    alignSelf: 'flex-start',
    marginTop: 4,
    backgroundColor: c.surfaceMuted,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  visitedBadgeText: { fontSize: 10, fontWeight: '700', color: c.textPrimary },
  compareBarFill: {
    height: '100%',
    borderRadius: 999,
  },

  storeAddressLine: {
    fontSize: 11,
    color: c.textSecondary,
    marginTop: 2,
  },
  storeDistanceLine: {
    fontSize: 11,
    color: c.textMuted,
    marginTop: 1,
  },

  storeTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  visitedBadgeInline: {
    backgroundColor: c.surfaceMuted,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },

  // Cheapest row stands out with a soft tint + accent border (existing).
  rowWinner: {
    backgroundColor: c.successMuted,
    borderColor: c.success,
  },
  // B1: visited row tint (when NOT cheapest). Lighter than the winner
  // tint so the two states are pre-attentively distinguishable —
  // success-green = cheapest, soft-pink = your row.
  rowVisited: {
    backgroundColor: c.softAccentWash,
    borderColor: c.softAccent,
  },

  // "Pigiausia" chip — trophy + label on the cheapest row.
  winnerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: c.success,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  winnerChipText: {
    fontSize: 10,
    fontWeight: '700',
    color: c.onSuccess,
    letterSpacing: 0.4,
  },

  // Right-aligned column holding total + delta under it.
  priceColumn: { alignItems: 'flex-end', minWidth: 82 },
  deltaSave:    { marginTop: 2, fontSize: 12, fontWeight: '700', color: c.success },
  deltaSpend:   { marginTop: 2, fontSize: 12, fontWeight: '500', color: c.textMuted },
  deltaNeutral: { marginTop: 2, fontSize: 11, fontStyle: 'italic', color: c.textMuted },
});
