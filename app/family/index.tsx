import {
    View, Text, StyleSheet, FlatList, ScrollView, Pressable, TouchableOpacity,
    RefreshControl, Alert,
} from 'react-native';
import { useCallback, useMemo, useRef, useState, type ComponentProps } from 'react';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { ScreenBackButton } from '../../components/ScreenBackButton';
import { DockedGlassSheet } from '../../components/DockedGlassSheet';
import { DockTabsRow } from '../../components/FloatingPillTabBar';
import { ActionPill } from '../../components/dock/ActionPill';
import { ProductImage } from '../../components/ProductImage';
import { UserAvatar } from '../../components/UserAvatar';
import { TripCard } from '../../components/TripCard';
import { MaterialProgress } from '../../components/MaterialProgress';
import { formatItemAmount } from '../../utils/amountDisplay';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { fetchTrips, type TripSummary } from '../../utils/tripsApi';
import {
    fetchFamilyHousehold, fetchHouseholdLedger, fetchHouseholdHistory, confirmSettlement,
    type FamilyHousehold, type HouseholdLedgerView, type PendingSettlement,
    type HouseholdHistoryEntry, type HistoryEntryKind,
} from '../../utils/familyShoppingApi';
import {
    isAllSelected, isItemSelected, toggleItem, toggleSelectAll, pruneSelection, selectedCount,
    formatCents, formatBalanceCents, mayConfirmSettlement, buildFamilyFeed, buildMemberStrip,
    mergeHistoryPages, type FamilyFeedEntry,
} from '../../utils/familyShopping';
import { formatDayDate } from '../../utils/formatDayDate';
import { useTheme, spacing, radius, type AppTheme } from '../../constants/theme';

type Tab = 'basket' | 'history';

/** §5.2 history-row icon per ledger event kind. */
const HISTORY_ICONS: Record<HistoryEntryKind, ComponentProps<typeof Ionicons>['name']> = {
    receipt: 'cart-outline',
    settlement: 'checkmark',
    member_joined: 'person-add-outline',
    member_left: 'exit-outline',
    adjustment: 'create-outline',
};

/** GET /baskets/:id/items row — the fields this screen renders. */
interface FamilyBasketItem {
    id: number;
    productId: number;
    quantity: number;
    productName: string;
    isWeighable: boolean;
    canonicalUnit?: string | null;
    canonicalFamily?: string | null;
    canonicalStep?: number | null;
    imageUrls?: (string | null | undefined)[] | string | null;
}

/**
 * Family-shopping screen (spec §5) — the destination of the pinned card on the
 * Shopping tab. Basket tab: the shared family basket with §5.1's select-all
 * list and the "Parduotuvės ›" CTA. History tab: the member strip (balances
 * from the server-derived ledger — never recomputed here) over the family
 * transaction feed, with §3.2.1's counterparty-only settlement confirm.
 */
