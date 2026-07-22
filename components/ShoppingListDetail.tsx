import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    Alert,
    TextInput,
    Platform,
    Modal,
    KeyboardAvoidingView,
    ScrollView,
} from "react-native";
import Animated, {
    useSharedValue, useAnimatedStyle, withTiming, withSpring, LinearTransition,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LiquidGlass } from './LiquidGlass';
import { SkeletonBox } from './SkeletonBox';
import { useRouter, useFocusEffect } from 'expo-router';
import { useCollapsingHeader, CollapsingHeader } from './CollapsingHeader';
import { ScreenHeading } from './ScreenHeading';
import { GlassIconButton } from './GlassIconButton';
import { useState, useCallback, useEffect, useRef, useMemo, type ReactNode } from 'react';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ContextMenu, type ContextMenuAction } from './ContextMenu';
import { SwipeableRow } from './SwipeableRow';
import { UserAvatar } from './UserAvatar';
import { ChainLogoChip } from './ChainLogoChip';
import { API_BASE_URL } from '../config/api';
import { getUserId } from '../config/user';
import { useAuthState } from '../state/authState';
import { setCachedListItems, getCachedListItems, hasCachedListItems } from '../utils/listItemsCache';
import { ProductImage } from './ProductImage';
import { useTheme, spacing, radius, elevation, iconSize, avatarSize, typography, type AppTheme } from '../constants/theme';
import * as Haptics from 'expo-haptics';
import { formatEuro } from '../utils/formatCurrency';
import { formatStoreStreet } from '../utils/formatAddress';
import { isWeighableDisplay } from '../utils/weighable';
import { chainBrandName } from '../utils/chainBrandName';
import { useTranslation } from 'react-i18next';

interface ShoppingList {
    id: number;
    storeId: number;
    storeName: string;
    // API (getShoppingListById) returns Store.address aliased as `address`.
    address: string;
    chainName: string;
    chainId: number;
    chainLogoUrl: string | null;
    status: string;
    createdAt: string;
}

interface ShoppingListItem {
    id: number;
    listId: number;
    productId: number | null;
    productName: string;
    quantity: number;
    price: number | null;
    isChecked: boolean;
    imageUrls?: (string | null | undefined)[] | string | null;
    isWeighable: boolean;
    unit?: string;
    /** Anchored SP's pack size (sp.amount, joined server-side). */
    amount?: number | string | null;
    storeProductId?: number | null;
    requiresCoupon?: boolean;
    couponLabel?: string | null;
    l1CategoryId?: number | null;
    l2CategoryId?: number | null;
    l2CategoryName?: string | null;
    /** Who ticked this item (shared lists): null = unchecked or self. */
    checkedByUserId?: string | null;
    checkedByName?: string | null;
    checkedByColor?: string | null;
}

// Category groups follow the Naršyti sequence — by L1 id, then L2 id (NOT
// alphabetical). Uncategorised items (no L2) sink to the bottom under "Kita".
const CAT_LAST = Number.MAX_SAFE_INTEGER;
const sortItems = (arr: ShoppingListItem[]): ShoppingListItem[] =>
    arr.sort((a, b) => {
        if (a.isChecked !== b.isChecked) return Number(a.isChecked) - Number(b.isChecked);
        if (!a.isChecked) {
            const l1a = a.l2CategoryId == null ? CAT_LAST : (a.l1CategoryId ?? CAT_LAST);
            const l1b = b.l2CategoryId == null ? CAT_LAST : (b.l1CategoryId ?? CAT_LAST);
            if (l1a !== l1b) return l1a - l1b;
            const l2a = a.l2CategoryId ?? CAT_LAST;
            const l2b = b.l2CategoryId ?? CAT_LAST;
            if (l2a !== l2b) return l2a - l2b;
        }
        return a.productName.localeCompare(b.productName, 'lt');
    });

/** V2 checkbox: a spring-fill circle that pops when ticked. */
function SpringCheckbox({ checked, styles, colors }: {
    checked: boolean;
    styles: ReturnType<typeof makeStyles>;
    colors: AppTheme;
}) {
    const p = useSharedValue(checked ? 1 : 0);
    useEffect(() => {
        p.value = withSpring(checked ? 1 : 0, { damping: 12, stiffness: 220, mass: 0.6 });
    }, [checked]);
    const boxStyle = useAnimatedStyle(() => ({
        backgroundColor: p.value > 0.5 ? colors.primary : 'transparent',
        borderColor: p.value > 0.5 ? colors.primary : colors.border,
        transform: [{ scale: 1 + 0.14 * Math.sin(Math.min(p.value, 1) * Math.PI) }],
    }));
    const tickStyle = useAnimatedStyle(() => ({ opacity: p.value, transform: [{ scale: p.value }] }));
    return (
        <Animated.View style={[styles.v2check, boxStyle]}>
            <Animated.View style={tickStyle}>
                <Ionicons name="checkmark" size={16} color={colors.onPrimary} />
            </Animated.View>
        </Animated.View>
    );
}

function ShoppingListItemCard({ item, isMine, onToggle, onRemove, storeBadge, styles, colors }: {
    item: ShoppingListItem;
    isMine: (uid?: string | null) => boolean;
    onToggle: (item: ShoppingListItem) => void;
    onRemove: (id: number) => void;
    /** Unified view: the store this item is bought at (logo, top-left of image). */
    storeBadge?: UnifiedSource | null;
    styles: ReturnType<typeof makeStyles>;
    colors: AppTheme;
}) {
    const { t } = useTranslation();
    // Someone ELSE ticked this (shared list): show their avatar so I don't
    // think I did it myself.
    const otherChecker = item.isChecked && item.checkedByUserId && !isMine(item.checkedByUserId)
        ? { name: item.checkedByName ?? null, color: item.checkedByColor ?? null }
        : null;
    return (
        <SwipeableRow onDelete={() => onRemove(item.id)}>
            <TouchableOpacity
                style={[styles.v2row, item.isChecked && styles.v2rowDone]}
                onPress={() => onToggle(item)}
                activeOpacity={0.7}
            >
                <SpringCheckbox checked={item.isChecked} styles={styles} colors={colors} />
                <View style={styles.imageContainer}>
                    <ProductImage
                        uris={item.imageUrls}
                        imageStyle={styles.productImage}
                        placeholderStyle={styles.imagePlaceholder}
                        emojiStyle={styles.imageEmoji}
                    />
                    {storeBadge && (
                        <View style={styles.storeBadge}>
                            <ChainLogoChip chainId={storeBadge.chainId} name={storeBadge.chainName} size={18} />
                        </View>
                    )}
                </View>
                <View style={styles.cardContent}>
                    <Text style={[styles.itemName, item.isChecked && styles.itemNameChecked]} numberOfLines={1}>
                        {item.productName}
                    </Text>
                    <Text style={styles.itemQuantity} numberOfLines={1}>
                        {(() => {
                            if (isWeighableDisplay(item.isWeighable, item.quantity)) {
                                return item.quantity < 10 ? `${item.quantity} kg` : `${item.quantity} g`;
                            }
                            const amt = Number(item.amount);
                            if (item.storeProductId && Number.isFinite(amt) && amt > 0 && item.unit) {
                                return `${item.quantity} × ${fmtPackSize(amt, item.unit)}`;
                            }
                            return `${item.quantity} ${t('shoppingListDetail.unitPieces')}`;
                        })()}
                    </Text>
                    {item.requiresCoupon && item.couponLabel && !item.isChecked && (
                        <View style={styles.couponBadge}>
                            <Text style={styles.couponBadgeText}>{t('shoppingListDetail.couponBadge', { name: item.couponLabel })}</Text>
                        </View>
                    )}
                </View>
                {otherChecker && (
                    <UserAvatar name={otherChecker.name} color={otherChecker.color} size={22} style={styles.checkerAvatar} />
                )}
                {item.price && (
                    <Text style={[styles.itemPrice, item.isChecked && styles.itemPriceChecked]}>
                        {formatEuro(item.price)}
                    </Text>
                )}
            </TouchableOpacity>
        </SwipeableRow>
    );
}

