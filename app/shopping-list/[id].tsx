import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, TextInput, Image, Keyboard, Platform, Modal  } from 'react-native';
import { SkeletonBox } from '../../components/SkeletonBox';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import AsyncStorage from '@react-native-async-storage/async-storage';
import QRCode from 'react-native-qrcode-svg';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import ReanimatedSwipeable, { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { ProductImage } from '../../components/ProductImage';
import { useTheme, type AppTheme } from '../../constants/theme';
import * as Haptics from 'expo-haptics';

interface ShoppingList {
    id: number;
    storeId: number;
    storeName: string;
    storeAddress: string;
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
    const swipeableRef = useRef<SwipeableMethods>(null);

    // Matches the list-tab pattern: swipe-left = immediate delete with a
    // 3-second undo toast in the parent. No modal alert — the swipe is
    // the confirmation, and the toast covers slip-ups.
    const handleSwipeOpen = (direction: 'left' | 'right') => {
        swipeableRef.current?.close();
        if (direction === 'left') {
            onRemove(item.id);
        }
    };

    const rightActions = () => (
        <View style={styles.deleteAction}>
            <Ionicons name="trash-outline" size={24} color={colors.onPrimary} />
            <Text style={styles.actionText}>Ištrinti</Text>
        </View>
    );

    return (
        <View style={{ paddingHorizontal: 2, overflow: 'visible' }}>
            <ReanimatedSwipeable
                ref={swipeableRef}
                renderRightActions={rightActions}
                overshootRight={false}
                friction={3}
                activeOffsetX={[-20, 20]}
                failOffsetY={[-10, 10]}
                rightThreshold={40}
                onSwipeableOpen={handleSwipeOpen}
            >
                <TouchableOpacity
                    style={[styles.card, item.isChecked && styles.cardChecked]}
                    onPress={() => onToggle(item)}
                >
                    <View style={styles.imageContainer}>
                        {item.isChecked ? (
                            <View style={styles.checkmarkContainer}>
                                <Ionicons name="checkmark" size={24} color={colors.onPrimary} />
                            </View>
                        ) : (
                            <ProductImage
                                uris={item.imageUrls}
                                imageStyle={styles.productImage}
                                placeholderStyle={styles.imagePlaceholder}
                                emojiStyle={styles.imageEmoji}
                            />
                        )}
                    </View>
                    <View style={styles.cardContent}>
                        <Text style={[styles.itemName, item.isChecked && styles.itemNameChecked]}>
                            {item.productName}
                        </Text>
                        <Text style={styles.itemQuantity}>
                            Kiekis: {item.storeProductId
                                ? `${item.quantity} ${item.unit}`
                                : item.isWeighable
                                    ? (item.quantity < 10 ? `${item.quantity} kg` : `${item.quantity} g`)
                                    : `${item.quantity} vnt.`}
                        </Text>
                        {item.requiresCoupon && item.couponLabel && !item.isChecked && (
                            <View style={styles.couponBadge}>
                                <Text style={styles.couponBadgeText}>{item.couponLabel} kuponas</Text>
                            </View>
                        )}
                    </View>
                    {item.price && (
                        <Text style={[styles.itemPrice, item.isChecked && styles.itemPriceChecked]}>
                            €{item.price.toFixed(2)}
                        </Text>
                    )}
                </TouchableOpacity>
            </ReanimatedSwipeable>
        </View>
    );
}
export default function ShoppingListScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const [list, setList] = useState<ShoppingList | null>(null);
    const [items, setItems] = useState<ShoppingListItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    // Inline search+add input at the top of the item list. Typing runs a
    // chain-scoped StoreProduct search and shows suggestions inline;
    // Enter on a non-empty value adds it as a custom item.
    const [quickAddText, setQuickAddText] = useState('');
    // Item-level swipe-delete undo: we keep the pending item + timer
    // out-of-render in a ref (so the timeout callback reads fresh
    // state), and force re-renders with a tick counter when the toast
    // needs to appear/disappear.
    const pendingDeleteRef = useRef<{ item: ShoppingListItem; timer: ReturnType<typeof setTimeout> } | null>(null);
    const [pendingDeleteTick, setPendingDeleteTick] = useState(0);
    void pendingDeleteTick; // read by render below
    // Item-level mutation guard for the live-sync poll. When a local
    // toggle or add is in flight, we record the item id with a timestamp
    // — the poll merger keeps the local copy of that row until the
    // guard window expires, so a stale server read can't revert an
    // optimistic change mid-request.
    const inFlightItemsRef = useRef<Map<number, number>>(new Map());
    const FLIGHT_HOLD_MS = 1500;
    const markInFlight = (itemId: number) => {
        inFlightItemsRef.current.set(itemId, Date.now());
    };
    const [searchResults, setSearchResults] = useState<any[]>([]);
    const [visibleCount, setVisibleCount] = useState(0);
    const [menuVisible, setMenuVisible] = useState(false);
    const { id, expectedCount } = useLocalSearchParams<{ id: string; expectedCount: string }>();
    const [quantityModal, setQuantityModal] = useState<{
        productId: number | null;
        name: string;
        isWeighable: boolean;
        storeProductId: number | null;
        imageUrl: string | null;
    } | null>(null);
    const [quantityInput, setQuantityInput] = useState('1');
    const [modalIsWeighable, setModalIsWeighable] = useState(false);
    const [keyboardHeight, setKeyboardHeight] = useState(0);
    // Share-modal state. shareToken is null until the POST returns; the
    // QR is only rendered once we have a real token.
    const [shareOpen, setShareOpen] = useState(false);
    const [shareToken, setShareToken] = useState<string | null>(null);
    const [shareStatus, setShareStatus] = useState<'pending' | 'claimed' | 'expired' | 'error'>('pending');
    const [shareLoading, setShareLoading] = useState(false);
    // Coupon reminder: queue of coupon labels not yet shown this session.
    // shownCouponsRef prevents re-showing a label already dismissed.
    const shownCouponsRef = useRef<Set<string>>(new Set());
    const [couponQueue, setCouponQueue] = useState<string[]>([]);
    const [couponDontShow, setCouponDontShow] = useState(false);

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

    // Poll the token status while the share modal is open. 1.5s cadence
    // is a reasonable middle ground — users perceive the "scanned"
    // confirmation as near-instant, and server load stays trivial for a
    // thesis-scale deployment. Interval is torn down on unmount, on
    // status transition (claimed/expired), and on modal close.
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
    useEffect(() => {
        const show = Keyboard.addListener('keyboardDidShow', e => setKeyboardHeight(e.endCoordinates.height));
        const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
        return () => { show.remove(); hide.remove(); };
    }, []);
    useFocusEffect(useCallback(() => {
        let attempts = 0;
        let cancelled = false;

        const fetchList = async () => {
            try {
                const listRes = await fetch(`${API_BASE_URL}/api/shopping-lists/${id}`);
                const listData = await listRes.json();
                setList(listData);
            } catch (error) {
                console.error('Failed to fetch list:', error);
            }
        };

        const expected = expectedCount ? parseInt(expectedCount) : 0;

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
            } catch (error) {
                console.error('Failed to fetch items:', error);
                setLoading(false);
            }
        };

        fetchList();
        pollItems();

        // Live sync — while this screen is open, re-fetch items every
        // 3s so collaborative edits from other list members show up
        // without needing a focus change. Merger below respects
        // in-flight local mutations so we don't clobber an optimistic
        // toggle or a swipe-delete that's still inside its undo window.
        const syncItems = async () => {
            if (cancelled) return;
            try {
                const res = await fetch(`${API_BASE_URL}/api/shopping-lists/${id}/items`);
                if (!res.ok) return;
                const server = await res.json();
                if (!Array.isArray(server) || cancelled) return;

                // Expire stale in-flight guards — a dead request
                // shouldn't freeze its row forever.
                const now = Date.now();
                for (const [k, ts] of Array.from(inFlightItemsRef.current.entries())) {
                    if (now - ts > FLIGHT_HOLD_MS) inFlightItemsRef.current.delete(k);
                }

                setItems(prev => {
                    const byId = new Map<number, ShoppingListItem>(prev.map(p => [p.id, p]));
                    const merged: ShoppingListItem[] = server.map((s: any) => {
                        // Keep the local copy while a mutation on this row
                        // is still racing the server.
                        if (inFlightItemsRef.current.has(s.id)) {
                            return byId.get(s.id) ?? s;
                        }
                        return s;
                    });
                    // Row is locally-deleted and within the 3s undo
                    // window — drop the server version so it doesn't
                    // flash back in.
                    const pendDel = pendingDeleteRef.current?.item.id;
                    const filtered = pendDel != null
                        ? merged.filter(m => m.id !== pendDel)
                        : merged;
                    sortItems(filtered);
                    return filtered;
                });
                // Keep the staggered reveal in sync — any newly-added
                // rows from other members should be visible immediately.
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

        // Coupon reminder: first check of an item that needs a Lidl+ coupon
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

        if (newChecked && updatedItems.every(i => i.isChecked)) {
            // Fire the completion prompt exactly once per list. After "Ne"
            // the user can finish manually from the tab's swipe-complete
            // — no point re-nagging every time they uncheck/recheck a
            // stray item. Persistent flag in AsyncStorage so the one-shot
            // survives navigations.
            const key = `sl_prompted_${id}`;
            const already = await AsyncStorage.getItem(key);
            if (already === '1') return;
            await AsyncStorage.setItem(key, '1');
            Alert.alert(
                'Pirkiniai surinkti!',
                'Ar norite pažymėti sąrašą kaip užbaigtą?',
                [
                    { text: 'Ne', style: 'cancel' },
                    {
                        text: 'Taip',
                        onPress: async () => {
                            await fetch(`${API_BASE_URL}/api/shopping-lists/${id}/status`, {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ status: 'completed' }),
                            });
                            router.back();
                        }
                    }
                ]
            );
        }
    };
    const promptQuantity = (productId: number | null, name: string, isWeighable: boolean, storeProductId: number | null = null, imageUrl: string | null = null) => {
        setModalIsWeighable(isWeighable);
        setQuantityInput(isWeighable ? '0.5' : '1');
        setQuantityModal({ productId, name, isWeighable, storeProductId, imageUrl });
    };
    // Optimistic delete with 3-second undo. Hides the row locally, queues
    // the DELETE request, and shows the undo toast. Tapping Atšaukti
    // before the timer cancels the request and restores the row.
    const removeItem = (itemId: number) => {
        const target = items.find(i => i.id === itemId);
        if (!target) return;
        setItems(prev => prev.filter(i => i.id !== itemId));
        // If another delete is already pending, finalize it first —
        // second-delete shouldn't cancel the first undo window.
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
        // Without a chainId we'd search across all chains — the results
        // would include products the user's selected store doesn't
        // actually stock. Bail out until the list (and therefore chainId)
        // has loaded.
        if (!list?.chainId) { setSearchResults([]); return; }
        try {
            const res = await fetch(`${API_BASE_URL}/api/store-products/search?name=${encodeURIComponent(query)}&chainId=${list.chainId}`);
            const data = await res.json();
            setSearchResults(Array.isArray(data) ? data.slice(0, 5) : []);
        } catch {}
    };

    const addProduct = async (productId: number | null, name: string, quantity: number, isWeighable: boolean, storeProductId: number | null = null, imageUrl: string | null = null) => {
        const existing = items.find(i => i.productId === productId && productId !== null);
        if (existing) {
            Alert.alert('Jau sąraše', `"${name}" jau yra pirkinių sąraše`);
            return;
        }
        try {
            const res = await fetch(`${API_BASE_URL}/api/list-items`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    listId: Number(id),
                    productId,
                    storeProductId,
                    quantity,
                    name,
                }),
            });
            if (!res.ok) {
                // Previously we'd happily parse a 400 response, end up with
                // data.id = undefined, and push a keyless item into the
                // list — triggering React's "unique key" warning AND
                // showing a ghost row that never existed in the DB. Now
                // we reject explicitly before touching state.
                throw new Error(`HTTP ${res.status}`);
            }
            const data = await res.json();
            if (typeof data?.id !== 'number') {
                throw new Error('Response missing id');
            }
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
        } catch (error) {
            Alert.alert('Klaida', 'Nepavyko pridėti produkto');
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
            const newId = data.id;
            router.dismissAll();
            router.replace('/(tabs)/shoppingList' as any);
            setTimeout(() => {
                router.push(`/shopping-list/${newId}` as any);
            }, 100);
        } catch (error) {
            Alert.alert('Klaida', 'Nepavyko nukopijuoti sąrašo');
        }
    };

    if (loading) return (
        <View style={[styles.container, { padding: 16, gap: 10 }]}>
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
    );

    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <>
                <Stack.Screen options={{
                    title: list?.storeAddress || 'Pirkinių sąrašas',
                    headerStyle: { backgroundColor: colors.cardBackground },
                    headerShadowVisible: false,
                    headerLeft: () => list?.chainLogoUrl ? (
                        <Image source={{ uri: list.chainLogoUrl }} style={styles.headerLogo} resizeMode="contain" />
                    ) : null,
                    headerRight: () => (
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginRight: 8 }}>
                            {list?.status === 'active' && (
                                <TouchableOpacity style={{ paddingHorizontal: 8 }} onPress={openShare}>
                                    <Ionicons name="share-social-outline" size={22} color={colors.textPrimary} />
                                </TouchableOpacity>
                            )}
                            {list?.status === 'completed' && (
                                <TouchableOpacity style={{ paddingHorizontal: 8 }} onPress={() => setMenuVisible(true)}>
                                    <Ionicons name="ellipsis-vertical" size={22} color={colors.textMuted} />
                                </TouchableOpacity>
                            )}
                        </View>
                    ),
                }} />

                <View style={styles.container}>
                    {pendingDeleteRef.current && (
                        <TouchableOpacity
                            style={styles.undoToast}
                            onPress={undoItemDelete}
                            activeOpacity={0.85}
                        >
                            <Ionicons name="arrow-undo" size={14} color={colors.onPrimary} />
                            <Text style={styles.undoToastText}>
                                Ištrinta. Atšaukti?
                            </Text>
                        </TouchableOpacity>
                    )}
                    <View style={styles.progressContainer}>
                        <View style={styles.progressBar}>
                            <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
                        </View>
                        <Text style={styles.progressText}>{checkedCount} iš {totalCount}</Text>
                    </View>

                    <ScrollView contentContainerStyle={styles.list}>
                        {list?.status === 'active' && (
                            <View style={styles.quickAddWrapper}>
                                <View style={styles.quickAddRow}>
                                    <Ionicons name="search-outline" size={18} color={colors.textMuted} />
                                    <TextInput
                                        style={styles.quickAddInput}
                                        value={quickAddText}
                                        onChangeText={(t) => { setQuickAddText(t); handleSearch(t); }}
                                        placeholder="Ieškoti arba pridėti prekę…"
                                        placeholderTextColor={colors.textMuted}
                                        onSubmitEditing={() => {
                                            const name = quickAddText.trim();
                                            if (name.length === 0) return;
                                            setQuickAddText('');
                                            setSearchQuery('');
                                            setSearchResults([]);
                                            // Custom item: productId + storeProductId null, qty 1.
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
                                {quickAddText.length >= 2 && (
                                    <View style={styles.inlineSearchResults}>
                                        {searchResults.map((product, index) => {
                                            const alreadyInList = items.some(i => i.productId === product.productId);
                                            return (
                                                <TouchableOpacity
                                                    key={`${product.id}-${index}`}
                                                    style={styles.searchResultItem}
                                                    onPress={() => {
                                                        if (alreadyInList) {
                                                            Alert.alert('Jau sąraše', `"${product.storeProductName}" jau yra pirkinių sąraše`);
                                                            return;
                                                        }
                                                        promptQuantity(product.productId, product.storeProductName, product.isWeighable === 1 || product.isWeighable === true, product.id, product.imageUrl);
                                                        setQuickAddText('');
                                                        setSearchQuery('');
                                                        setSearchResults([]);
                                                    }}
                                                >
                                                    {alreadyInList && (
                                                        <Ionicons name="checkmark-circle" size={18} color={colors.primary} style={{ marginRight: 8 }} />
                                                    )}
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
                                            <Text style={styles.customItemText}>Pridėti "{quickAddText}" kaip naują prekę</Text>
                                        </TouchableOpacity>
                                    </View>
                                )}
                            </View>
                        )}
                        {uncheckedGroups.map(group => (
                            <View key={group.name ?? '__no_category__'}>
                                {group.name && (
                                    <Text style={styles.sectionHeader}>{group.name}</Text>
                                )}
                                <View style={styles.listContainer}>
                                    {group.items.map((item, index) => (
                                        <Animated.View key={item.id} entering={FadeInDown}>
                                            {index > 0 && <View style={styles.divider} />}
                                            <ShoppingListItemCard
                                                item={item}
                                                onToggle={toggleItem}
                                                onRemove={removeItem}
                                                styles={styles}
                                                colors={colors}
                                            />
                                        </Animated.View>
                                    ))}
                                </View>
                            </View>
                        ))}
                        {checkedItems.length > 0 && (
                            <View style={styles.listContainer}>
                                {checkedItems.map((item, index) => (
                                    <Animated.View key={item.id} entering={FadeInDown}>
                                        {index > 0 && <View style={styles.divider} />}
                                        <ShoppingListItemCard
                                            item={item}
                                            onToggle={toggleItem}
                                            onRemove={removeItem}
                                            styles={styles}
                                            colors={colors}
                                        />
                                    </Animated.View>
                                ))}
                            </View>
                        )}
                        {items.length === 0 && (
                            <View style={styles.centered}>
                                <Text style={styles.emptyText}>Sąrašas tuščias</Text>
                            </View>
                        )}
                    </ScrollView>

                    {menuVisible && (
                        <TouchableOpacity
                            style={styles.menuOverlay}
                            onPress={() => setMenuVisible(false)}
                            activeOpacity={1}
                        >
                            <View style={styles.menuContainer}>
                                <TouchableOpacity
                                    style={styles.menuItem}
                                    onPress={() => {
                                        setMenuVisible(false);
                                        handleDuplicate();
                                    }}
                                >
                                    <Ionicons name="copy-outline" size={18} color={colors.textPrimary} />
                                    <Text style={styles.menuItemText}>Nukopijuoti sąrašą</Text>
                                </TouchableOpacity>
                            </View>
                        </TouchableOpacity>
                    )}
                </View>
                {quantityModal && (
                    <View style={[styles.modalOverlay, { paddingBottom: keyboardHeight }]}>
                        <TouchableOpacity
                            style={StyleSheet.absoluteFillObject}
                            activeOpacity={1}
                            onPress={() => setQuantityModal(null)}
                        />
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
                                <TouchableOpacity
                                    style={styles.modalCancel}
                                    onPress={() => setQuantityModal(null)}
                                >
                                    <Text style={styles.modalCancelText}>Atšaukti</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={styles.modalConfirm}
                                    onPress={() => {
                                        const qty = parseFloat(quantityInput);
                                        if (!qty || qty <= 0) {
                                            Alert.alert('Klaida', 'Įveskite teisingą kiekį');
                                            return;
                                        }
                                        const modal = quantityModal;
                                        setQuantityModal(null);
                                        addProduct(modal.productId, modal.name, qty, modalIsWeighable, modal.storeProductId, modal.imageUrl);
                                    }}
                                >
                                    <Text style={styles.modalConfirmText}>Pridėti</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    </View>
                )}
                <Modal
                    visible={couponQueue.length > 0}
                    transparent
                    animationType="slide"
                    onRequestClose={dismissCoupon}
                >
                    <View style={styles.shareOverlay}>
                        <TouchableOpacity
                            style={StyleSheet.absoluteFillObject}
                            activeOpacity={1}
                            onPress={dismissCoupon}
                        />
                        <View style={styles.couponModalContainer}>
                            <View style={styles.couponBadgeLarge}>
                                <Text style={styles.couponBadgeLargeText}>
                                    {couponQueue[0]} kuponas
                                </Text>
                            </View>
                            <Text style={styles.couponModalTitle}>Prisiminkite kuponą!</Text>
                            <Text style={styles.couponModalBody}>
                                Suaktyvinkite {couponQueue[0]} kuponą <Text style={{ fontWeight: '700' }}>Lidl Plus</Text> programėlėje prieš atsiskaitydami.
                            </Text>
                            <TouchableOpacity
                                style={styles.couponDontShowRow}
                                onPress={() => setCouponDontShow(v => !v)}
                            >
                                <View style={[styles.checkbox, couponDontShow && styles.checkboxChecked]}>
                                    {couponDontShow && <Ionicons name="checkmark" size={14} color="#fff" />}
                                </View>
                                <Text style={styles.couponDontShowLabel}>Daugiau nerodyti</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.couponModalBtn}
                                onPress={dismissCoupon}
                            >
                                <Text style={styles.couponModalBtnText}>Supratau</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </Modal>

                <Modal
                    visible={shareOpen}
                    transparent
                    animationType="fade"
                    onRequestClose={closeShare}
                >
                    <View style={styles.shareOverlay}>
                        <TouchableOpacity
                            style={StyleSheet.absoluteFillObject}
                            activeOpacity={1}
                            onPress={closeShare}
                        />
                        <View style={styles.shareContainer}>
                            {shareStatus === 'claimed' ? (
                                <>
                                    <View style={styles.shareCheckCircle}>
                                        <Ionicons name="checkmark" size={40} color={colors.onPrimary} />
                                    </View>
                                    <Text style={styles.shareTitle}>Sąrašas prijungtas</Text>
                                    <Text style={styles.shareSubtitle}>Kitas vartotojas prisijungė prie sąrašo.</Text>
                                    <TouchableOpacity style={styles.shareCloseBtn} onPress={closeShare}>
                                        <Text style={styles.shareCloseBtnText}>Uždaryti</Text>
                                    </TouchableOpacity>
                                </>
                            ) : shareStatus === 'expired' ? (
                                <>
                                    <Text style={styles.shareTitle}>QR kodas nebegalioja</Text>
                                    <Text style={styles.shareSubtitle}>Sukurkite naują, jei norite pasidalinti.</Text>
                                    <TouchableOpacity style={styles.shareCloseBtn} onPress={closeShare}>
                                        <Text style={styles.shareCloseBtnText}>Uždaryti</Text>
                                    </TouchableOpacity>
                                </>
                            ) : shareStatus === 'error' ? (
                                <>
                                    <Text style={styles.shareTitle}>Klaida</Text>
                                    <Text style={styles.shareSubtitle}>Nepavyko sukurti QR kodo.</Text>
                                    <TouchableOpacity style={styles.shareCloseBtn} onPress={closeShare}>
                                        <Text style={styles.shareCloseBtnText}>Uždaryti</Text>
                                    </TouchableOpacity>
                                </>
                            ) : (
                                <>
                                    <Text style={styles.shareTitle}>Dalintis sąrašu</Text>
                                    <Text style={styles.shareSubtitle}>Tegul kitas vartotojas nuskaito QR kodą.</Text>
                                    <View style={styles.shareQrWrap}>
                                        {shareLoading || !shareToken ? (
                                            <ActivityIndicator size="large" color={colors.primary} />
                                        ) : (
                                            <QRCode value={shareToken} size={220} />
                                        )}
                                    </View>
                                    <TouchableOpacity style={styles.shareCloseBtn} onPress={closeShare}>
                                        <Text style={styles.shareCloseBtnText}>Uždaryti</Text>
                                    </TouchableOpacity>
                                </>
                            )}
                        </View>
                    </View>
                </Modal>
            </>
        </GestureHandlerRootView>
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
    quickAddWrapper: {
        marginHorizontal: 10,
        marginBottom: 10,
    },
    quickAddRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: c.cardBackground,
        borderRadius: 10,
        elevation: 1,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
    },
    inlineSearchResults: {
        backgroundColor: c.cardBackground,
        borderRadius: 10,
        marginTop: 6,
        elevation: 2,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08,
        shadowRadius: 3,
        overflow: 'hidden',
    },
    quickAddInput: {
        flex: 1,
        fontSize: 14,
        color: c.textPrimary,
        paddingVertical: 2,
    },
    progressFill: { height: '100%', backgroundColor: c.primary, borderRadius: 4 },
    progressText: { fontSize: 13, color: c.textSecondary, minWidth: 50, textAlign: 'right' },
list: {
    paddingTop: 16,
    paddingBottom: 100,
},
sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: c.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 6,
},
listContainer: {
    backgroundColor: c.cardBackground,
    marginBottom: 10,
    elevation: 1,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05, shadowRadius: 2,
},
card: {
    backgroundColor: c.cardBackground,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
},
    divider: {
        height: 0.5,
        backgroundColor: c.border,
        marginLeft: 68,
    },

    cardChecked: {
        opacity: 0.5,
    },
    imageContainer: {
        width: 40, height: 40, flexShrink: 0,
    },
    productImage: {
        width: 40, height: 40, borderRadius: 8,
    },
    imagePlaceholder: {
        width: 40, height: 40, borderRadius: 8,
        backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center',
    },
    imageEmoji: {
        fontSize: 22,
        opacity: 0.4,
    },
    checkmarkContainer: {
        width: 40, height: 40, borderRadius: 8,
        backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center',
    },
    cardContent: { flex: 1 },
    itemName: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    itemNameChecked: { textDecorationLine: 'line-through', color: c.textMuted },
    itemQuantity: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
    itemPrice: { fontSize: 14, fontWeight: '500', color: c.primary },
    itemPriceChecked: { color: c.textMuted },
    searchResultItem: {
        padding: 12, borderBottomWidth: 1, borderBottomColor: c.borderSubtle,
        flexDirection: 'row', alignItems: 'center',
    },
    searchResultText: { fontSize: 14, color: c.textPrimary },
    customItemButton: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
    customItemText: { fontSize: 14, color: c.primary },
    emptyText: { fontSize: 16, color: c.textSecondary },
    menuOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 },
    menuContainer: {
        position: 'absolute', top: 8, right: 12,
        backgroundColor: c.cardBackground, borderRadius: 10,
        elevation: 8, shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2, shadowRadius: 4,
        minWidth: 180,
    },
    menuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: 10 },
    menuItemText: { fontSize: 14, color: c.textPrimary },
    modalOverlay: {
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: c.overlayBackdrop,
        justifyContent: 'center',
        alignItems: 'center', zIndex: 200,
    },
    modalContainer: {
        backgroundColor: c.cardBackground,
        borderRadius: 16,
        padding: 24,
        width: '90%',
        elevation: 8,
        shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2, shadowRadius: 8,
    },
    modalTitle: {
        fontSize: 16, fontWeight: '700', color: c.textPrimary, marginBottom: 12,
    },
    modalLabel: {
        fontSize: 13, color: c.textSecondary, marginBottom: 8,
    },
    modalInput: {
        borderWidth: 1, borderColor: c.border, borderRadius: 8,
        padding: 12, fontSize: 18, color: c.textPrimary, textAlign: 'center',
        marginBottom: 16,
    },
    modalButtons: {
        flexDirection: 'row', gap: 10,
    },
    modalCancel: {
        flex: 1, padding: 12, borderRadius: 8,
        borderWidth: 1, borderColor: c.border, alignItems: 'center',
    },
    modalCancelText: {
        fontSize: 14, color: c.textSecondary, fontWeight: '600',
    },
    modalConfirm: {
        flex: 1, padding: 12, borderRadius: 8,
        backgroundColor: c.primary, alignItems: 'center',
    },
    modalConfirmText: {
        fontSize: 14, color: c.onPrimary, fontWeight: '600',
    },
    weighableRow: {
        flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16,
    },
    weighableLabel: {
        fontSize: 14, color: c.textPrimary,
    },
    checkbox: {
        width: 22, height: 22, borderRadius: 11,
        borderWidth: 2, borderColor: c.primary,
        alignItems: 'center', justifyContent: 'center',
    },
    checkboxChecked: {
        backgroundColor: c.primary, borderColor: c.primary,
    },
    deleteAction: {
        backgroundColor: c.error,
        justifyContent: 'center',
        alignItems: 'center',
        width: 80,
        flexDirection: 'column',
        flex: 1,
    },
    actionText: { color: c.onPrimary, fontSize: 11, fontWeight: '600' },
    undoToast: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: c.textPrimary,
        marginHorizontal: 16,
        marginTop: 12,
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 10,
        alignSelf: 'center',
        zIndex: 50,
    },
    undoToastText: {
        color: c.onPrimary,
        fontSize: 13,
        fontWeight: '600',
    },
    shareOverlay: {
        flex: 1,
        backgroundColor: c.overlayBackdrop,
        alignItems: 'center',
        justifyContent: 'center',
    },
    shareContainer: {
        backgroundColor: c.cardBackground,
        borderRadius: 16,
        paddingVertical: 24,
        paddingHorizontal: 28,
        width: '85%',
        alignItems: 'center',
        elevation: 8,
        shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2, shadowRadius: 8,
    },
    shareTitle: { fontSize: 18, fontWeight: '700', color: c.textPrimary, marginBottom: 6, textAlign: 'center' },
    shareSubtitle: { fontSize: 13, color: c.textSecondary, marginBottom: 16, textAlign: 'center' },
    shareQrWrap: {
        padding: 12,
        backgroundColor: '#fff',
        borderRadius: 12,
        marginBottom: 18,
        minWidth: 244,
        minHeight: 244,
        alignItems: 'center',
        justifyContent: 'center',
    },
    shareCloseBtn: {
        paddingHorizontal: 24,
        paddingVertical: 12,
        backgroundColor: c.primary,
        borderRadius: 8,
    },
    shareCloseBtnText: { color: c.onPrimary, fontSize: 14, fontWeight: '600' },
    shareCheckCircle: {
        width: 72, height: 72, borderRadius: 36,
        backgroundColor: c.success,
        alignItems: 'center', justifyContent: 'center',
        marginBottom: 16,
    },

    // Coupon badge on shopping list item card
    couponBadge: {
        flexDirection: 'row',
        alignSelf: 'flex-start',
        backgroundColor: '#FFF3B0',
        borderWidth: 1,
        borderColor: '#FFCC00',
        borderRadius: 4,
        paddingHorizontal: 6,
        paddingVertical: 2,
        marginTop: 4,
    },
    couponBadgeText: {
        fontSize: 10,
        fontWeight: '700',
        color: '#003D8F',
    },

    // Coupon reminder modal
    couponModalContainer: {
        backgroundColor: c.cardBackground,
        borderRadius: 16,
        paddingVertical: 28,
        paddingHorizontal: 24,
        width: '85%',
        alignItems: 'center',
        elevation: 8,
        shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2, shadowRadius: 8,
    },
    couponBadgeLarge: {
        backgroundColor: '#FFF3B0',
        borderWidth: 2,
        borderColor: '#FFCC00',
        borderRadius: 8,
        paddingHorizontal: 16,
        paddingVertical: 8,
        marginBottom: 18,
    },
    couponBadgeLargeText: {
        fontSize: 20,
        fontWeight: '800',
        color: '#003D8F',
    },
    couponModalTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: c.textPrimary,
        marginBottom: 8,
        textAlign: 'center',
    },
    couponModalBody: {
        fontSize: 14,
        color: c.textSecondary,
        textAlign: 'center',
        lineHeight: 20,
        marginBottom: 16,
    },
    couponDontShowRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginBottom: 20,
    },
    couponDontShowLabel: {
        fontSize: 13,
        color: c.textSecondary,
    },
    couponModalBtn: {
        paddingHorizontal: 32,
        paddingVertical: 12,
        backgroundColor: '#003D8F',
        borderRadius: 8,
    },
    couponModalBtnText: {
        color: '#fff',
        fontSize: 14,
        fontWeight: '700',
    },
});
