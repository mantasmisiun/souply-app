import { View, Text, StyleSheet } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useTheme, spacing, radius, typography } from '../constants/theme';
import { ChainLogoChip } from './ChainLogoChip';
import { chainIdByName } from '../utils/chainBrandName';
import { formatEuro } from '../utils/formatCurrency';

export interface LegendItem { label: string; color: string; value: number; logoUri?: string | null }

/**
 * Legend rows for a DonutChart — a coloured dot (or chain logo) + label + value.
 * Selecting a slice dims the others. Shared by the profile stats and the trip
 * stats donut carousel. `formatValue` defaults to euro (Stores passes a %).
 */
export function DonutLegend({
    items, selectedIndex, formatValue,
}: {
    items: LegendItem[];
    selectedIndex?: number | null;
    formatValue?: (value: number) => string;
}) {
    const colors = useTheme();
    const fmtValue = formatValue ?? formatEuro;
    const anySelected = selectedIndex !== null && selectedIndex !== undefined;
    return (
        <Animated.View style={styles.container} layout={LinearTransition.duration(280)}>
            {items.map((item, i) => {
                const dimmed = anySelected && i !== selectedIndex;
                return (
                    <Animated.View
                        key={item.label}
                        entering={FadeIn.duration(280)}
                        exiting={FadeOut.duration(160)}
                        layout={LinearTransition.duration(280)}
                    >
                        <View style={[styles.row, dimmed && styles.rowDimmed]}>
                            {item.logoUri ? (
                                <ChainLogoChip chainId={chainIdByName(item.label) ?? 0} name={item.label} size={20} />
                            ) : (
                                <View style={[styles.dot, { backgroundColor: item.color }]} />
                            )}
                            <Text style={[styles.label, { color: colors.textSecondary }]} numberOfLines={1}>{item.label}</Text>
                            <Text style={[styles.value, { color: colors.textPrimary }]}>{fmtValue(item.value)}</Text>
                        </View>
                    </Animated.View>
                );
            })}
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    container: { alignSelf: 'stretch', marginTop: spacing.sm, gap: spacing.xs },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    rowDimmed: { opacity: 0.3 },
    dot: { width: 10, height: 10, borderRadius: radius.pill, flexShrink: 0 },
    label: { flex: 1, ...typography.label, fontWeight: '400' },
    value: { ...typography.label, flexShrink: 0 },
});