export interface ShoppingListMeta {
    title: string;
    logo: string | null;
    status: string;
}

interface Props {
    listId: number;
    /** Passed from the basket creation flow to know how many items to wait for */
    expectedCount?: number;
    /** True in multi-store mode: header/chips come from the parent; the
     *  completion confirm is the PARENT's (whole-trip) — this list only
     *  reports its live progress via `onItemsProgress`. */
    isPartOfBasket?: boolean;
    /** Multi-store: live checked/total counts for this list (fired on load and
     *  on every items change) — drives the parent's chip badges, the silent
     *  advance to the next store, and the all-stores-done completion prompt. */
    onItemsProgress?: (listId: number, checkedCount: number, itemCount: number) => void;
    /** Multi-store: reports whether the search/add input is focused. The parent
     *  MUST NOT swap the active list (key remount) while true — remounting
     *  destroys the focused TextInput and Android drops the keyboard. */
    onSearchActiveChange?: (active: boolean) => void;
    /** Title row override — multi-store passes the joined chain short names
     *  (e.g. "Maxima · Rimi"). Single store derives it from the list. */
    headerTitle?: string;
    /** Breadcrumb override — multi-store passes the joined addresses. */
    headerSubtitle?: string;
    /** Extra pinned content shown under the header (multi-store: the store
     *  chip selector). */
    pinnedHeader?: ReactNode;
    /** Trip actions (3-dot menu). Provided by the parent only when the list
     *  belongs to a trip/basket — omitted for legacy standalone lists. */
    onInvite?: () => void;
    onChangeStore?: () => void;
    /** Unified view: when set (multi-store), items from ALL these lists are
     *  merged into one list, each card tagged with its store's logo. Replaces
     *  the per-store chip tabs; add/search is hidden (target store ambiguous). */
    unifiedSources?: UnifiedSource[];
    /** View-mode toggle (3-dot) — shown only for multi-store lists. */
    viewMode?: 'chips' | 'unified';
    onToggleViewMode?: () => void;
    /** Receipt actions (3-dot): upload a receipt for the trip; view uploaded
     *  receipts (shown only when some exist). Trip-scoped only. */
    onUploadReceipt?: () => void;
    onViewReceipts?: () => void;
}

export interface UnifiedSource {
    listId: number;
    chainId: number;
    chainName: string;
    chainLogoUrl: string | null;
}

const PIECE_PRESETS = ['1', '2', '3', '5', '10'];

/** One same-chain pack size for a packed product (350 g / 1 l / 8 rit.). */
interface PackOption {
    spId: number;
    label: string;
    /** Size normalized to base units (g/ml/pieces) for ascending sort. */
    baseAmount: number;
    imageUrl: string | null;
}

// "350 g", "1 l" — sizes print in their natural unit (never 0.35 kg, never 0.5 l).
const fmtPackSize = (amount: number, unit: string): string => {
    if ((unit === 'g' || unit === 'ml') && amount >= 1000) {
        return `${Number((amount / 1000).toFixed(3))} ${unit === 'g' ? 'kg' : 'l'}`;
    }
    if ((unit === 'kg' || unit === 'l') && amount > 0 && amount < 1) {
        return `${Number((amount * 1000).toFixed(1))} ${unit === 'kg' ? 'g' : 'ml'}`;
    }
    return `${Number(amount.toFixed(3))} ${unit}`;
};
const packBaseAmount = (amount: number, unit: string): number =>
    unit === 'kg' || unit === 'l' ? amount * 1000 : amount;
const WEIGHT_PRESETS = ['0.2', '0.5', '1', '2', '5'];

