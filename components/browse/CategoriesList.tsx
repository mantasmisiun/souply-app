import {
    View,
    FlatList,
    TouchableOpacity,
    Text,
    StyleSheet,
    useWindowDimensions,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { categoriesQueryKey, fetchCategoryTree } from '../../utils/categoriesQuery';
import { readSharedValue } from '../../utils/sharedValue';
import { useNetworkStatus } from '../../state/networkStatus';
import { useBasketSession } from '../../state/basketSession';
import { useTheme, radius, elevation, type AppTheme } from '../../constants/theme';
import { categoryIcon } from '../../constants/categoryIcons';
import { useSafeBottomTabBarHeight } from '../../hooks/useSafeBottomTabBarHeight';
import { SkeletonBox } from '../SkeletonBox';

/** Stable empty references — a new []/{} each render would re-run every memo
 *  and effect that depends on them. */
const EMPTY_L1: Category[] = [];
const EMPTY_L2_MAP: Record<number, Category[]> = {};

export interface Category {
    id: number;
    name: string;
    /** Canonical Lithuanian name (used for icon lookup). Server-side
     *  responses use it for stable icon lookup independent of the user's
     *  current language. Falls back to `name` when missing. */
    nameKey?: string;
    parentCategoryId: number | null;
}


const EMPTY_L2: Category[] = [];

const L1Item = memo(function L1Item({ item, isExpanded, l2, onToggle, onSelectL2, onExpanded, colors, styles }: {
    item: Category;
    isExpanded: boolean;
    l2: Category[];
    onToggle: (id: number) => void;
    onSelectL2: (l2: Category) => void;
    /** After expanding + settling: report the item's on-screen frame so the list
     *  can scroll it into view (clears the tab bar) only if it's clipped. */
    onExpanded: (id: number, screenY: number, height: number) => void;
    colors: AppTheme;
    styles: ReturnType<typeof makeStyles>;
}) {
    const contentHeightRef = useRef(0);
    const animatedHeight = useSharedValue(0);
    const chevronRotation = useSharedValue(0);
    const outerRef = useRef<View>(null);

    const EXPAND_MS = 200;
    useLayoutEffect(() => {
        animatedHeight.value = withTiming(isExpanded ? contentHeightRef.current : 0, {
            duration: EXPAND_MS,
            easing: Easing.out(Easing.cubic),
        });
        chevronRotation.value = withTiming(isExpanded ? 1 : 0, { duration: EXPAND_MS });
        if (isExpanded) {
            // Measure once the height settles, then let the list decide the scroll.
            const t = setTimeout(() => {
                outerRef.current?.measureInWindow((_x, y, _w, h) => onExpanded(item.id, y, h));
            }, EXPAND_MS + 30);
            return () => clearTimeout(t);
        }
    }, [isExpanded]);

    const animatedContentStyle = useAnimatedStyle(() => ({
        height: animatedHeight.value,
        overflow: 'hidden',
    }));

    const chevronStyle = useAnimatedStyle(() => ({
        transform: [{ rotate: `${chevronRotation.value * 180}deg` }],
    }));

    const handleLayout = (e: { nativeEvent: { layout: { height: number } } }) => {
        const h = e.nativeEvent.layout.height;
        if (h > 0 && h !== contentHeightRef.current) {
            contentHeightRef.current = h;
            if (isExpanded) {
                animatedHeight.value = withTiming(h, { duration: EXPAND_MS, easing: Easing.out(Easing.cubic) });
            }
        }
    };

    const l2Rows = l2.length === 0 ? (
        <MaterialProgress size="small" color={colors.primary} style={{ padding: 12 }} />
    ) : (
        l2.map((cat, index) => (
            <View key={cat.id}>
                {index > 0 && <View style={styles.divider} />}
                <TouchableOpacity
                    style={styles.l2Row}
                    onPress={() => onSelectL2(cat)}
                >
                    <Text style={styles.l2Text}>{cat.name}</Text>
                    <Ionicons name="chevron-forward" size={18} color={colors.primary} />
                </TouchableOpacity>
            </View>
        ))
    );

    return (
        <View ref={outerRef} style={[styles.l1Container, isExpanded && styles.l1ContainerExpanded]}>
            <TouchableOpacity
                style={[styles.l1Row, isExpanded && styles.l1RowExpanded]}
                onPress={() => onToggle(item.id)}
            >
                <Text style={styles.l1Icon}>{categoryIcon(item.nameKey, item.name)}</Text>
                <Text style={styles.l1Text}>{item.name}</Text>
                <Animated.View style={chevronStyle}>
                    <Ionicons name="chevron-down" size={20} color={isExpanded ? colors.primary : colors.success} />
                </Animated.View>
            </TouchableOpacity>
            {/* Ghost view: absolutely positioned so its layout isn't constrained by
                animatedHeight. onLayout here always returns the natural content height. */}
            <View
                style={{ position: 'absolute', opacity: 0, left: 0, right: 0 }}
                pointerEvents="none"
                onLayout={handleLayout}
            >
                <View style={styles.l2Container}>{l2Rows}</View>
            </View>
            <Animated.View style={animatedContentStyle}>
                <View style={styles.l2Container}>{l2Rows}</View>
            </Animated.View>
        </View>
    );
});

interface Props {
    /** Called when the user taps an L2 (subcategory) row. Caller decides
     *  routing (Narsyti tab navigates to /browse/[id]; template-add appends
     *  a templateId param so downstream screens know to add to the template
     *  instead of the basket). */
    onSelectL2: (l2: Category) => void;
    /** Optional content rendered as the FlatList's header — scrolls with
     *  the list (e.g. the Nuolaidos shortcut), so it isn't pinned above
     *  the categories. */
    header?: ReactElement | null;
    /** Scroll handler props from useCollapsingHeader().scroll, so a collapsing
     *  header can track this list's scroll. Optional — omit for a plain list. */
    scroll?: { onScroll?: any; scrollEventThrottle?: number };
    /** The header's live scroll offset (useCollapsingHeader().offset), so an
     *  expanded category can be scrolled into view by an EXACT relative amount. */
    scrollOffset?: { value: number };
    /** Top padding to reserve for an overlaying collapsing header. */
    contentPaddingTop?: number;
}

export function CategoriesList({ onSelectL2, header, scroll, scrollOffset, contentPaddingTop = 0 }: Props) {
    const colors = useTheme();
    const { t, i18n } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    // Exact bottom tab bar clearance (NativeTabs folds the bar into the safe-area
    // inset on iOS; @react-navigation context on Android) + a small breather, so
    // the last L1 row sits just above the bar on every device. No FAB here, so no
    // extra reserve.
    const tabBarHeight = useSafeBottomTabBarHeight();
    const { height: winHeight } = useWindowDimensions();
    const listPadBottom = tabBarHeight + 8;
    const [expandedL1, setExpandedL1] = useState<number | null>(null);
    // Publish the list ref so the basket dock's Pan can block this scroll while
    // a drag starts on the bar (else the list steals the gesture).
    const listRef = useRef(null);
    useEffect(() => {
        useBasketSession.getState().setBrowseListRef(listRef);
        return () => useBasketSession.getState().setBrowseListRef(null);
    }, []);

    // Load L1 + ALL L2 in two parallel requests (was 1 + N: one subcategory call
    // per L1). `/api/categories/l2` returns every L2 with its parentCategoryId,
    // so we group client-side — every L1 already has its L2 in hand, so
    // expanding is instant, never a spinner.
    //
    // ON REACT QUERY, deliberately. As a bare useEffect this fetch ran ONCE per
    // mount and swallowed its error, so a server that was down at launch left an
    // empty catalog with no error, no retry and no way back: tab screens stay
    // mounted, so leaving to Shopping and returning didn't re-run it — only
    // restarting the app did. React Query gives the three things that were
    // missing: automatic retry with backoff (client default), a persisted cache
    // so a cold start paints the last known tree instead of nothing, and an
    // explicit error state to retry from. The language is part of the key, so a
    // switch refetches and a late 'lt' response can't overwrite fresh 'en' data.
    const { data, isLoading, isError, refetch, isFetching } = useQuery({
        queryKey: categoriesQueryKey(i18n.language),
        queryFn: ({ signal }) => fetchCategoryTree(signal),
        // The category tree is near-static — a day-old copy is fine to show
        // while a refetch confirms it.
        staleTime: 24 * 60 * 60 * 1000,
    });
    const l1Categories = data?.l1 ?? EMPTY_L1;
    const l2Map = data?.l2Map ?? EMPTY_L2_MAP;

    // Coming back to the tab with NOTHING to show → try again. (With data in
    // hand this does nothing: the screen is already usable and React Query's
    // staleness rules own the refresh.)
    useFocusEffect(useCallback(() => {
        if (isError || l1Categories.length === 0) void refetch();
    }, [isError, l1Categories.length, refetch]));

    // Offline → online edge: the same recovery, without waiting for a focus.
    const isOnline = useNetworkStatus(s => s.isOnline);
    useEffect(() => {
        if (isOnline && (isError || l1Categories.length === 0)) void refetch();
    }, [isOnline, isError, l1Categories.length, refetch]);

    const toggleL1 = useCallback((id: number) => {
        // An expanded basket dock gets out of the way when the user starts
        // interacting with the page (spec: L1 toggle / scroll collapse it).
        useBasketSession.getState().collapseDock?.();
        setExpandedL1(prev => prev === id ? null : id);
        // The scroll-into-view happens in onL1Expanded once the item has laid out.
    }, []);

    // Screen top of the scrollable (measured) — the guard so a very tall card is
    // top-aligned just under the header rather than pushed above it.
    const listTopRef = useRef(0);

    // Screen-aware scroll: after a category expands, only scroll if its bottom is
    // clipped (e.g. behind the tab bar). Scroll up by EXACTLY the clipped amount
    // (relative to the current offset), capped so the card's top stays under the
    // header — precise and immune to content-height clamping on the last item.
    const onL1Expanded = useCallback((id: number, screenY: number, height: number) => {
        // readSharedValue, not `scrollOffset?.value` — with the React Compiler on,
        // an inline read here becomes a render-time read of the shared value (it
        // is lifted into the memo-cache key), which is what Reanimated's strict
        // mode was warning about on every render of this list.
        const cur = readSharedValue(scrollOffset);
        if (cur == null) return; // no offset wired → skip (browse usages)
        const visibleBottom = winHeight - tabBarHeight - 8;
        if (screenY + height <= visibleBottom) return; // already fully visible
        const topGuard = listTopRef.current || 100;
        const overflow = (screenY + height) - visibleBottom;
        const maxUp = Math.max(0, screenY - topGuard);   // don't push top above the header
        const delta = Math.min(overflow, maxUp);
        if (delta > 1) (listRef.current as any)?.scrollToOffset?.({ offset: cur + delta, animated: true });
    }, [scrollOffset, tabBarHeight, winHeight]);

    if (isLoading) {
        return (
            <View style={[styles.container, { padding: 16, gap: 10, paddingTop: contentPaddingTop + (header ? 0 : 16) }]}>
                {header}
                {Array.from({ length: 8 }).map((_, i) => (
                    <View
                        key={i}
                        style={{
                            flexDirection: 'row', alignItems: 'center', gap: 12,
                            paddingHorizontal: 16, paddingVertical: 14,
                            backgroundColor: colors.cardBackground, borderRadius: radius.lg,
                            borderWidth: 3, borderColor: 'transparent', borderLeftColor: colors.softAccent,
                        }}
                    >
                        <SkeletonBox width={24} height={24} borderRadius={6} />
                        <SkeletonBox width={180} height={15} borderRadius={7} style={{ flex: 1 }} />
                        <SkeletonBox width={16} height={16} borderRadius={4} />
                    </View>
                ))}
            </View>
        );
    }

    // NOTHING TO SHOW AND A FAILED LOAD → say so and offer the retry. The old
    // behaviour was a silent empty list that could only be fixed by restarting
    // the app (the fetch never ran again).
    if (isError && l1Categories.length === 0) {
        return (
            <View style={[styles.container, styles.errorWrap, { paddingTop: contentPaddingTop + (header ? 0 : 16) }]}>
                {header}
                <Ionicons name="cloud-offline-outline" size={44} color={colors.textMuted} />
                <Text style={styles.errorText}>{t('catalog.loadFailed')}</Text>
                <TouchableOpacity
                    style={styles.errorBtn}
                    onPress={() => void refetch()}
                    disabled={isFetching}
                    activeOpacity={0.85}
                >
                    {isFetching
                        ? <MaterialProgress size="small" color={colors.onPrimary} />
                        : <Text style={styles.errorBtnText}>{t('discounts.retry')}</Text>}
                </TouchableOpacity>
            </View>
        );
    }

    return (
        <Animated.FlatList
            ref={listRef}
            {...scroll}
            style={styles.container}
            data={l1Categories}
            keyExtractor={(item: any) => item.id.toString()}
            contentInsetAdjustmentBehavior="never"
            contentContainerStyle={[styles.list, { paddingTop: contentPaddingTop + (header ? 0 : 16), paddingBottom: listPadBottom }]}
            scrollIndicatorInsets={{ bottom: tabBarHeight }}
            ListHeaderComponent={header ?? undefined}
            onLayout={() => { (listRef.current as any)?.measureInWindow?.((_x: number, y: number) => { if (y > 0) listTopRef.current = y; }); }}
            renderItem={({ item }) => (
                <L1Item
                    item={item}
                    isExpanded={expandedL1 === item.id}
                    l2={l2Map[item.id] ?? EMPTY_L2}
                    onToggle={toggleL1}
                    onSelectL2={onSelectL2}
                    onExpanded={onL1Expanded}
                    colors={colors}
                    styles={styles}
                />
            )}
            onScrollToIndexFailed={info => {
                // Not-yet-measured item: approximate, then settle.
                (listRef.current as any)?.scrollToOffset?.({ offset: info.averageItemLength * info.index, animated: true });
            }}
        />
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    errorWrap: { alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 },
    errorText: { fontSize: 15, color: c.textSecondary, textAlign: 'center' },
    errorBtn: {
        backgroundColor: c.primary, borderRadius: radius.pill,
        paddingHorizontal: 22, paddingVertical: 11, minWidth: 140, alignItems: 'center',
    },
    errorBtnText: { color: c.onPrimary, fontSize: 15, fontWeight: '700' },
    container: { flex: 1, backgroundColor: c.pageBackground },
    list: { paddingHorizontal: 16, paddingTop: 16, gap: 10 },
    l1Container: {
        backgroundColor: c.cardBackground,
        borderRadius: radius.lg,
        overflow: 'hidden',
        ...elevation.level1,
        borderWidth: 3, borderColor: 'transparent',
        borderLeftColor: c.softAccent,
    },
    l1ContainerExpanded: {
        borderLeftColor: c.primary,
    },
    l1Row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
    l1RowExpanded: {
        backgroundColor: c.softAccentWash,
    },
    l1Text: {
        fontSize: 15,
        fontWeight: '600',
        color: c.textPrimary,
        flex: 1,
    },
    l2Container: {
        borderTopWidth: 0.5,
        borderTopColor: c.softAccent,
    },
    l2Row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        paddingLeft: 24,
    },
    l2Text: {
        fontSize: 14,
        color: c.textPrimary,
        flex: 1,
    },
    divider: {
        height: 0.5,
        backgroundColor: c.softAccent,
        marginLeft: 24,
    },
    l1Icon: {
        fontSize: 20,
        marginRight: 12,
    },
});
