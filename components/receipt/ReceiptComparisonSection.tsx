import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet, DimensionValue } from 'react-native';
import { ReceiptComparison } from '../../types/receipt-view';

type Props = {
  comparison: ReceiptComparison | null;
  loading: boolean;
  error: string | null;
};

export default function ReceiptComparisonSection({ comparison, loading, error }: Props) {
  if (loading) {
    return (
      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>Kainų palyginimas</Text>
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color="#2e7d32" />
          <Text style={styles.sectionSubvalue}>Skaičiuojama...</Text>
        </View>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>Kainų palyginimas</Text>
        <Text style={[styles.sectionSubvalue, { color: '#c62828', marginTop: 6 }]}>{error}</Text>
      </View>
    );
  }

  if (!comparison) return null;

  const bestAlt = comparison.alternatives[0];
  const hasSavings = !!bestAlt && bestAlt.savings > 0;

  const totals = [comparison.currentChain.total, ...comparison.alternatives.map(a => a.total)]
    .filter(n => Number.isFinite(n) && n >= 0);

  const maxTotal = totals.length ? Math.max(...totals) : 1;
  const barWidth = (total: number): DimensionValue => {
    const pct = Math.max(8, (total / Math.max(maxTotal, 1)) * 100);
    return `${pct}%` as `${number}%`;
  };

  return (
    <View style={[styles.sectionCard, hasSavings && styles.savingsCard]}>
      <Text style={styles.sectionTitle}>Kainų palyginimas</Text>

      {hasSavings ? (
        <Text style={styles.savingsText}>
          Sutaupytumėte €{bestAlt!.savings.toFixed(2)} pasirinkę {bestAlt!.chainName}
        </Text>
      ) : (
        <Text style={styles.sectionSubvalue}>Pigiau nerasta pagal turimus duomenis</Text>
      )}

      <Text style={[styles.sectionSubvalue, { marginTop: 8 }]}>
        Lyginta pagal {comparison.summary.recognizedItems} atpažintas prekes
        {comparison.summary.excludedItems > 0 ? `, neįtraukta: ${comparison.summary.excludedItems}` : ''}
      </Text>
      {!!comparison.summary.note && <Text style={styles.warningText}>{comparison.summary.note}</Text>}

      <View style={{ marginTop: 12, gap: 10 }}>
        <View>
          <Text style={styles.footerLabel}>
            Jūsų parduotuvė: {comparison.currentChain.chainName} ({comparison.currentChain.storeName})
          </Text>
          <View style={styles.compareBarTrack}>
            <View style={[styles.compareBarFillCurrent, { width: barWidth(comparison.currentChain.total) }]} />
          </View>
          <Text style={styles.footerValue}>€{comparison.currentChain.total.toFixed(2)}</Text>
        </View>

        {comparison.alternatives.map((alt) => (
          <View key={`${alt.chainId}-${alt.storeId}`}>
            <Text style={styles.footerLabel}>
              {alt.chainName} ({alt.storeName}) • {alt.distanceKm.toFixed(1)} km
            </Text>
            <View style={styles.compareBarTrack}>
              <View style={[styles.compareBarFillAlt, { width: barWidth(alt.total) }]} />
            </View>
            <Text style={styles.footerValue}>
              €{alt.total.toFixed(2)}
              {alt.savings > 0 ? `  (−€${alt.savings.toFixed(2)})` : ''}
            </Text>
            {!!alt.note && <Text style={styles.warningText}>{alt.note}</Text>}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
  sectionTitle: { fontSize: 15, fontWeight: '600', color: '#212121' },
  sectionSubvalue: { fontSize: 13, color: '#757575' },
  warningText: { fontSize: 12, color: '#f57c00', marginTop: 4 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },

  savingsCard: { borderWidth: 1, borderColor: '#a5d6a7', backgroundColor: '#e8f5e9' },
  savingsText: { marginTop: 6, fontSize: 14, fontWeight: '700', color: '#1b5e20' },

  compareBarTrack: {
    marginTop: 6,
    height: 8,
    borderRadius: 999,
    backgroundColor: '#eeeeee',
    overflow: 'hidden',
  },
  compareBarFillCurrent: { height: '100%', backgroundColor: '#1565c0', borderRadius: 999 },
  compareBarFillAlt: { height: '100%', backgroundColor: '#2e7d32', borderRadius: 999 },

  footerLabel: { fontSize: 13, color: '#757575' },
  footerValue: { fontSize: 13, fontWeight: '600', color: '#212121' },
});