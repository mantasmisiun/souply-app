import { useEffect, useMemo, useRef, useState } from 'react';
import {
    View, Text, StyleSheet, Modal, TouchableOpacity, Pressable, Platform,
    Animated as RNAnimated, ScrollView, type NativeSyntheticEvent, type NativeScrollEvent,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Haptics from 'expo-haptics';
import { useTheme, spacing, radius, typography, type AppTheme } from '../constants/theme';
import { monthLong, parseMonthKey } from '../utils/monthNames';
import { LiquidGlass } from './LiquidGlass';

// Wheel geometry. VISIBLE_ROWS must be odd so one row sits dead-centre.
const ITEM_HEIGHT = 44;
const VISIBLE_ROWS = 5;
const PAD = ((VISIBLE_ROWS - 1) / 2) * ITEM_HEIGHT;
const WHEEL_HEIGHT = VISIBLE_ROWS * ITEM_HEIGHT;

const IS_IOS = Platform.OS === 'ios';

interface WheelDatum {
    value: number;
    label: string;
}

/**
 * A single snapping wheel column (RN Animated + native driver so the fade/scale
 * follows the finger). Items are laid out in a padded ScrollView; the selected
 * row is whichever sits under the centre band. onChange fires once per settle.
 */
function Wheel({
    data,
    selectedValue,
    onChange,
    align,
    colors,
}: {
    data: WheelDatum[];
    selectedValue: number;
    onChange: (value: number) => void;
    align: 'flex-end' | 'flex-start' | 'center';
    colors: AppTheme;
}) {
    const ref = useRef<ScrollView>(null);
    const selectedIndex = Math.max(0, data.findIndex((d) => d.value === selectedValue));
    const scrollY = useRef(new RNAnimated.Value(selectedIndex * ITEM_HEIGHT)).current;
    // Index that last fired a haptic tick — so we buzz once per row crossed
    // while spinning, not continuously.
    const lastTick = useRef(selectedIndex);

    // Re-centre when the selected value or the option set changes (e.g. the
    // valid month list shrinks after the year wheel moves to a bound year).
    useEffect(() => {
        const y = selectedIndex * ITEM_HEIGHT;
        ref.current?.scrollTo({ y, animated: false });
        scrollY.setValue(y);
        lastTick.current = selectedIndex;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedValue, data.length]);

    // Fires on the JS thread alongside the native-driven animation — one
    // selection tick each time a new row passes under the centre band.
    const onScrollTick = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
        const idx = Math.round(e.nativeEvent.contentOffset.y / ITEM_HEIGHT);
        if (idx !== lastTick.current && idx >= 0 && idx < data.length) {
            lastTick.current = idx;
            Haptics.selectionAsync();
        }
    };

    // Settle ONLY on momentum end. snapToInterval always produces a snap
    // animation (hence a momentum-end) on release, so this fires for both
    // flings and slow drags. Settling on onScrollEndDrag instead would commit
    // the release-point row mid-fling — the re-centre effect then yanks the
    // wheel back there for a frame (a visible flash) before momentum lands.
    const settle = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
        const y = e.nativeEvent.contentOffset.y;
        const idx = Math.min(data.length - 1, Math.max(0, Math.round(y / ITEM_HEIGHT)));
        const next = data[idx]?.value;
        if (next !== undefined && next !== selectedValue) onChange(next);
    };

    return (
        <View style={{ height: WHEEL_HEIGHT, flex: 1 }}>
            <RNAnimated.ScrollView
                ref={ref as any}
                showsVerticalScrollIndicator={false}
                snapToInterval={ITEM_HEIGHT}
                decelerationRate="fast"
                scrollEventThrottle={16}
                onScroll={RNAnimated.event(
                    [{ nativeEvent: { contentOffset: { y: scrollY } } }],
                    { useNativeDriver: true, listener: onScrollTick },
                )}
                onMomentumScrollEnd={settle}
                contentContainerStyle={{ paddingVertical: PAD }}
            >
                {data.map((d, i) => {
                    const inputRange = [
                        (i - 2) * ITEM_HEIGHT, (i - 1) * ITEM_HEIGHT, i * ITEM_HEIGHT,
                        (i + 1) * ITEM_HEIGHT, (i + 2) * ITEM_HEIGHT,
                    ];
                    const opacity = scrollY.interpolate({
                        inputRange, outputRange: [0.28, 0.5, 1, 0.5, 0.28], extrapolate: 'clamp',
                    });
                    const scale = scrollY.interpolate({
                        inputRange, outputRange: [0.82, 0.9, 1, 0.9, 0.82], extrapolate: 'clamp',
                    });
                    return (
                        <RNAnimated.View
                            key={d.value}
                            style={[styles.item, { opacity, transform: [{ scale }] }]}
                        >
                            <Text
                                style={[
                                    styles.itemText,
                                    { color: colors.textPrimary, textAlign: align === 'center' ? 'center' : (align === 'flex-end' ? 'right' : 'left') },
                                    align === 'flex-end' && { paddingRight: spacing.lg },
                                    align === 'flex-start' && { paddingLeft: spacing.lg },
                                ]}
                                numberOfLines={1}
                            >
                                {d.label}
                            </Text>
                        </RNAnimated.View>
                    );
                })}
            </RNAnimated.ScrollView>
        </View>
    );
}

