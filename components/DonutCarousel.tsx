import { useEffect, useRef, useState, type ReactNode } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useTheme, spacing, typography, type AppTheme } from '../constants/theme';
import { DonutChart, type DonutSlice } from './DonutChart';
import { DonutLegend } from './DonutLegend';

export interface DonutPage {
    key: string;
    title: string;
    /** Muted date-range line under the title — tells the user the window the
     *  data was taken from. Omit for pages whose data isn't date-limited. */
    subtitle?: string;
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
    // Card adapts to the active page's content height — pages have different
    // legend-row counts, so a fixed height would leave dead space or clip.
    const [heights, setHeights] = useState<Record<number, number>>({});
    const containerH = useSharedValue(0);
    useEffect(() => {
        const target = heights[active];
        if (!target) return;
        if (containerH.value === 0) containerH.value = target;      // first measure: snap
        else containerH.value = withTiming(target, { duration: 240 }); // page change: ease
    }, [active, heights, containerH]);
    const heightStyle = useAnimatedStyle(() => ({ height: containerH.value > 0 ? containerH.value : undefined }));

    const page = pages[active];

    return (
        <View style={styles.wrap} onLayout={e => { const w = e.nativeEvent.layout.width; if (w > 0) setWidth(w); }}>
            <View style={styles.titleRow}>
                <Text style={styles.title}>{page?.title}</Text>
                {!!page?.subtitle && <Text style={styles.subtitle}>{page.subtitle}</Text>}
            </View>

            {width > 0 && (
                <Animated.View style={[{ width, overflow: 'hidden' }, heightStyle]}>
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
                        <View
                            key={p.key}
                            style={{ width, alignItems: 'center' }}
                            onLayout={e => { const hgt = e.nativeEvent.layout.height; setHeights(prev => prev[i] === hgt ? prev : { ...prev, [i]: hgt }); }}
                        >
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
                </Animated.View>
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
    titleRow: { alignSelf: 'stretch', marginBottom: spacing.sm },
    title: { ...typography.bodyStrong, fontWeight: '800', color: c.textPrimary },
    subtitle: { ...typography.caption, color: c.textMuted, marginTop: 2 },
    empty: { ...typography.body, color: c.textSecondary, paddingVertical: spacing.xxl },
    dots: { flexDirection: 'row', gap: 5, justifyContent: 'center', marginTop: spacing.md },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.border },
    dotOn: { width: 18, backgroundColor: c.primary },
});
