/**
 * Apsipirkimai tab — Souply 2.0 interim: the baskets accordion, relabeled.
 * Phase 4 rebuilds this into the trips list (stage-derived cards); the
 * Šablonai chip view moved to its own tab in Phase 2.
 */
import {
    View,
    Text,
    ScrollView,
    TouchableOpacity,
    StyleSheet,
    RefreshControl,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, memo } from 'react';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { glassHeaderOptions } from '../../../constants/navHeader';
import { ScreenHeading } from '../../../components/ScreenHeading';
import { useCollapsingHeader, CollapsingHeader } from '../../../components/CollapsingHeader';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../../config/api';
import { coverEmoji } from '../../../utils/templateCover';
import { useSafeBottomTabBarHeight } from '../../../hooks/useSafeBottomTabBarHeight';
import { useAuthState } from '../../../state/authState';
import { getUserId } from '../../../config/user';
import { useBasketState } from '../../../state/basketState';
import { useTheme, radius, type AppTheme } from '../../../constants/theme';
import { ScalePressable } from '../../../components/ScalePressable';
import { SkeletonBox } from '../../../components/SkeletonBox';
import { formatDate, formatEuro } from '../../../utils/formatCurrency';

interface Basket {
    id: number;
    userId: string;
    status: string;
    name: string | null;
    createdAt: string;
    updatedAt: string;
    itemCount: number;
    /** Sum of (price × quantity) for the ShoppingList tied to this basket,
     *  rounded to 2dp. Null for draft / compared baskets that haven't had
     *  a store selected yet. */
    selectedStoreTotal: string | number | null;
    /** Cheapest store's total from the most recent comparison run.
     *  Drives the "nuo €X" line on compared baskets. */
    cheapestTotal: string | number | null;
    /** 1 once the user has changed items/amounts after creation — drives the
     *  "Redaguota" chip (this basket diverged from the creator's original). */
    userEditedAfterCreation?: 0 | 1;
    /** Inherited identity from the source template (null for manual baskets). */
    templateCoverColor?: string | null;
    templateCoverImage?: { kind: 'preset'; iconKey: string } | { kind: 'emoji'; emoji: string } | null;
    templateCreatorHandle?: string | null;
    templateName?: string | null;
}

type BasketStatus = 'draft' | 'compared' | 'inProgress' | 'completed';

const STATUS_PRIORITY: BasketStatus[] = ['draft', 'compared', 'inProgress', 'completed'];

/**
 * Accordion section with the same animation feel as Narsyti's L1 categories.
 * Mirrors the ghost-view-measures-natural-height pattern from
 * app/(tabs)/browse/index.tsx — Reanimated shared values drive a height
 * tween + chevron rotation, both 220 ms with `Easing.inOut(quad)`.
 */
