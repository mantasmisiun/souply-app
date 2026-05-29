import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, TextInput, Modal } from 'react-native';
import { SkeletonBox } from '../../components/SkeletonBox';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ScreenBackButton } from '../../components/ScreenBackButton';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE_URL } from '../../config/api';
import { ProductImage } from '../../components/ProductImage';
import { useTheme, type AppTheme } from '../../constants/theme';
import { useBasketState } from '../../state/basketState';
import { useDisplayMode } from '../../contexts/DisplayPreferenceContext';
import LocationPromptModal from '../../components/LocationPromptModal';
import LocationSettingsModal from '../../components/LocationSettingsModal';
import * as Haptics from 'expo-haptics';
import { ScalePressable } from '../../components/ScalePressable';
import { formatDate } from '../../utils/formatCurrency';
import { loadCachedCoords, persistCoords, tryGpsCoords, type UserCoords, VILNIUS_FALLBACK } from '../../utils/location';
import { buildCandidatePool } from '../../utils/candidatePool';
import { getLocationSettings, type LocationSettings } from '../../utils/locationStorage';
import { useTranslation } from 'react-i18next';
import { GlassIconButton } from '../../components/GlassIconButton';
import { createTemplateFromBasket } from '../../utils/basketTemplatesApi';

interface BasketItem {
    id: number;
    basketId: number;
    productId: number;
    quantity: number;
    matchMode: 'sku' | 'base';
    productName: string;
    categoryName?: string;
    isWeighable: boolean;
    imageUrls?: (string | null | undefined)[] | string | null;
}

interface Basket {
    id: number;
    status: string;
    name: string;
    createdAt: string;
}

