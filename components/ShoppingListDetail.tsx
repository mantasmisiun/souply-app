import {
    View, Text, TouchableOpacity, StyleSheet, ActivityIndicator,
    Alert, TextInput, Platform, Modal, KeyboardAvoidingView, Keyboard,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { SkeletonBox } from './SkeletonBox';
import { useRouter, useFocusEffect } from 'expo-router';
import { useCollapsingHeader, CollapsingHeader } from './CollapsingHeader';
import { ScreenHeading } from './ScreenHeading';
import { GlassIconButton } from './GlassIconButton';
import { useState, useCallback, useEffect, useRef, useMemo, type ReactNode } from 'react';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import QRCode from 'react-native-qrcode-svg';
import { API_BASE_URL } from '../config/api';
import { getUserId } from '../config/user';
import { ProductImage } from './ProductImage';
import { useTheme, type AppTheme } from '../constants/theme';
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
    l2CategoryId?: number | null;
    l2CategoryName?: string | null;
}

const sortItems = (arr: ShoppingListItem[]): ShoppingListItem[] =>
    arr.sort((a, b) => {
        if (a.isChecked !== b.isChecked) return Number(a.isChecked) - Number(b.isChecked);
        if (!a.isChecked) {
            const ca = a.l2CategoryName ?? '￿';
            const cb = b.l2CategoryName ?? '￿';
            if (ca !== cb) return ca.localeCompare(cb, 'lt');
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
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 }}
                onPress={() => onToggle(item)}
                activeOpacity={0.7}
            >
                <View style={[styles.checkCircle, item.isChecked && styles.checkCircleChecked]}>
                    {item.isChecked && <Ionicons name="checkmark" size={16} color={colors.onPrimary} />}
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
                <Ionicons name="trash-outline" size={16} color={colors.textMuted} />
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
                if (!a.name && !b.name) return 0;
                if (!a.name) return 1;
                if (!b.name) return -1;
                return a.name.localeCompare(b.name, 'lt');
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
            <View style={[styles.container, { paddingTop: header.paddingTop + 16, paddingHorizontal: 16, gap: 10 }]}>
                {Array.from({ length: 8 }).map((_, i) => (
                    <View key={i} style={{ backgroundColor: colors.cardBackground, borderRadius: 10, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
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
                                <Ionicons name="arrow-undo" size={14} color={colors.onPrimary} />
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
                                {group.name && <Text style={styles.sectionHeader}>{group.name}</Text>}
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
                    {/* Floating search results — sit above the pinned add bar */}
                    {showSearchResults && (
                        <View style={styles.floatingResults}>
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
                                        {alreadyInList && <Ionicons name="checkmark-circle" size={18} color={colors.primary} style={{ marginRight: 8 }} />}
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
                                <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
                                <Text style={styles.customItemText}>{t('shoppingListDetail.addCustom', { name: quickAddText })}</Text>
                            </TouchableOpacity>
                        </View>
                    )}

                    {/* Pinned add bar — only for active lists. Bottom inset clears
                        the Android nav bar (skipped while the keyboard is open). */}
                    {list?.status === 'active' && (
                        <View style={[styles.addBar, { paddingBottom: 12 + (kbHeight > 0 ? 0 : insets.bottom) }]}>
                            <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
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
                                    <Ionicons name="close" size={18} color={colors.textSecondary} />
                                </TouchableOpacity>
                            )}
                        </View>
                    )}
                    </KeyboardStickyView>

                    {menuVisible && (
                        <TouchableOpacity style={styles.menuOverlay} onPress={() => setMenuVisible(false)} activeOpacity={1}>
                            <View style={styles.menuContainer}>
                                <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuVisible(false); handleDuplicate(); }}>
                                    <Ionicons name="copy-outline" size={18} color={colors.textPrimary} />
                                    <Text style={styles.menuItemText}>{t('shoppingListDetail.copyList')}</Text>
                                </TouchableOpacity>
                            </View>
                        </TouchableOpacity>
                    )}
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
                                        {modalIsWeighable ? <Ionicons name="checkmark" size={14} color={colors.onPrimary} /> : null}
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
                                {couponDontShow && <Ionicons name="checkmark" size={14} color="#fff" />}
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
                                        <QRCode
                                            value={shareToken}
                                            size={220}
                                            // Branded centre mark; ecl="H" keeps it scannable
                                            // with the logo over the middle, logoMargin adds a
                                            // little padding around the mark.
                                            ecl="H"
                                            logo={require('../assets/images/icon.png')}
                                            logoSize={46}
                                            logoMargin={5}
                                            logoBackgroundColor="#ffffff"
                                            logoBorderRadius={10}
                                        />
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
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    headerLogo: { width: 32, height: 32, marginLeft: 8, borderRadius: 6 },

    progressContainer: {
        flexDirection: 'row', alignItems: 'center', padding: 12,
        backgroundColor: c.cardBackground, borderBottomWidth: 1, borderBottomColor: c.border, gap: 10,
    },
    progressBar: { flex: 1, height: 8, backgroundColor: c.border, borderRadius: 4, overflow: 'hidden' },
    progressFill: { height: '100%', backgroundColor: c.primary, borderRadius: 4 },
    progressText: { fontSize: 13, color: c.textSecondary, minWidth: 50, textAlign: 'right' },

    scrollContent: { paddingBottom: 40 },
    listInner: { paddingTop: 16, paddingHorizontal: 12 },

    sectionHeader: {
        fontSize: 12, fontWeight: '700', color: c.textMuted,
        textTransform: 'uppercase', letterSpacing: 0.6,
        paddingHorizontal: 4, paddingTop: 16, paddingBottom: 6,
    },
    listContainer: {
        backgroundColor: c.cardBackground, marginBottom: 10,
        borderRadius: 10, overflow: 'hidden',
        elevation: 1, shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2,
    },
    card: {
        backgroundColor: c.cardBackground, flexDirection: 'row',
        alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, gap: 12,
    },
    divider: { height: 0.5, backgroundColor: c.border, marginLeft: 14 },
    cardChecked: { opacity: 0.5 },
    checkCircle: {
        width: 22, height: 22, borderRadius: 11,
        borderWidth: 2, borderColor: c.border,
        alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    },
    checkCircleChecked: { backgroundColor: c.primary, borderColor: c.primary },
    imageContainer: { width: 40, height: 40, flexShrink: 0 },
    productImage: { width: 40, height: 40, borderRadius: 8 },
    imagePlaceholder: {
        width: 40, height: 40, borderRadius: 8,
        backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center',
    },
    imageEmoji: { fontSize: 22, opacity: 0.4 },
    cardContent: { flex: 1 },
    itemName: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    itemNameChecked: { textDecorationLine: 'line-through', color: c.textMuted },
    itemQuantity: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
    itemPrice: { fontSize: 14, fontWeight: '500', color: c.primary },
    itemPriceChecked: { color: c.textMuted },
    deleteBtn: { paddingLeft: 8, paddingVertical: 4 },

    emptyText: { fontSize: 16, color: c.textSecondary },

    // ── Floating search results ───────────────────────────────────────────────
    floatingResults: {
        backgroundColor: c.cardBackground,
        borderTopWidth: 0.5, borderTopColor: c.border,
        maxHeight: 280,
        elevation: 8,
        shadowColor: '#000', shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.1, shadowRadius: 4,
    },
    searchResultItem: {
        padding: 12, borderBottomWidth: 1, borderBottomColor: c.borderSubtle,
        flexDirection: 'row', alignItems: 'center',
    },
    searchResultText: { fontSize: 14, color: c.textPrimary },
    customItemButton: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
    customItemText: { fontSize: 14, color: c.primary },

    // ── Pinned add bar ────────────────────────────────────────────────────────
    addBar: {
        flexDirection: 'row', alignItems: 'center', gap: 10,
        paddingHorizontal: 16, paddingVertical: 12,
        backgroundColor: c.cardBackground,
        borderTopWidth: 0.5, borderTopColor: c.border,
    },
    addBarInput: { flex: 1, fontSize: 14, color: c.textPrimary, paddingVertical: 2 },

    // ── Undo toast ────────────────────────────────────────────────────────────
    undoToastWrap: { position: 'absolute', left: 0, right: 0, zIndex: 60, alignItems: 'center' },
    undoToast: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        backgroundColor: c.textPrimary,
        marginHorizontal: 16, marginTop: 12,
        paddingVertical: 10, paddingHorizontal: 14,
        borderRadius: 10, alignSelf: 'center', zIndex: 50,
    },
    undoToastText: { color: c.onPrimary, fontSize: 13, fontWeight: '600' },

    // ── Menu overlay ──────────────────────────────────────────────────────────
    menuOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 },
    menuContainer: {
        position: 'absolute', top: 8, right: 12,
        backgroundColor: c.cardBackground, borderRadius: 10,
        elevation: 8, shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4,
        minWidth: 180,
    },
    menuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: 10 },
    menuItemText: { fontSize: 14, color: c.textPrimary },

    // ── Quantity modal ────────────────────────────────────────────────────────
    modalOverlay: {
        flex: 1, backgroundColor: c.overlayBackdrop,
        justifyContent: 'center', alignItems: 'center',
    },
    modalContainer: {
        backgroundColor: c.cardBackground, borderRadius: 16, padding: 24, width: '90%',
        elevation: 8, shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 8,
    },
    modalTitle: { fontSize: 16, fontWeight: '700', color: c.textPrimary, marginBottom: 12 },
    completeModalBody: { fontSize: 14, color: c.textSecondary, marginBottom: 20, lineHeight: 20 },
    modalLabel: { fontSize: 13, color: c.textSecondary, marginBottom: 8 },
    modalInput: {
        borderWidth: 1, borderColor: c.border, borderRadius: 8,
        padding: 12, fontSize: 18, color: c.textPrimary, textAlign: 'center', marginBottom: 16,
    },
    modalButtons: { flexDirection: 'row', gap: 10 },
    modalCancel: { flex: 1, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, alignItems: 'center' },
    modalCancelText: { fontSize: 14, color: c.textSecondary, fontWeight: '600' },
    modalConfirm: { flex: 1, padding: 12, borderRadius: 8, backgroundColor: c.primary, alignItems: 'center' },
    modalConfirmText: { fontSize: 14, color: c.onPrimary, fontWeight: '600' },
    weighableRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 },
    weighableLabel: { fontSize: 14, color: c.textPrimary },
    checkbox: {
        width: 22, height: 22, borderRadius: 11,
        borderWidth: 2, borderColor: c.primary, alignItems: 'center', justifyContent: 'center',
    },
    checkboxChecked: { backgroundColor: c.primary, borderColor: c.primary },

    // ── Quantity presets ──────────────────────────────────────────────────────
    presetsRow: { flexDirection: 'row', gap: 8, marginBottom: 14, flexWrap: 'wrap' },
    presetBtn: {
        paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20,
        borderWidth: 1, borderColor: c.border, backgroundColor: c.pageBackground,
    },
    presetBtnActive: { backgroundColor: c.primary, borderColor: c.primary },
    presetBtnText: { fontSize: 13, color: c.textSecondary, fontWeight: '500' },
    presetBtnTextActive: { color: c.onPrimary, fontWeight: '700' },

    // ── Share modal ───────────────────────────────────────────────────────────
    shareOverlay: { flex: 1, backgroundColor: c.overlayBackdrop, alignItems: 'center', justifyContent: 'center' },
    shareContainer: {
        backgroundColor: c.cardBackground, borderRadius: 16,
        paddingVertical: 24, paddingHorizontal: 28, width: '85%', alignItems: 'center',
        elevation: 8, shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 8,
    },
    shareTitle: { fontSize: 18, fontWeight: '700', color: c.textPrimary, marginBottom: 6, textAlign: 'center' },
    shareSubtitle: { fontSize: 13, color: c.textSecondary, marginBottom: 16, textAlign: 'center' },
    shareQrWrap: {
        padding: 12, backgroundColor: '#fff', borderRadius: 12, marginBottom: 18,
        minWidth: 244, minHeight: 244, alignItems: 'center', justifyContent: 'center',
    },
    shareCloseBtn: { paddingHorizontal: 24, paddingVertical: 12, backgroundColor: c.primary, borderRadius: 8 },
    shareCloseBtnText: { color: c.onPrimary, fontSize: 14, fontWeight: '600' },
    shareCheckCircle: {
        width: 72, height: 72, borderRadius: 36, backgroundColor: c.success,
        alignItems: 'center', justifyContent: 'center', marginBottom: 16,
    },

    // ── Coupon modals ─────────────────────────────────────────────────────────
    couponBadge: {
        flexDirection: 'row', alignSelf: 'flex-start',
        backgroundColor: '#FFF3B0', borderWidth: 1, borderColor: '#FFCC00',
        borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, marginTop: 4,
    },
    couponBadgeText: { fontSize: 10, fontWeight: '700', color: '#003D8F' },
    couponModalContainer: {
        backgroundColor: c.cardBackground, borderRadius: 16,
        paddingVertical: 28, paddingHorizontal: 24, width: '85%', alignItems: 'center',
        elevation: 8, shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 8,
    },
    couponBadgeLarge: {
        backgroundColor: '#FFF3B0', borderWidth: 2, borderColor: '#FFCC00',
        borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8, marginBottom: 18,
    },
    couponBadgeLargeText: { fontSize: 20, fontWeight: '800', color: '#003D8F' },
    couponModalTitle: { fontSize: 18, fontWeight: '700', color: c.textPrimary, marginBottom: 8, textAlign: 'center' },
    couponModalBody: { fontSize: 14, color: c.textSecondary, textAlign: 'center', lineHeight: 20, marginBottom: 16 },
    couponDontShowRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 20 },
    couponDontShowLabel: { fontSize: 13, color: c.textSecondary },
    couponModalBtn: { paddingHorizontal: 32, paddingVertical: 12, backgroundColor: '#003D8F', borderRadius: 8 },
    couponModalBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
