import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, TextInput, Modal } from 'react-native';
import { SkeletonBox } from '../../components/SkeletonBox';
import { isWeighableDisplay } from '../../utils/weighable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import Animated from 'react-native-reanimated';
import { useCollapsingHeader, CollapsingHeader } from '../../components/CollapsingHeader';
import { ScreenHeading } from '../../components/ScreenHeading';
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
import { coverEmoji } from '../../utils/templateCover';
import { TemplateCoverEditor, type CoverDraft } from '../../components/TemplateCoverEditor';
import { Toast, type ToastHandle } from '../../components/Toast';
import { createTemplateFromBasket, instantiateTemplate } from '../../utils/basketTemplatesApi';
import { ContextMenu } from '../../components/ContextMenu';
import { getUserId } from '../../config/user';
import { useAuthState } from '../../state/authState';

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

/** Render an item as weighable (kg) vs pieces (vnt) — see utils/weighable. */
const isWeighableItem = (it: { isWeighable: boolean; quantity: number }): boolean =>
    isWeighableDisplay(it.isWeighable, it.quantity);

interface Basket {
    id: number;
    status: string;
    name: string;
    createdAt: string;
    userEditedAfterCreation?: 0 | 1;
    sourceTemplateId?: number | null;
    templateCoverColor?: string | null;
    templateCoverImage?: { kind: 'preset'; iconKey: string } | { kind: 'emoji'; emoji: string } | null;
    templateCreatorHandle?: string | null;
    templateName?: string | null;
}

