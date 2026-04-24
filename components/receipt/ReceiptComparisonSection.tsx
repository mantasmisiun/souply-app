import { ReceiptComparison } from '../../types/receipt-view';
import React, { useEffect, useMemo, useRef } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Image, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, type AppTheme } from '../../constants/theme';
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
  total: number;
  savings: number;
  note?: string;
  chainLogoUrl: string | null;
  isVisited: boolean;
};

const getInitials = (value?: string) => {
  if (!value) return '';
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('');
};

export default function ReceiptComparisonSection({ comparison, loading, error, summary }: Props) {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!comparison) return;
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
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.sectionSubvalue}>Skaičiuojama...</Text>
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

  const shopName =
    summary?.shopName ||
    `${comparison.currentChain.chainName}${comparison.currentChain.storeName ? ` • ${comparison.currentChain.storeName}` : ''}`;

  const shopAddress = summary?.shopAddress || comparison.currentChain.storeAddress || null;
  const productCount = summary?.productCount ?? comparison.summary.recognizedItems;
  const receiptDate = summary?.receiptDate || null;
  const comparedCount = comparison.summary.recognizedItems;
  const totalCount = summary?.productCount ?? (
    comparison.summary.recognizedItems +
    comparison.summary.unrecognizedItems +
    comparison.summary.invalidItems
  );
  const hasUnrecognized = comparedCount < totalCount;
  const formattedDate = (() => {
    if (!receiptDate) return null;
    const raw = String(receiptDate).trim();
    const dateOnly = raw.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? raw;
    const d = new Date(dateOnly);
    if (Number.isNaN(d.getTime())) return dateOnly;
    return d.toLocaleDateString('lt-LT');
  })();

  // Shop name + address + date moved to the screen's navbar.
  void shopName;
  void shopAddress;
  void formattedDate;

  const visitedTotal = visitedRow?.total ?? null;
  // If every row totals the same, there's nothing to celebrate or nudge
  // about — don't crown a winner, don't show deltas, don't print a prose
  // summary. The bars + totals are enough; everything else would be noise.
  const anyPriceSpread = maxTotal - cheapestTotal > 0.005;
  const bestSaving =
    visitedTotal !== null ? visitedTotal - cheapestTotal : 0;
  // Show the prose summary ONLY when the visited shop is NOT the cheapest.
  // "You could have saved X" is useful; telling someone who already picked
  // the best option that they saved vs the worst is noise — the bars +
  // totals already show that visually.
  const summaryMessage =
    !anyPriceSpread || visitedTotal === null || visitedIsCheapest
      ? null
      : `Galėjote sutaupyti ${bestSaving.toFixed(2)} € pirkdami pigiausioje parduotuvėje`;

  return (
    <View style={styles.sectionCard}>
      <View style={styles.sectionHeader}>
        <Ionicons name="analytics-outline" size={20} color={colors.primary} />
        <Text style={styles.sectionTitle}>
          Apsipirkimo analizė ({comparedCount}/{totalCount})
        </Text>
        {hasUnrecognized && (
          <Ionicons name="alert-circle" size={18} color={colors.warning} />
        )}
      </View>
      {!!summaryMessage && (
        <Text
          style={[
            styles.summaryLine,
            visitedIsCheapest ? styles.summaryWin : styles.summaryNudge,
          ]}
        >
          {summaryMessage}
        </Text>
      )}
      {rows.map((row) => {
        // Only label/style a row as the winner when there's an actual spread;
        // if everyone's tied, no row is "the" cheapest.
        const isCheapest =
          anyPriceSpread && Math.abs(row.total - cheapestTotal) < 0.0001;
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
            style={[styles.rowWrap, isCheapest && styles.rowWinner]}
          >
            <View style={styles.rowHeader}>
              <View style={styles.storeInfo}>
                {row.chainLogoUrl ? (
                  <Image source={{ uri: row.chainLogoUrl }} style={styles.logo} resizeMode="contain" />
                ) : (
                  <View style={styles.logoFallback}>
                    <Text style={styles.logoFallbackText}>{getInitials(row.storeName || row.chainName)}</Text>
                  </View>
                )}

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
                        <Text style={styles.visitedBadgeText}>Jūs pirkote</Text>
                      </View>
                    )}
                  </View>
                  {!!row.storeAddress && <Text style={styles.storeAddressLine}>{row.storeAddress}</Text>}
                </View>
              </View>

              <View style={styles.priceColumn}>
                <Text style={styles.totalText}>{row.total.toFixed(2)} €</Text>
                {showDeltaSave && (
                  <Text style={styles.deltaSave}>
                    −{Math.abs(delta).toFixed(2)} €
                  </Text>
                )}
                {showDeltaSpend && (
                  <Text style={styles.deltaSpend}>
                    +{delta.toFixed(2)} €
                  </Text>
                )}
                {row.isVisited && isCheapest && (
                  <Text style={styles.deltaNeutral}>pirkote čia</Text>
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
  barsWrap: {
    marginTop: 14,
    gap: 12,
  },
  rowWrap: {
    gap: 8,
    backgroundColor: c.cardBackground,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: c.borderSubtle,
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
  totalText: {
    fontSize: 14,
    fontWeight: '700',
    color: c.textPrimary,
    minWidth: 72,
    textAlign: 'right',
  },
  sectionCard: {
    backgroundColor: c.cardBackground,
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 12,
    padding: 16,
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
  },
  // Match receipt-process.tsx's own section styling exactly so this card
  // sits among the others without an odd border or a larger heading.
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: c.textPrimary },
  sectionSubvalue: { fontSize: 13, color: c.textSecondary, marginTop: 6 },
  warningText: { fontSize: 12, color: c.warning, marginTop: 6 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },

  summaryBlock: { marginTop: 10, marginBottom: 10 },
  shopName: { fontSize: 16, fontWeight: '700', color: c.textPrimary },
  shopAddress: { fontSize: 12, color: c.textSecondary, marginTop: 2 },

  logo: { width: 28, height: 28, borderRadius: 14, backgroundColor: c.cardBackground },
  logoFallback: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: c.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoFallbackText: { fontSize: 11, fontWeight: '700', color: c.textPrimary },

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
  shopRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  shopNameWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, paddingRight: 8 },
  topDate: { fontSize: 12, color: c.textSecondary, fontWeight: '600' },

  comparedHeader: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  storeAddressLine: {
    fontSize: 11,
    color: c.textSecondary,
    marginTop: 2,
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


  // Hero message right under the title chip — "you saved" or "you could have
  // saved" depending on whether the visited store was the cheapest.
  summaryLine: { marginTop: 8, fontSize: 13, fontWeight: '600' },
  summaryWin:   { color: c.success },
  summaryNudge: { color: c.primary },

  // Cheapest row stands out with a soft tint + accent border.
  rowWinner: {
    backgroundColor: c.successMuted,
    borderColor: c.success,
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