export interface MonthYearPickerProps {
    visible: boolean;
    /** Currently-selected month, `YYYY-MM`. */
    value: string;
    /** Earliest selectable month, `YYYY-MM` (inclusive). */
    minKey: string;
    /** Latest selectable month, `YYYY-MM` (inclusive) — typically the current month. */
    maxKey: string;
    onSelect: (key: string) => void;
    onClose: () => void;
}

/**
 * Month + year wheel picker, bounded to [minKey, maxKey]. Two custom snapping
 * wheels (no native month-only picker exists on either platform). Styled per
 * platform: a thin iOS selection band vs a filled Material-expressive pill.
 */
export default function MonthYearPicker({
    visible, value, minKey, maxKey, onSelect, onClose,
}: MonthYearPickerProps) {
    const colors = useTheme();
    const { t, i18n } = useTranslation();
    const styles2 = useMemo(() => makeStyles(colors), [colors]);

    const min = parseMonthKey(minKey) ?? [2000, 1];
    const max = parseMonthKey(maxKey) ?? [2100, 12];
    const seed = parseMonthKey(value) ?? max;

    const [year, setYear] = useState(seed[0]);
    const [month, setMonth] = useState(seed[1]);

    // Re-seed whenever the sheet is (re)opened for a different card/month.
    useEffect(() => {
        if (visible) {
            const s = parseMonthKey(value) ?? max;
            setYear(s[0]);
            setMonth(s[1]);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, value]);

    const years = useMemo(() => {
        const out: WheelDatum[] = [];
        for (let y = min[0]; y <= max[0]; y++) out.push({ value: y, label: String(y) });
        return out;
    }, [min[0], max[0]]);

    // Valid months for the chosen year, clamped at the range's end years.
    const months = useMemo(() => {
        const startM = year === min[0] ? min[1] : 1;
        const endM = year === max[0] ? max[1] : 12;
        const out: WheelDatum[] = [];
        for (let m = startM; m <= endM; m++) out.push({ value: m, label: monthLong(m, i18n.language) });
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [year, i18n.language]);

    // Keep the month in range when the year moves to a bound year.
    useEffect(() => {
        const startM = year === min[0] ? min[1] : 1;
        const endM = year === max[0] ? max[1] : 12;
        if (month < startM) setMonth(startM);
        else if (month > endM) setMonth(endM);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [year]);

    const commit = () => {
        onSelect(`${year}-${String(month).padStart(2, '0')}`);
        onClose();
    };

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <Pressable style={styles2.backdrop} onPress={onClose} />
            <View style={styles2.sheet}>
                {/* Grabber handle — modern bottom-sheet affordance */}
                <View style={styles2.grabber} />
                {/* Header — Cancel / title / Confirm */}
                <View style={styles2.header}>
                    <TouchableOpacity onPress={onClose} hitSlop={10}>
                        <Text style={styles2.cancel}>{t('common.cancel')}</Text>
                    </TouchableOpacity>
                    <Text style={styles2.title}>{t('profilis.pickMonth')}</Text>
                    <TouchableOpacity onPress={commit} hitSlop={10}>
                        <Text style={styles2.confirm}>{t('common.confirm')}</Text>
                    </TouchableOpacity>
                </View>

                {/* Wheels + centred selection indicator. iOS 26 gets a native
                    Liquid Glass lozenge (blur fallback on older iOS); Android
                    gets a Material-expressive filled pill. */}
                <View style={styles2.wheelsWrap}>
                    <View pointerEvents="none" style={styles2.bandContainer}>
                        {IS_IOS ? (
                            <LiquidGlass
                                style={styles2.bandGlass}
                                interactive={false}
                                fallback="blur"
                                intensity={22}
                            />
                        ) : (
                            <View style={styles2.bandMaterial} />
                        )}
                    </View>
                    <View style={styles2.wheelsRow}>
                        <Wheel data={months} selectedValue={month} onChange={setMonth} align="flex-end" colors={colors} />
                        <Wheel data={years} selectedValue={year} onChange={setYear} align="flex-start" colors={colors} />
                    </View>
                </View>
            </View>
        </Modal>
    );
}

// Shared item styles (used inside Wheel, theme-independent).
const styles = StyleSheet.create({
    item: { height: ITEM_HEIGHT, justifyContent: 'center' },
    itemText: { ...typography.priceLarge, fontWeight: '500', fontSize: 22 },
});

const makeStyles = (c: AppTheme) => StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: c.overlayBackdrop },
    sheet: {
        backgroundColor: c.cardBackground,
        borderTopLeftRadius: IS_IOS ? radius.lg : radius.xl,
        borderTopRightRadius: IS_IOS ? radius.lg : radius.xl,
        paddingBottom: spacing.xxl,
        paddingTop: spacing.sm,
    },
    header: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    },
    grabber: {
        alignSelf: 'center', width: 36, height: 5, borderRadius: radius.pill,
        backgroundColor: c.borderSubtle, marginTop: spacing.xs, marginBottom: spacing.xs,
    },
    title: { ...typography.bodyStrong, fontWeight: '700', color: c.textPrimary },
    // iOS: plain text buttons (Confirm bold). Material: same but confirm is the accent.
    cancel: { ...typography.body, color: IS_IOS ? c.textSecondary : c.primary, fontWeight: IS_IOS ? '400' : '600' },
    confirm: { ...typography.body, color: c.primary, fontWeight: IS_IOS ? '600' : '700' },

    wheelsWrap: { height: WHEEL_HEIGHT, marginTop: spacing.xs, justifyContent: 'center' },
    wheelsRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xxl },

    // The selection lozenge is centred in the wheel column via this absolute
    // full-bleed, non-interactive container (its child stretches to width).
    bandContainer: {
        ...StyleSheet.absoluteFill,
        justifyContent: 'center',
        paddingHorizontal: spacing.lg,
    },
    // iOS 26 Liquid Glass lozenge (rounded, translucent, faint specular edge).
    bandGlass: {
        height: ITEM_HEIGHT,
        borderRadius: radius.lg,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: c.borderSubtle,
        overflow: 'hidden',
    },
    // Android Material-expressive filled pill.
    bandMaterial: {
        height: ITEM_HEIGHT,
        borderRadius: radius.pill,
        backgroundColor: c.secondaryContainer,
    },
});