export default function FamilyScreen() {
    const colors = useTheme();
    const insets = useSafeAreaInsets();
    const router = useRouter();
    const { t, i18n } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [tab, setTab] = useState<Tab>('basket');

    // ── Data ──────────────────────────────────────────────────────────────
    const [myId, setMyId] = useState<string | null>(null);
    const [household, setHousehold] = useState<FamilyHousehold | null>(null);
    const [ledger, setLedger] = useState<HouseholdLedgerView | null>(null);
    const [trips, setTrips] = useState<TripSummary[]>([]);
    const [items, setItems] = useState<FamilyBasketItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    // §5.1 selection — the UNCHECKED set ("checked by default" = empty set).
    const [unchecked, setUnchecked] = useState<Set<number>>(new Set());
    const hasFetchedRef = useRef(false);

    // §5.2 past entries — accumulated keyset pages of /households/mine/history.
    const [history, setHistory] = useState<HouseholdHistoryEntry[]>([]);
    const [historyCursor, setHistoryCursor] = useState<string | null>(null);
    const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
    // Bumped on every full refresh so an in-flight older-page fetch from
    // before the refresh cannot append onto the new page-1.
    const historyGenRef = useRef(0);

    const fetchAll = useCallback(async () => {
        try {
            const gen = ++historyGenRef.current;
            const [uid, hh, lv, tripRes, histPage] = await Promise.all([
                getUserId().catch(() => null),
                fetchFamilyHousehold().catch(() => null),
                fetchHouseholdLedger().catch(() => null),
                fetchTrips().catch(() => [] as TripSummary[]),
                fetchHouseholdHistory().catch(() => undefined),
            ]);
            setMyId(uid);
            setHousehold(hh);
            setLedger(lv);
            setTrips(tripRes);
            // undefined = fetch failed → keep what we had; null = no household.
            if (histPage !== undefined && gen === historyGenRef.current) {
                setHistory(histPage?.entries ?? []);
                setHistoryCursor(histPage?.nextCursor ?? null);
            }
            const basketId = hh?.sharedBasketId ?? null;
            if (basketId != null) {
                const rows = await fetch(`${API_BASE_URL}/api/baskets/${basketId}/items`)
                    .then(r => r.json()).catch(() => []);
                const parsed: FamilyBasketItem[] = Array.isArray(rows)
                    ? rows.map((r: any) => ({ ...r, quantity: parseFloat(r.quantity), isWeighable: Number(r.isWeighable) === 1 }))
                    : [];
                setItems(parsed);
                // Keep the user's unchecks for surviving items; new items are
                // born checked (absent from the unchecked set).
                setUnchecked(prev => pruneSelection(prev, parsed.map(i => i.id)));
            } else {
                setItems([]);
            }
        } finally {
            setLoading(false);
        }
    }, []);

    useFocusEffect(useCallback(() => {
        if (!hasFetchedRef.current) setLoading(true);
        hasFetchedRef.current = true;
        void fetchAll();
    }, [fetchAll]));

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await fetchAll();
        setRefreshing(false);
    }, [fetchAll]);

    // Older history pages (infinite scroll). nextCursor == null means the log
    // is exhausted — onEndReached then does nothing and no footer renders.
    const loadMoreHistory = useCallback(async () => {
        if (historyCursor == null || historyLoadingMore) return;
        setHistoryLoadingMore(true);
        const gen = historyGenRef.current;
        try {
            const page = await fetchHouseholdHistory(historyCursor);
            if (page != null && gen === historyGenRef.current) {
                setHistory(prev => mergeHistoryPages(prev, page.entries));
                setHistoryCursor(page.nextCursor);
            }
        } catch {
            // Leave the cursor as-is — the next end-reach retries the page.
        } finally {
            setHistoryLoadingMore(false);
        }
    }, [historyCursor, historyLoadingMore]);

    // ── Derived ───────────────────────────────────────────────────────────
    const itemIds = useMemo(() => items.map(i => i.id), [items]);
    const allSelected = isAllSelected(items.length, unchecked);
    const nSelected = selectedCount(itemIds, unchecked);

    const memberLabel = useCallback((userId: string): string => {
        const m = household?.members.find(mm => mm.userId === userId);
        return m?.label ?? (userId === myId ? t('family.you') : t('family.member'));
    }, [household, myId, t]);

    const strip = useMemo(
        () => buildMemberStrip(household?.members ?? [], ledger, t('family.member')),
        [household, ledger, t]);

    // Settlements confirmed in THIS session — suppresses the live pending row
    // in the window before the refetched ledger + history land (afterwards the
    // history feed's own `settlement` entry is the row).
    const [confirmedNow, setConfirmedNow] = useState<Set<string>>(new Set());

    const feed = useMemo(
        () => buildFamilyFeed(trips, ledger, household?.sharedBasketId ?? null, history, confirmedNow),
        [trips, ledger, household, history, confirmedNow]);
    const [confirmBusy, setConfirmBusy] = useState<string | null>(null);
    const onConfirmSettlement = useCallback(async (s: PendingSettlement) => {
        if (confirmBusy) return;
        setConfirmBusy(s.settlementId);
        try {
            await confirmSettlement(s.settlementId);
            setConfirmedNow(prev => new Set(prev).add(s.settlementId));
            await fetchAll(); // balances moved — re-read the ledger
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('family.confirmError'));
        } finally {
            setConfirmBusy(null);
        }
    }, [confirmBusy, fetchAll, t]);

    // §5.1 CTA — into the shared basket's existing stores flow (basket detail
    // owns comparison/location; a selection subset has no server mechanism yet,
    // so the CTA is gated on having ANY selection and hands over the basket).
    const goToStores = useCallback(() => {
        const basketId = household?.sharedBasketId;
        if (basketId == null) return;
        router.push(`/basket/${basketId}` as any);
    }, [household, router]);

    // ── Basket tab ────────────────────────────────────────────────────────
    const renderItem = useCallback(({ item }: { item: FamilyBasketItem }) => {
        const checked = isItemSelected(unchecked, item.id);
        const amount = formatItemAmount(
            { ...item, unit: item.canonicalUnit ?? null } as any,
            (k: string) => t(k),
        );
        return (
            <Pressable
                style={styles.itemRow}
                onPress={() => setUnchecked(prev => toggleItem(prev, item.id))}
                accessibilityRole="checkbox"
                accessibilityState={{ checked }}
            >
                <Ionicons
                    name={checked ? 'checkbox' : 'square-outline'}
                    size={24}
                    color={checked ? colors.primary : colors.textMuted}
                />
                <ProductImage uris={item.imageUrls} imageStyle={styles.itemImage} placeholderStyle={styles.itemImage} />
                <View style={styles.itemBody}>
                    <Text style={styles.itemName} numberOfLines={2}>{item.productName}</Text>
                    {amount !== '' && <Text style={styles.itemMeta}>{amount}</Text>}
                </View>
            </Pressable>
        );
    }, [unchecked, styles, colors, t]);

    const basketHeader = items.length > 0 ? (
        <Pressable
            style={styles.selectAllRow}
            onPress={() => setUnchecked(prev => toggleSelectAll(prev, itemIds))}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: allSelected }}
        >
            <Ionicons
                name={allSelected ? 'checkbox' : 'square-outline'}
                size={24}
                color={allSelected ? colors.primary : colors.textMuted}
            />
            <Text style={styles.selectAllText}>{t('family.selectAll')}</Text>
            <Text style={styles.selectAllCount}>{nSelected}/{items.length}</Text>
        </Pressable>
    ) : null;

    const basketEmpty = (
        <View style={styles.emptyBox}>
            <Ionicons name="cart-outline" size={48} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>{t('family.emptyBasket')}</Text>
            <Text style={styles.emptySub}>{t('family.emptyBasketBody')}</Text>
        </View>
    );

    // ── History tab ───────────────────────────────────────────────────────
    const memberStrip = strip.length > 0 ? (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.stripScroll}
            contentContainerStyle={styles.stripRow}
        >
            {strip.map(m => (
                <View key={m.userId} style={[styles.memberCard, m.suggested && styles.memberCardSuggested]}>
                    {m.suggested && (
                        <View style={styles.suggestedBadge}>
                            <Ionicons name="cart" size={10} color={colors.onPrimary} />
                            <Text style={styles.suggestedBadgeText}>{t('family.nextShopper')}</Text>
                        </View>
                    )}
                    <UserAvatar name={m.label} color={m.avatarColor} size={44} />
                    <Text style={styles.memberName} numberOfLines={1}>
                        {m.userId === myId ? t('family.you') : m.label}
                    </Text>
                    <Text
                        style={[
                            styles.memberBalance,
                            m.balanceCents < 0 && { color: colors.error },
                            m.balanceCents > 0 && { color: colors.success },
                        ]}
                    >
                        {formatBalanceCents(m.balanceCents)}
                    </Text>
                    {m.leaving && <Text style={styles.memberLeaving}>{t('family.leavingTag')}</Text>}
                </View>
            ))}
        </ScrollView>
    ) : null;

    const renderFeedEntry = useCallback(({ item: entry }: { item: FamilyFeedEntry }) => {
        switch (entry.kind) {
            case 'settlement': {
                // Always genuinely PENDING here — once confirmed, the builder
                // drops this row and the history `settlement` entry takes over.
                const s = entry.settlement;
                const canConfirm = mayConfirmSettlement(s, myId);
                return (
                    <View style={styles.eventCard}>
                        <View style={styles.eventIcon}>
                            <Ionicons name="swap-horizontal" size={18} color={colors.primary} />
                        </View>
                        <View style={styles.eventBody}>
                            <Text style={styles.eventTitle}>
                                {t('family.settlementEntry', {
                                    from: memberLabel(s.from), to: memberLabel(s.to),
                                    amount: formatCents(s.amountCents),
                                })}
                            </Text>
                            {!canConfirm && (
                                <Text style={styles.eventMeta}>{t('family.awaitingConfirm')}</Text>
                            )}
                        </View>
                        {canConfirm && (
                            <TouchableOpacity
                                style={styles.confirmBtn}
                                onPress={() => onConfirmSettlement(s)}
                                disabled={confirmBusy != null}
                            >
                                {confirmBusy === s.settlementId
                                    ? <MaterialProgress size="small" color={colors.onPrimary} />
                                    : <Text style={styles.confirmBtnText}>{t('family.confirm')}</Text>}
                            </TouchableOpacity>
                        )}
                    </View>
                );
            }
            case 'leaving':
                return (
                    <View style={styles.eventCard}>
                        <View style={styles.eventIcon}>
                            <Ionicons name="exit-outline" size={18} color={colors.primary} />
                        </View>
                        <View style={styles.eventBody}>
                            <Text style={styles.eventTitle}>
                                {t('family.leavingEntry', { name: memberLabel(entry.userId) })}
                            </Text>
                        </View>
                    </View>
                );
            case 'pendingTrip':
                // §5.2 — a started trip with no receipt: no amount, no balances,
                // no CTA; just "X is shopping…" live state.
                return (
                    <TripCard
                        trip={entry.trip}
                        ctaLabel={null}
                        statusLine={t('family.shoppingNow', { name: memberLabel(entry.trip.ownerUserId) })}
                        onPress={() => {}}
                    />
                );
            case 'trip':
                // Resolved (receipt uploaded) → "Stats ›", openable by any member.
                return (
                    <TripCard
                        trip={entry.trip}
                        ctaLabel={t('family.statsCta')}
                        onPress={() => router.push(`/trip/receipts/${entry.trip.id}?tab=stats` as any)}
                    />
                );
            case 'history': {
                // §5.2 past entry. `title` is the server-rendered sentence
                // WITHOUT money; the amount fills the card's own slot so
                // formatting stays in formatCents (integer cents in, always).
                const h = entry.entry;
                const icon = HISTORY_ICONS[h.kind] ?? 'time-outline';
                const settled = h.kind === 'settlement';
                const meta = [formatDayDate(h.at, i18n.language), h.subtitle]
                    .filter(Boolean).join(' · ');
                return (
                    <View style={styles.eventCard}>
                        <View style={[styles.eventIcon, settled && styles.eventIconDone]}>
                            <Ionicons name={icon} size={18} color={settled ? colors.onPrimary : colors.primary} />
                        </View>
                        <View style={styles.eventBody}>
                            <Text style={styles.eventTitle}>{h.title}</Text>
                            {meta !== '' && <Text style={styles.eventMeta}>{meta}</Text>}
                        </View>
                        {h.amountCents != null && (
                            <Text style={styles.eventAmount}>{formatCents(h.amountCents)}</Text>
                        )}
                    </View>
                );
            }
        }
    }, [confirmBusy, myId, memberLabel, onConfirmSettlement, router, styles, colors, t, i18n.language]);

    const historyEmpty = (
        <View style={styles.emptyBox}>
            <Ionicons name="time-outline" size={48} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>{t('family.historyEmpty')}</Text>
            <Text style={styles.emptySub}>{t('family.historyEmptyBody')}</Text>
        </View>
    );

    // ── Layout ────────────────────────────────────────────────────────────
    // Clear the floating dock: its bottom float (≈26) + bar height + margin.
    const listBottomPad = insets.bottom + 132;
    const refreshControl = (
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} tintColor={colors.primary} />
    );

    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
                <View style={styles.chrome}>
                    <ScreenBackButton />
                    <Text style={styles.title} numberOfLines={1}>{t('family.screenTitle')}</Text>
                </View>

                {loading ? (
                    <View style={styles.centered}>
                        <MaterialProgress size="large" color={colors.primary} />
                    </View>
                ) : tab === 'basket' ? (
                    <FlatList
                        data={items}
                        keyExtractor={(it) => String(it.id)}
                        renderItem={renderItem}
                        ListHeaderComponent={basketHeader}
                        ListEmptyComponent={basketEmpty}
                        contentContainerStyle={[styles.list, { paddingBottom: listBottomPad }]}
                        refreshControl={refreshControl}
                    />
                ) : (
                    <FlatList
                        data={feed}
                        keyExtractor={(e) => e.key}
                        renderItem={renderFeedEntry}
                        ListHeaderComponent={memberStrip}
                        ListEmptyComponent={historyEmpty}
                        ListFooterComponent={historyLoadingMore ? (
                            <View style={styles.historyFooter}>
                                <MaterialProgress size="small" color={colors.primary} />
                            </View>
                        ) : null}
                        onEndReached={() => { void loadMoreHistory(); }}
                        onEndReachedThreshold={0.4}
                        contentContainerStyle={[styles.list, { paddingBottom: listBottomPad }]}
                        refreshControl={refreshControl}
                    />
                )}
            </View>

            <DockedGlassSheet
                compact
                barRowHeight={0}
                barRow={
                    <View style={styles.dockRow}>
                        <DockTabsRow
                            hug
                            tabs={[
                                { key: 'basket', label: t('family.tabBasket'), icon: 'cart-outline' },
                                { key: 'history', label: t('family.tabHistory'), icon: 'time-outline' },
                            ]}
                            activeKey={tab}
                            onSelect={(k) => setTab(k as Tab)}
                        />
                        {/* §5.1 bottom bar, right: the pink stores CTA (shared
                            ActionPill) — basket tab only, disarmed with nothing
                            selected (you can't shop zero items). */}
                        {tab === 'basket' && items.length > 0 && (
                            <ActionPill
                                colors={colors}
                                label={t('family.storesCta')}
                                onPress={goToStores}
                                disabled={nSelected === 0 || household?.sharedBasketId == null}
                                chevron
                            />
                        )}
                    </View>
                }
            />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    chrome: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
    title: { flex: 1, fontSize: 22, fontWeight: '800', color: c.textPrimary },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    list: { paddingTop: 4 },

    // Dock bar: tabs left · (basket tab) pink CTA right, one glass pill.
    dockRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },

    // ── Basket tab (§5.1) ────────────────────────────────────────────────
    selectAllRow: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        paddingHorizontal: spacing.lg, paddingVertical: 12,
    },
    selectAllText: { flex: 1, fontSize: 15, fontWeight: '700', color: c.textPrimary },
    selectAllCount: { fontSize: 13, fontWeight: '600', color: c.textSecondary },
    itemRow: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        backgroundColor: c.cardBackground, borderRadius: radius.lg,
        marginHorizontal: spacing.lg, marginBottom: 8, padding: 10,
    },
    itemImage: { width: 44, height: 44, borderRadius: radius.md, backgroundColor: c.surfaceMuted },
    itemBody: { flex: 1, minWidth: 0, gap: 2 },
    itemName: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    itemMeta: { fontSize: 12, color: c.textSecondary },

    // ── History tab (§5.2) ───────────────────────────────────────────────
    stripScroll: { flexGrow: 0, marginBottom: spacing.md },
    stripRow: { paddingHorizontal: spacing.lg, gap: spacing.md },
    memberCard: {
        alignItems: 'center', gap: 4,
        backgroundColor: c.cardBackground, borderRadius: radius.lg,
        paddingHorizontal: 14, paddingVertical: 12, minWidth: 104,
        borderWidth: 1.5, borderColor: 'transparent',
    },
    // The suggested next shopper (most negative balance) — visually marked.
    memberCardSuggested: { borderColor: c.primary, backgroundColor: c.primaryMuted ?? c.surfaceMuted },
    suggestedBadge: {
        flexDirection: 'row', alignItems: 'center', gap: 3,
        backgroundColor: c.primary, borderRadius: radius.pill,
        paddingHorizontal: 7, paddingVertical: 2, marginBottom: 2,
    },
    suggestedBadgeText: { fontSize: 9, fontWeight: '900', color: c.onPrimary, letterSpacing: 0.3 },
    memberName: { fontSize: 13, fontWeight: '700', color: c.textPrimary, maxWidth: 110 },
    memberBalance: { fontSize: 13, fontWeight: '800', color: c.textSecondary },
    memberLeaving: { fontSize: 10, fontWeight: '700', color: c.textMuted },

    // Settlement / departure feed entries.
    eventCard: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        backgroundColor: c.cardBackground, borderRadius: radius.lg,
        marginHorizontal: spacing.lg, marginBottom: 10, padding: 12,
    },
    eventIcon: {
        width: 34, height: 34, borderRadius: 17,
        backgroundColor: c.primaryMuted ?? c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center',
    },
    eventIconDone: { backgroundColor: c.primary },
    eventBody: { flex: 1, minWidth: 0, gap: 2 },
    eventTitle: { fontSize: 13.5, fontWeight: '600', color: c.textPrimary },
    eventMeta: { fontSize: 12, color: c.textSecondary },
    // The history card's own amount slot — the server title carries no money.
    eventAmount: { fontSize: 14, fontWeight: '800', color: c.textPrimary, paddingLeft: 4 },
    historyFooter: { paddingVertical: 16, alignItems: 'center' },
    confirmBtn: {
        backgroundColor: c.primary, borderRadius: radius.pill,
        paddingHorizontal: 14, paddingVertical: 8,
        alignItems: 'center', justifyContent: 'center', minWidth: 92,
    },
    confirmBtnText: { fontSize: 13, fontWeight: '800', color: c.onPrimary },

    emptyBox: { alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.xl, paddingTop: 64 },
    emptyTitle: { fontSize: 16, fontWeight: '800', color: c.textPrimary, textAlign: 'center' },
    emptySub: { fontSize: 13, color: c.textSecondary, textAlign: 'center', lineHeight: 18 },
});