export default function BasketDetailScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { bottom: bottomInset } = useSafeAreaInsets();
    const { id } = useLocalSearchParams();
    const router = useRouter();
    const { mode: displayMode } = useDisplayMode();
    const { setDraftBasketId, clearSessionBasket } = useBasketState();

    const [basket, setBasket] = useState<Basket | null>(null);
    const [items, setItems] = useState<BasketItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [quantityInputs, setQuantityInputs] = useState<{[key: number]: string}>({});
    const [basketName, setBasketName] = useState('');
    const [editingName, setEditingName] = useState(false);
    const nameInputRef = useRef<any>(null);
    const nameTextRef = useRef(basketName);
    useEffect(() => {
        if (editingName) {
            nameTextRef.current = basketName;
            const t = setTimeout(() => nameInputRef.current?.focus(), 50);
            return () => clearTimeout(t);
        }
    }, [editingName]);

    // Inline calc state. `calcing` drives the bottom-bar progress UI;
    // `calcError` shows a retry banner above it if the POST fails.
    const [calcing, setCalcing] = useState(false);
    const [calcError, setCalcError] = useState<string | null>(null);
    // Location prompt state. Shown when GPS permission is denied and the
    // user hasn't previously cached an address. On resolve, we continue
    // the calc flow with the new coordinates.
    const [locationPromptVisible, setLocationPromptVisible] = useState(false);
    const [locationSettingsVisible, setLocationSettingsVisible] = useState(false);
    // Save-as-template flow: bookmark icon in the nav bar opens a name
    // prompt → POST /api/basket-templates/from-basket/:id → toast.
    const [saveTplVisible, setSaveTplVisible] = useState(false);
    const [saveTplName, setSaveTplName] = useState('');
    const [saveTplBusy, setSaveTplBusy] = useState(false);
    const saveTplNameRef = useRef<TextInput>(null);

    const submitSaveAsTemplate = useCallback(async () => {
        const trimmed = saveTplName.trim();
        if (trimmed.length === 0 || saveTplBusy) return;
        try {
            setSaveTplBusy(true);
            const basketIdNum = Number(id);
            await createTemplateFromBasket(basketIdNum, { name: trimmed });
            setSaveTplVisible(false);
            setSaveTplName('');
            // Cross-platform toast — Android has ToastAndroid but iOS doesn't,
            // so an Alert is the lowest-common-denominator confirmation.
            Alert.alert(
                t('basketTab.templates.savedToast', { name: trimmed }),
            );
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorInstantiate'));
        } finally {
            setSaveTplBusy(false);
        }
    }, [saveTplName, saveTplBusy, id, t]);
    const [settingsRefreshKey, setSettingsRefreshKey] = useState(0);
    const [activeSettings, setActiveSettings] = useState<LocationSettings | null>(null);
    // Snapshot of the settings used at the time of the most recent calculation.
    // Loaded from AsyncStorage `basket_calc_meta_${id}` whenever the basket
    // is in 'compared' status. Drives the "settings changed → re-find vs
    // view results" branch on the bottom button.
    const [calcSettingsSnapshot, setCalcSettingsSnapshot] = useState<LocationSettings | null>(null);

    // Cheap structural compare — both objects are flat, the modal only edits
    // primitive fields. Stringifying with sorted keys avoids the ordering
    // gotchas a naive JSON.stringify would have.
    const settingsChanged = useMemo(() => {
        if (!calcSettingsSnapshot || !activeSettings) return false;
        const norm = (s: LocationSettings) =>
            JSON.stringify(s, Object.keys(s as any).sort());
        return norm(calcSettingsSnapshot) !== norm(activeSettings);
    }, [calcSettingsSnapshot, activeSettings]);

    const fetchBasket = async () => {
        try {
            const [basketRes, itemsRes] = await Promise.all([
                fetch(`${API_BASE_URL}/api/baskets/${id}`),
                fetch(`${API_BASE_URL}/api/baskets/${id}/items`),
            ]);
            const basketData = await basketRes.json();
            const itemsData = await itemsRes.json();
            setBasket(basketData);
            setBasketName(basketData.name || '');
            const parsedItems = Array.isArray(itemsData) ? itemsData.map((item: any) => ({
                ...item,
                quantity: parseFloat(item.quantity),
                isWeighable: item.isWeighable === 1,
            })) : [];
            setItems(parsedItems);

            const inputs: {[key: number]: string} = {};
            parsedItems.forEach((item: any) => {
                inputs[item.id] = parseFloat(item.quantity) % 1 === 0
                    ? String(parseInt(item.quantity))
                    : parseFloat(item.quantity).toFixed(1);
            });
            setQuantityInputs(inputs);
        } catch (error) {
            console.error('Failed to fetch basket:', error);
        } finally {
            setLoading(false);
        }
    };

    /**
     * Persist name change. Fire on blur or manual submit — tapping the
     * title enters edit mode, blurring (including pressing Back) commits.
     * No separate "edit" button.
     */
    const saveBasketName = async (name: string) => {
        const trimmed = name.trim();
        setEditingName(false);
        setBasketName(trimmed);
        if (!trimmed) return; // empty name — keep displaying creation date
        try {
            await fetch(`${API_BASE_URL}/api/baskets/${id}/name`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: trimmed }),
            });
        } catch {
            // non-fatal — the local name stays, next fetch will reconcile
        }
    };

    useFocusEffect(useCallback(() => {
        fetchBasket();
        setSettingsRefreshKey(k => k + 1);
        getLocationSettings().then(setActiveSettings);
        // Hydrate the calc-time settings snapshot for the
        // "settings changed" branch. Missing key → leave null and the
        // button falls back to "Rodyti parduotuves".
        AsyncStorage.getItem(`basket_calc_meta_${id}`).then(raw => {
            if (!raw) { setCalcSettingsSnapshot(null); return; }
            try {
                const meta = JSON.parse(raw);
                setCalcSettingsSnapshot(meta?.settings ?? null);
            } catch {
                setCalcSettingsSnapshot(null);
            }
        });
    }, [id]));

    /**
     * Reconcile the basket's item matchModes with the user's current
     * display preference. If the user flipped the global toggle elsewhere,
     * we auto-convert so the basket calc uses consistent semantics.
     * Only acts on DRAFT baskets — compared/completed are immutable by
     * design and re-converting would silently change calc results.
     */
    useEffect(() => {
        if (!basket || basket.status !== 'draft' || items.length === 0) return;
        const itemMode = items[0].matchMode;
        // Heuristic: if any item's mode differs from the current preference,
        // and all items share the same mode (indicating they were all added
        // together under one preference), auto-convert. Mixed baskets are
        // left alone — probably from an older code path that predates
        // matchMode being a thing.
        const allSame = items.every(i => i.matchMode === itemMode);
        if (!allSame) return;
        if (itemMode === displayMode) return;
        (async () => {
            try {
                await fetch(`${API_BASE_URL}/api/baskets/${id}/convert-mode`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: displayMode }),
                });
                fetchBasket();
            } catch {
                // silent — next focus will try again
            }
        })();
    }, [basket?.status, displayMode]);

    /** Transition this basket to 'draft' (server + local) if it's currently
     *  'compared'. A no-op for already-draft baskets. */
    const revertToDraftIfCompared = async () => {
        if (basket?.status !== 'compared') return;
        await fetch(`${API_BASE_URL}/api/baskets/${id}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'draft' }),
        });
        setBasket(prev => prev ? { ...prev, status: 'draft' } : prev);
        setDraftBasketId(Number(id));
        await AsyncStorage.removeItem(`basket_results_${id}`);
    };

    const updateQuantity = async (itemId: number, newQuantity: number) => {
        const rounded = Math.round(newQuantity * 100) / 100;
        const existing = items.find(i => i.id === itemId);
        if (!existing) return;
        if (rounded < 1 && !existing.isWeighable) {
            removeItem(itemId);
            return;
        }
        if (rounded <= 0) {
            removeItem(itemId);
            return;
        }

        // Optimistic update + rollback on failure.
        const previousQty = existing.quantity;
        const previousInput = quantityInputs[itemId];
        setItems(prev => prev.map(item =>
            item.id === itemId ? { ...item, quantity: rounded } : item
        ));
        setQuantityInputs(prev => ({ ...prev, [itemId]: String(rounded) }));

        try {
            await revertToDraftIfCompared();
            const res = await fetch(`${API_BASE_URL}/api/basket-items/${itemId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quantity: rounded }),
            });
            if (!res.ok) throw new Error(`PUT ${res.status}`);
        } catch {
            // Rollback: restore the prior quantity so the UI never shows
            // a number that isn't on the server.
            setItems(prev => prev.map(item =>
                item.id === itemId ? { ...item, quantity: previousQty } : item
            ));
            setQuantityInputs(prev => ({ ...prev, [itemId]: previousInput }));
            Alert.alert('Klaida', 'Nepavyko atnaujinti kiekio');
        }
    };

    const removeItem = async (itemId: number) => {
        const previous = items;
        setItems(prev => prev.filter(item => item.id !== itemId));
        try {
            await revertToDraftIfCompared();
            await fetch(`${API_BASE_URL}/api/basket-items/${itemId}`, { method: 'DELETE' });
            const remaining = previous.filter(item => item.id !== itemId);
            if (remaining.length === 0) {
                // Deleting the last item is handled by FK cascade once the
                // basket itself is deleted; trigger that here for UX
                // consistency (empty basket == no basket).
                await fetch(`${API_BASE_URL}/api/baskets/${id}`, { method: 'DELETE' });
                clearSessionBasket();
                router.back();
            }
        } catch {
            setItems(previous);
            Alert.alert(t('basketTab.errorGeneric'), t('basketDetail.errorRemove'));
        }
    };

    /**
     * Runs calc with the given coordinates. Extracted so the address-modal
     * resolver can invoke it without going through the permission flow
     * again.
     */
    const runCalcWithCoords = async (coords: UserCoords) => {
        setCalcError(null);
        setCalcing(true);
        try {
            // Build candidate pool from location settings (non-blocking on failure)
            const [pool, settings] = await Promise.all([
                buildCandidatePool({ lat: coords.lat, lng: coords.lng }),
                getLocationSettings(),
            ]);

            const body: Record<string, any> = { lat: coords.lat, lng: coords.lng };
            if (pool.storeIds.length > 0) body.storeIds = pool.storeIds;

            const res = await fetch(`${API_BASE_URL}/api/baskets/${id}/calculate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const newResults = await res.json();

            // Persist results + location context so the results screen can score combos.
            // The full `settings` snapshot is also written so the basket-detail
            // screen can detect "user changed settings since the last calc" and
            // swap the button text from "view results" to "re-find stores".
            await Promise.all([
                AsyncStorage.setItem(`basket_results_${id}`, JSON.stringify(newResults)),
                AsyncStorage.setItem(`basket_calc_meta_${id}`, JSON.stringify({
                    storeCount: settings.storeCount,
                    searchCenter: pool.searchCenter,
                    settings,
                })),
            ]);

            setBasket(prev => prev ? { ...prev, status: 'compared' } : prev);
            // This basket is no longer a draft: subsequent "add to basket"
            // taps from product screens should create a new draft instead
            // of attaching here.
            setDraftBasketId(null);
            // Persist the coords that actually produced these results so
            // re-calcs use the same viewpoint by default.
            await persistCoords(coords);
            router.push(`/basket/results/${id}`);
        } catch {
            setCalcError(t('basketDetail.errorCalculate'));
        } finally {
            setCalcing(false);
        }
    };

    /**
     * Resolve user coordinates then calculate. Order:
     *   1. cached coords from prior successful calc — skip prompts
     *   2. GPS permission → device location
     *   3. address modal fallback (or Vilnius centre from inside the modal)
     */
    const handleCalculate = async () => {
        if (calcing) return;
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        const cached = await loadCachedCoords();
        if (cached) {
            await runCalcWithCoords(cached);
            return;
        }
        const gps = await tryGpsCoords();
        if (gps) {
            await runCalcWithCoords(gps);
            return;
        }
        setLocationPromptVisible(true);
    };

    const handleLocationResolved = async (coords: UserCoords) => {
        setLocationPromptVisible(false);
        await runCalcWithCoords(coords);
    };

    const handleRevertToDraft = async () => {
        Alert.alert(
            t('basketDetail.revertTitle'),
            t('basketDetail.revertBody'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('basketDetail.revertConfirm'),
                    onPress: async () => {
                        try {
                            await fetch(`${API_BASE_URL}/api/baskets/${id}/status`, {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ status: 'draft' }),
                            });
                            await AsyncStorage.removeItem(`basket_results_${id}`);
                            setDraftBasketId(Number(id));
                            fetchBasket();
                        } catch {
                            Alert.alert(t('basketTab.errorGeneric'), t('basketDetail.errorRevert'));
                        }
                    }
                }
            ]
        );
    };

    if (loading) return (
        <View style={[styles.container, { padding: 16, gap: 10 }]}>
            {Array.from({ length: 5 }).map((_, i) => (
                <View key={i} style={{ backgroundColor: colors.cardBackground, borderRadius: 12, padding: 12, flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                    <SkeletonBox width={56} height={56} borderRadius={8} />
                    <View style={{ flex: 1, gap: 8 }}>
                        <SkeletonBox width={150} height={13} borderRadius={6} />
                        <SkeletonBox width={90} height={11} borderRadius={5} />
                        <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                            <SkeletonBox width={28} height={28} borderRadius={14} />
                            <SkeletonBox width={40} height={28} borderRadius={6} />
                            <SkeletonBox width={28} height={28} borderRadius={14} />
                        </View>
                    </View>
                </View>
            ))}
        </View>
    );

    const fallbackTitle = formatDate(basket?.createdAt || '');
    const titleText = basketName || fallbackTitle;

    return (
        <>
            <Stack.Screen options={{
                // Tap-title-to-edit: no separate pencil button. Headless
                // mode in the header: if editing, show a TextInput; if
                // not, render the title as a tappable Text that flips
                // editing on. Blurring the input (including via Back)
                // saves.
                title: editingName ? '' : titleText,
                headerTitle: editingName
                    ? () => (
                        <TextInput
                            ref={nameInputRef}
                            defaultValue={basketName}
                            onChangeText={text => { nameTextRef.current = text; }}
                            onEndEditing={e => saveBasketName(e.nativeEvent.text)}
                            onSubmitEditing={e => saveBasketName(e.nativeEvent.text)}
                            onBlur={() => saveBasketName(nameTextRef.current)}
                            placeholder={fallbackTitle}
                            placeholderTextColor={colors.textMuted}
                            style={{
                                fontSize: 17,
                                fontWeight: '600',
                                color: colors.textPrimary,
                                minWidth: 200,
                                paddingVertical: 2,
                                borderBottomWidth: 1,
                                borderBottomColor: colors.primary,
                            }}
                        />
                    )
                    : () => (
                        <TouchableOpacity
                            onPress={() => basket?.status === 'draft' && setEditingName(true)}
                            disabled={basket?.status !== 'draft'}
                            activeOpacity={0.6}
                        >
                            <Text style={{ fontSize: 17, fontWeight: '600', color: colors.textPrimary }} numberOfLines={1}>
                                {titleText}
                            </Text>
                        </TouchableOpacity>
                    ),
                headerLeft: () => <ScreenBackButton />,
                // Bookmark icon → save-as-template modal. Only meaningful
                // when the basket has at least one item; hide otherwise
                // so the user isn't prompted to save an empty template.
                headerRight: items.length > 0
                    ? () => (
                        <GlassIconButton
                            icon="bookmark-outline"
                            onPress={() => setSaveTplVisible(true)}
                        />
                    )
                    : undefined,
            }} />
            <View style={styles.container}>
                <FlatList
                    data={items}
                    keyExtractor={item => item.id.toString()}
                    contentContainerStyle={styles.list}
                    ListEmptyComponent={
                        <View style={styles.centered}>
                            <Text style={styles.emptyText}>{t('basketDetail.empty')}</Text>
                            <Text style={styles.emptySubText}>{t('basketDetail.emptyBody')}</Text>
                        </View>
                    }
                    renderItem={({ item }) => {
                        // inProgress/completed = read-only: user is shopping or
                        // done, basket is locked. compared = editable but edits
                        // auto-revert to draft. draft = freely editable.
                        const readOnly = basket?.status === 'inProgress' || basket?.status === 'completed';
                        return (
                        <View style={styles.card}>
                            <ProductImage
                                uris={item.imageUrls}
                                imageStyle={styles.productImage}
                                placeholderStyle={styles.productImagePlaceholder}
                                emojiStyle={styles.productImageEmoji}
                            />
                            <View style={styles.cardContent}>
                                <Text style={styles.itemName}>{item.productName}</Text>
                                {readOnly ? (
                                    <Text style={styles.readOnlyQty}>
                                        {item.quantity}{item.isWeighable ? ' kg' : ' vnt.'}
                                    </Text>
                                ) : (() => {
                                    // Weighable rows step in 0.1 kg; piece rows
                                    // step in whole units. Mirrors the template
                                    // editor so the two surfaces feel identical.
                                    const step = item.isWeighable ? 0.1 : 1;
                                    const inputValueDefault = item.isWeighable
                                        ? Number(item.quantity).toFixed(1).replace('.', ',')
                                        : String(item.quantity);
                                    return (
                                    <View style={styles.controls}>
                                        <TouchableOpacity
                                            style={styles.controlButton}
                                            onPress={() => updateQuantity(item.id, Number(item.quantity) - step)}
                                        >
                                            <Ionicons name="remove" size={18} color={colors.primary} />
                                        </TouchableOpacity>
                                        <TextInput
                                            style={styles.quantityInput}
                                            value={quantityInputs[item.id] ?? inputValueDefault}
                                            onChangeText={v => {
                                                if (!item.isWeighable && (v.includes('.') || v.includes(','))) return;
                                                const dotIndex = v.indexOf('.');
                                                const commaIndex = v.indexOf(',');
                                                const separatorIndex = dotIndex !== -1 ? dotIndex : commaIndex;
                                                if (separatorIndex !== -1 && v.length - separatorIndex > 2) return;
                                                setQuantityInputs(prev => ({ ...prev, [item.id]: v }));
                                            }}
                                            onEndEditing={async e => {
                                                const val = parseFloat(e.nativeEvent.text.replace(',', '.'));
                                                if (!val || val <= 0) {
                                                    removeItem(item.id);
                                                    return;
                                                }
                                                await updateQuantity(item.id, val);
                                                setQuantityInputs(prev => ({ ...prev, [item.id]: String(val) }));
                                            }}
                                            keyboardType={item.isWeighable ? 'decimal-pad' : 'number-pad'}
                                            selectTextOnFocus
                                            underlineColorAndroid="transparent"
                                        />
                                        <Text style={styles.unitLabel}>
                                            {item.isWeighable ? 'kg' : 'vnt.'}
                                        </Text>
                                        <TouchableOpacity
                                            style={styles.controlButton}
                                            onPress={() => updateQuantity(item.id, Number(item.quantity) + step)}
                                        >
                                            <Ionicons name="add" size={18} color={colors.primary} />
                                        </TouchableOpacity>
                                    </View>
                                    );
                                })()}
                            </View>
                            {!readOnly && (
                                <TouchableOpacity
                                    style={styles.removeButton}
                                    onPress={() => removeItem(item.id)}
                                >
                                    <Ionicons name="trash-outline" size={20} color={colors.error} />
                                </TouchableOpacity>
                            )}
                        </View>
                        );
                    }}
                />

                {calcError && (
                    <View style={styles.errorBanner}>
                        <Ionicons name="alert-circle" size={16} color={colors.error} />
                        <Text style={styles.errorBannerText}>{calcError}</Text>
                    </View>
                )}

                {items.length > 0 && (
                    <View style={[styles.bottomBar, bottomInset > 0 && { paddingBottom: 12 + bottomInset }]}>
                        {basket?.status === 'inProgress' || basket?.status === 'completed' ? (
                            // Read-only states: basket is locked because the
                            // user is actively shopping (inProgress) or the
                            // trip is done (completed). Only affordance is
                            // viewing the calculated store comparison.
                            <ScalePressable
                                style={styles.showResultsButton}
                                onPress={() => router.push(`/basket/results/${id}`)}
                            >
                                <Ionicons name="storefront-outline" size={20} color={colors.onPrimary} />
                                <Text style={styles.showResultsText}>
                                    {basket?.status === 'inProgress' ? t('basketDetail.viewInProgress') : t('basketDetail.viewCompleted')}
                                </Text>
                            </ScalePressable>
                        ) : basket?.status === 'compared' ? (
                            <>
                                <ScalePressable
                                    style={[styles.showResultsButton, styles.secondaryButton]}
                                    onPress={handleRevertToDraft}
                                >
                                    <Text style={styles.secondaryButtonText}>{t('basketDetail.draft')}</Text>
                                </ScalePressable>
                                {/* Settings squircle stays available while compared
                                    so the user can tweak storeCount / location
                                    and have the main button retarget to "Rasti
                                    parduotuves" (re-find). Without this, there'd
                                    be no surface to change the inputs. */}
                                <ScalePressable
                                    style={[
                                        styles.settingsSquircle,
                                        activeSettings && !(activeSettings.mode === 'current' && activeSettings.storeCount === 1)
                                            && styles.settingsSquircleActive,
                                    ]}
                                    onPress={() => setLocationSettingsVisible(true)}
                                    disabled={calcing}
                                    scaleTo={0.92}
                                >
                                    <Ionicons
                                        name={
                                            activeSettings?.mode === 'specific' ? 'location-outline'
                                            : activeSettings?.mode === 'route' ? 'git-commit-outline'
                                            : 'locate-outline'
                                        }
                                        size={20}
                                        color={
                                            activeSettings && !(activeSettings.mode === 'current' && activeSettings.storeCount === 1)
                                                ? colors.primary
                                                : colors.textSecondary
                                        }
                                    />
                                    {activeSettings && activeSettings.storeCount > 1 && (
                                        <View style={styles.settingsBadge}>
                                            <Text style={styles.settingsBadgeText}>{activeSettings.storeCount}</Text>
                                        </View>
                                    )}
                                </ScalePressable>
                                <ScalePressable
                                    style={[styles.showResultsButton, calcing && styles.buttonCalcing]}
                                    onPress={settingsChanged ? handleCalculate : () => router.push(`/basket/results/${id}`)}
                                    disabled={calcing}
                                >
                                    {calcing ? (
                                        <>
                                            <ActivityIndicator size="small" color={colors.onPrimary} />
                                            <Text style={styles.showResultsText}>{t('basketDetail.calculating')}</Text>
                                        </>
                                    ) : (
                                        <>
                                            <Ionicons name="storefront-outline" size={20} color={colors.onPrimary} />
                                            <Text style={styles.showResultsText}>
                                                {settingsChanged
                                                    ? ((activeSettings?.storeCount ?? 1) > 1
                                                        ? 'Rasti parduotuves'
                                                        : 'Rasti parduotuvę')
                                                    : 'Rodyti parduotuves'}
                                            </Text>
                                        </>
                                    )}
                                </ScalePressable>
                            </>
                        ) : (
                            <>
                                <ScalePressable
                                    style={[
                                        styles.settingsSquircle,
                                        activeSettings && !(activeSettings.mode === 'current' && activeSettings.storeCount === 1)
                                            && styles.settingsSquircleActive,
                                    ]}
                                    onPress={() => {
                                        setLocationSettingsVisible(true);
                                    }}
                                    disabled={calcing}
                                    scaleTo={0.92}
                                >
                                    <Ionicons
                                        name={
                                            activeSettings?.mode === 'specific' ? 'location-outline'
                                            : activeSettings?.mode === 'route' ? 'git-commit-outline'
                                            : 'locate-outline'
                                        }
                                        size={20}
                                        color={
                                            activeSettings && !(activeSettings.mode === 'current' && activeSettings.storeCount === 1)
                                                ? colors.primary
                                                : colors.textSecondary
                                        }
                                    />
                                    {activeSettings && activeSettings.storeCount > 1 && (
                                        <View style={styles.settingsBadge}>
                                            <Text style={styles.settingsBadgeText}>{activeSettings.storeCount}</Text>
                                        </View>
                                    )}
                                </ScalePressable>
                                <ScalePressable
                                    style={[styles.showResultsButton, calcing && styles.buttonCalcing]}
                                    onPress={handleCalculate}
                                    disabled={calcing}
                                    scaleTo={calcing ? 1 : 0.95}
                                >
                                    {calcing ? (
                                        <>
                                            <ActivityIndicator size="small" color={colors.onPrimary} />
                                            <Text style={styles.showResultsText}>{t('basketDetail.calculating')}</Text>
                                        </>
                                    ) : (
                                        <>
                                            <Ionicons name="storefront-outline" size={20} color={colors.onPrimary} />
                                            <Text style={styles.showResultsText}>
                                                {(activeSettings?.storeCount ?? 1) > 1
                                                    ? 'Rasti parduotuves'
                                                    : 'Rasti parduotuvę'}
                                            </Text>
                                        </>
                                    )}
                                </ScalePressable>
                            </>
                        )}
                    </View>
                )}

                {calcing && (
                    <View style={styles.calcProgressOverlay} pointerEvents="none">
                        <View style={styles.calcProgressBar} />
                    </View>
                )}
            </View>

            {/* Full-screen calc progress modal so rapid back-taps can't
                leave the user with a half-calculated basket. Modal
                dismisses when calcing flips off and we navigate. */}
            <Modal
                visible={calcing}
                transparent
                animationType="fade"
                statusBarTranslucent
            >
                <View style={styles.calcModalBackdrop}>
                    <View style={styles.calcModalCard}>
                        <ActivityIndicator size="large" color={colors.primary} />
                        <Text style={styles.calcModalTitle}>{t('basketDetail.calculating')}</Text>
                        <Text style={styles.calcModalSub}>
                            {t('basketDetail.calcModalSub')}
                        </Text>
                    </View>
                </View>
            </Modal>

            <Modal
                visible={saveTplVisible}
                transparent
                animationType="fade"
                onRequestClose={() => !saveTplBusy && setSaveTplVisible(false)}
                onShow={() => setTimeout(() => saveTplNameRef.current?.focus(), 80)}
            >
                <TouchableOpacity
                    style={styles.calcModalBackdrop}
                    activeOpacity={1}
                    onPress={() => !saveTplBusy && setSaveTplVisible(false)}
                >
                    <TouchableOpacity
                        activeOpacity={1}
                        onPress={() => {}}
                        style={{
                            backgroundColor: colors.cardBackground, borderRadius: 16,
                            padding: 20, width: '85%', gap: 12,
                        }}
                    >
                        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.textPrimary }}>
                            {t('basketTab.templates.saveFromBasketTitle')}
                        </Text>
                        <Text style={{ fontSize: 13, color: colors.textSecondary }}>
                            {t('basketTab.templates.saveFromBasketBody')}
                        </Text>
                        <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 4 }}>
                            {t('basketTab.templates.createNameLabel')}
                        </Text>
                        <TextInput
                            ref={saveTplNameRef}
                            value={saveTplName}
                            onChangeText={setSaveTplName}
                            placeholder={t('basketTab.templates.createNamePlaceholder')}
                            placeholderTextColor={colors.textMuted}
                            maxLength={100}
                            returnKeyType="done"
                            onSubmitEditing={submitSaveAsTemplate}
                            style={{
                                borderWidth: 1, borderColor: colors.border,
                                borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
                                fontSize: 15, color: colors.textPrimary,
                            }}
                        />
                        <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
                            <TouchableOpacity
                                onPress={() => setSaveTplVisible(false)}
                                disabled={saveTplBusy}
                                style={{
                                    flex: 1, paddingVertical: 12, borderRadius: 10,
                                    borderWidth: 1, borderColor: colors.border, alignItems: 'center',
                                }}
                            >
                                <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>
                                    {t('basketTab.templates.createCancel')}
                                </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                onPress={submitSaveAsTemplate}
                                disabled={saveTplBusy || saveTplName.trim().length === 0}
                                style={{
                                    flex: 1, paddingVertical: 12, borderRadius: 10,
                                    backgroundColor: saveTplName.trim().length === 0
                                        ? colors.border
                                        : colors.primary,
                                    alignItems: 'center',
                                }}
                            >
                                {saveTplBusy ? (
                                    <ActivityIndicator size="small" color={colors.onPrimary} />
                                ) : (
                                    <Text style={{ color: colors.onPrimary, fontWeight: '700' }}>
                                        {t('basketTab.templates.saveFromBasketConfirm')}
                                    </Text>
                                )}
                            </TouchableOpacity>
                        </View>
                    </TouchableOpacity>
                </TouchableOpacity>
            </Modal>

            <LocationPromptModal
                visible={locationPromptVisible}
                onResolved={handleLocationResolved}
                onCancel={() => setLocationPromptVisible(false)}
            />

            <LocationSettingsModal
                visible={locationSettingsVisible}
                onClose={() => {
                    setLocationSettingsVisible(false);
                    getLocationSettings().then(setActiveSettings);
                }}
                refreshKey={settingsRefreshKey}
                onOpenPresetMap={(key, label, existing) => {
                    router.push(
                        `/preset/${key}/map?label=${encodeURIComponent(label)}${existing ? `&lat=${existing.lat}&lng=${existing.lng}` : ''}` as any,
                    );
                }}
            />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    list: { padding: 16 },
    controlButton: {
        width: 28, height: 28, borderRadius: 14,
        borderWidth: 1, borderColor: c.primary,
        alignItems: 'center', justifyContent: 'center',
    },
    emptyText: { fontSize: 16, color: c.textSecondary, fontWeight: '600' },
    emptySubText: { fontSize: 13, color: c.textMuted, marginTop: 4 },
    quantityInput: {
        fontSize: 15, fontWeight: '600', color: c.textPrimary,
        minWidth: 40, textAlign: 'center',
        borderBottomWidth: 1, borderBottomColor: c.border,
        paddingVertical: 2,
    },
    unitLabel: { fontSize: 13, fontWeight: '600', color: c.textSecondary, minWidth: 28 },
    readOnlyQty: {
        fontSize: 13,
        color: c.textSecondary,
        marginTop: 8,
    },
    errorBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginHorizontal: 16,
        marginBottom: 8,
        paddingVertical: 10,
        paddingHorizontal: 12,
        backgroundColor: c.warningMuted,
        borderRadius: 10,
    },
    errorBannerText: {
        flex: 1,
        fontSize: 13,
        color: c.error,
    },
    bottomBar: {
        flexDirection: 'row',
        padding: 12,
        backgroundColor: c.cardBackground,
        borderTopWidth: 1,
        borderTopColor: c.border,
        gap: 10,
    },
    showResultsButton: {
        flex: 1,
        backgroundColor: c.primary,
        borderRadius: 12,
        padding: 14,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    showResultsText: { color: c.onPrimary, fontWeight: '700', fontSize: 15 },
    settingsSquircle: {
        width: 50,
        height: 50,
        borderRadius: 14,
        backgroundColor: c.surfaceMuted,
        borderWidth: 1,
        borderColor: c.border,
        alignItems: 'center',
        justifyContent: 'center',
    },
    settingsSquircleActive: {
        borderColor: c.primary,
        borderWidth: 2,
        backgroundColor: c.primaryMuted,
    },
    settingsBadge: {
        position: 'absolute',
        top: -5,
        right: -5,
        width: 16,
        height: 16,
        borderRadius: 8,
        backgroundColor: c.primary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    settingsBadgeText: {
        fontSize: 10,
        fontWeight: '700',
        color: c.onPrimary,
    },
    secondaryButton: {
        backgroundColor: c.cardBackground,
        borderWidth: 1,
        borderColor: c.border,
        flex: 0,
        paddingHorizontal: 18,
    },
    secondaryButtonText: {
        color: c.textSecondary,
        fontWeight: '600',
        fontSize: 14,
    },
    buttonCalcing: {
        opacity: 0.9,
    },
    calcProgressOverlay: {
        position: 'absolute',
        top: 0, left: 0, right: 0,
        height: 2,
        backgroundColor: c.borderSubtle,
    },
    calcProgressBar: {
        height: '100%',
        width: '60%',
        backgroundColor: c.primary,
    },
    calcModalBackdrop: {
        flex: 1,
        backgroundColor: c.overlayBackdrop,
        alignItems: 'center',
        justifyContent: 'center',
    },
    calcModalCard: {
        backgroundColor: c.cardBackground,
        borderRadius: 16,
        paddingHorizontal: 32,
        paddingVertical: 28,
        alignItems: 'center',
        gap: 10,
        minWidth: 220,
    },
    calcModalTitle: {
        fontSize: 15,
        fontWeight: '700',
        color: c.textPrimary,
        marginTop: 4,
    },
    calcModalSub: {
        fontSize: 12,
        color: c.textSecondary,
        textAlign: 'center',
    },
    card: {
        backgroundColor: c.cardBackground, borderRadius: 12, padding: 12, marginBottom: 10,
        flexDirection: 'row', alignItems: 'center',
        elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08, shadowRadius: 2,
    },
    productImage: {
        width: 56, height: 56, borderRadius: 8, marginRight: 12, alignSelf: 'center',
    },
    productImagePlaceholder: {
        width: 56, height: 56, borderRadius: 8, marginRight: 12,
        backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center', alignSelf: 'center',
    },
    productImageEmoji: {
        fontSize: 28,
        opacity: 0.4,
    },
    cardContent: { flex: 1, justifyContent: 'space-between' },
    itemName: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    controls: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
    removeButton: {
        width: 36,
        alignItems: 'center',
        justifyContent: 'center',
        borderLeftWidth: 1,
        borderLeftColor: c.borderSubtle,
        marginLeft: 8,
        paddingLeft: 8,
    },
});
