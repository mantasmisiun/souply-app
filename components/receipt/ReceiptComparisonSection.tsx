import { ReceiptComparison } from '../../types/receipt-view';
import React, { useEffect, useRef } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Image, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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

const getInitials = (value: string) =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('');

export default function ReceiptComparisonSection({ comparison, loading, error, summary }: Props) {
  if (loading) {
    return (
      <View style={styles.sectionCard}>
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color="#2e7d32" />
          <Text style={styles.sectionSubvalue}>Skaičiuojama...</Text>
        </View>
      </View>
    );
  }
  if (!comparison) return null;
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: 700,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [comparison, progress]);

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
  const totalCount = summary?.productCount ?? (comparison.summary.recognizedItems + comparison.summary.excludedItems);
  const hasUnrecognized = comparedCount < totalCount;
  const formattedDate = (() => {
    if (!receiptDate) return null;
    const raw = String(receiptDate).trim();
    const dateOnly = raw.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? raw;
    const d = new Date(dateOnly);
    if (Number.isNaN(d.getTime())) return dateOnly;
    return d.toLocaleDateString('lt-LT');
  })();

  return (
    <View style={[styles.sectionCard, styles.heroCard]}>

      <View style={styles.shopRow}>
        <View style={styles.shopNameWrap}>
          <Text style={styles.shopName}>{shopName}</Text>
          {!!summary?.storeRecognized && (
            <Ionicons name="checkmark-circle" size={18} color="#2e7d32" />
          )}
        </View>
        {!!formattedDate && <Text style={styles.topDate}>{formattedDate}</Text>}
      </View>

      {!!shopAddress && <Text style={styles.shopAddress}>{shopAddress}</Text>}

      <View style={styles.comparedHeaderWrap}>
        <View style={styles.comparedChip}>
          <Text style={styles.comparedTitle}>Palygintos prekės ({comparedCount}/{totalCount})</Text>
          {hasUnrecognized && <Ionicons name="alert-circle" size={16} color="#f57c00" />}
        </View>
      </View>
        {rows.map((row) => {
          const fillColor = row.isVisited
            ? visitedIsCheapest
              ? '#2e7d32'
              : '#c62828'
            : '#1565c0';

          return (
            <View key={`${row.chainId}-${row.storeId}`} style={styles.rowWrap}>
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
                      {row.isVisited && (
                        <View style={styles.visitedBadgeInline}>
                          <Text style={styles.visitedBadgeText}>Jūsų parduotuvė</Text>
                        </View>
                      )}
                    </View>
                    {!!row.storeAddress && <Text style={styles.storeAddressLine}>{row.storeAddress}</Text>}
                  </View>
                </View>

                <Text style={styles.totalText}>€{row.total.toFixed(2)}</Text>
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

const styles = StyleSheet.create({
  barsWrap: {
    marginTop: 14,
    gap: 12,
  },
  rowWrap: {
    gap: 8,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#edf2f7',
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
    backgroundColor: '#e5e7eb',
    overflow: 'hidden',
    width: '100%',
  },
  totalText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
    minWidth: 72,
    textAlign: 'right',
  },
  sectionCard: {
    backgroundColor: 'white',
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
  heroCard: {
    borderWidth: 1,
    borderColor: '#dce7ff',
    backgroundColor: '#f9fbff',
  },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: '#212121' },
  sectionSubvalue: { fontSize: 13, color: '#757575', marginTop: 6 },
  warningText: { fontSize: 12, color: '#f57c00', marginTop: 6 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },

  summaryBlock: { marginTop: 10, marginBottom: 10 },
  shopName: { fontSize: 16, fontWeight: '700', color: '#1f2937' },
  shopAddress: { fontSize: 12, color: '#6b7280', marginTop: 2 },

  logo: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#fff' },
  logoFallback: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#e5e7eb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoFallbackText: { fontSize: 11, fontWeight: '700', color: '#374151' },

  storeLabel: { fontSize: 13, color: '#374151', fontWeight: '600' },

  visitedBadge: {
    alignSelf: 'flex-start',
    marginTop: 4,
    backgroundColor: '#eef2ff',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  visitedBadgeText: { fontSize: 10, fontWeight: '700', color: '#374151' },
  compareBarFill: {
    height: '100%',
    borderRadius: 999,
  },
  shopRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  shopNameWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, paddingRight: 8 },
  topDate: { fontSize: 12, color: '#6b7280', fontWeight: '600' },

  comparedHeader: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  storeAddressLine: {
    fontSize: 11,
    color: '#6b7280',
    marginTop: 2,
  },

  storeTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  visitedBadgeInline: {
    backgroundColor: '#eef2ff',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },

  comparedHeaderWrap: {
    marginTop: 14,
    marginBottom: 6,
  },
  comparedChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#f3f4f6',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  comparedTitle: {
    fontSize: 13,
    color: '#374151',
    fontWeight: '600',
  },
});