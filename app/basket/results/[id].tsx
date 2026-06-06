import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, InteractionManager } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, useFocusEffect, useNavigation, Stack } from 'expo-router';
import React, { useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Animated, { FadeInDown, FadeIn } from 'react-native-reanimated';
import { API_BASE_URL } from '../../../config/api';
import { useTheme, type AppTheme } from '../../../constants/theme';
import { useBasketState } from '../../../state/basketState';
import { useProfileStore } from '../../../state/profileStore';
import { loadCachedCoords, tryGpsCoords, persistCoords, type UserCoords } from '../../../utils/location';
import LocationPromptModal from '../../../components/LocationPromptModal';
import { formatEuro } from '../../../utils/formatCurrency';
import { scoreAllCombinations, type ScoredCombo } from '../../../utils/splitBasketScore';
import { type StoreResult, type ItemResult } from '../../../utils/basketPricing';
import { ScreenBackButton } from '../../../components/ScreenBackButton';
import { chainBrandColorById } from '../../../utils/chainBrandName';
import StoreResultsMap, { type MapPin } from '../../../components/results/StoreResultsMap';
import ResultsWheel, { type WheelItem } from '../../../components/results/ResultsWheel';

/** Sum of a store's assigned items within a split combo (its share of the bill). */
function comboStorePortion(combo: ScoredCombo, storeId: number): number {
    const store = combo.stores.find(s => s.storeId === storeId);
    if (!store) return 0;
    let sum = 0;
    for (const it of store.items) {
        if (combo.itemAssignments[it.productId] === storeId && it.totalPrice != null) sum += it.totalPrice;
    }
    return Math.round(sum * 100) / 100;
}

function pluralizePrekes(n: number): string {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 'prekė';
    if (mod10 >= 2 && mod10 <= 9 && (mod100 < 10 || mod100 >= 20)) return 'prekės';
    return 'prekių';
}

// StoreResult / ItemResult now live in utils/basketPricing (shared with the
// lazy /store-prices fetch) — imported above.

/** Hard cap on the single-store list — near a city centre the calc can return
 *  hundreds of stores; we only ever show the top 10 ranked options. */
const MAX_SINGLE_STORES = 10;

export default function BasketResultsScreen() {
    const colors = useTheme();
    const { clearSessionBasket } = useBasketState();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { bottom: bottomInset, top: topInset } = useSafeAreaInsets();
    const { id } = useLocalSearchParams();
    const router = useRouter();
    const navigation = useNavigation();
    const [results, setResults] = useState<StoreResult[]>([]);
    const [loading, setLoading] = useState(true);
    const [pullRefreshing, setPullRefreshing] = useState(false);
    const [selectedStoreId, setSelectedStoreId] = useState<number | null>(null);
    const [locationPromptVisible, setLocationPromptVisible] = useState(false);
    const [combos, setCombos] = useState<ScoredCombo[]>([]);
    const [storeCount, setStoreCount] = useState<1 | 2 | 3>(1);
    const [selectedCombo, setSelectedCombo] = useState<ScoredCombo | null>(null);
    const [mapMounted, setMapMounted] = useState(false);
    const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null);

    // Defer the heavy MapView mount until after the toggle's tap interaction so
    // switching to Žemėlapis feels instant (the capsule animates immediately,
    // the map appears a frame later).
    useEffect(() => {
        if (loading || mapMounted) return;
        const task = InteractionManager.runAfterInteractions(() => setMapMounted(true));
        return () => task.cancel();
    }, [loading, mapMounted]);

    const loadResults = async () => {
        // Detail screen now awaits the calc before pushing to this route,
        // so the cache is always populated on entry. The previous 30-second
        // polling loop was a workaround for the old fire-and-navigate
        // pattern and is no longer needed. If we still find an empty cache
        // (e.g., the user reverted the basket to draft from a parallel
        // stack, wiping this key), render the empty state immediately.
        setLoading(true);
        setSelectedStoreId(null);
        setSelectedCombo(null);
        setCombos([]);

        const [stored, metaRaw] = await Promise.all([
            AsyncStorage.getItem(`basket_results_${id}`),
            AsyncStorage.getItem(`basket_calc_meta_${id}`),
        ]);

        if (stored) {
            const parsed: StoreResult[] = JSON.parse(stored);
            setResults(parsed);

            const meta = metaRaw ? JSON.parse(metaRaw) : null;
            const sc: 1 | 2 | 3 = meta?.storeCount ?? 1;
            setStoreCount(sc);

            if (sc > 1 && parsed.length > 0) {
                try {
                    const itemsRes = await fetch(`${API_BASE_URL}/api/baskets/${id}/items`);
                    const itemsData = await itemsRes.json();
                    const criticalIds = new Set<number>(
                        (itemsData as any[]).filter(it => it.isCritical).map(it => Number(it.productId)),
                    );
                    const scored = scoreAllCombinations(parsed, criticalIds, sc);
                    setCombos(scored); // includes single-store options — recommendation can be 1 store
                } catch {
                    // non-fatal — falls back to single-store view
                }
            }
        } else {
            setResults([]);
        }
        setLoading(false);
    };

    const runRecalcWithCoords = useCallback(async (coords: UserCoords, isPull = false) => {
        if (!isPull) setLoading(true);
        setSelectedStoreId(null);
        try {
            const res = await fetch(`${API_BASE_URL}/api/baskets/${id}/calculate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ lat: coords.lat, lng: coords.lng }),
            });
            const newResults = await res.json();
            await AsyncStorage.setItem(`basket_results_${id}`, JSON.stringify(newResults));
            await persistCoords(coords);
            setUserCoords({ lat: coords.lat, lng: coords.lng });
            setResults(newResults);
            setLoading(false);
        } catch {
            Alert.alert('Klaida', 'Nepavyko perskaičiuoti');
            setLoading(false);
        }
    }, [id]);

    const handleRecalculate = useCallback(async () => {
        const cached = await loadCachedCoords();
        if (cached) { await runRecalcWithCoords(cached); return; }
        const gps = await tryGpsCoords();
        if (gps) { await runRecalcWithCoords(gps); return; }
        setLocationPromptVisible(true);
    }, [runRecalcWithCoords]);

    const handlePullRefresh = useCallback(async () => {
        setPullRefreshing(true);
        try {
            let blocked = false;
            try {
                const res = await fetch(`${API_BASE_URL}/api/baskets/${id}`);
                const basket = await res.json();
                if (basket?.status === 'inProgress' || basket?.status === 'completed') {
                    blocked = true;
                }
            } catch {}
            if (blocked) { await loadResults(); return; }
            const cached = await loadCachedCoords();
            if (cached) { await runRecalcWithCoords(cached, true); }
            else {
                const gps = await tryGpsCoords();
                if (gps) { await runRecalcWithCoords(gps, true); }
                else { setLocationPromptVisible(true); }
            }
        } finally {
            setPullRefreshing(false);
        }
    }, [runRecalcWithCoords, id]);

    // The full header config (Parduotuvės/Žemėlapis toggle + back chevron).
    // Kept in a ref so the focus effect can re-assert it without depending on
    // `view` (which would re-run loadResults on every toggle).
    const headerCfgRef = useRef<() => void>(() => {});
    headerCfgRef.current = () => {
        // Results is map-only now → full-bleed map, no native header.
        navigation.setOptions({ headerShown: false });
    };
    useLayoutEffect(() => { headerCfgRef.current(); }, [storeCount, colors]);

    useFocusEffect(useCallback(() => {
        // Re-assert the header here — after expo-router's own focus event —
        // because an unregistered screen has its options reset to defaults on
        // focus, which otherwise blanks the toggle until the next re-render.
        headerCfgRef.current();

        // Store results render regardless of pending mandatory swipes — the
        // comparison is never gated behind card-swiping.
        loadResults();
        loadCachedCoords().then(c => { if (c) setUserCoords({ lat: c.lat, lng: c.lng }); });
    }, [id, navigation, handleRecalculate, colors.primary]));

    // Results arrive pre-sorted by the calc service (fewest missing →
    // fewest CCA → fewest substituted → lowest total). results[0] is
    // therefore always the recommended option, even on price ties — the
    // tiebreak chain has already settled them. Earlier code returned
    // null on ties, which made the "Daugiau" collapse fall through to
    // showing every store.
    const cheapestStoreId: number | null = results[0]?.storeId ?? null;
    const selectedStore = results.find(r => r.storeId === selectedStoreId);

    // ── Map / wheel data ──────────────────────────────────────────────────
    // Single-store list (capped) vs split combos (deduped by chain composition,
    // capped at 5) — mirrors the list view so the map matches what's on screen.
    const singleStores = useMemo(() => results.slice(0, MAX_SINGLE_STORES), [results]);
    const dedupedCombos = useMemo(() => {
        const seen = new Set<string>();
        const out: ScoredCombo[] = [];
        for (const combo of combos) {
            const key = combo.stores.map(s => s.chainId).sort((a, b) => a - b).join('-');
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(combo);
        }
        return out.slice(0, 5);
    }, [combos]);
    const mapMode: 'single' | 'combo' = storeCount > 1 && dedupedCombos.length > 0 ? 'combo' : 'single';

    const pins: MapPin[] = useMemo(() => {
        if (mapMode === 'combo') {
            const byStore = new Map<number, MapPin>();
            const recIds = new Set(dedupedCombos[0]?.storeIds ?? []);
            for (const combo of dedupedCombos) {
                for (const s of combo.stores) {
                    if (s.latitude == null || s.longitude == null || byStore.has(s.storeId)) continue;
                    byStore.set(s.storeId, {
                        storeId: s.storeId, chainId: s.chainId, chainName: s.chainName,
                        miniLogoUrl: s.chainMiniLogoUrl ?? s.chainLogoUrl ?? null,
                        latitude: s.latitude, longitude: s.longitude,
                        euro: null, active: false, recommended: recIds.has(s.storeId),
                    });
                }
            }
            if (selectedCombo) {
                for (const sid of selectedCombo.storeIds) {
                    const pin = byStore.get(sid);
                    if (pin) { pin.active = true; pin.euro = comboStorePortion(selectedCombo, sid); }
                }
            }
            return [...byStore.values()];
        }
        return singleStores
            .filter(s => s.latitude != null && s.longitude != null)
            .map(s => ({
                storeId: s.storeId, chainId: s.chainId, chainName: s.chainName,
                miniLogoUrl: s.chainMiniLogoUrl ?? s.chainLogoUrl ?? null,
                latitude: s.latitude as number, longitude: s.longitude as number,
                euro: s.total, // price shown on every pin now, not just the selected one
                active: s.storeId === selectedStoreId,
                recommended: s.storeId === cheapestStoreId,
            }));
    }, [mapMode, dedupedCombos, selectedCombo, singleStores, selectedStoreId, cheapestStoreId]);

    const wheelItems: WheelItem[] = useMemo(() => {
        // First option = "Visi" (overview / full map).
        const all: WheelItem = { key: '__all__', logos: [], sum: 0, recommended: false, isAll: true };
        if (mapMode === 'combo') {
            return [all, ...dedupedCombos.map((combo, idx) => ({
                key: combo.storeIds.join('-'),
                logos: combo.stores.map(s => ({ chainId: s.chainId, logoUrl: s.chainMiniLogoUrl ?? s.chainLogoUrl ?? null })),
                sum: combo.splitTotal,
                recommended: idx === 0,
            }))];
        }
        return [all, ...singleStores.map(s => ({
            key: `s-${s.storeId}`,
            logos: [{ chainId: s.chainId, logoUrl: s.chainMiniLogoUrl ?? s.chainLogoUrl ?? null }],
            sum: s.total,
            recommended: s.storeId === cheapestStoreId,
        }))];
    }, [mapMode, dedupedCombos, singleStores, cheapestStoreId]);

    // Index 0 is "Visi"; real options start at 1.
    const wheelSelectedIndex = useMemo(() => {
        if (mapMode === 'combo') {
            if (!selectedCombo) return 0;
            const i = dedupedCombos.findIndex(c => c.storeIds.join('-') === selectedCombo.storeIds.join('-'));
            return i < 0 ? 0 : i + 1;
        }
        if (selectedStoreId == null) return 0;
        const i = singleStores.findIndex(s => s.storeId === selectedStoreId);
        return i < 0 ? 0 : i + 1;
    }, [mapMode, selectedCombo, dedupedCombos, selectedStoreId, singleStores]);

    const handleWheelSelect = useCallback((i: number) => {
        if (i === 0) { setSelectedStoreId(null); setSelectedCombo(null); return; } // Visi → full map
        if (mapMode === 'combo') {
            const combo = dedupedCombos[i - 1];
            if (combo) { setSelectedCombo(combo); setSelectedStoreId(null); }
        } else {
            const s = singleStores[i - 1];
            if (s) { setSelectedStoreId(s.storeId); setSelectedCombo(null); }
        }
    }, [mapMode, dedupedCombos, singleStores]);

    // Coords the map zooms to: the selected store/combo, or null = fit all (Visi).
    const focusCoords = useMemo(() => {
        if (mapMode === 'combo') {
            if (!selectedCombo) return null;
            const cs = selectedCombo.stores
                .filter(s => s.latitude != null && s.longitude != null)
                .map(s => ({ latitude: s.latitude as number, longitude: s.longitude as number }));
            return cs.length ? cs : null;
        }
        if (selectedStoreId == null) return null;
        const s = singleStores.find(x => x.storeId === selectedStoreId);
        return s && s.latitude != null && s.longitude != null
            ? [{ latitude: s.latitude, longitude: s.longitude }]
            : null;
    }, [mapMode, selectedCombo, selectedStoreId, singleStores]);

    const handlePinTap = useCallback((storeId: number) => {
        if (mapMode === 'combo') {
            const combo = dedupedCombos.find(c => c.storeIds.includes(storeId));
            if (combo) { setSelectedCombo(combo); setSelectedStoreId(null); }
        } else {
            setSelectedStoreId(storeId); setSelectedCombo(null);
        }
    }, [mapMode, dedupedCombos]);

    const handleNavigate = () => {
        if (!selectedStore) return;
        const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(selectedStore.storeAddress)}`;
        const { Linking } = require('react-native');
        Linking.openURL(url);
    };

    const [creatingList, setCreatingList] = useState(false);

    const handleCreateShoppingList = async () => {
        // Route to split-list creation when a multi-store combo is selected
        if (selectedCombo && !selectedStore) {
            await handleCreateSplitShoppingList();
            return;
        }
        if (!selectedStore || creatingList) return;
        setCreatingList(true);
        try {
            const { getUserId } = await import('../../../config/user');
            const userId = await getUserId();

            // "Padėjai sutaupyti" basis = average of the UNIQUE full-coverage
            // store totals − the store the user chose. Deduping the totals
            // (rounded to cents) stops a cluster of equally-cheap stores near
            // the user from skewing the average down; only full-coverage stores
            // count so a partial basket can't pollute it. Accrued server-side
            // onto the template's collectiveSavingsEur, once per basket.
            const round2 = (n: number) => Math.round(n * 100) / 100;
            let savingsEur = 0;
            if (selectedStore.missingItemNames.length === 0) {
                const uniqueTotals = [...new Set(
                    results
                        .filter(r => r.missingItemNames.length === 0)
                        .map(r => round2(r.total)),
                )];
                if (uniqueTotals.length > 1) {
                    const avg = uniqueTotals.reduce((s, v) => s + v, 0) / uniqueTotals.length;
                    savingsEur = Math.max(0, round2(avg - selectedStore.total));
                }
            }

            const body = {
                userId,
                storeId: selectedStore.storeId,
                basketId: Number(id),
                savingsEur,
                items: selectedStore.items.map(item => {
                    const wasSubstituted =
                        (item as any).isSubstituted || (item as any).isCrossChainAverage;
                    return {
                        productId: item.productId,
                        storeProductId: wasSubstituted ? null : (item.storeProductId || null),
                        quantity: wasSubstituted
                            ? item.quantity
                            : (item.storeProductId
                                ? (item.isWeighable ? item.quantity : item.packsNeeded || item.quantity)
                                : item.quantity),
                        price: item.totalPrice,
                    };
                }),
            };

            const res = await fetch(`${API_BASE_URL}/api/shopping-lists`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (res.status === 409) {
                const data = await res.json();
                clearSessionBasket();
                router.dismissAll();
                router.navigate('/(tabs)/shoppingList' as any);
                setTimeout(() => {
                    router.push(`/shopping-list/${data.listId}` as any);
                }, 100);
                return;
            }
            if (!res.ok) {
                const errorText = await res.text().catch(() => '');
                throw new Error(`HTTP ${res.status}: ${errorText.slice(0, 200)}`);
            }
            const listData = await res.json();
            if (!listData?.id) throw new Error('Response missing id');

            clearSessionBasket();
            useProfileStore.getState().invalidate();
            router.dismissAll();
            router.navigate('/(tabs)/shoppingList' as any);
            setTimeout(() => {
                router.push(`/shopping-list/${listData.id}` as any);
            }, 100);
        } catch (error: any) {
            Alert.alert('Klaida', 'Nepavyko sukurti pirkinių sąrašo');
        } finally {
            setCreatingList(false);
        }
    };

    const handleCreateSplitShoppingList = async () => {
        if (!selectedCombo || creatingList) return;
        setCreatingList(true);
        try {
            const { getUserId } = await import('../../../config/user');
            const userId = await getUserId();

            const createdLists: { storeId: number; storeName: string; storeAddress: string; chainName: string; chainLogoUrl: string | null; listId: number }[] = [];

            for (const store of selectedCombo.stores) {
                const assignedPids = new Set(
                    Object.entries(selectedCombo.itemAssignments)
                        .filter(([, sid]) => sid === store.storeId)
                        .map(([pid]) => Number(pid)),
                );
                const storeItems = store.items
                    .filter(item => assignedPids.has(item.productId))
                    .map(item => {
                        const it = item as any;
                        const wasSubstituted = it.isSubstituted || it.isCrossChainAverage;
                        return {
                            productId: item.productId,
                            storeProductId: wasSubstituted ? null : (it.storeProductId || null),
                            quantity: wasSubstituted
                                ? it.quantity
                                : (it.storeProductId
                                    ? (it.isWeighable ? it.quantity : it.packsNeeded || it.quantity)
                                    : it.quantity),
                            price: item.totalPrice,
                        };
                    });

                const res = await fetch(`${API_BASE_URL}/api/shopping-lists`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId, storeId: store.storeId, basketId: Number(id), items: storeItems }),
                });
                if (res.status === 409) {
                    const data = await res.json();
                    createdLists.push({ storeId: store.storeId, storeName: store.storeName, storeAddress: store.storeAddress, chainName: store.chainName, chainLogoUrl: store.chainLogoUrl, listId: data.listId });
                    continue;
                }
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const listData = await res.json();
                createdLists.push({ storeId: store.storeId, storeName: store.storeName, storeAddress: store.storeAddress, chainName: store.chainName, chainLogoUrl: store.chainLogoUrl, listId: listData.id });
            }

            if (createdLists.length === 0) throw new Error('No lists created');
            await AsyncStorage.setItem(`split_lists_${id}`, JSON.stringify(createdLists));
            clearSessionBasket();
            useProfileStore.getState().invalidate();
            router.dismissAll();
            router.navigate('/(tabs)/shoppingList' as any);
            setTimeout(() => {
                router.push(`/shopping-list/split/${id}` as any);
            }, 100);
        } catch {
            Alert.alert('Klaida', 'Nepavyko sukurti pirkinių sąrašo');
        } finally {
            setCreatingList(false);
        }
    };

    // Shared action bar (Vykti / Pirkinių sąrašas) — rendered in-flow for the
    // list view and inside the floating stack for the map view.
    const bottomBarNode = (selectedStore || selectedCombo) ? (
        <Animated.View entering={FadeInDown} style={[styles.bottomBar, bottomInset > 0 && { paddingBottom: 12 + bottomInset }]}>
            {selectedStore && (
                <>
                    <TouchableOpacity style={styles.navigateButton} onPress={handleNavigate}>
                        <Ionicons name="navigate-outline" size={20} color={colors.primary} />
                        <Text style={styles.navigateText}>Vykti</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={styles.shoppingListButton}
                        onPress={handleCreateShoppingList}
                        disabled={creatingList}
                    >
                        {creatingList ? (
                            <ActivityIndicator size="small" color={colors.onPrimary} />
                        ) : (
                            <Ionicons name="list-outline" size={20} color={colors.onPrimary} />
                        )}
                        <Text style={styles.shoppingListText}>
                            {creatingList ? 'Kuriama…' : 'Pirkinių sąrašas'}
                        </Text>
                    </TouchableOpacity>
                </>
            )}
            {selectedCombo && !selectedStore && (
                <TouchableOpacity
                    style={styles.shoppingListButton}
                    onPress={handleCreateShoppingList}
                    disabled={creatingList}
                >
                    {creatingList ? (
                        <ActivityIndicator size="small" color={colors.onPrimary} />
                    ) : (
                        <Ionicons name="list-outline" size={20} color={colors.onPrimary} />
                    )}
                    <Text style={styles.shoppingListText}>
                        {creatingList ? 'Kuriama…' : 'Pirkinių sąrašas'}
                    </Text>
                </TouchableOpacity>
            )}
        </Animated.View>
    ) : null;

    return (
        <>
            {/* Declarative options for the first-mount case. Mirrored by
                useLayoutEffect above so re-renders keep the button
                attached even if expo-router's initial push timing hides
                it briefly. */}
            <Stack.Screen options={{ headerShown: false }} />
            <View style={styles.container}>
                {loading && !pullRefreshing ? (
                    <Animated.View entering={FadeIn} style={styles.loadingContainer}>
                        <ActivityIndicator size="large" color={colors.primary} />
                        <Text style={styles.loadingText}>Skaičiuojamos kainos...</Text>
                    </Animated.View>
                ) : mapMounted ? (
                    // Full-bleed map fills the content region; wheel + action bar
                    // float over it at the bottom. The heavy MapView mount is
                    // deferred a frame past entry so the screen paints instantly.
                    <>
                        <StoreResultsMap
                            pins={pins}
                            userCoords={userCoords}
                            focusCoords={focusCoords}
                            onSelectStore={handlePinTap}
                            colors={colors}
                        />
                        {/* Full-bleed map → floating back circle, top-left. */}
                        <View style={[styles.mapTopLeft, { top: topInset + 10 }]} pointerEvents="box-none">
                            <TouchableOpacity style={styles.mapBackBtn} onPress={() => router.back()} activeOpacity={0.8}>
                                <Ionicons name="chevron-back" size={24} color={colors.primary} />
                            </TouchableOpacity>
                        </View>
                    </>
                ) : (
                    <View style={styles.loadingContainer}>
                        <ActivityIndicator size="large" color={colors.primary} />
                    </View>
                )}
                {/* Wheel + action bar float over the full-bleed map. */}
                {!loading && mapMounted ? (
                    <View style={styles.mapBottomStack}>
                        {/* Inset below the wheel clears the Android nav bar
                            when no action bar is shown (Visi / nothing selected). */}
                        <View style={{ backgroundColor: colors.cardBackground, paddingBottom: (selectedStore || selectedCombo) ? 0 : bottomInset }}>
                            <ResultsWheel
                                items={wheelItems}
                                selectedIndex={wheelSelectedIndex}
                                onSelectIndex={handleWheelSelect}
                                colors={colors}
                            />
                        </View>
                        {bottomBarNode}
                    </View>
                ) : null}
            </View>
            <LocationPromptModal
                visible={locationPromptVisible}
                onResolved={async (coords) => {
                    setLocationPromptVisible(false);
                    await runRecalcWithCoords(coords);
                }}
                onCancel={() => setLocationPromptVisible(false)}
            />
        </>
    );
}


const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    // Floating map header (map view is full-bleed): back circle + toggle, left.
    mapTopLeft: { position: 'absolute', left: 12, alignItems: 'flex-start', gap: 10, zIndex: 20 },
    mapBackBtn: {
        width: 42, height: 42, borderRadius: 21,
        backgroundColor: c.cardBackground,
        alignItems: 'center', justifyContent: 'center',
        elevation: 5, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4,
        borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, backgroundColor: c.pageBackground },
    loadingText: { fontSize: 15, color: c.textSecondary },
    list: { padding: 16, paddingBottom: 100 },
    card: {
        backgroundColor: c.cardBackground, borderRadius: 12, padding: 16, marginBottom: 10,
        flexDirection: 'row', alignItems: 'center',
        elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08, shadowRadius: 2,
    },
    cardCheapest: { borderWidth: 2, borderColor: c.primary },
    cardClosest: { borderWidth: 2, borderColor: c.info },
    cardSelected: { backgroundColor: c.primaryMuted },
    cheapestBadge: {
        position: 'absolute', top: -8, left: 16,
        backgroundColor: c.primary, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8,
    },
    cheapestBadgeText: { color: c.onPrimary, fontSize: 10, fontWeight: '700' },
    closestBadge: {
        position: 'absolute', top: -8, left: 16,
        backgroundColor: c.info, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8,
    },
    closestBadgeText: { color: c.textInverse, fontSize: 10, fontWeight: '700' },
    cardLeft: { marginRight: 12 },
    logo: {
        width: 48, height: 48, borderRadius: 8,
        alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    },
    logoImage: { width: 36, height: 36 },
    logoPlaceholderText: { fontSize: 20, fontWeight: '700', color: '#FFFFFF' },
    cardContent: { flex: 1 },
    storeName: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 4 },
    distance: { fontSize: 11, color: c.textMuted },
    missingBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        marginLeft: 6,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 8,
        backgroundColor: c.warningMuted,
    },
    missingBadgeText: {
        fontSize: 10,
        color: c.warning,
        fontWeight: '600',
    },
    missingList: {
        marginTop: 4,
        fontSize: 11,
        color: c.textSecondary,
        fontStyle: 'italic',
    },
    // Tier-3 substitute: the store carries a name-similar product, just
    // not the user's exact one. Blue = "decent confidence, something to
    // grab off the shelf".
    substitutedBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        marginLeft: 6,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 8,
        backgroundColor: c.infoMuted,
    },
    substitutedBadgeText: {
        fontSize: 10,
        color: c.info,
        fontWeight: '600',
    },
    approxBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        marginLeft: 6,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 8,
        backgroundColor: c.surfaceMuted,
    },
    approxBadgeText: {
        fontSize: 10,
        color: c.textMuted,
        fontWeight: '600',
    },
    price: { fontSize: 18, fontWeight: '700', color: c.primary, marginLeft: 8 },
    bottomBar: {
        flexDirection: 'row', padding: 12, gap: 10,
        backgroundColor: c.cardBackground, borderTopWidth: 1, borderTopColor: c.border,
    },
    mapBottomStack: { position: 'absolute', left: 0, right: 0, bottom: 0 },
    emptyText: { fontSize: 16, color: c.textSecondary },
    shoppingListButton: {
        flex: 2, backgroundColor: c.primary, borderRadius: 12,
        padding: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    },
    shoppingListText: { color: c.onPrimary, fontWeight: '700', fontSize: 15 },
    navigateButton: {
        flex: 1, borderWidth: 1, borderColor: c.primary, borderRadius: 12,
        padding: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    },
    navigateText: { color: c.primary, fontWeight: '600', fontSize: 15 },

    gateOverlay: {
        flex: 1, alignItems: 'center', justifyContent: 'center',
        padding: 32, gap: 16,
    },
    gateTitle: { fontSize: 20, fontWeight: '700', color: c.textPrimary, textAlign: 'center' },
    gateBody: { fontSize: 14, color: c.textSecondary, textAlign: 'center', lineHeight: 22 },
    gateButton: {
        backgroundColor: c.primary, borderRadius: 10,
        paddingVertical: 12, paddingHorizontal: 24, marginTop: 8,
    },
    gateButtonText: { color: c.onPrimary, fontWeight: '700', fontSize: 15 },

    // ── Split basket section ──
    splitSectionTitle: {
        fontSize: 12, fontWeight: '700', color: c.textMuted,
        textTransform: 'uppercase', letterSpacing: 0.5,
        marginTop: 4, marginBottom: 8,
    },
    nudgeBanner: {
        flexDirection: 'row', alignItems: 'flex-start', gap: 8,
        backgroundColor: c.surfaceMuted, borderRadius: 10,
        paddingVertical: 10, paddingHorizontal: 12, marginBottom: 10,
    },
    nudgeBannerText: { flex: 1, fontSize: 13, color: c.textSecondary, lineHeight: 18 },
    comboCard: {
        backgroundColor: c.cardBackground, borderRadius: 12,
        padding: 14, marginBottom: 10,
        elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08, shadowRadius: 2,
    },
    comboCardRecommended: {
        borderWidth: 2, borderColor: c.primary,
    },
    comboCardSelected: {
        borderWidth: 2, borderColor: c.primary, backgroundColor: c.primaryMuted,
    },
    comboCardDimmed: { opacity: 0.55 },
    recommendedBadge: {
        position: 'absolute', top: -8, left: 14,
        backgroundColor: c.primary, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8,
    },
    recommendedBadgeText: { color: c.onPrimary, fontSize: 10, fontWeight: '700' },
    criticalWarning: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        marginBottom: 6,
    },
    criticalWarningText: { fontSize: 11, color: c.warning, fontWeight: '600' },
    comboLogos: {
        flexDirection: 'row', alignItems: 'center', gap: 0, marginBottom: 8, marginTop: 4,
    },
    comboLogoWrap: { flexDirection: 'row', alignItems: 'center' },
    comboPlusSep: { width: 28, textAlign: 'center', fontSize: 13, color: c.textMuted, paddingVertical: 2 },
    comboLogo: { width: 40, height: 40, borderRadius: 8 },
    comboLogoPlaceholder: {
        width: 40, height: 40, borderRadius: 8,
        backgroundColor: c.border, alignItems: 'center', justifyContent: 'center',
    },
    comboLogoPlaceholderText: { fontSize: 16, fontWeight: '700', color: c.textSecondary },
    comboStoreDetails: {
        flexDirection: 'column',
        marginBottom: 10, marginTop: 4,
    },
    comboStoreDetailRow: {
        flexDirection: 'row', alignItems: 'flex-start', gap: 6,
    },
    comboMiniLogo: {
        width: 28, height: 28, borderRadius: 6,
        alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    },
    comboMiniLogoImage: { width: 20, height: 20 },
    comboMiniLogoText: { fontSize: 12, fontWeight: '700', color: '#FFFFFF' },
    comboItemCount: { fontSize: 13, color: c.textSecondary, fontWeight: '500' },
    comboStoreAddress: { fontSize: 11, color: c.textMuted, marginTop: 1 },
    comboCardRow: { flexDirection: 'row', alignItems: 'center' },
    comboCardLeft: { flex: 1 },
    comboCardRight: { alignItems: 'flex-end', paddingLeft: 12 },
    comboDelta: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    comboDeltaGood: { color: c.success },
    comboDistRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
    comboDistText: { fontSize: 11, color: c.textMuted },
    comboTotalsRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    comboTotal: { fontSize: 18, fontWeight: '700', color: c.primary },
    comboSavingBadge: {
        backgroundColor: c.successMuted, borderRadius: 8,
        paddingHorizontal: 8, paddingVertical: 3,
    },
    comboSavingText: { fontSize: 13, fontWeight: '700', color: c.success },
    comboEurosPerKm: { fontSize: 11, color: c.textMuted, marginTop: 4 },
    showMoreBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: 4, paddingVertical: 10, marginBottom: 6,
    },
    showMoreBtnText: { fontSize: 13, fontWeight: '600', color: c.primary },
});
