import {
    View,
    FlatList,
    TouchableOpacity,
    Text,
    StyleSheet,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../config/api';
import { useBasketSession } from '../../state/basketSession';
import { useTheme, radius, elevation, type AppTheme } from '../../constants/theme';
import { categoryIcon } from '../../constants/categoryIcons';
import { useSafeBottomTabBarHeight } from '../../hooks/useSafeBottomTabBarHeight';
import { SkeletonBox } from '../SkeletonBox';

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

const L1Item = memo(function L1Item({ item, isExpanded, l2, onToggle, onSelectL2, colors, styles }: {
    item: Category;
    isExpanded: boolean;
    l2: Category[];
    onToggle: (id: number) => void;
    onSelectL2: (l2: Category) => void;
    colors: AppTheme;
    styles: ReturnType<typeof makeStyles>;
}) {
    const contentHeightRef = useRef(0);
    const animatedHeight = useSharedValue(0);
    const chevronRotation = useSharedValue(0);

    useLayoutEffect(() => {
        animatedHeight.value = withTiming(isExpanded ? contentHeightRef.current : 0, {
            duration: 220,
            easing: Easing.inOut(Easing.quad),
        });
        chevronRotation.value = withTiming(isExpanded ? 1 : 0, { duration: 220 });
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
                animatedHeight.value = withTiming(h, { duration: 150 });
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
        <View style={[styles.l1Container, isExpanded && styles.l1ContainerExpanded]}>
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
    /** Top padding to reserve for an overlaying collapsing header. */
    contentPaddingTop?: number;
}

export function CategoriesList({ onSelectL2, header, scroll, contentPaddingTop = 0 }: Props) {
    const colors = useTheme();
    const { i18n } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    // Exact bottom tab bar clearance (NativeTabs folds the bar into the safe-area
    // inset on iOS; @react-navigation context on Android) + a small breather, so
    // the last L1 row sits just above the bar on every device. No FAB here, so no
    // extra reserve.
    const tabBarHeight = useSafeBottomTabBarHeight();
    const listPadBottom = tabBarHeight + 8;
    const [l1Categories, setL1Categories] = useState<Category[]>([]);
    const [l2Map, setL2Map] = useState<Record<number, Category[]>>({});
    const [expandedL1, setExpandedL1] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    // Publish the list ref so the basket dock's Pan can block this scroll while
    // a drag starts on the bar (else the list steals the gesture).
    const listRef = useRef(null);
    useEffect(() => {
        useBasketSession.getState().setBrowseListRef(listRef);
        return () => useBasketSession.getState().setBrowseListRef(null);
    }, []);

    // Load L1 + ALL L2 in two parallel requests (was 1 + N: one subcategory
    // call per L1). `/api/categories/l2` returns every L2 with its
    // parentCategoryId, so we group client-side. Both finish before `loading`
    // clears, so every L1 already has its L2 in hand → expanding is instant,
    // never a spinner. Re-fetch on language change; the AbortController keeps a
    // late 'lt' response (first launch boots 'lt', then flips to the persisted
    // language) from overwriting fresh 'en' data.
    useEffect(() => {
        let cancelled = false;
        const ctrl = new AbortController();
        Promise.all([
            fetch(`${API_BASE_URL}/api/categories`, { signal: ctrl.signal }).then(r => r.json()),
            fetch(`${API_BASE_URL}/api/categories/l2`, { signal: ctrl.signal }).then(r => r.json()),
        ])
            .then(([l1, l2]: [Category[], Category[]]) => {
                if (cancelled) return;
                setL1Categories(Array.isArray(l1) ? l1 : []);
                const map: Record<number, Category[]> = {};
                (Array.isArray(l2) ? l2 : []).forEach(cat => {
                    if (cat.parentCategoryId == null) return;
                    (map[cat.parentCategoryId] ??= []).push(cat);
                });
                setL2Map(map);
            })
            .catch((err: any) => {
                if (err?.name !== 'AbortError') console.warn('[browse] categories fetch failed:', err);
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; ctrl.abort(); };
    }, [i18n.language]);

    const toggleL1 = useCallback((id: number) => {
        // An expanded basket dock gets out of the way when the user starts
        // interacting with the page (spec: L1 toggle / scroll collapse it).
        useBasketSession.getState().collapseDock?.();
        setExpandedL1(prev => prev === id ? null : id);
    }, []);

    if (loading) {
        return (
            <View style={[styles.container, { padding: 16, gap: 10, paddingTop: contentPaddingTop + 16 }]}>
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

    return (
        <Animated.FlatList
            ref={listRef}
            {...scroll}
            onScrollBeginDrag={() => { useBasketSession.getState().collapseDock?.(); }}
            style={styles.container}
            data={l1Categories}
            keyExtractor={(item: any) => item.id.toString()}
            contentInsetAdjustmentBehavior="never"
            contentContainerStyle={[styles.list, { paddingTop: contentPaddingTop + 16, paddingBottom: listPadBottom }]}
            scrollIndicatorInsets={{ bottom: tabBarHeight }}
            ListHeaderComponent={header ?? undefined}
            renderItem={({ item }) => (
                <L1Item
                    item={item}
                    isExpanded={expandedL1 === item.id}
                    l2={l2Map[item.id] ?? EMPTY_L2}
                    onToggle={toggleL1}
                    onSelectL2={onSelectL2}
                    colors={colors}
                    styles={styles}
                />
            )}
        />
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
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
