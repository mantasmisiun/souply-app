import {
    View, Text, TouchableOpacity, StyleSheet, ActivityIndicator,
    Alert, TextInput, Platform, Modal, KeyboardAvoidingView, Keyboard,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { LiquidGlass } from './LiquidGlass';
import { SkeletonBox } from './SkeletonBox';
import { useRouter, useFocusEffect } from 'expo-router';
import { useCollapsingHeader, CollapsingHeader } from './CollapsingHeader';
import { ScreenHeading } from './ScreenHeading';
import { GlassIconButton } from './GlassIconButton';
import { useState, useCallback, useEffect, useRef, useMemo, type ReactNode } from 'react';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BrandedQR } from './BrandedQR';
import { ContextMenu } from './ContextMenu';
import { API_BASE_URL } from '../config/api';
import { getUserId } from '../config/user';
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
    storeProductId?: number | null;
    requiresCoupon?: boolean;
    couponLabel?: string | null;
    l1CategoryId?: number | null;
    l2CategoryId?: number | null;
    l2CategoryName?: string | null;
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

function ShoppingListItemCard({ item, onToggle, onRemove, styles, colors }: {
    item: ShoppingListItem;
    onToggle: (item: ShoppingListItem) => void;
    onRemove: (id: number) => void;
    styles: ReturnType<typeof makeStyles>;
    colors: AppTheme;
}) {
    const { t } = useTranslation();
    return (
        <View style={[styles.card, item.isChecked && styles.cardChecked]}>
            <TouchableOpacity
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md }}
                onPress={() => onToggle(item)}
                activeOpacity={0.7}
            >
                <View style={[styles.checkCircle, item.isChecked && styles.checkCircleChecked]}>
                    {item.isChecked && <Ionicons name="checkmark" size={iconSize.sm} color={colors.onPrimary} />}
                </View>
                <View style={styles.imageContainer}>
                    <ProductImage
                        uris={item.imageUrls}
                        imageStyle={styles.productImage}
                        placeholderStyle={styles.imagePlaceholder}
                        emojiStyle={styles.imageEmoji}
                    />
                </View>
                <View style={styles.cardContent}>
                    <Text style={[styles.itemName, item.isChecked && styles.itemNameChecked]}>
                        {item.productName}
                    </Text>
                    <Text style={styles.itemQuantity}>
                        {t('shoppingListDetail.quantityLabel')}: {item.storeProductId
                            ? `${item.quantity} ${item.unit}`
                            : isWeighableDisplay(item.isWeighable, item.quantity)
                                ? (item.quantity < 10 ? `${item.quantity} kg` : `${item.quantity} g`)
                                : `${item.quantity} ${t('shoppingListDetail.unitPieces')}`}
                    </Text>
                    {item.requiresCoupon && item.couponLabel && !item.isChecked && (
                        <View style={styles.couponBadge}>
                            <Text style={styles.couponBadgeText}>{t('shoppingListDetail.couponBadge', { name: item.couponLabel })}</Text>
                        </View>
                    )}
                </View>
                {item.price && (
                    <Text style={[styles.itemPrice, item.isChecked && styles.itemPriceChecked]}>
                        {formatEuro(item.price)}
                    </Text>
                )}
            </TouchableOpacity>
            <TouchableOpacity
                style={styles.deleteBtn}
                onPress={() => onRemove(item.id)}
                hitSlop={8}
            >
                <Ionicons name="trash-outline" size={iconSize.sm} color={colors.textMuted} />
            </TouchableOpacity>
        </View>
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
    /** When true (multi-store mode), the all-items-checked completion prompt is suppressed */
    isPartOfBasket?: boolean;
    /** Title row override — multi-store passes the joined chain short names
     *  (e.g. "Maxima · Rimi"). Single store derives it from the list. */
    headerTitle?: string;
    /** Breadcrumb override — multi-store passes the joined addresses. */
    headerSubtitle?: string;
    /** Extra pinned content shown above the progress bar (multi-store: the store
     *  chip selector). */
    pinnedHeader?: ReactNode;
}

const PIECE_PRESETS = ['1', '2', '3', '5', '10'];
const WEIGHT_PRESETS = ['0.1', '0.2', '0.5', '1'];

