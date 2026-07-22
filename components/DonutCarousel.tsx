import { useRef, useState, type ReactNode } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, spacing, typography, type AppTheme } from '../constants/theme';
import { DonutChart, type DonutSlice } from './DonutChart';
import { DonutLegend } from './DonutLegend';

export interface DonutPage {
    key: string;
    title: string;
    slices: DonutSlice[];
    /** Per-row value formatter (default euro). */
    formatValue?: (value: number) => string;
    /** Center sub-label under the total when nothing is selected. */
    centerLabel?: string;
    /** Extra content under the legend (e.g. a "Kita" row). */
    footer?: ReactNode;
    /** Slice index to highlight by default (e.g. the current trip). */
    preselect?: number | null;
    emptyText?: string;
}

/**
 * Swipeable donut pager — the same look as the profile stats carousel (title ‹›,
 * DonutChart + DonutLegend, page dots), but self-contained and page-driven.
 * Used by the trip Stats tab: Category → Trips → Stores.
 */
export function DonutCarousel({ pages }: { pages: DonutPage[] }) {
    const colors = useTheme();
    const styles = makeStyles(colors);
    const scrollRef = useRef<ScrollView>(null);
    const [width, setWidth] = useState(0);
    const [active, setActive] = useState(0);
    const [selected, setSelected] = useState<number | null>(pages[0]?.preselect ?? null);

    const goTo = (i: number) => {
        const next = Math.max(0, Math.min(pages.length - 1, i));
        scrollRef.current?.scrollTo({ x: next * width, animated: true });
        setActive(next);
        setSelected(pages[next]?.preselect ?? null);
    };

    const page = pages[active];

    return (
        <View style={styles.wrap} onLayout={e => { const w = e.nativeEvent.layout.width; if (w > 0) setWidth(w); }}>
            <View style={styles.titleRow}>
                <TouchableOpacity onPress={() => goTo(active - 1)} disabled={active === 0} hitSlop={10}>
                    <Ionicons name="chevron-back" size={18} color={active === 0 ? colors.borderSubtle : colors.textMuted} />
                </TouchableOpacity>
                <Text style={styles.title}>{page?.title}</Text>
                <TouchableOpacity onPress={() => goTo(active + 1)} disabled={active === pages.length - 1} hitSlop={10}>
                    <Ionicons name="chevron-forward" size={18} color={active === pages.length - 1 ? colors.borderSubtle : colors.textMuted} />
                </TouchableOpacity>
            </View>

            {width > 0 && (
                <ScrollView
                    ref={scrollRef}
                    horizontal
                    pagingEnabled
                    showsHorizontalScrollIndicator={false}
                    style={{ width }}
                    contentContainerStyle={{ alignItems: 'flex-start' }}
                    onMomentumScrollEnd={e => {
                        const i = Math.round(e.nativeEvent.contentOffset.x / width);
                        setActive(i);
                        setSelected(pages[i]?.preselect ?? null);
                    }}
                >
                    {pages.map((p, i) => (
                        <View key={p.key} style={{ width, alignItems: 'center' }}>
                            {p.slices.length > 0 ? (
                                <>
                                    <DonutChart
                                        data={p.slices}
                                        size={180}
                                        thickness={32}
                                        emptyColor={colors.borderSubtle}
                                        selectedIndex={i === active ? selected : (p.preselect ?? null)}
                                        onSelect={i === active ? setSelected : undefined}
                                        cardBackground={colors.cardBackground}
                                        defaultCenterLabel={p.centerLabel}
                                    />
                                    <DonutLegend
                                        items={p.slices.map(s => ({ label: s.label, color: s.color, value: s.value, logoUri: s.logoUri }))}
                                        selectedIndex={i === active ? selected : (p.preselect ?? null)}
                                        formatValue={p.formatValue}
                                    />
                                    {p.footer}
                                </>
                            ) : (
                                <Text style={styles.empty}>{p.emptyText ?? ''}</Text>
                            )}
                        </View>
                    ))}
                </ScrollView>
            )}

            <View style={styles.dots}>
                {pages.map((p, i) => (
                    <View key={p.key} style={[styles.dot, i === active && styles.dotOn]} />
                ))}
            </View>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    wrap: { alignItems: 'center' },
    titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.lg, marginBottom: spacing.sm },
    title: { ...typography.bodyStrong, fontWeight: '800', color: c.textPrimary },
    empty: { ...typography.body, color: c.textSecondary, paddingVertical: spacing.xxl },
    dots: { flexDirection: 'row', gap: 5, justifyContent: 'center', marginTop: spacing.md },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.border },
    dotOn: { width: 18, backgroundColor: c.primary },
});
