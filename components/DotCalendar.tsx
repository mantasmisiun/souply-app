import { useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, type ListRenderItemInfo, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, radius, typography, type AppTheme } from '../constants/theme';
import { formatMonthKey } from '../utils/monthNames';

const WEEKDAYS_LT = ['Pr', 'An', 'Tr', 'Kt', 'Pn', 'Št', 'Sk'];
const WEEKDAYS_EN = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MAX_DOTS = 3;
const CELL_H = 46;
const GRID_H = 6 * CELL_H + 32; // 6 fixed rows + the weekday header — constant per month

const pad = (n: number) => String(n).padStart(2, '0');
const keyOf = (y: number, m1: number, d: number) => `${y}-${pad(m1)}-${pad(d)}`;
const monthIndex = (y: number, m0: number) => y * 12 + m0;
const sameYMD = (a: Date, y: number, m0: number, d: number) =>
    a.getFullYear() === y && a.getMonth() === m0 && a.getDate() === d;

type Month = { y: number; m: number };

/** Leading-blank-padded (Monday-first) day cells, always 6 rows so every month
 *  is the same height. */
function buildWeeks(y: number, m0: number): (number | null)[][] {
    const firstDow = (new Date(y, m0, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(y, m0 + 1, 0).getDate();
    const cells: (number | null)[] = [];
    for (let i = 0; i < firstDow; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    while (cells.length < 42) cells.push(null);
    const rows: (number | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
    return rows;
}

/** One month's weekday header + day grid (a single FlatList page). */
function MonthGrid({
    y, m, width, value, markedDates, onSelect, weekdays, styles, onPrimary,
}: {
    y: number;
    m: number;
    width: number;
    value: Date | null;
    markedDates: Map<string, string[]>;
    onSelect: (d: Date) => void;
    weekdays: string[];
    styles: ReturnType<typeof makeStyles>;
    onPrimary: string;
}) {
    const weeks = useMemo(() => buildWeeks(y, m), [y, m]);
    return (
        <View style={{ width }}>
            <View style={styles.weekRow}>
                {weekdays.map((w) => <Text key={w} style={styles.weekday}>{w}</Text>)}
            </View>
            {weeks.map((row, ri) => (
                <View key={ri} style={styles.weekRow}>
                    {row.map((day, ci) => {
                        if (day == null) return <View key={ci} style={styles.cell} />;
                        const dots = markedDates.get(keyOf(y, m + 1, day));
                        const enabled = !!dots;
                        const selected = value != null && sameYMD(value, y, m, day);
                        return (
                            <TouchableOpacity
                                key={ci}
                                style={styles.cell}
                                disabled={!enabled}
                                activeOpacity={0.7}
                                onPress={() => onSelect(new Date(y, m, day))}
                            >
                                <View style={[styles.dayDisc, selected && styles.dayDiscSelected]}>
                                    <Text style={[styles.dayText, !enabled && styles.dayTextDisabled, selected && styles.dayTextSelected]}>
                                        {day}
                                    </Text>
                                </View>
                                <View style={styles.dotsRow}>
                                    {(dots ?? []).slice(0, MAX_DOTS).map((col, i) => (
                                        <View key={i} style={[styles.dot, { backgroundColor: selected ? onPrimary : col }]} />
                                    ))}
                                </View>
                            </TouchableOpacity>
                        );
                    })}
                </View>
            ))}
        </View>
    );
}

/**
 * A day-grid calendar for the receipt date filter. Only days present in
 * `markedDates` are selectable; each shows up to MAX_DOTS chain-coloured dots.
 * Months live in a native paginated FlatList (virtualized — only ~3 mounted),
 * so swiping runs on the native thread and there's no teleport/flash. Bounded
 * to the data span; Monday-first (LT/EU).
 */
export function DotCalendar({
    value,
    onSelect,
    markedDates,
}: {
    value: Date | null;
    onSelect: (d: Date) => void;
    /** "YYYY-MM-DD" → dot colours (deduped per chain, order preserved). */
    markedDates: Map<string, string[]>;
}) {
    const colors = useTheme();
    const { i18n } = useTranslation();
    const styles = makeStyles(colors);
    const weekdays = i18n.language.toLowerCase().startsWith('lt') ? WEEKDAYS_LT : WEEKDAYS_EN;

    const months = useMemo<Month[]>(() => {
        const keys = [...markedDates.keys()].sort();
        if (!keys.length) { const n = new Date(); return [{ y: n.getFullYear(), m: n.getMonth() }]; }
        const idx = (k: string) => { const [y, m] = k.split('-'); return monthIndex(Number(y), Number(m) - 1); };
        const min = idx(keys[0]);
        const max = idx(keys[keys.length - 1]);
        const out: Month[] = [];
        for (let i = min; i <= max; i++) out.push({ y: Math.floor(i / 12), m: ((i % 12) + 12) % 12 });
        return out;
    }, [markedDates]);
    const maxIdx = months.length - 1;

    const initialIdx = useMemo(() => {
        if (value) {
            const vi = monthIndex(value.getFullYear(), value.getMonth());
            const i = months.findIndex((mo) => monthIndex(mo.y, mo.m) === vi);
            if (i >= 0) return i;
        }
        return maxIdx;
    }, [months, value, maxIdx]);

    const [idx, setIdx] = useState(initialIdx);
    const [w, setW] = useState(0);
    const listRef = useRef<FlatList<Month>>(null);

    const onMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (!w) return;
        const i = Math.round(e.nativeEvent.contentOffset.x / w);
        if (i !== idx && i >= 0 && i <= maxIdx) setIdx(i);
    };

    const goTo = (target: number) => {
        if (target < 0 || target > maxIdx) return;
        setIdx(target);
        listRef.current?.scrollToIndex({ index: target, animated: true });
    };

    const renderItem = ({ item }: ListRenderItemInfo<Month>) => (
        <MonthGrid
            y={item.y} m={item.m} width={w} value={value} markedDates={markedDates}
            onSelect={onSelect} weekdays={weekdays} styles={styles} onPrimary={colors.onPrimary}
        />
    );

    const monthLabel = formatMonthKey(`${months[idx].y}-${pad(months[idx].m + 1)}`, i18n.language);

    return (
        <View style={styles.root}>
            {/* Month nav (chevrons + label) — static above the swiped grid. */}
            <View style={styles.header}>
                <TouchableOpacity onPress={() => goTo(idx - 1)} disabled={idx <= 0} hitSlop={10} style={styles.navBtn}>
                    <Ionicons name="chevron-back" size={22} color={idx > 0 ? colors.textPrimary : colors.borderSubtle} />
                </TouchableOpacity>
                <Text style={styles.monthLabel}>{monthLabel}</Text>
                <TouchableOpacity onPress={() => goTo(idx + 1)} disabled={idx >= maxIdx} hitSlop={10} style={styles.navBtn}>
                    <Ionicons name="chevron-forward" size={22} color={idx < maxIdx ? colors.textPrimary : colors.borderSubtle} />
                </TouchableOpacity>
            </View>

            <View style={styles.viewport} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
                {w > 0 && (
                    <FlatList
                        ref={listRef}
                        data={months}
                        horizontal
                        pagingEnabled
                        showsHorizontalScrollIndicator={false}
                        keyExtractor={(mo) => `${mo.y}-${mo.m}`}
                        renderItem={renderItem}
                        getItemLayout={(_, i) => ({ length: w, offset: w * i, index: i })}
                        initialScrollIndex={initialIdx}
                        onScrollToIndexFailed={() => {}}
                        onMomentumScrollEnd={onMomentumEnd}
                        decelerationRate="fast"
                        windowSize={3}
                        initialNumToRender={1}
                        maxToRenderPerBatch={2}
                    />
                )}
            </View>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    root: { width: '100%' },
    header: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingVertical: spacing.sm, paddingHorizontal: spacing.sm,
    },
    navBtn: { padding: 6, borderRadius: radius.sm },
    monthLabel: { ...typography.bodyStrong, fontWeight: '700', color: c.textPrimary, textTransform: 'capitalize' },
    viewport: { height: GRID_H },
    weekRow: { flexDirection: 'row' },
    weekday: {
        flex: 1, textAlign: 'center', ...typography.caption, fontWeight: '600',
        color: c.textMuted, paddingVertical: spacing.xs,
    },
    cell: { flex: 1, height: CELL_H, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 3 },
    dayDisc: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
    dayDiscSelected: { backgroundColor: c.primary },
    dayText: { ...typography.body, color: c.textPrimary },
    dayTextDisabled: { color: c.borderSubtle },
    dayTextSelected: { color: c.onPrimary, fontWeight: '700' },
    dotsRow: { flexDirection: 'row', gap: 3, height: 6, marginTop: 1 },
    dot: { width: 5, height: 5, borderRadius: 2.5 },
});