export function ShoppingListDetail({
    listId,
    expectedCount,
    isPartOfBasket = false,
    headerTitle,
    headerSubtitle,
    pinnedHeader,
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

    const [list, setList] = useState<ShoppingList | null>(null);
    const [items, setItems] = useState<ShoppingListItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [quickAddText, setQuickAddText] = useState('');
    const [searchQuery, setSearchQuery] = useState('');

    const pendingDeleteRef = useRef<{ item: ShoppingListItem; timer: ReturnType<typeof setTimeout> } | null>(null);
    const [pendingDeleteTick, setPendingDeleteTick] = useState(0);
    void pendingDeleteTick;

    const inFlightItemsRef = useRef<Map<number, number>>(new Map());
    const FLIGHT_HOLD_MS = 1500;
    const markInFlight = (itemId: number) => { inFlightItemsRef.current.set(itemId, Date.now()); };

    const [searchResults, setSearchResults] = useState<any[]>([]);
    const [visibleCount, setVisibleCount] = useState(0);
    const [menuVisible, setMenuVisible] = useState(false);

    const [quantityModal, setQuantityModal] = useState<{
        productId: number | null;
        name: string;
        isWeighable: boolean;
        storeProductId: number | null;
        imageUrl: string | null;
    } | null>(null);
    const [quantityInput, setQuantityInput] = useState('1');
    const [modalIsWeighable, setModalIsWeighable] = useState(false);

    const [shareOpen, setShareOpen] = useState(false);
    const [shareToken, setShareToken] = useState<string | null>(null);
    const [shareStatus, setShareStatus] = useState<'pending' | 'claimed' | 'expired' | 'error'>('pending');
    const [shareLoading, setShareLoading] = useState(false);

    const shownCouponsRef = useRef<Set<string>>(new Set());
    const [couponQueue, setCouponQueue] = useState<string[]>([]);
    const [couponDontShow, setCouponDontShow] = useState(false);
    const [completionModal, setCompletionModal] = useState(false);
    const [kbHeight, setKbHeight] = useState(0);

    useEffect(() => {
        const show = Keyboard.addListener(
            Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
            e => setKbHeight(e.endCoordinates.height),
        );
        const hide = Keyboard.addListener(
            Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
            () => setKbHeight(0),
        );
        return () => { show.remove(); hide.remove(); };
    }, []);

    const dismissCoupon = async () => {
        const label = couponQueue[0];
        if (couponDontShow && label) {
            await AsyncStorage.setItem(`coupon_hide_${label}`, '1');
        }
        setCouponDontShow(false);
        setCouponQueue(q => q.slice(1));
    };

    const openShare = async () => {
        setShareOpen(true);
        setShareToken(null);
        setShareStatus('pending');
        setShareLoading(true);
        try {
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/shopping-lists/${id}/share`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (typeof data?.token !== 'string') throw new Error('Missing token');
            setShareToken(data.token);
        } catch {
            setShareStatus('error');
        } finally {
            setShareLoading(false);
        }
    };

    const closeShare = () => {
        setShareOpen(false);
        setShareToken(null);
        setShareStatus('pending');
    };

    useEffect(() => {
        if (!shareOpen || !shareToken) return;
        if (shareStatus === 'claimed' || shareStatus === 'expired') return;
        let cancelled = false;
        const poll = async () => {
            try {
                const res = await fetch(`${API_BASE_URL}/api/shopping-lists/share/${shareToken}/status`);
                if (!res.ok) return;
                const data = await res.json();
                if (cancelled) return;
                if (data.status === 'claimed') setShareStatus('claimed');
                else if (data.status === 'expired') setShareStatus('expired');
            } catch {}
        };
        poll();
        const interval = setInterval(poll, 1500);
        return () => { cancelled = true; clearInterval(interval); };
    }, [shareOpen, shareToken, shareStatus]);

    useFocusEffect(useCallback(() => {
        let attempts = 0;
        let cancelled = false;

        const fetchListMeta = async () => {
            try {
                const listRes = await fetch(`${API_BASE_URL}/api/shopping-lists/${id}`);
                const listData = await listRes.json();
                setList(listData);
            } catch {}
        };

        const expected = expectedCount ?? 0;

        const pollItems = async () => {
            if (cancelled) return;
            try {
                const res = await fetch(`${API_BASE_URL}/api/shopping-lists/${id}/items`);
                const data = await res.json();
                if (Array.isArray(data) && (data.length >= expected || attempts >= 20)) {
                    setItems(sortItems(data));
                    setLoading(false);
                    setVisibleCount(0);
                    for (let i = 0; i <= data.length; i++) {
                        setTimeout(() => setVisibleCount(i), i * 100);
                    }
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
                const res = await fetch(`${API_BASE_URL}/api/shopping-lists/${id}/items`);
                if (!res.ok) return;
                const server = await res.json();
                if (!Array.isArray(server) || cancelled) return;

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
    }, [id]));

    const checkedCount = items.filter(i => i.isChecked).length;
    const totalCount = items.length;
    const progress = totalCount > 0 ? checkedCount / totalCount : 0;

    const { uncheckedGroups, checkedItems } = useMemo(() => {
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

        return { uncheckedGroups: groups, checkedItems: checked };
    }, [items, visibleCount]);

    const toggleItem = async (item: ShoppingListItem) => {
        const newChecked = !item.isChecked;
        Haptics.impactAsync(newChecked ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light);

        const updatedItems = sortItems(
            items.map(i => i.id === item.id ? { ...i, isChecked: newChecked } : i)
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

        if (!isPartOfBasket && newChecked && updatedItems.every(i => i.isChecked)) {
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
    ) => {
        setModalIsWeighable(isWeighable);
        setQuantityInput(isWeighable ? '0.5' : '1');
        setQuantityModal({ productId, name, isWeighable, storeProductId, imageUrl });
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
        if (!list?.chainId) { setSearchResults([]); return; }
        try {
            const res = await fetch(`${API_BASE_URL}/api/store-products/search?name=${encodeURIComponent(query)}&chainId=${list.chainId}`);
            const data = await res.json();
            setSearchResults(Array.isArray(data) ? data.slice(0, 5) : []);
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
                body: JSON.stringify({ listId: Number(id), productId, storeProductId, quantity, name, isWeighable }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (typeof data?.id !== 'number') throw new Error('Response missing id');
            const newItem: ShoppingListItem = {
                id: data.id,
                listId: Number(id),
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

    const handleDuplicate = async () => {
        try {
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/shopping-lists/${id}/duplicate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
            });
            const data = await res.json();
            router.dismissAll();
            router.replace('/(tabs)/shoppingList' as any);
            setTimeout(() => { router.push(`/shopping-list/${data.id}` as any); }, 100);
        } catch {
            Alert.alert(t('shoppingListDetail.errorGeneric'), t('shoppingListDetail.errorCopy'));
        }
    };

    // ── Loading skeleton ──────────────────────────────────────────────────────

    if (loading) return (
        <>
            <CollapsingHeader
                controller={header}
                back
                collapsing={<ScreenHeading title={headerTitle ?? t('shoppingListDetail.fallbackTitle')} subtitle={headerSubtitle} />}
                pinned={pinnedHeader}
            />
            <View style={[styles.container, { paddingTop: header.paddingTop + spacing.lg, paddingHorizontal: spacing.lg, gap: spacing.sm }]}>
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

    const showSearchResults = list?.status === 'active' && quickAddText.length >= 2;

    return (
        <>
            <CollapsingHeader
                controller={header}
                back
                right={
                    list?.status === 'active' ? (
                        <GlassIconButton icon="share-social-outline" color={colors.textPrimary} onPress={openShare} />
                    ) : list?.status === 'completed' ? (
                        <GlassIconButton icon="ellipsis-vertical" color={colors.textMuted} onPress={() => setMenuVisible(true)} />
                    ) : undefined
                }
                collapsing={
                    <ScreenHeading
                        title={headerTitle ?? (list?.chainName ? chainBrandName(list.chainName) : list?.storeName) ?? t('shoppingListDetail.fallbackTitle')}
                        subtitle={headerSubtitle ?? (formatStoreStreet(list?.address) || list?.storeName || undefined)}
                    />
                }
                pinned={
                    <>
                        {pinnedHeader}
                        <View style={styles.progressContainer}>
                            <View style={styles.progressBar}>
                                <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
                            </View>
                            <Text style={styles.progressText}>{t('shoppingListDetail.progress', { checked: checkedCount, total: totalCount })}</Text>
                        </View>
                    </>
                }
            />

            <View style={styles.container}>
                    {pendingDeleteRef.current && (
                        <View style={[styles.undoToastWrap, { top: header.paddingTop }]} pointerEvents="box-none">
                            <TouchableOpacity style={styles.undoToast} onPress={undoItemDelete} activeOpacity={0.85}>
                                <Ionicons name="arrow-undo" size={iconSize.xs} color={colors.onPrimary} />
                                <Text style={styles.undoToastText}>{t('shoppingListDetail.deletedUndo')}</Text>
                            </TouchableOpacity>
                        </View>
                    )}

                    <Animated.ScrollView
                        {...header.scroll}
                        style={{ flex: 1 }}
                        contentContainerStyle={[styles.scrollContent, { paddingTop: header.paddingTop }]}
                    >
                        <View style={styles.listInner}>
                        {uncheckedGroups.map(group => (
                            <View key={group.name ?? '__no_category__'}>
                                <Text style={styles.sectionHeader}>{group.name ?? t('shoppingListDetail.uncategorised', { defaultValue: 'Kita' })}</Text>
                                <View style={styles.listContainer}>
                                    {group.items.map((item, index) => (
                                        <View key={item.id}>
                                            {index > 0 && <View style={styles.divider} />}
                                            <ShoppingListItemCard item={item} onToggle={toggleItem} onRemove={removeItem} styles={styles} colors={colors} />
                                        </View>
                                    ))}
                                </View>
                            </View>
                        ))}
                        {checkedItems.length > 0 && (
                            <View style={styles.listContainer}>
                                {checkedItems.map((item, index) => (
                                    <View key={item.id}>
                                        {index > 0 && <View style={styles.divider} />}
                                        <ShoppingListItemCard item={item} onToggle={toggleItem} onRemove={removeItem} styles={styles} colors={colors} />
                                    </View>
                                ))}
                            </View>
                        )}
                        {items.length === 0 && (
                            <View style={styles.centered}>
                                <Text style={styles.emptyText}>{t('shoppingListDetail.empty')}</Text>
                            </View>
                        )}
                        </View>
                    </Animated.ScrollView>

                    {/* Bottom bar group — KeyboardStickyView lifts it above the
                        keyboard reliably (manual padding under-lifts in Android
                        edge-to-edge). */}
                    <KeyboardStickyView>
                    {/* Floating search results — a glass card above the floating bar */}
                    {showSearchResults && (
                        <View style={styles.resultsWrap}>
                            <View style={styles.resultsShadow}>
                            <LiquidGlass style={styles.floatingResults} fallback="solid">
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
                                            promptQuantity(product.productId, product.storeProductName, product.isWeighable === 1 || product.isWeighable === true, product.id, product.imageUrl);
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
                            </LiquidGlass>
                            </View>
                        </View>
                    )}

                    {/* Floating search / add bar — glass on iOS, solid on Android,
                        detached above the safe area like the tab bar. */}
                    {list?.status === 'active' && (
                        <View style={[styles.addBarWrap, { paddingBottom: kbHeight > 0 ? spacing.sm : insets.bottom + spacing.sm }]}>
                            <View style={styles.addBarShadow}>
                            <LiquidGlass style={styles.addBar} fallback="solid">
                                <Ionicons name="search" size={iconSize.md} color={colors.textMuted} />
                                <TextInput
                                    style={styles.addBarInput}
                                    value={quickAddText}
                                    onChangeText={(text) => { setQuickAddText(text); handleSearch(text); }}
                                    placeholder={t('shoppingListDetail.searchPlaceholder')}
                                    placeholderTextColor={colors.textMuted}
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
                                {quickAddText.length > 0 && (
                                    <TouchableOpacity
                                        onPress={() => { setQuickAddText(''); setSearchQuery(''); setSearchResults([]); }}
                                        hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                                    >
                                        <Ionicons name="close-circle" size={iconSize.md} color={colors.textMuted} />
                                    </TouchableOpacity>
                                )}
                                <TouchableOpacity
                                    style={styles.addBarBtn}
                                    onPress={() => {
                                        const name = quickAddText.trim();
                                        if (!name) return;
                                        setQuickAddText('');
                                        setSearchQuery('');
                                        setSearchResults([]);
                                        addProduct(null, name, 1, false, null, null);
                                    }}
                                >
                                    <Ionicons name="add" size={iconSize.md} color={colors.onPrimary} />
                                </TouchableOpacity>
                            </LiquidGlass>
                            </View>
                        </View>
                    )}
                    </KeyboardStickyView>

                    <ContextMenu
                        visible={menuVisible}
                        onDismiss={() => setMenuVisible(false)}
                        actions={[
                            { icon: 'copy-outline', label: t('shoppingListDetail.copyList'), onPress: () => { setMenuVisible(false); handleDuplicate(); } },
                        ]}
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
                                        addProduct(modal.productId, modal.name, qty, modalIsWeighable, modal.storeProductId, modal.imageUrl);
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

            {/* Share modal */}
            <Modal visible={shareOpen} transparent animationType="fade" onRequestClose={closeShare}>
                <View style={styles.shareOverlay}>
                    <TouchableOpacity style={StyleSheet.absoluteFillObject} activeOpacity={1} onPress={closeShare} />
                    <View style={styles.shareContainer}>
                        {shareStatus === 'claimed' ? (
                            <>
                                <View style={styles.shareCheckCircle}>
                                    <Ionicons name="checkmark" size={40} color={colors.onPrimary} />
                                </View>
                                <Text style={styles.shareTitle}>{t('shoppingListDetail.shareConnected')}</Text>
                                <Text style={styles.shareSubtitle}>{t('shoppingListDetail.shareConnectedSub')}</Text>
                                <TouchableOpacity style={styles.shareCloseBtn} onPress={closeShare}>
                                    <Text style={styles.shareCloseBtnText}>{t('shoppingListDetail.shareClose')}</Text>
                                </TouchableOpacity>
                            </>
                        ) : shareStatus === 'expired' ? (
                            <>
                                <Text style={styles.shareTitle}>{t('shoppingListDetail.shareExpiredTitle')}</Text>
                                <Text style={styles.shareSubtitle}>{t('shoppingListDetail.shareCreateForShare')}</Text>
                                <TouchableOpacity style={styles.shareCloseBtn} onPress={closeShare}>
                                    <Text style={styles.shareCloseBtnText}>{t('shoppingListDetail.shareClose')}</Text>
                                </TouchableOpacity>
                            </>
                        ) : shareStatus === 'error' ? (
                            <>
                                <Text style={styles.shareTitle}>{t('shoppingListDetail.shareErrorTitle')}</Text>
                                <Text style={styles.shareSubtitle}>{t('shoppingListDetail.shareErrorBody')}</Text>
                                <TouchableOpacity style={styles.shareCloseBtn} onPress={closeShare}>
                                    <Text style={styles.shareCloseBtnText}>{t('shoppingListDetail.shareClose')}</Text>
                                </TouchableOpacity>
                            </>
                        ) : (
                            <>
                                <Text style={styles.shareTitle}>{t('shoppingListDetail.shareTitle')}</Text>
                                <Text style={styles.shareSubtitle}>{t('shoppingListDetail.shareSubtitle')}</Text>
                                <View style={styles.shareQrWrap}>
                                    {shareLoading || !shareToken ? (
                                        <ActivityIndicator size="large" color={colors.primary} />
                                    ) : (
                                        <BrandedQR value={shareToken} size={220} />
                                    )}
                                </View>
                                <TouchableOpacity style={styles.shareCloseBtn} onPress={closeShare}>
                                    <Text style={styles.shareCloseBtnText}>{t('shoppingListDetail.shareClose')}</Text>
                                </TouchableOpacity>
                            </>
                        )}
                    </View>
                </View>
            </Modal>
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },

    progressContainer: {
        flexDirection: 'row', alignItems: 'center', padding: spacing.md,
        backgroundColor: c.cardBackground, borderBottomWidth: 1, borderBottomColor: c.border, gap: spacing.sm,
    },
    progressBar: { flex: 1, height: 8, backgroundColor: c.border, borderRadius: radius.pill, overflow: 'hidden' },
    progressFill: { height: '100%', backgroundColor: c.primary, borderRadius: radius.pill },
    progressText: { ...typography.label, fontWeight: '400', color: c.textSecondary, minWidth: 50, textAlign: 'right' },

    scrollContent: { paddingBottom: spacing.xxxl },
    listInner: { paddingTop: spacing.lg, paddingHorizontal: spacing.md },

    sectionHeader: {
        ...typography.labelSmall, fontWeight: '700', color: c.textMuted,
        textTransform: 'uppercase', letterSpacing: 0.6,
        paddingHorizontal: spacing.xs, paddingTop: spacing.lg, paddingBottom: 6,
    },
    listContainer: {
        backgroundColor: c.cardBackground, marginBottom: spacing.sm,
        borderRadius: radius.lg, overflow: 'hidden',
        ...elevation.level1,
    },
    card: {
        backgroundColor: c.cardBackground, flexDirection: 'row',
        alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.md,
    },
    divider: { height: 0.5, backgroundColor: c.border, marginLeft: spacing.lg },
    cardChecked: { opacity: 0.5 },
    checkCircle: {
        width: 22, height: 22, borderRadius: radius.pill,
        borderWidth: 2, borderColor: c.border,
        alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    },
    checkCircleChecked: { backgroundColor: c.primary, borderColor: c.primary },
    imageContainer: { width: avatarSize.md, height: avatarSize.md, flexShrink: 0 },
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

    // ── Floating search / add bar ─────────────────────────────────────────────
    // Wrapper holds the margins; the shadow lives on a non-clipped layer so the
    // glass pill (overflow hidden) can still cast it (same trick as the map).
    addBarWrap: { paddingHorizontal: spacing.lg },
    addBarShadow: { borderRadius: radius.pill, ...elevation.level3 },
    addBar: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
        paddingLeft: spacing.lg, paddingRight: spacing.xs, paddingVertical: spacing.xs,
        backgroundColor: c.cardBackground,
        borderRadius: radius.pill, overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    },
    addBarInput: { flex: 1, ...typography.bodySmall, color: c.textPrimary, paddingVertical: 2 },
    addBarBtn: { width: 36, height: 36, borderRadius: radius.pill, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },

    // ── Undo toast ────────────────────────────────────────────────────────────
    undoToastWrap: { position: 'absolute', left: 0, right: 0, zIndex: 60, alignItems: 'center' },
    undoToast: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
        backgroundColor: c.textPrimary,
        marginHorizontal: spacing.lg, marginTop: spacing.md,
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
    presetsRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg, flexWrap: 'wrap' },
    presetBtn: {
        paddingHorizontal: spacing.lg, paddingVertical: 7, borderRadius: radius.pill,
        borderWidth: 1, borderColor: c.border, backgroundColor: c.pageBackground,
    },
    presetBtnActive: { backgroundColor: c.primary, borderColor: c.primary },
    presetBtnText: { ...typography.label, fontWeight: '500', color: c.textSecondary },
    presetBtnTextActive: { color: c.onPrimary, fontWeight: '700' },

    // ── Share modal ───────────────────────────────────────────────────────────
    shareOverlay: { flex: 1, backgroundColor: c.overlayBackdrop, alignItems: 'center', justifyContent: 'center' },
    shareContainer: {
        backgroundColor: c.cardBackground, borderRadius: radius.lg,
        paddingVertical: spacing.xl, paddingHorizontal: spacing.xl, width: '85%', alignItems: 'center',
        ...elevation.level3,
    },
    shareTitle: { ...typography.subheading, color: c.textPrimary, marginBottom: 6, textAlign: 'center' },
    shareSubtitle: { ...typography.label, fontWeight: '400', color: c.textSecondary, marginBottom: spacing.lg, textAlign: 'center' },
    shareQrWrap: {
        marginBottom: spacing.lg,
        minWidth: 244, minHeight: 244, alignItems: 'center', justifyContent: 'center',
    },
    shareCloseBtn: { paddingHorizontal: spacing.xl, paddingVertical: spacing.md, backgroundColor: c.primary, borderRadius: radius.pill },
    shareCloseBtnText: { ...typography.bodySmallStrong, color: c.onPrimary },
    shareCheckCircle: {
        width: 72, height: 72, borderRadius: radius.pill, backgroundColor: c.success,
        alignItems: 'center', justifyContent: 'center', marginBottom: spacing.lg,
    },

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