export default function BasketDetailScreen() {
    const colors = useTheme();
    const header = useCollapsingHeader();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { bottom: bottomInset } = useSafeAreaInsets();
    const { id } = useLocalSearchParams();
    const router = useRouter();
    const { mode: displayMode } = useDisplayMode();
    const { setDraftBasketId, clearSessionBasket } = useBasketState();
    const authUsername = useAuthState((s: any) => s.user?.username ?? null);

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
    // `calcInFlight` is set synchronously the moment "Rasti parduotuvę" is
    // tapped, BEFORE the async location resolution (loadCachedCoords /
    // tryGpsCoords). `calcing` only flips true *after* coords resolve (inside
    // runCalcWithCoords), so without this the button stays enabled during the
    // GPS-permission window and rapid taps each spawn a calc → multiple
    // router.push → stacked results screens. The ref is a synchronous gate
    // (state updates are async and can't block fast taps); `resolvingLocation`
    // drives the disabled/spinner UI during that same window.
    const calcInFlight = useRef(false);
    const [resolvingLocation, setResolvingLocation] = useState(false);
    const [calcError, setCalcError] = useState<string | null>(null);
    // Drives the find-store button's disabled + spinner state. Includes the
    // location-resolution window so the button reacts the instant it is tapped
    // (not only once the network calc starts).
    const busy = calcing || resolvingLocation;
    // Location prompt state. Shown when GPS permission is denied and the
    // user hasn't previously cached an address. On resolve, we continue
    // the calc flow with the new coordinates.
    const [locationPromptVisible, setLocationPromptVisible] = useState(false);
    const [locationSettingsVisible, setLocationSettingsVisible] = useState(false);
    // Set when we leave the settings sheet to add a preset on the map; the
    // focus effect re-opens the sheet on return so the setup flow continues
    // (the sheet reloads presets on open, so the new address is already there).
    const reopenSettingsRef = useRef(false);
    // Save-as-template flow: bookmark icon in the nav bar opens a name
    // prompt → POST /api/basket-templates/from-basket/:id → toast.
    // Save-as-template: the bookmark opens the shared identity sheet
    // (prefilled with the basket name); on submit we create the template
    // from this basket with the chosen name/emoji/colour.
    const [saveTplVisible, setSaveTplVisible] = useState(false);
    const toastRef = useRef<ToastHandle>(null);

    const handleSaveAsTemplate = useCallback(async (next: CoverDraft) => {
        try {
            await createTemplateFromBasket(Number(id), {
                name: next.name, coverColor: next.coverColor, coverImage: next.coverImage,
            });
            toastRef.current?.show(t('basketTab.templates.savedToast', { name: next.name }));
            // The basket is now this template's first instance (server linked
            // sourceTemplateId) — refetch so the header inherits the cover
            // (emoji/colour/name) + template-derived UI.
            await fetchBasket();
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorInstantiate'));
        }
    }, [id, t]);

    // 3-dots actions for template-derived baskets.
    const [actionsOpen, setActionsOpen] = useState(false);

    // Copy the basket as it is now. If it was edited, the server returns a
    // "plain" copy (no template identity) — navigate into it.
    const handleCopyBasket = useCallback(async () => {
        setActionsOpen(false);
        try {
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/baskets/${Number(id)}/copy`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
            });
            const data = await res.json();
            if (data?.id) router.push(`/basket/${data.id}` as any);
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorSave'));
        }
    }, [id, router, t]);

    // Copy the creator's original (re-instantiate the source template) —
    // keeps the inherited emoji/colour/@attribution + the original items.
    const handleCopyOriginal = useCallback(async () => {
        setActionsOpen(false);
        const tplId = basket?.sourceTemplateId;
        if (!tplId) return;
        try {
            const userId = await getUserId();
            const res = await instantiateTemplate(tplId, userId, { force: true });
            if (res?.basketId) router.push(`/basket/${res.basketId}` as any);
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorInstantiate'));
        }
    }, [basket?.sourceTemplateId, router, t]);
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
        // Ignore `storeCount`: it only re-organises the already-priced basket
        // (client-side split across 1/2/3 shops), so changing it must NOT force
        // a recalc. Location-affecting fields (mode / Vieta / Maršrutas) still do.
        const norm = (s: LocationSettings) =>
            JSON.stringify(s, Object.keys(s as any).filter(k => k !== 'storeCount').sort());
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
                // Robust coerce: the API may send 1 | "1" | true depending on the
                // driver/aggregation; Number() normalises all of them.
                isWeighable: Number(item.isWeighable) === 1,
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
        // Returning from the preset map (opened from the settings sheet) →
        // re-open the sheet so the user keeps configuring where they left off.
        if (reopenSettingsRef.current) {
            reopenSettingsRef.current = false;
            setLocationSettingsVisible(true);
        }
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

    /** "Add item" CTA on a draft basket: mark this basket as the active
     *  session/draft so the Narsyti tab edits it directly — items already in
     *  it show the amount picker, and new items add without a basket prompt —
     *  then switch to that tab. Drafts are singletons, so this is always the
     *  basket the user is looking at. */
    const handleAddItem = async () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        // Adding an item is an edit → a compared basket reverts to draft so the
        // user must re-run the comparison before viewing results again.
        await revertToDraftIfCompared();
        setDraftBasketId(Number(id));
        router.navigate('/(tabs)/browse' as any);
    };

    // Changing location/store-count settings while compared is also an edit:
    // drop back to draft so the bottom button retargets to "Rasti parduotuves".
    useEffect(() => {
        if (basket?.status === 'compared' && settingsChanged) {
            void revertToDraftIfCompared();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [basket?.status, settingsChanged]);

    // Mirror the server's userEditedAfterCreation flag locally so the
    // "Redaguota" chip and the "Copy original" action appear together the
    // moment the user changes items (no refetch needed).
    const markEditedLocally = useCallback(() => {
        setBasket(prev => (prev && prev.userEditedAfterCreation !== 1 ? { ...prev, userEditedAfterCreation: 1 } : prev));
    }, []);

    const updateQuantity = async (itemId: number, newQuantity: number) => {
        const rounded = Math.round(newQuantity * 100) / 100;
        const existing = items.find(i => i.id === itemId);
        if (!existing) return;
        if (rounded < 1 && !isWeighableItem(existing)) {
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
            markEditedLocally();
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
            markEditedLocally();
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
        if (calcInFlight.current || calcing) return;
        calcInFlight.current = true;
        setResolvingLocation(true);
        try {
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
            // No coords resolvable without user input — hand off to the
            // location prompt; the modal's resolver continues the calc.
            setLocationPromptVisible(true);
        } finally {
            setResolvingLocation(false);
            calcInFlight.current = false;
        }
    };

    const handleLocationResolved = async (coords: UserCoords) => {
        setLocationPromptVisible(false);
        await runCalcWithCoords(coords);
    };

    if (loading) return (
        <View style={styles.container}>
            {/* Match the loaded header: white bg + pink back chevron + an
                emoji-tile/name placeholder, so nothing flashes on load. */}
            <Stack.Screen options={{
                headerStyle: { backgroundColor: colors.cardBackground },
                headerShadowVisible: false,
                headerLeft: () => <ScreenBackButton />,
                headerTitle: () => (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <SkeletonBox width={34} height={34} borderRadius={10} />
                        <SkeletonBox width={120} height={15} borderRadius={6} />
                    </View>
                ),
            }} />
            <View style={styles.list}>
                {Array.from({ length: 5 }).map((_, i) => (
                    <View key={i} style={styles.card}>
                        <SkeletonBox width={56} height={56} borderRadius={8} />
                        <View style={{ flex: 1, marginLeft: 12, gap: 10 }}>
                            <SkeletonBox width={150} height={14} borderRadius={6} />
                            <View style={{ flexDirection: 'row', gap: 8, marginTop: 2, alignItems: 'center' }}>
                                <SkeletonBox width={28} height={28} borderRadius={14} />
                                <SkeletonBox width={40} height={24} borderRadius={6} />
                                <SkeletonBox width={28} height={28} borderRadius={14} />
                            </View>
                        </View>
                    </View>
                ))}
            </View>
        </View>
    );

    const fallbackTitle = formatDate(basket?.createdAt || '');
    const titleText = basketName || fallbackTitle;

    // Template-derived baskets inherit the template's identity (emoji + colour
    // + creator @handle) and are NOT renamable here — the name belongs to the
    // creator's template. Manual baskets keep the editable name.
    const fromTemplate = !!(basket?.templateName || basket?.templateCoverColor);
    const headerColor = fromTemplate && basket?.templateCoverColor ? basket.templateCoverColor : colors.cardBackground;
    const onCover = fromTemplate && basket?.templateCoverColor ? '#FFFFFF' : colors.textPrimary;
    const basketEmoji = coverEmoji(basket?.templateCoverImage ?? null);
    const inheritedName = basket?.templateName ?? titleText;
    // "Redaguota" only applies while the basket is still tied to a template.
    const edited = fromTemplate && basket?.userEditedAfterCreation === 1;
    // Attribution = template owner's @handle; fall back to the current user's
    // handle for own/private templates (DB username not populated yet).
    const attribHandle = basket?.templateCreatorHandle ?? (fromTemplate ? authUsername : null);
    // Draft and compared are both editable; any edit reverts compared → draft.
    // (inProgress/completed are locked.) The only user-facing difference is the
    // bottom button: "Rasti parduotuves" (draft) vs "Parduotuvės" (compared).
    const isEditable = basket?.status === 'draft' || basket?.status === 'compared';

    return (
        <>
            <CollapsingHeader
                controller={header}
                background={headerColor}
                back
                headerOptions={{
                    headerShown: true,
                    title: '',
                    headerTitle: () => null,
                    headerStyle: { backgroundColor: headerColor },
                    headerTintColor: onCover,
                    headerShadowVisible: false,
                    headerLeft: () => <ScreenBackButton color={fromTemplate && basket?.templateCoverColor ? '#FFFFFF' : colors.primary} />,
                    // Bookmark icon → save-as-template modal. Only meaningful
                    // when the basket has at least one item; hide otherwise
                    // so the user isn't prompted to save an empty template.
                    // Template-derived baskets get a 3-dots menu (copy / copy
                    // original); manual + plain baskets keep the save-as-template
                    // bookmark.
                    headerRight: items.length === 0
                        ? undefined
                        : fromTemplate
                        ? () => (
                            <GlassIconButton
                                icon="ellipsis-horizontal"
                                color={onCover}
                                onPress={() => setActionsOpen(true)}
                            />
                        )
                        : () => (
                            <GlassIconButton
                                icon="bookmark-outline"
                                color={onCover}
                                onPress={() => setSaveTplVisible(true)}
                            />
                        ),
                }}
                collapsing={
                    fromTemplate ? (
                        <View style={styles.titleRow}>
                            <View style={[styles.titleEmoji, {
                                backgroundColor: basket?.templateCoverColor ? 'rgba(255,255,255,0.22)' : (colors.surfaceMuted ?? colors.cardBackground),
                            }]}>
                                <Text style={{ fontSize: 20 }}>{basketEmoji ?? '🫜'}</Text>
                            </View>
                            <View style={{ flex: 1, minWidth: 0 }}>
                                {/* "Redaguota" sits next to the name (this basket diverged
                                    from the creator's original), not next to the @handle. */}
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                    <Text style={{ fontSize: 20, fontWeight: '700', color: onCover, flexShrink: 1 }} numberOfLines={2}>
                                        {inheritedName}
                                    </Text>
                                    {edited && (
                                        <View style={{ backgroundColor: 'rgba(255,255,255,0.25)', borderRadius: 7, paddingHorizontal: 6, paddingVertical: 1 }}>
                                            <Text style={{ fontSize: 9, fontWeight: '800', color: onCover, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                                                {t('basketTab.edited')}
                                            </Text>
                                        </View>
                                    )}
                                </View>
                                {/* Attribution = the template owner's @handle; falls back to
                                    the creation date when the owner isn't a creator (no handle). */}
                                <Text style={{ fontSize: 12, fontWeight: '600', color: onCover, opacity: 0.85 }} numberOfLines={1}>
                                    {attribHandle ? `@${attribHandle}` : formatDate(basket?.createdAt || '')}
                                </Text>
                            </View>
                        </View>
                    ) : editingName ? (
                        <View style={styles.titleRow}>
                            <TextInput
                                ref={nameInputRef}
                                defaultValue={basketName}
                                onChangeText={text => { nameTextRef.current = text; }}
                                onEndEditing={e => saveBasketName(e.nativeEvent.text)}
                                onSubmitEditing={e => saveBasketName(e.nativeEvent.text)}
                                onBlur={() => saveBasketName(nameTextRef.current)}
                                placeholder={fallbackTitle}
                                placeholderTextColor={colors.textMuted}
                                autoFocus
                                style={{
                                    flex: 1,
                                    fontSize: 22,
                                    fontWeight: '700',
                                    color: colors.textPrimary,
                                    paddingVertical: 2,
                                    borderBottomWidth: 1,
                                    borderBottomColor: colors.primary,
                                }}
                            />
                        </View>
                    ) : (
                        <TouchableOpacity
                            style={styles.titleRow}
                            onPress={() => isEditable && setEditingName(true)}
                            disabled={!isEditable}
                            activeOpacity={0.6}
                        >
                            <Text style={[styles.titleText, { color: colors.textPrimary }]} numberOfLines={2}>
                                {titleText}
                            </Text>
                        </TouchableOpacity>
                    )
                }
            />
            <View style={styles.container}>
                <Animated.FlatList
                    {...header.scroll}
                    style={{ flex: 1 }}
                    data={items}
                    keyExtractor={(item: any) => item.id.toString()}
                    contentContainerStyle={[styles.list, { paddingTop: header.paddingTop + 12 }]}
                    ListHeaderComponent={
                        isEditable ? (
                            <TouchableOpacity
                                style={styles.addItemBtn}
                                onPress={handleAddItem}
                                activeOpacity={0.7}
                            >
                                <Ionicons name="add" size={18} color={colors.primary} />
                                <Text style={styles.addItemBtnText}>{t('basketDetail.addItem')}</Text>
                            </TouchableOpacity>
                        ) : null
                    }
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
                                        {item.quantity}{isWeighableItem(item) ? ' kg' : ' vnt.'}
                                    </Text>
                                ) : (() => {
                                    // Weighable rows step in 0.1 kg; piece rows
                                    // step in whole units. Mirrors the template
                                    // editor so the two surfaces feel identical.
                                    const weighable = isWeighableItem(item);
                                    const step = weighable ? 0.1 : 1;
                                    const inputValueDefault = weighable
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
                                                if (!weighable && (v.includes('.') || v.includes(','))) return;
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
                                            keyboardType={weighable ? 'decimal-pad' : 'number-pad'}
                                            selectTextOnFocus
                                            underlineColorAndroid="transparent"
                                        />
                                        <Text style={styles.unitLabel}>
                                            {weighable ? 'kg' : 'vnt.'}
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
                                    disabled={busy}
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
                                    style={styles.showResultsButton}
                                    onPress={() => router.push(`/basket/results/${id}`)}
                                >
                                    <Ionicons name="storefront-outline" size={20} color={colors.onPrimary} />
                                    <Text style={styles.showResultsText}>
                                        {(activeSettings?.storeCount ?? 1) > 1 ? 'Parduotuvės' : 'Parduotuvė'}
                                    </Text>
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
                                    disabled={busy}
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
                                    style={[styles.showResultsButton, busy && styles.buttonCalcing]}
                                    onPress={handleCalculate}
                                    disabled={busy}
                                    scaleTo={busy ? 1 : 0.95}
                                >
                                    {busy ? (
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
                leave the user with a half-calculated basket. Shown for the
                WHOLE busy window (location resolving + calculating), not just
                `calcing` — otherwise GPS acquisition (seconds) passes with no
                modal and the press feels dead. */}
            <Modal
                visible={busy}
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

            <TemplateCoverEditor
                visible={saveTplVisible}
                onClose={() => setSaveTplVisible(false)}
                name={basketName || ''}
                coverColor={null}
                coverImage={null}
                submitLabel={t('basketTab.templates.saveFromBasketConfirm')}
                onSubmit={handleSaveAsTemplate}
            />

            <ContextMenu
                visible={actionsOpen}
                onDismiss={() => setActionsOpen(false)}
                actions={[
                    { icon: 'copy-outline', label: t('basketTab.copyBasket'), onPress: handleCopyBasket },
                    ...(edited ? [{ icon: 'duplicate-outline' as const, label: t('basketTab.copyOriginal'), onPress: handleCopyOriginal }] : []),
                ]}
            />

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
                    // Dismiss the sheet first so the pushed map isn't covered by
                    // it; mark for re-open so the focus effect restores the sheet
                    // (with the new address) when we navigate back.
                    reopenSettingsRef.current = true;
                    setLocationSettingsVisible(false);
                    router.push(
                        `/preset/${key}/map?label=${encodeURIComponent(label)}${existing ? `&lat=${existing.lat}&lng=${existing.lng}` : ''}` as any,
                    );
                }}
            />

            <Toast ref={toastRef} />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    list: { padding: 16 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 10 },
    titleEmoji: { width: 40, height: 40, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
    titleText: { fontSize: 22, fontWeight: '700' },
    addItemBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: 6, paddingVertical: 12, borderRadius: 10, marginBottom: 12,
        borderWidth: 1, borderColor: c.primary, borderStyle: 'dashed',
    },
    addItemBtnText: { fontSize: 14, fontWeight: '600', color: c.primary },
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