export function ShoppingListDetail({
    listId,
    expectedCount,
    isPartOfBasket = false,
    onItemsProgress,
    onSearchActiveChange,
    headerTitle,
    headerSubtitle,
    pinnedHeader,
    onInvite,
    onChangeStore,
    unifiedSources,
    viewMode,
    onToggleViewMode,
    onUploadReceipt,
    onViewReceipts,
}: Props) {
    const colors = useTheme();
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();

    // Single owner of the header for both single- and multi-store lists. The
    // store chip selector (multi) is fed in via `pinnedHeader`.
    const header = useCollapsingHeader();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const id = String(listId);

    // The list is a ROOT route (not under a tab), so a plain pop lands on
    // whatever tab was last focused (often Catalog). Shopping lists belong to
    // the Shopping tab — send back there explicitly.
    const handleBack = useCallback(() => { router.navigate('/(tabs)/basket' as any); }, [router]);

    // Unified view: items from EVERY source list merged into one, each tagged
    // with its store logo. Single-source (chip mode / single store) keeps the
    // one `listId`. Add/search is hidden in unified (no single target store).
    const unified = !!(unifiedSources && unifiedSources.length > 1);
    const sourceIds = useMemo(
        () => (unified ? unifiedSources!.map(s => s.listId) : [Number(listId)]),
        [unified, unifiedSources, listId],
    );
    const chainBySource = useMemo(() => {
        const m = new Map<number, UnifiedSource>();
        (unifiedSources ?? []).forEach(s => m.set(s.listId, s));
        return m;
    }, [unifiedSources]);
    // In unified view, search/add target the NEAREST store (the first source);
    // its chain scopes the product search and new items land on its list.
    const primarySource = unifiedSources?.[0] ?? null;
    const addTargetListId = unified ? (primarySource?.listId ?? Number(listId)) : Number(listId);

    const [list, setList] = useState<ShoppingList | null>(null);
    // Seed from the shared cache so a tab / view switch paints the right items
    // immediately (the component remounts on switch); background fetch refreshes.
    const [items, setItems] = useState<ShoppingListItem[]>(() => sortItems(getCachedListItems(sourceIds) as ShoppingListItem[]));
    // Which ids count as ME when reading a shared item's `checkedBy`. The server
    // records the SESSION token's subject: the account id when signed in, else
    // the anon/device id. authUserId is REACTIVE (updates when auth hydrates —
    // a non-reactive snapshot locked in the device id and mis-flagged my own
    // ticks as another member's → stray avatar + uncheck confirm). Both ids are
    // accepted so pre-sign-in ticks merged into the account still read as mine.
    const authUserId = useAuthState(s => s.user?.id ?? null);
    const [deviceId, setDeviceId] = useState<string | null>(null);
    useEffect(() => { getUserId().then(setDeviceId).catch(() => {}); }, []);
    const myIds = useMemo(() => [authUserId, deviceId].filter(Boolean) as string[], [authUserId, deviceId]);
    const isMine = useCallback((uid?: string | null) => !uid || myIds.includes(uid), [myIds]);
    // Multi-store: stream this list's live progress to the parent (load +
    // every add/remove/toggle) so its chip badges and the whole-trip
    // completion check never go stale.
    useEffect(() => {
        if (!isPartOfBasket) return;
        if (unified) {
            // Report EACH source list's progress so the parent's chip badges and
            // whole-trip completion stay correct even while viewing unified.
            for (const lid of sourceIds) {
                const own = items.filter(i => i.listId === lid);
                onItemsProgress?.(lid, own.filter(i => i.isChecked).length, own.length);
            }
        } else {
            onItemsProgress?.(listId, items.filter(i => i.isChecked).length, items.length);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [items, isPartOfBasket, listId, unified, sourceIds]);
    // Write the current view's items THROUGH the shared cache (split by list) on
    // every change — so an optimistic tick is reflected instantly if the user
    // switches views before the next sync.
    useEffect(() => {
        const byList = new Map<number, ShoppingListItem[]>();
        sourceIds.forEach(lid => byList.set(lid, []));
        for (const it of items) {
            if (!byList.has(it.listId)) byList.set(it.listId, []);
            byList.get(it.listId)!.push(it);
        }
        byList.forEach((arr, lid) => setCachedListItems(lid, arr));
    }, [items, sourceIds]);
    // Only show the skeleton on a genuine cold load — a cached switch is instant.
    const [loading, setLoading] = useState(() => !hasCachedListItems(sourceIds));
    const [quickAddText, setQuickAddText] = useState('');
    const [searchQuery, setSearchQuery] = useState('');

    const pendingDeleteRef = useRef<{ item: ShoppingListItem; timer: ReturnType<typeof setTimeout> } | null>(null);
    const [pendingDeleteTick, setPendingDeleteTick] = useState(0);
    void pendingDeleteTick;

    const inFlightItemsRef = useRef<Map<number, number>>(new Map());
    const FLIGHT_HOLD_MS = 1500;
    const markInFlight = (itemId: number) => { inFlightItemsRef.current.set(itemId, Date.now()); };

    const [searchResults, setSearchResults] = useState<any[]>([]);
    const [visibleCount, setVisibleCount] = useState(() => getCachedListItems(sourceIds).length);
    const [menuVisible, setMenuVisible] = useState(false);

    const [quantityModal, setQuantityModal] = useState<{
        productId: number | null;
        name: string;
        isWeighable: boolean;
        storeProductId: number | null;
        imageUrl: string | null;
        /** Same-chain pack sizes for a packed product (deduped, ascending).
         *  >1 → size chips in the modal; exactly 1 → fixed size subtitle. */
        packOptions?: PackOption[];
    } | null>(null);
    const [selectedPack, setSelectedPack] = useState<PackOption | null>(null);
    const [quantityInput, setQuantityInput] = useState('1');
    const [modalIsWeighable, setModalIsWeighable] = useState(false);

    // Top search reveal: the search icon mounts a top search bar (autoFocus →
    // keyboard) in place of the old bottom add-bar. Mounting happens BEFORE
    // focus (no remount while typing) so the Android IME session stays alive.
    const [searchRevealed, setSearchRevealed] = useState(false);

    const shownCouponsRef = useRef<Set<string>>(new Set());
    const [couponQueue, setCouponQueue] = useState<string[]>([]);
    const [couponDontShow, setCouponDontShow] = useState(false);
    const [completionModal, setCompletionModal] = useState(false);

    const dismissCoupon = async () => {
        const label = couponQueue[0];
        if (couponDontShow && label) {
            await AsyncStorage.setItem(`coupon_hide_${label}`, '1');
        }
        setCouponDontShow(false);
        setCouponQueue(q => q.slice(1));
    };

    const closeSearch = useCallback(() => {
        setSearchRevealed(false);
        setQuickAddText('');
        setSearchQuery('');
        setSearchResults([]);
        onSearchActiveChange?.(false);
    }, [onSearchActiveChange]);

    // Fetch + merge items from every source list (one list in single mode).
    // Each list's result is written through the shared cache so the next switch
    // seeds instantly.
    const fetchAllItems = useCallback(async (): Promise<ShoppingListItem[]> => {
        const perList = await Promise.all(sourceIds.map(async lid => {
            try {
                const res = await fetch(`${API_BASE_URL}/api/shopping-lists/${lid}/items`);
                if (!res.ok) return [];
                const data = await res.json();
                const arr = Array.isArray(data) ? (data as ShoppingListItem[]) : [];
                setCachedListItems(lid, arr);
                return arr;
            } catch { return []; }
        }));
        return perList.flat();
    }, [sourceIds]);

    useFocusEffect(useCallback(() => {
        let attempts = 0;
        let cancelled = false;

        const fetchListMeta = async () => {
            // Unified mode takes its header from the parent (headerTitle) — no
            // single list to describe.
            if (unified) return;
            try {
                const listRes = await fetch(`${API_BASE_URL}/api/shopping-lists/${id}`);
                const listData = await listRes.json();
                setList(listData);
            } catch {}
        };

        // Unified merges several lists → the single-list expected-count wait
        // doesn't apply.
        const expected = unified ? 0 : (expectedCount ?? 0);

        const pollItems = async () => {
            if (cancelled) return;
            try {
                const data = await fetchAllItems();
                if (data.length >= expected || attempts >= 20) {
                    setItems(sortItems(data));
                    setLoading(false);
                    setVisibleCount(data.length);
                } else {
                    attempts++;
                    setTimeout(pollItems, 500);
                }
            } catch {
                setLoading(false);
            }
        };

        fetchListMeta();
        pollItems();

        const syncItems = async () => {
            if (cancelled) return;
            try {
                const server = await fetchAllItems();
                if (cancelled) return;

                const now = Date.now();
                for (const [k, ts] of Array.from(inFlightItemsRef.current.entries())) {
                    if (now - ts > FLIGHT_HOLD_MS) inFlightItemsRef.current.delete(k);
                }

                setItems(prev => {
                    const byId = new Map<number, ShoppingListItem>(prev.map(p => [p.id, p]));
                    const merged: ShoppingListItem[] = server.map((s: any) => {
                        if (inFlightItemsRef.current.has(s.id)) return byId.get(s.id) ?? s;
                        return s;
                    });
                    const pendDel = pendingDeleteRef.current?.item.id;
                    const filtered = pendDel != null ? merged.filter(m => m.id !== pendDel) : merged;
                    sortItems(filtered);
                    return filtered;
                });
                setVisibleCount(c => Math.max(c, server.length));
            } catch {}
        };
        const syncInterval = setInterval(syncItems, 3000);

        return () => { cancelled = true; clearInterval(syncInterval); };
    }, [id, unified, fetchAllItems, expectedCount]));

    const checkedCount = items.filter(i => i.isChecked).length;
    const totalCount = items.length;
    const progress = totalCount > 0 ? checkedCount / totalCount : 0;

    // Top-edge progress glow — animates to the active list's fraction. Keyed
    // remount (store switch) resets it to that store's own progress.
    const glow = useSharedValue(0);
    useEffect(() => { glow.value = withTiming(progress, { duration: 400 }); }, [progress]);
    const glowStyle = useAnimatedStyle(() => ({ width: `${glow.value * 100}%` }));

    const { rows } = useMemo(() => {
        const visible = items.slice(0, visibleCount);
        const unchecked = visible.filter(i => !i.isChecked);
        const checked = visible.filter(i => i.isChecked);

        const byCategory = new Map<string, ShoppingListItem[]>();
        for (const item of unchecked) {
            const key = item.l2CategoryName ?? '';
            if (!byCategory.has(key)) byCategory.set(key, []);
            byCategory.get(key)!.push(item);
        }
        const groups = Array.from(byCategory.entries())
            .map(([key, groupItems]) => ({ name: key || null, items: groupItems }))
            .sort((a, b) => {
                // Naršyti sequence: L1 id, then L2 id. Uncategorised → bottom.
                const la = a.name ? (a.items[0].l1CategoryId ?? CAT_LAST) : CAT_LAST;
                const lb = b.name ? (b.items[0].l1CategoryId ?? CAT_LAST) : CAT_LAST;
                if (la !== lb) return la - lb;
                const ka = a.name ? (a.items[0].l2CategoryId ?? CAT_LAST) : CAT_LAST;
                const kb = b.name ? (b.items[0].l2CategoryId ?? CAT_LAST) : CAT_LAST;
                return ka - kb;
            });

        // Flatten to a single sequence of header/item rows so each item is one
        // Animated.View sibling in ONE parent — a ticked item can then FLY down
        // to the "Atlikta" tray via LinearTransition (cross-parent moves don't
        // animate). Stable keys: `h:<name>` / `i:<id>`.
        type Row =
            | { kind: 'header'; key: string; label: string }
            | { kind: 'item'; key: string; item: ShoppingListItem };
        const rows: Row[] = [];
        for (const g of groups) {
            rows.push({ kind: 'header', key: `h:${g.name ?? '__nocat__'}`, label: g.name ?? t('shoppingListDetail.uncategorised', { defaultValue: 'Kita' }) });
            for (const it of g.items) rows.push({ kind: 'item', key: `i:${it.id}`, item: it });
        }
        if (checked.length > 0) {
            rows.push({ kind: 'header', key: 'h:__done__', label: t('shoppingListDetail.doneSection', { count: checked.length }) });
            for (const it of checked) rows.push({ kind: 'item', key: `i:${it.id}`, item: it });
        }

        return { uncheckedGroups: groups, checkedItems: checked, rows };
    }, [items, visibleCount, t]);

    // Tap handler: guard un-ticking an item that ANOTHER member ticked (so a
    // stray tap doesn't silently undo their work); everything else toggles.
    const requestToggle = (item: ShoppingListItem) => {
        const othersItem = item.isChecked && item.checkedByUserId && !isMine(item.checkedByUserId);
        if (othersItem) {
            Alert.alert(
                t('shoppingListDetail.uncheckOtherTitle'),
                t('shoppingListDetail.uncheckOtherBody', { name: item.checkedByName ?? t('shoppingListDetail.someone') }),
                [
                    { text: t('common.cancel'), style: 'cancel' },
                    { text: t('shoppingListDetail.uncheckConfirm'), style: 'destructive', onPress: () => void toggleItem(item) },
                ],
            );
            return;
        }
        void toggleItem(item);
    };

    const toggleItem = async (item: ShoppingListItem) => {
        const newChecked = !item.isChecked;
        Haptics.impactAsync(newChecked ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light);

        // Optimistically record self as the checker (so my own ticks show no
        // avatar); the 3s sync brings the authoritative checker for others.
        const updatedItems = sortItems(
            items.map(i => i.id === item.id
                ? { ...i, isChecked: newChecked, checkedByUserId: newChecked ? (myIds[0] ?? null) : null, checkedByName: null, checkedByColor: null }
                : i)
        );
        setItems(updatedItems);
        markInFlight(item.id);

        fetch(`${API_BASE_URL}/api/list-items/${item.id}/toggle`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isChecked: newChecked }),
        })
            .catch(() => { setItems(items); })
            .finally(() => { inFlightItemsRef.current.delete(item.id); });

        if (newChecked && item.requiresCoupon && item.couponLabel) {
            const label = item.couponLabel;
            if (!shownCouponsRef.current.has(label)) {
                const hidden = await AsyncStorage.getItem(`coupon_hide_${label}`);
                if (hidden !== '1') {
                    shownCouponsRef.current.add(label);
                    setCouponQueue(q => [...q, label]);
                }
            }
        }

        // Single-store lists prompt here; split-basket sub-lists DON'T — the
        // parent owns the whole-trip completion (prompted only when EVERY
        // store's items are checked) and gets this list's progress via
        // onItemsProgress.
        if (!isPartOfBasket && newChecked && updatedItems.length > 0 && updatedItems.every(i => i.isChecked)) {
            const key = `sl_prompted_${id}`;
            const already = await AsyncStorage.getItem(key);
            if (already === '1') return;
            await AsyncStorage.setItem(key, '1');
            setCompletionModal(true);
        }
    };

    const promptQuantity = (
        productId: number | null,
        name: string,
        isWeighable: boolean,
        storeProductId: number | null = null,
        imageUrl: string | null = null,
        packOptions?: PackOption[],
    ) => {
        setModalIsWeighable(isWeighable);
        setQuantityInput(isWeighable ? '0.5' : '1');
        setSelectedPack(packOptions && packOptions.length > 0 ? packOptions[0] : null);
        setQuantityModal({ productId, name, isWeighable, storeProductId, imageUrl, packOptions });
    };

    /**
     * Unit-aware search-result pick. Weighable (the picked SP or ANY same-chain
     * sibling — mixed products use the weighable logic) → kg presets + free
     * input. Packed → same-chain sibling sizes: >1 distinct → size chips +
     * pack count; 1 → fixed "N × 350 g"; no size data → plain vnt count.
     * Picking a size ANCHORS the list item to that SP so check-off, pricing
     * and receipt matching agree on the pack.
     */
    const pickSearchResult = async (product: any) => {
        const targetChainId = unified ? (primarySource?.chainId ?? null) : (list?.chainId ?? null);
        const name = product.storeProductName;
        const pickedWeighable = product.isWeighable === 1 || product.isWeighable === true;
        if (pickedWeighable || !product.productId || !targetChainId) {
            promptQuantity(product.productId ?? null, name, pickedWeighable, product.id, product.imageUrl);
            return;
        }
        let packOptions: PackOption[] = [];
        let anyWeighable = false;
        try {
            const res = await fetch(`${API_BASE_URL}/api/store-products/product/${product.productId}`);
            const sps = await res.json();
            const sameChain = (Array.isArray(sps) ? sps : []).filter((sp: any) => sp.chainId === targetChainId);
            anyWeighable = sameChain.some((sp: any) => sp.isWeighable === 1 || sp.isWeighable === true);
            if (!anyWeighable) {
                const seen = new Map<string, PackOption>();
                for (const sp of sameChain) {
                    const amt = Number(sp.amount);
                    if (!Number.isFinite(amt) || amt <= 0 || !sp.unit) continue;
                    const key = `${amt}|${sp.unit}`;
                    if (!seen.has(key)) {
                        seen.set(key, {
                            spId: sp.id,
                            label: fmtPackSize(amt, sp.unit),
                            baseAmount: packBaseAmount(amt, sp.unit),
                            imageUrl: sp.imageUrl ?? product.imageUrl ?? null,
                        });
                    }
                }
                packOptions = [...seen.values()].sort((a, b) => a.baseAmount - b.baseAmount);
            }
        } catch { /* sibling fetch is best-effort — fall back to the plain flow */ }
        if (anyWeighable) {
            promptQuantity(product.productId, name, true, product.id, product.imageUrl);
            return;
        }
        promptQuantity(product.productId, name, false, product.id, product.imageUrl, packOptions.length > 0 ? packOptions : undefined);
    };

    const removeItem = (itemId: number) => {
        const target = items.find(i => i.id === itemId);
        if (!target) return;
        setItems(prev => prev.filter(i => i.id !== itemId));
        if (pendingDeleteRef.current) {
            clearTimeout(pendingDeleteRef.current.timer);
            const prev = pendingDeleteRef.current.item;
            fetch(`${API_BASE_URL}/api/list-items/${prev.id}`, { method: 'DELETE' }).catch(() => {});
        }
        const timer = setTimeout(() => {
            fetch(`${API_BASE_URL}/api/list-items/${itemId}`, { method: 'DELETE' })
                .catch(() => setItems(current => [...current, target]));
            pendingDeleteRef.current = null;
            setPendingDeleteTick(t => t + 1);
        }, 3000);
        pendingDeleteRef.current = { item: target, timer };
        setPendingDeleteTick(t => t + 1);
    };

    const undoItemDelete = () => {
        if (!pendingDeleteRef.current) return;
        clearTimeout(pendingDeleteRef.current.timer);
        const { item } = pendingDeleteRef.current;
        setItems(prev => sortItems([...prev, item]));
        pendingDeleteRef.current = null;
        setPendingDeleteTick(t => t + 1);
    };

    const handleSearch = async (query: string) => {
        setSearchQuery(query);
        if (query.length < 2) { setSearchResults([]); return; }
        const chainId = unified ? (primarySource?.chainId ?? null) : (list?.chainId ?? null);
        if (!chainId) { setSearchResults([]); return; }
        try {
            const res = await fetch(`${API_BASE_URL}/api/store-products/search?name=${encodeURIComponent(query)}&chainId=${chainId}`);
            const data = await res.json();
            setSearchResults(Array.isArray(data) ? data.slice(0, 12) : []);
        } catch {}
    };

    const addProduct = async (
        productId: number | null,
        name: string,
        quantity: number,
        isWeighable: boolean,
        storeProductId: number | null = null,
        imageUrl: string | null = null,
    ) => {
        const existing = items.find(i => i.productId === productId && productId !== null);
        if (existing) {
            Alert.alert(t('shoppingListDetail.alreadyInList'), t('shoppingListDetail.alreadyInListBody', { name }));
            return;
        }
        try {
            const res = await fetch(`${API_BASE_URL}/api/list-items`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ listId: addTargetListId, productId, storeProductId, quantity, name, isWeighable }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (typeof data?.id !== 'number') throw new Error('Response missing id');
            const newItem: ShoppingListItem = {
                id: data.id,
                listId: addTargetListId,
                productId,
                storeProductId,
                productName: name,
                quantity,
                price: null,
                isChecked: false,
                imageUrls: imageUrl ? [imageUrl] : null,
                isWeighable,
                unit: isWeighable ? 'kg' : 'vnt.',
            };
            setItems(prev => [...prev, newItem]);
            markInFlight(data.id);
            setVisibleCount(prev => prev + 1);
            setQuickAddText('');
            setSearchQuery('');
            setSearchResults([]);
        } catch {
            Alert.alert(t('shoppingListDetail.errorGeneric'), t('shoppingListDetail.errorAdd'));
        }
    };

    // ── Loading skeleton ──────────────────────────────────────────────────────

    if (loading) return (
        <>
            <CollapsingHeader
                controller={header}
                back
                onBack={handleBack}
                smallTitle={headerTitle ?? t('shoppingListDetail.fallbackTitle')}
            />
            <View style={[styles.container, { paddingTop: spacing.lg, paddingHorizontal: spacing.lg, gap: spacing.sm }]}>
                <ScreenHeading title={headerTitle ?? t('shoppingListDetail.fallbackTitle')} subtitle={headerSubtitle} bleedX={spacing.lg} />
                {Array.from({ length: 8 }).map((_, i) => (
                    <View key={i} style={{ backgroundColor: colors.cardBackground, borderRadius: radius.lg, padding: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                        <SkeletonBox width={22} height={22} borderRadius={6} />
                        <View style={{ flex: 1, gap: 6 }}>
                            <SkeletonBox width={180} height={13} borderRadius={6} />
                            <SkeletonBox width={100} height={11} borderRadius={5} />
                        </View>
                        <SkeletonBox width={40} height={13} borderRadius={5} />
                    </View>
                ))}
            </View>
        </>
    );

    // ── Main render ───────────────────────────────────────────────────────────

    const canSearch = unified || list?.status === 'active';
    const showSearchResults = canSearch && quickAddText.length >= 2;

    // 3-dot overflow actions. Change-store + Pakviesti + view-mode toggle all
    // come from the parent (trip-scoped / multi-store only). Active vs completed
    // only differ in whether change-store is offered.
    const menuActions: ContextMenuAction[] = [
        ...(onToggleViewMode
            ? [{
                icon: (viewMode === 'unified' ? 'albums-outline' : 'layers-outline') as ContextMenuAction['icon'],
                label: viewMode === 'unified' ? t('shoppingListDetail.viewByStore') : t('shoppingListDetail.viewUnified'),
                onPress: () => { setMenuVisible(false); onToggleViewMode(); },
            }]
            : []),
        ...(onChangeStore && (unified || list?.status === 'active')
            ? [{ icon: 'swap-horizontal-outline' as const, label: t('shoppingListDetail.changeStore'), onPress: () => { setMenuVisible(false); onChangeStore(); } }]
            : []),
        ...(onInvite
            ? [{ icon: 'person-add-outline' as const, label: t('shoppingListDetail.inviteAction'), onPress: () => { setMenuVisible(false); onInvite(); } }]
            : []),
        ...(onUploadReceipt
            ? [{ icon: 'cloud-upload-outline' as const, label: t('shoppingListDetail.uploadReceipt'), onPress: () => { setMenuVisible(false); onUploadReceipt(); } }]
            : []),
        ...(onViewReceipts
            ? [{ icon: 'receipt-outline' as const, label: t('shoppingListDetail.viewReceipts'), onPress: () => { setMenuVisible(false); onViewReceipts(); } }]
            : []),
    ];

    return (
        <>
            {/* KEYBOARD-HIDE FIX: the container's style NEVER changes. Flipping
                zIndex/elevation on this ancestor of the focused TextInput closed
                the Android IME session on the 2nd keystroke (ImeTracker:
                HIDE_SOFT_INPUT_CLOSE_CURRENT_SESSION ~80ms after the flip). The
                header lives INSIDE the container now, and the search overlay
                out-stacks it with a CONSTANT zIndex — only the overlay's
                opacity/pointerEvents toggle, which is IME-safe (proven by trace). */}
            <View style={styles.container}>
    <CollapsingHeader
                    controller={header}
                    back
                    onBack={handleBack}
                    smallTitle={headerTitle ?? (list?.chainName ? chainBrandName(list.chainName) : list?.storeName) ?? t('shoppingListDetail.fallbackTitle')}
                    right={
                        <View style={styles.headerActions}>
                            {canSearch && (
                                <GlassIconButton icon="search" color={colors.textPrimary} onPress={() => setSearchRevealed(true)} />
                            )}
                            <GlassIconButton icon="ellipsis-vertical" color={colors.textMuted} onPress={() => setMenuVisible(true)} />
                        </View>
                    }
                />

                    {/* Top-edge progress glow — a thin fill from the left with a
                        soft downward bloom, pinned over the very top of the screen.
                        Replaces the old inline progress bar; reflects the ACTIVE
                        store's fraction (remount resets per store). */}
                    {(unified || list?.status === 'active') && totalCount > 0 && (
                        <View pointerEvents="none" style={styles.glowWrap}>
                            <Animated.View style={[styles.glowFill, glowStyle]}>
                                <View style={styles.glowLine} />
                                <Svg width="100%" height={14} style={styles.glowBloom}>
                                    <Defs>
                                        <SvgLinearGradient id="listGlow" x1="0" y1="0" x2="0" y2="1">
                                            <Stop offset="0" stopColor={colors.primary} stopOpacity="0.55" />
                                            <Stop offset="1" stopColor={colors.primary} stopOpacity="0" />
                                        </SvgLinearGradient>
                                    </Defs>
                                    <Rect x="0" y="0" width="100%" height="14" fill="url(#listGlow)" />
                                </Svg>
                            </Animated.View>
                        </View>
                    )}

                    {/* ALWAYS MOUNTED (opacity toggle): the toast unmounting on the
                        3s expiry re-render removed a native sibling above the focused
                        search input — delete an item, start typing, keyboard dies. */}
                    <View
                        style={[styles.undoToastWrap, { bottom: insets.bottom + spacing.lg, opacity: pendingDeleteRef.current ? 1 : 0 }]}
                        pointerEvents={pendingDeleteRef.current ? 'box-none' : 'none'}
                    >
                        <TouchableOpacity style={styles.undoToast} onPress={undoItemDelete} activeOpacity={0.85}>
                            <Ionicons name="arrow-undo" size={iconSize.xs} color={colors.onPrimary} />
                            <Text style={styles.undoToastText}>{t('shoppingListDetail.deletedUndo')}</Text>
                        </TouchableOpacity>
                    </View>

                    <Animated.ScrollView
                        {...header.scroll}
                        style={{ flex: 1 }}
                        stickyHeaderIndices={[1]}
                        contentContainerStyle={[styles.scrollContent, { paddingTop: 0 }]}
                    >
                        <ScreenHeading
                            title={headerTitle ?? (list?.chainName ? chainBrandName(list.chainName) : list?.storeName) ?? t('shoppingListDetail.fallbackTitle')}
                            subtitle={headerSubtitle ?? (formatStoreStreet(list?.address) || list?.storeName || undefined)}
                            onLayout={header.onTitleLayout}
                        />
                        <View style={{ backgroundColor: colors.pageBackground }}>
                            {pinnedHeader}
                        </View>
                        <View style={styles.listInner}>
                        {rows.map(row => (
                            <Animated.View key={row.key} layout={LinearTransition.duration(240)}>
                                {row.kind === 'header'
                                    ? <Text style={styles.sectionHeader}>{row.label}</Text>
                                    : <ShoppingListItemCard item={row.item} isMine={isMine} onToggle={requestToggle} onRemove={removeItem} storeBadge={unified ? chainBySource.get(row.item.listId) : null} styles={styles} colors={colors} />}
                            </Animated.View>
                        ))}
                        {items.length === 0 && (
                            <View style={styles.centered}>
                                <Text style={styles.emptyText}>{t('shoppingListDetail.empty')}</Text>
                            </View>
                        )}
                        </View>
                    </Animated.ScrollView>

                    {/* Search results — a FULL-SCREEN overlay under the top search
                        bar. ALWAYS MOUNTED, toggled ONLY via opacity/pointerEvents:
                        mounting it conditionally OR flipping zIndex on an ancestor
                        of the focused TextInput kills the Android IME session. */}
                    <View
                        pointerEvents={showSearchResults ? 'auto' : 'none'}
                        style={[styles.searchOverlay, { paddingTop: insets.top + 60, opacity: showSearchResults ? 1 : 0 }]}
                    >
                        <ScrollView
                            keyboardShouldPersistTaps="handled"
                            contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: 140 }}
                        >
                            {searchResults.map((product, index) => {
                                const alreadyInList = items.some(i => i.productId === product.productId);
                                return (
                                    <TouchableOpacity
                                        key={`${product.id}-${index}`}
                                        style={styles.searchResultItem}
                                        onPress={() => {
                                            if (alreadyInList) {
                                                Alert.alert(t('shoppingListDetail.alreadyInList'), t('shoppingListDetail.alreadyInListBody', { name: product.storeProductName }));
                                                return;
                                            }
                                            void pickSearchResult(product);
                                            setQuickAddText('');
                                            setSearchQuery('');
                                            setSearchResults([]);
                                        }}
                                    >
                                        {alreadyInList && <Ionicons name="checkmark-circle" size={iconSize.md} color={colors.primary} style={{ marginRight: spacing.sm }} />}
                                        <Text style={styles.searchResultText}>{product.storeProductName}</Text>
                                    </TouchableOpacity>
                                );
                            })}
                            <TouchableOpacity
                                style={styles.customItemButton}
                                onPress={() => {
                                    const name = quickAddText.trim();
                                    if (!name) return;
                                    promptQuantity(null, name, false);
                                }}
                            >
                                <Ionicons name="add-circle-outline" size={iconSize.md} color={colors.primary} />
                                <Text style={styles.customItemText}>{t('shoppingListDetail.addCustom', { name: quickAddText })}</Text>
                            </TouchableOpacity>
                        </ScrollView>
                    </View>

                    {/* Top search reveal — mounted only when the search icon is
                        tapped. Mounting happens BEFORE autoFocus (no remount while
                        typing), so the Android IME session stays alive. Sits above
                        the results overlay. Same look as the catalog search pill. */}
                    {searchRevealed && canSearch && (
                        <View style={[styles.searchBarWrap, { paddingTop: insets.top + spacing.xs }]}>
                            <LiquidGlass style={styles.searchBar} fallback="solid">
                                <TouchableOpacity onPress={closeSearch} hitSlop={8}>
                                    <Ionicons name="arrow-back" size={iconSize.md} color={colors.textPrimary} />
                                </TouchableOpacity>
                                <TextInput
                                    style={styles.searchBarInput}
                                    autoFocus
                                    value={quickAddText}
                                    onChangeText={(text) => { setQuickAddText(text); handleSearch(text); }}
                                    placeholder={t('shoppingListDetail.searchPlaceholder')}
                                    placeholderTextColor={colors.textMuted}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    onFocus={() => onSearchActiveChange?.(true)}
                                    onBlur={() => onSearchActiveChange?.(false)}
                                    onSubmitEditing={() => {
                                        const name = quickAddText.trim();
                                        if (!name) return;
                                        setQuickAddText('');
                                        setSearchQuery('');
                                        setSearchResults([]);
                                        addProduct(null, name, 1, false, null, null);
                                    }}
                                    returnKeyType="done"
                                />
                                {/* ALWAYS MOUNTED (opacity toggle): conditionally
                                    mounting a sibling next to the focused input drops
                                    the Android keyboard on the first keystroke. */}
                                <TouchableOpacity
                                    onPress={() => { setQuickAddText(''); setSearchQuery(''); setSearchResults([]); }}
                                    hitSlop={8}
                                    disabled={quickAddText.length === 0}
                                    style={{ opacity: quickAddText.length > 0 ? 1 : 0 }}
                                >
                                    <Ionicons name="close-circle" size={iconSize.md} color={colors.textMuted} />
                                </TouchableOpacity>
                            </LiquidGlass>
                        </View>
                    )}

                    <ContextMenu
                        visible={menuVisible}
                        onDismiss={() => setMenuVisible(false)}
                        actions={menuActions}
                    />
            </View>

            {/* Quantity modal with presets */}
            <Modal visible={quantityModal !== null} transparent animationType="fade" onRequestClose={() => setQuantityModal(null)}>
                {quantityModal && (
                    <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
                        <TouchableOpacity style={StyleSheet.absoluteFillObject} activeOpacity={1} onPress={() => setQuantityModal(null)} />
                        <View style={styles.modalContainer}>
                            <Text style={styles.modalTitle}>{quantityModal.name}</Text>

                            {quantityModal.productId === null && (
                                <TouchableOpacity
                                    style={styles.weighableRow}
                                    onPress={() => {
                                        const next = !modalIsWeighable;
                                        setModalIsWeighable(next);
                                        setQuantityInput(next ? '0.5' : '1');
                                    }}
                                >
                                    <View style={[styles.checkbox, modalIsWeighable ? styles.checkboxChecked : null]}>
                                        {modalIsWeighable ? <Ionicons name="checkmark" size={iconSize.xs} color={colors.onPrimary} /> : null}
                                    </View>
                                    <Text style={styles.weighableLabel}>Sveriamas</Text>
                                </TouchableOpacity>
                            )}

                            {/* Same-chain pack sizes (packed products): >1 → chips,
                                exactly 1 → fixed size subtitle. Picking anchors the SP. */}
                            {quantityModal.packOptions && quantityModal.packOptions.length > 1 && (
                                <>
                                    <Text style={styles.modalLabel}>{t('shoppingListDetail.packSize')}</Text>
                                    <View style={styles.presetsRow}>
                                        {quantityModal.packOptions.map(opt => (
                                            <TouchableOpacity
                                                key={opt.spId}
                                                style={[styles.presetBtn, selectedPack?.spId === opt.spId && styles.presetBtnActive]}
                                                onPress={() => setSelectedPack(opt)}
                                            >
                                                <Text style={[styles.presetBtnText, selectedPack?.spId === opt.spId && styles.presetBtnTextActive]}>
                                                    {opt.label}
                                                </Text>
                                            </TouchableOpacity>
                                        ))}
                                    </View>
                                </>
                            )}
                            {quantityModal.packOptions && quantityModal.packOptions.length === 1 && (
                                <Text style={styles.packFixedText}>
                                    {quantityInput || '1'} × {quantityModal.packOptions[0].label}
                                </Text>
                            )}

                            {/* Quick quantity presets */}
                            <View style={styles.presetsRow}>
                                {(modalIsWeighable ? WEIGHT_PRESETS : PIECE_PRESETS).map(v => (
                                    <TouchableOpacity
                                        key={v}
                                        style={[styles.presetBtn, quantityInput === v && styles.presetBtnActive]}
                                        onPress={() => setQuantityInput(v)}
                                    >
                                        <Text style={[styles.presetBtnText, quantityInput === v && styles.presetBtnTextActive]}>
                                            {v}{modalIsWeighable ? ' kg' : ''}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </View>

                            <Text style={styles.modalLabel}>
                                {modalIsWeighable ? 'Kiekis (kg)' : 'Kiekis (vnt.)'}
                            </Text>
                            <TextInput
                                style={styles.modalInput}
                                value={quantityInput}
                                onChangeText={(text) => {
                                    if (modalIsWeighable) {
                                        if (/^\d*\.?\d*$/.test(text)) setQuantityInput(text);
                                    } else {
                                        if (/^\d*$/.test(text)) setQuantityInput(text);
                                    }
                                }}
                                keyboardType={modalIsWeighable ? 'decimal-pad' : 'number-pad'}
                                selectTextOnFocus
                                autoFocus
                            />
                            <View style={styles.modalButtons}>
                                <TouchableOpacity style={styles.modalCancel} onPress={() => setQuantityModal(null)}>
                                    <Text style={styles.modalCancelText}>{t('common.cancel')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={styles.modalConfirm}
                                    onPress={() => {
                                        const qty = parseFloat(quantityInput);
                                        if (!qty || qty <= 0) {
                                            Alert.alert(t('shoppingListDetail.errorGeneric'), t('shoppingListDetail.errorAmount'));
                                            return;
                                        }
                                        const modal = quantityModal;
                                        setQuantityModal(null);
                                        // A picked pack size anchors ITS SP (and image), so
                                        // downstream check-off/pricing/receipt matching agree.
                                        addProduct(
                                            modal.productId,
                                            modal.name,
                                            qty,
                                            modalIsWeighable,
                                            selectedPack?.spId ?? modal.storeProductId,
                                            selectedPack?.imageUrl ?? modal.imageUrl,
                                        );
                                    }}
                                >
                                    <Text style={styles.modalConfirmText}>{t('shoppingListDetail.modalAdd')}</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    </KeyboardAvoidingView>
                )}
            </Modal>

            {/* Coupon reminder modal */}
            <Modal visible={couponQueue.length > 0} transparent animationType="slide" onRequestClose={dismissCoupon}>
                <View style={styles.shareOverlay}>
                    <TouchableOpacity style={StyleSheet.absoluteFillObject} activeOpacity={1} onPress={dismissCoupon} />
                    <View style={styles.couponModalContainer}>
                        <View style={styles.couponBadgeLarge}>
                            <Text style={styles.couponBadgeLargeText}>{t('shoppingListDetail.couponBadge', { name: couponQueue[0] })}</Text>
                        </View>
                        <Text style={styles.couponModalTitle}>{t('shoppingListDetail.couponTitle')}</Text>
                        <Text style={styles.couponModalBody}>
                            {t('shoppingListDetail.couponBodyPart1', { name: couponQueue[0] })} <Text style={{ fontWeight: '700' }}>{t('shoppingListDetail.couponApp')}</Text> {t('shoppingListDetail.couponBodyPart2')}
                        </Text>
                        <TouchableOpacity style={styles.couponDontShowRow} onPress={() => setCouponDontShow(v => !v)}>
                            <View style={[styles.checkbox, couponDontShow && styles.checkboxChecked]}>
                                {couponDontShow && <Ionicons name="checkmark" size={iconSize.xs} color="#fff" />}
                            </View>
                            <Text style={styles.couponDontShowLabel}>{t('shoppingListDetail.couponNeverShow')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.couponModalBtn} onPress={dismissCoupon}>
                            <Text style={styles.couponModalBtnText}>{t('shoppingListDetail.couponGotIt')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>

            {/* Completion confirmation — styled to match app, replaces stock Alert */}
            <Modal visible={completionModal} transparent animationType="fade" onRequestClose={() => setCompletionModal(false)}>
                <View style={styles.shareOverlay}>
                    <TouchableOpacity style={StyleSheet.absoluteFillObject} activeOpacity={1} onPress={() => setCompletionModal(false)} />
                    <View style={styles.modalContainer}>
                        <Text style={styles.modalTitle}>{t('shoppingListDetail.completeTitle')}</Text>
                        <Text style={styles.completeModalBody}>{t('shoppingListDetail.completeConfirm')}</Text>
                        <View style={styles.modalButtons}>
                            <TouchableOpacity style={styles.modalCancel} onPress={() => setCompletionModal(false)}>
                                <Text style={styles.modalCancelText}>{t('shoppingListDetail.completeNo')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.modalConfirm}
                                onPress={async () => {
                                    setCompletionModal(false);
                                    await fetch(`${API_BASE_URL}/api/shopping-lists/${id}/status`, {
                                        method: 'PATCH',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ status: 'completed' }),
                                    });
                                    router.back();
                                }}
                            >
                                <Text style={styles.modalConfirmText}>{t('shoppingListDetail.completeYes')}</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>

        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },

    // Search + 3-dot sit side by side in the header's right slot.
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },

    // ── Top-edge progress glow ────────────────────────────────────────────────
    // Pinned over the very top of the screen (above the header). The fill's
    // width animates to the active list's fraction; a 3px line rides a soft
    // downward bloom.
    glowWrap: { position: 'absolute', top: 0, left: 0, right: 0, height: 17, zIndex: 30, elevation: 30 },
    glowFill: { height: '100%' },
    glowLine: { height: 3, backgroundColor: c.primary },
    glowBloom: { marginTop: 0 },

    scrollContent: { paddingBottom: spacing.xxxl },
    listInner: { paddingTop: spacing.sm, paddingHorizontal: spacing.md },

    sectionHeader: {
        ...typography.labelSmall, fontWeight: '700', color: c.textMuted,
        textTransform: 'uppercase', letterSpacing: 0.6,
        paddingHorizontal: spacing.xs, paddingTop: spacing.md, paddingBottom: 6,
    },

    // ── V2 item card — each item is its own rounded card (spring checkbox +
    // done-tray fly-down via LinearTransition). ──
    v2row: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        backgroundColor: c.cardBackground,
        borderRadius: radius.lg, borderWidth: 1, borderColor: c.border,
        paddingHorizontal: spacing.md, paddingVertical: spacing.md,
        marginBottom: spacing.sm,
    },
    v2rowDone: { backgroundColor: c.surfaceMuted, borderColor: 'transparent' },
    v2check: {
        width: 26, height: 26, borderRadius: 13, borderWidth: 2,
        alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    },
    checkerAvatar: { marginLeft: spacing.xs },
    imageContainer: { width: avatarSize.md, height: avatarSize.md, flexShrink: 0 },
    // Store logo overlaid on the top-left of the product image (unified view).
    storeBadge: {
        position: 'absolute', top: -5, left: -5,
        borderRadius: 11, padding: 1.5, backgroundColor: c.cardBackground,
        ...elevation.level1,
    },
    productImage: { width: avatarSize.md, height: avatarSize.md, borderRadius: radius.sm },
    imagePlaceholder: {
        width: avatarSize.md, height: avatarSize.md, borderRadius: radius.sm,
        backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center',
    },
    imageEmoji: { fontSize: 22, opacity: 0.4 },
    cardContent: { flex: 1 },
    itemName: { ...typography.bodySmallStrong, color: c.textPrimary },
    itemNameChecked: { textDecorationLine: 'line-through', color: c.textMuted },
    itemQuantity: { ...typography.labelSmall, fontWeight: '400', color: c.textSecondary, marginTop: 2 },
    itemPrice: { ...typography.bodySmall, fontWeight: '500', color: c.primary },
    itemPriceChecked: { color: c.textMuted },
    deleteBtn: { paddingLeft: spacing.sm, paddingVertical: spacing.xs },

    emptyText: { ...typography.body, color: c.textSecondary },

    // ── Floating search results (glass card above the bar) ────────────────────
    resultsWrap: { paddingHorizontal: spacing.lg, marginBottom: spacing.sm },
    resultsShadow: { borderRadius: radius.lg, ...elevation.level3 },
    floatingResults: {
        backgroundColor: c.cardBackground,
        borderRadius: radius.lg, overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
        maxHeight: 280,
    },
    searchResultItem: {
        padding: spacing.md, borderBottomWidth: 1, borderBottomColor: c.borderSubtle,
        flexDirection: 'row', alignItems: 'center',
    },
    searchResultText: { ...typography.bodySmall, color: c.textPrimary },
    customItemButton: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md },
    customItemText: { ...typography.bodySmall, color: c.primary },

    // ── Top search reveal bar ─────────────────────────────────────────────────
    // Above the results overlay (zIndex 15) so it stays visible/tappable; sits
    // at the very top like the catalog search pill.
    searchBarWrap: {
        position: 'absolute', top: 0, left: 0, right: 0,
        paddingHorizontal: spacing.lg, paddingBottom: spacing.sm,
        backgroundColor: c.pageBackground,
        zIndex: 20, elevation: 20,
    },
    searchBar: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
        backgroundColor: c.cardBackground,
        borderRadius: radius.pill, overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
        ...elevation.level2,
    },
    searchBarInput: { flex: 1, ...typography.bodySmall, color: c.textPrimary, paddingVertical: 2 },

    // ── Undo toast ────────────────────────────────────────────────────────────
    undoToastWrap: { position: 'absolute', left: 0, right: 0, zIndex: 60, alignItems: 'center' },
    undoToast: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
        backgroundColor: c.textPrimary,
        marginHorizontal: spacing.lg,
        paddingVertical: spacing.sm, paddingHorizontal: spacing.lg,
        borderRadius: radius.md, alignSelf: 'center', zIndex: 50,
    },
    undoToastText: { ...typography.label, color: c.onPrimary },

    // ── Menu overlay ──────────────────────────────────────────────────────────
    menuOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 },
    menuContainer: {
        position: 'absolute', top: spacing.sm, right: spacing.md,
        backgroundColor: c.cardBackground, borderRadius: radius.md,
        ...elevation.level3,
        minWidth: 180,
    },
    menuItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.lg, borderRadius: radius.md },
    menuItemText: { ...typography.bodySmall, color: c.textPrimary },

    // ── Quantity modal ────────────────────────────────────────────────────────
    modalOverlay: {
        flex: 1, backgroundColor: c.overlayBackdrop,
        justifyContent: 'center', alignItems: 'center',
    },
    modalContainer: {
        backgroundColor: c.cardBackground, borderRadius: radius.lg, padding: spacing.xl, width: '90%',
        ...elevation.level3,
    },
    modalTitle: { ...typography.bodyStrong, fontWeight: '700', color: c.textPrimary, marginBottom: spacing.md },
    completeModalBody: { ...typography.bodySmall, color: c.textSecondary, marginBottom: spacing.xl },
    modalLabel: { ...typography.label, fontWeight: '400', color: c.textSecondary, marginBottom: spacing.sm },
    modalInput: {
        borderWidth: 1, borderColor: c.border, borderRadius: radius.sm,
        padding: spacing.md, fontSize: 18, color: c.textPrimary, textAlign: 'center', marginBottom: spacing.lg,
    },
    modalButtons: { flexDirection: 'row', gap: spacing.sm },
    modalCancel: { flex: 1, padding: spacing.md, borderRadius: radius.pill, borderWidth: 1, borderColor: c.border, alignItems: 'center' },
    modalCancelText: { ...typography.bodySmallStrong, color: c.textSecondary },
    modalConfirm: { flex: 1, padding: spacing.md, borderRadius: radius.pill, backgroundColor: c.primary, alignItems: 'center' },
    modalConfirmText: { ...typography.bodySmallStrong, color: c.onPrimary },
    weighableRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.lg },
    weighableLabel: { ...typography.bodySmall, color: c.textPrimary },
    checkbox: {
        width: 22, height: 22, borderRadius: radius.pill,
        borderWidth: 2, borderColor: c.primary, alignItems: 'center', justifyContent: 'center',
    },
    checkboxChecked: { backgroundColor: c.primary, borderColor: c.primary },

    // ── Quantity presets ──────────────────────────────────────────────────────
    packFixedText: { ...typography.bodySmall, color: c.textSecondary, marginBottom: spacing.sm },
    // The overlay out-stacks the CollapsingHeader (zIndex 10, now a SIBLING
    // inside the container) with a CONSTANT zIndex so results are visible and
    // tappable to the top. Never toggle zIndex/elevation here or on any
    // ancestor of the search input — that closes the Android IME session.
    searchOverlay: {
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: c.pageBackground,
        zIndex: 15, elevation: 15,
    },
    presetsRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg, flexWrap: 'wrap' },
    presetBtn: {
        paddingHorizontal: spacing.lg, paddingVertical: 7, borderRadius: radius.pill,
        borderWidth: 1, borderColor: c.border, backgroundColor: c.pageBackground,
    },
    presetBtnActive: { backgroundColor: c.primary, borderColor: c.primary },
    presetBtnText: { ...typography.label, fontWeight: '500', color: c.textSecondary },
    presetBtnTextActive: { color: c.onPrimary, fontWeight: '700' },

    // Shared modal backdrop (coupon + completion confirm).
    shareOverlay: { flex: 1, backgroundColor: c.overlayBackdrop, alignItems: 'center', justifyContent: 'center' },

    // ── Coupon modals (brand yellow/blue colours kept literal) ────────────────
    couponBadge: {
        flexDirection: 'row', alignSelf: 'flex-start',
        backgroundColor: '#FFF3B0', borderWidth: 1, borderColor: '#FFCC00',
        borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 2, marginTop: spacing.xs,
    },
    couponBadgeText: { ...typography.caption, fontWeight: '700', color: '#003D8F' },
    couponModalContainer: {
        backgroundColor: c.cardBackground, borderRadius: radius.lg,
        paddingVertical: spacing.xl, paddingHorizontal: spacing.xl, width: '85%', alignItems: 'center',
        ...elevation.level3,
    },
    couponBadgeLarge: {
        backgroundColor: '#FFF3B0', borderWidth: 2, borderColor: '#FFCC00',
        borderRadius: radius.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, marginBottom: spacing.lg,
    },
    couponBadgeLargeText: { ...typography.heading, fontWeight: '800', color: '#003D8F' },
    couponModalTitle: { ...typography.subheading, color: c.textPrimary, marginBottom: spacing.sm, textAlign: 'center' },
    couponModalBody: { ...typography.bodySmall, color: c.textSecondary, textAlign: 'center', marginBottom: spacing.lg },
    couponDontShowRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xl },
    couponDontShowLabel: { ...typography.label, fontWeight: '400', color: c.textSecondary },
    couponModalBtn: { paddingHorizontal: spacing.xxl, paddingVertical: spacing.md, backgroundColor: '#003D8F', borderRadius: radius.pill },
    couponModalBtnText: { ...typography.bodySmallStrong, fontWeight: '700', color: '#fff' },
});