const BasketSection = memo(function BasketSection({
    status, label, count, isExpanded, isEmpty, onToggle, children, styles, colors,
}: {
    status: BasketStatus;
    label: string;
    count: number;
    isExpanded: boolean;
    isEmpty: boolean;
    onToggle: (status: BasketStatus) => void;
    children: React.ReactNode;
    styles: ReturnType<typeof makeStyles>;
    colors: AppTheme;
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

    // Ghost view measurement — absolutely positioned + invisible. Whenever
    // its layout fires, we capture the natural content height and, if the
    // section is currently expanded, retarget the animation to match.
    const handleLayout = (e: { nativeEvent: { layout: { height: number } } }) => {
        const h = e.nativeEvent.layout.height;
        if (h > 0 && h !== contentHeightRef.current) {
            contentHeightRef.current = h;
            if (isExpanded) {
                animatedHeight.value = withTiming(h, { duration: 150 });
            }
        }
    };

    return (
        <View style={styles.section}>
            <TouchableOpacity
                style={[styles.sectionHeader, isExpanded && styles.sectionHeaderOpen]}
                onPress={() => !isEmpty && onToggle(status)}
                activeOpacity={isEmpty ? 1 : 0.7}
            >
                <Text style={[styles.sectionHeaderTitle, isEmpty && styles.sectionHeaderMuted]}>
                    {label}
                </Text>
                <Text style={[styles.sectionHeaderCount, isEmpty && styles.sectionHeaderMuted]}>
                    {count}
                </Text>
                {!isEmpty && (
                    <Animated.View style={[chevronStyle, { marginLeft: 8 }]}>
                        <Ionicons name="chevron-down" size={18} color={colors.textSecondary} />
                    </Animated.View>
                )}
            </TouchableOpacity>
            {/* Ghost view that the layout pass uses to measure natural content
                height. Absolutely positioned so its size doesn't push the
                surrounding layout while it measures. */}
            <View
                style={{ position: 'absolute', opacity: 0, left: 0, right: 0 }}
                pointerEvents="none"
                onLayout={handleLayout}
            >
                {children}
            </View>
            <Animated.View style={animatedContentStyle}>
                {children}
            </Animated.View>
        </View>
    );
});

export default function BasketScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const header = useCollapsingHeader();
    const insets = useSafeAreaInsets();
    const tabBarHeight = useSafeBottomTabBarHeight();
    const { setDraftBasketId } = useBasketState();
    // Own/private-template baskets attribute to the current user's handle when
    // the server hasn't a DB username for the owner yet.
    const authUsername = useAuthState((s: any) => s.user?.username ?? null);

    const [baskets, setBaskets] = useState<Basket[]>([]);
    // `loading` = full-screen spinner on FIRST mount only.
    // `refreshing` = small header pill shown on subsequent focus refetches
    // so the list doesn't blank out every time the tab regains focus.
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [pullRefreshing, setPullRefreshing] = useState(false);

    // Set of expanded section statuses. Multi-expand: users can open all,
    // close all, or any combination. Initial state is empty; the
    // auto-expand effect below picks the priority section once baskets
    // have loaded.
    const [expandedSet, setExpandedSet] = useState<Set<BasketStatus>>(() => new Set());

    const hasFetchedRef = useRef(false);
    // Auto-expand the priority section the first time baskets land, but
    // never again — subsequent fetches must not stomp the user's manual
    // expand/collapse state. A ref is the simplest way to gate this once.
    const autoExpandedRef = useRef(false);

    const fetchAll = useCallback(async (silent: boolean) => {
        if (silent) setRefreshing(true);
        try {
            const userId = await getUserId();
            const basketRes = await fetch(`${API_BASE_URL}/api/baskets/user/${userId}`)
                .then(r => r.json()).catch(() => []);
            const basketList: Basket[] = Array.isArray(basketRes) ? basketRes : [];
            setBaskets(basketList);
            const draft = basketList.find(b => b.status === 'draft');
            setDraftBasketId(draft ? draft.id : null);
        } catch (error) {
            console.error('Failed to fetch baskets:', error);
        } finally {
            if (silent) setRefreshing(false);
            setLoading(false);
        }
    }, [setDraftBasketId]);

    useFocusEffect(useCallback(() => {
        const silent = hasFetchedRef.current;
        hasFetchedRef.current = true;
        fetchAll(silent);
    }, [fetchAll]));

    // Basket lifecycle is exactly four states: draft (editable), compared
    // (calculated, read-only until reverted), inProgress (shopping list
    // created, basket locked), completed (shopping wrapped up). The per-
    // card status badge is gone (status is communicated by accordion
    // section), but the label lookup stays — section headers reuse it.
    const getStatusText = (status: string) => {
        switch (status) {
            case 'draft': return t('basketTab.statusDraft');
            case 'compared': return t('basketTab.statusCompared');
            case 'inProgress': return t('basketTab.statusInProgress');
            case 'completed': return t('basketTab.statusCompleted');
            default: return status;
        }
    };

    // ─── Grouping for the accordion ───────────────────────────────────────
    const grouped = useMemo<Record<BasketStatus, Basket[]>>(() => {
        const map: Record<BasketStatus, Basket[]> = {
            draft: [], compared: [], inProgress: [], completed: [],
        };
        baskets.forEach(b => {
            if (b.status in map) map[b.status as BasketStatus].push(b);
        });
        return map;
    }, [baskets]);

    // On first non-empty load, open the priority section so the user lands on
    // something meaningful. After that, expand/collapse is manual — including
    // the option to collapse everything — with ONE correction: a section that
    // becomes empty (e.g. a draft just got compared) is dropped from the open
    // set, and if that leaves nothing open we fall back to the topmost
    // non-empty section. Otherwise the previously-expanded "Drafts" would stay
    // open showing "0" while the populated "Compared" section sits collapsed.
    useEffect(() => {
        if (baskets.length === 0) return;
        setExpandedSet(prev => {
            if (!autoExpandedRef.current) {
                autoExpandedRef.current = true;
                const first = STATUS_PRIORITY.find(s => grouped[s].length > 0);
                return first ? new Set([first]) : prev;
            }
            // Later loads: keep only sections that still have rows.
            const pruned = new Set([...prev].filter(s => grouped[s].length > 0));
            // If pruning emptied a set the user had open (a status transition,
            // not a manual collapse-all), reopen the topmost non-empty section.
            if (pruned.size === 0 && prev.size > 0) {
                const first = STATUS_PRIORITY.find(s => grouped[s].length > 0);
                if (first) pruned.add(first);
            }
            return pruned;
        });
    }, [baskets, grouped]);

    const hasAnyBaskets = baskets.length > 0;

    const handleSectionTap = useCallback((status: BasketStatus) => {
        if (grouped[status].length === 0) return;
        setExpandedSet(prev => {
            const next = new Set(prev);
            if (next.has(status)) next.delete(status); else next.add(status);
            return next;
        });
    }, [grouped]);

    if (loading) return (
        <View style={styles.container}>
            <Stack.Screen options={glassHeaderOptions()} />
            <ScreenHeading title={t('tabs.trips')} topInset={insets.top} />
            <View style={{ padding: 16, gap: 12 }}>
                {Array.from({ length: 4 }).map((_, i) => (
                    <SkeletonBox key={i} width="100%" height={48} borderRadius={10} />
                ))}
            </View>
        </View>
    );

    return (
        <View style={styles.container}>
            <CollapsingHeader
                controller={header}
                background={colors.cardBackground}
                collapsing={<ScreenHeading title={t('tabs.trips')} />}
                pinned={refreshing ? (
                    <View style={styles.refreshingBanner}>
                        <MaterialProgress size="small" color={colors.primary} />
                        <Text style={styles.refreshingText}>{t('basketTab.loading')}</Text>
                    </View>
                ) : null}
            />
            <Animated.ScrollView
                {...header.scroll}
                contentInsetAdjustmentBehavior="never"
                contentContainerStyle={[styles.list, { paddingTop: header.paddingTop + 12, paddingBottom: tabBarHeight + 24 }]}
                refreshControl={
                    <RefreshControl
                        refreshing={pullRefreshing}
                        onRefresh={async () => { setPullRefreshing(true); await fetchAll(false); setPullRefreshing(false); }}
                        colors={[colors.primary]}
                        tintColor={colors.primary}
                    />
                }
            >
                {/* Accordion sections — rendered inline so LayoutAnimation's
                    parent re-flow drives a real height transition. FlatList's
                    virtualized item renderer doesn't propagate layout changes
                    cleanly enough for the animation to show. */}
                {!hasAnyBaskets ? (
                    <View style={styles.centered}>
                        <Ionicons name="cart-outline" size={56} color={colors.textMuted} />
                        <Text style={styles.emptyText}>{t('basketTab.empty')}</Text>
                        <Text style={styles.emptySubText}>{t('basketTab.emptyBody')}</Text>
                        <ScalePressable style={styles.emptyButton} onPress={() => router.navigate('/(tabs)/browse' as any)}>
                            <Text style={styles.emptyButtonText}>{t('basketTab.emptyCta')}</Text>
                        </ScalePressable>
                    </View>
                ) : (
                    STATUS_PRIORITY.map(status => {
                        const rows = grouped[status];
                        const isOpen = expandedSet.has(status);
                        const isEmpty = rows.length === 0;
                        return (
                            <BasketSection
                                key={`s-${status}`}
                                status={status}
                                label={getStatusText(status)}
                                count={rows.length}
                                isExpanded={isOpen}
                                isEmpty={isEmpty}
                                onToggle={handleSectionTap}
                                styles={styles}
                                colors={colors}
                            >
                                {rows.map(b => {
                                    const selected = b.selectedStoreTotal != null
                                        ? Number(b.selectedStoreTotal)
                                        : null;
                                    const cheapest = b.cheapestTotal != null
                                        ? Number(b.cheapestTotal)
                                        : null;
                                    const showSelected =
                                        (b.status === 'inProgress' || b.status === 'completed')
                                        && Number.isFinite(selected) && (selected as number) > 0;
                                    const showCheapest =
                                        b.status === 'compared'
                                        && Number.isFinite(cheapest) && (cheapest as number) > 0;
                                    const basketEmoji = coverEmoji(b.templateCoverImage ?? null);
                                    const basketTitle = b.templateName ?? b.name ?? formatDate(b.updatedAt);
                                    // True only while the title is a real name (template or
                                    // user-given) rather than the date fallback — so we don't
                                    // print the date twice on a nameless regular basket.
                                    const hasExplicitTitle = !!(b.templateName || b.name);
                                    const fromTpl = !!(b.templateName || b.templateCoverColor);
                                    const basketHandle = b.templateCreatorHandle ?? (fromTpl ? authUsername : null);
                                    // "Redaguota" only makes sense while the basket is still tied
                                    // to a template (diverged from the creator's original). Once
                                    // the template is gone it's just a regular basket.
                                    const edited = fromTpl && b.userEditedAfterCreation === 1;
                                    return (
                                        <TouchableOpacity
                                            key={b.id}
                                            style={[styles.card, b.templateCoverColor ? { borderWidth: 4, borderColor: 'transparent', borderLeftColor: b.templateCoverColor } : null]}
                                            onPress={() => router.push(`/basket/${b.id}`)}
                                        >
                                            <View style={styles.cardLeft}>
                                                <View style={styles.iconContainer}>
                                                    {/* Inherited cover emoji (template-derived baskets) or
                                                        the default cart icon (manual baskets). */}
                                                    {basketEmoji
                                                        ? <Text style={styles.basketEmoji}>{basketEmoji}</Text>
                                                        : <Ionicons name="cart-outline" size={28} color={colors.primary} />}
                                                    {b.itemCount > 0 && (
                                                        <View style={styles.badge}>
                                                            <Text style={styles.badgeText}>{b.itemCount}</Text>
                                                        </View>
                                                    )}
                                                </View>
                                            </View>
                                            <View style={styles.cardContent}>
                                                <View style={styles.titleRow}>
                                                    <Text style={styles.cardTitle} numberOfLines={1}>{basketTitle}</Text>
                                                    {edited && (
                                                        <View style={styles.editedChip}>
                                                            <Text style={styles.editedChipText}>{t('basketTab.edited')}</Text>
                                                        </View>
                                                    )}
                                                </View>
                                                {/* Sub-line: @handle for template baskets; the date
                                                    only when the title is a real name (else it'd repeat
                                                    the date already shown as the title). */}
                                                {basketHandle
                                                    ? <Text style={styles.attrib} numberOfLines={1}>@{basketHandle}</Text>
                                                    : hasExplicitTitle
                                                        ? <Text style={styles.cardDate}>{formatDate(b.updatedAt)}</Text>
                                                        : null}
                                            </View>
                                            {showSelected && (
                                                <Text style={styles.cardTotal}>{formatEuro(selected as number)}</Text>
                                            )}
                                            {showCheapest && (
                                                <Text style={styles.cardTotal}>
                                                    {t('basketTab.fromPrice', { amount: formatEuro(cheapest as number) })}
                                                </Text>
                                            )}
                                        </TouchableOpacity>
                                    );
                                })}
                            </BasketSection>
                        );
                    })
                )}
            </Animated.ScrollView>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    list: { padding: 16 },

    // ── Accordion section ─────────────────────────────────────────────────
    // Outer section: holds the border + corner clipping. Header lives flush
    // inside the top, expandable content + cards inside the bottom. The
    // overflow:'hidden' is what gives us the matching bottom rounding the
    // header has on top.
    section: {
        marginBottom: 10,
        borderRadius: radius.lg, overflow: 'hidden',
        borderWidth: 1, borderColor: c.border,
        backgroundColor: c.cardBackground,
    },
    sectionHeader: {
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: 14, paddingVertical: 12,
        backgroundColor: c.cardBackground,
    },
    sectionHeaderOpen: {
        borderBottomWidth: 0.5, borderBottomColor: c.borderSubtle,
    },
    sectionHeaderTitle: { flex: 1, fontSize: 14, fontWeight: '700', color: c.textPrimary },
    sectionHeaderCount: { fontSize: 13, fontWeight: '600', color: c.textSecondary },
    sectionHeaderMuted: { color: c.textMuted, fontWeight: '500' },

    // ── Basket card ───────────────────────────────────────────────────────
    card: {
        backgroundColor: c.cardBackground, padding: 14,
        flexDirection: 'row', alignItems: 'center',
        borderBottomWidth: 0.5, borderBottomColor: c.borderSubtle,
    },
    cardLeft: { marginRight: 12 },
    cardContent: { flex: 1, minWidth: 0 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    cardTitle: { fontSize: 15, fontWeight: '600', color: c.textPrimary, flexShrink: 1 },
    cardDate: { fontSize: 13, color: c.textSecondary, marginTop: 2 },
    cardTotal: { fontSize: 15, fontWeight: '700', color: c.primary, marginLeft: 8 },
    basketEmoji: { fontSize: 26 },
    attrib: { fontSize: 12, color: c.primary, fontWeight: '600', flexShrink: 1 },
    editedChip: { backgroundColor: c.surfaceMuted ?? c.border, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 2 },
    editedChipText: { fontSize: 10, fontWeight: '700', color: c.textSecondary, textTransform: 'uppercase', letterSpacing: 0.4 },

    // ── Empty ─────────────────────────────────────────────────────────────
    emptyText: { fontSize: 16, color: c.textSecondary, fontWeight: '600', marginTop: 16, textAlign: 'center' },
    emptySubText: { fontSize: 13, color: c.textMuted, marginTop: 6, textAlign: 'center', lineHeight: 18 },
    emptyButton: { marginTop: 20, backgroundColor: c.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: radius.pill },
    emptyButtonText: { color: c.onPrimary, fontWeight: '700', fontSize: 14 },

    // ── Misc ──────────────────────────────────────────────────────────────
    iconContainer: {
        position: 'relative',
        width: 36, height: 36,
        alignItems: 'center', justifyContent: 'center',
    },
    badge: {
        position: 'absolute', top: -4, right: -6,
        backgroundColor: c.primary, borderRadius: radius.pill,
        minWidth: 18, height: 18,
        alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
    },
    badgeText: { color: c.onPrimary, fontSize: 10, fontWeight: '700' },
    refreshingBanner: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: 6, paddingVertical: 4,
        backgroundColor: c.surfaceSubtle,
    },
    refreshingText: { fontSize: 11, color: c.textSecondary, fontWeight: '500' },
});
