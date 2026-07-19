import {
    View,
    Text,
    FlatList,
    TouchableOpacity,
    StyleSheet,
    Alert,
    TextInput,
    Modal,
    Platform,
    Dimensions,
    Share,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { SkeletonBox } from '../../components/SkeletonBox';
import { isWeighableDisplay } from '../../utils/weighable';
import { useSafeAreaInsets, initialWindowMetrics } from 'react-native-safe-area-context';
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
import { useTheme, radius, elevation, type AppTheme } from '../../constants/theme';
import { useBasketState } from '../../state/basketState';
import { useDisplayMode } from '../../contexts/DisplayPreferenceContext';
import LocationPromptModal from '../../components/LocationPromptModal';
import { DockedGlassSheet, type DockedSheetControls } from '../../components/DockedGlassSheet';
import { AddOrStepper } from '../../components/AddOrStepper';
import { BrandedQR } from '../../components/BrandedQR';
import { ChefToqueGlyph } from '../../components/icons/tabGlyphs';
import { useBasketSession } from '../../state/basketSession';
import { fetchTrips, createTripInviteUrl } from '../../utils/tripsApi';
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
    /** Product-level canonical unit (kg / l / vnt …) — a measured FLUID
     *  quantity must label as l, not the old hardcoded kg (Rokiškio pienas
     *  0,5 l rendered "0,5 kg"). */
    canonicalUnit?: string | null;
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
    // This screen's native-header context can report a 0 bottom inset even
    // though edge-to-edge draws the content under the gesture/nav bar — that
    // left the action bar clipped. When the per-screen inset under-reports, use
    // the launch-time window inset (the device's real nav-bar height) rather
    // than a magic number; small Android floor only if both are unavailable.
    const { bottom: rawBottomInset } = useSafeAreaInsets();
    const bottomInset =
        Math.max(rawBottomInset, initialWindowMetrics?.insets?.bottom ?? 0)
        || (Platform.OS === 'android' ? 24 : 0);
    const { id } = useLocalSearchParams();
    const router = useRouter();
    const { mode: displayMode } = useDisplayMode();
    const { setDraftBasketId, clearSessionBasket } = useBasketState();
    const authUsername = useAuthState((s: any) => s.user?.username ?? null);

    const [basket, setBasket] = useState<Basket | null>(null);
    const [items, setItems] = useState<BasketItem[]>([]);
    const [loading, setLoading] = useState(true);
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
    // Bottom bar-sheet (GlassStageSheet): stage 0 = the floating action bar,
    // stage 1 = the expanded settings panel. The settings squircle toggles it;
    // dragging the pill does the same. Bar/panel heights are measured by the
    // sheet and drive the snap points.
    const settingsSheetRef = useRef<DockedSheetControls>(null);
    const [barRowH, setBarRowH] = useState(44);
    const [dockClearance, setDockClearance] = useState(120);
    // List-sheet parity: tap a long name to reveal the full name.
    const [expandedNames, setExpandedNames] = useState<Set<number>>(new Set());
    // Invite-to-trip QR (resolved via the basket's trip).
    const [inviteOpen, setInviteOpen] = useState(false);
    const [inviteUrl, setInviteUrl] = useState<string | null>(null);
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
        // Store-search settings moved to the MAP surface — this screen only
        // reads them (storeCount / route completeness gate the Stores pill).
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
        // Target the SESSION at this basket too, so every catalog surface
        // (cards, list sheet) reads and writes THIS basket.
        useBasketSession.getState().setTarget({ kind: 'basket', basketId: Number(id), isFamily: false }, items.length);
        router.navigate('/(tabs)/catalog' as any);
    };

    // Invite a friend: baskets belong to trips — resolve the trip and show
    // its invite QR (same join flow as everywhere else).
    const openInvite = useCallback(async () => {
        setInviteOpen(true);
        setInviteUrl(null);
        try {
            const trips = await fetchTrips();
            const trip = trips.find(tr => tr.basket?.id === Number(id));
            if (!trip) { setInviteOpen(false); return; }
            setInviteUrl(await createTripInviteUrl(trip.id));
        } catch { setInviteOpen(false); }
    }, [id]);

    // Remove the whole basket (confirm first) — deletes the server row and
    // leaves the screen; any session targeting it is cleared.
    const removeBasket = useCallback(() => {
        Alert.alert(t('basketDetail.removeTitle'), t('basketDetail.removeBody'), [
            { text: t('common.cancel'), style: 'cancel' },
            {
                text: t('basketDetail.removeConfirm'),
                style: 'destructive',
                onPress: async () => {
                    await fetch(`${API_BASE_URL}/api/baskets/${id}`, { method: 'DELETE' }).catch(() => {});
                    const sess = useBasketSession.getState();
                    if (sess.target?.kind === 'basket' && sess.target.basketId === Number(id)) {
                        useBasketSession.setState({ target: null, barVisible: false, itemCount: 0 });
                    }
                    clearSessionBasket();
                    router.back();
                },
            },
        ]);
    }, [id, t, router, clearSessionBasket]);

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
        setItems(prev => prev.map(item =>
            item.id === itemId ? { ...item, quantity: rounded } : item
        ));

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

            // The calculate origin must be the SETTINGS-RESOLVED centre (the
            // chosen place/bus centre), not the device position: the server
            // derives every store's `distance` from these coords, and the
            // combo scorer optimises travel from them. Posting raw GPS in
            // place mode skewed recommendations toward the user's CURRENT
            // location (candidates around the place, distances from the GPS).
            // Route mode has no single centre (searchCenter null) → resolved
            // coords remain the fallback origin.
            const origin = pool.searchCenter ?? coords;
            const body: Record<string, any> = { lat: origin.lat, lng: origin.lng };
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
    // Route mode with either endpoint missing can't be priced meaningfully —
    // the find button disables and the settings squircle flags it with "!"
    // (picking the other endpoint's value in a route dropdown vacates it, so
    // this state is reachable in normal use, not just half-done setup).
    const routeIncomplete = !!activeSettings
        && activeSettings.mode === 'route'
        && (!activeSettings.routeFrom || !activeSettings.routeTo);

    // Bar-sheet snap points: collapsed = pill + action bar; expanded = the
    // settings live INSIDE the expanded dock now. Read-only baskets keep a
    // bar-only dock (no sheet).
    const sheetExpandable = basket?.status !== 'inProgress' && basket?.status !== 'completed';

    const handleCalculate = async () => {
        if (calcInFlight.current || calcing) return;
        if (routeIncomplete) { settingsSheetRef.current?.snapTo(1); return; }
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
            <Stack.Screen options={{ headerShown: false }} />
            <View style={{ paddingTop: 54, paddingHorizontal: 16 }}>
                <View style={{ marginBottom: 16 }}><ScreenBackButton /></View>
                <SkeletonBox width={200} height={24} borderRadius={7} />
                {Array.from({ length: 5 }).map((_, i) => (
                    <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 12 }}>
                        <SkeletonBox width={56} height={56} borderRadius={8} />
                        <View style={{ flex: 1, gap: 8 }}>
                            <SkeletonBox width={170} height={14} borderRadius={6} />
                            <SkeletonBox width={140} height={30} borderRadius={15} />
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
                back
                right={fromTemplate && items.length > 0
                    ? <GlassIconButton icon="ellipsis-horizontal" onPress={() => setActionsOpen(true)} />
                    : undefined}
            />
            <View style={styles.container}>
                <Animated.FlatList
                    {...header.scroll}
                    style={{ flex: 1 }}
                    data={items}
                    keyExtractor={(item: any) => item.id.toString()}
                    contentContainerStyle={[styles.list, { paddingTop: header.paddingTop + 12, paddingBottom: dockClearance + 28 }]}
                    ListHeaderComponent={
                        <>
                        {fromTemplate ? (
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
                    )}
                        </>
                    }
                    ListEmptyComponent={
                        <View style={styles.centered}>
                            <Text style={styles.emptyText}>{t('basketDetail.empty')}</Text>
                            <Text style={styles.emptySubText}>{t('basketDetail.emptyBody')}</Text>
                        </View>
                    }
                    ItemSeparatorComponent={() => <View style={styles.rowSep} />}
                    renderItem={({ item }) => {
                        // inProgress/completed = read-only (locked while
                        // shopping / after the trip).
                        const readOnly = basket?.status === 'inProgress' || basket?.status === 'completed';
                        const weighable = isWeighableItem(item);
                        return (
                            <View style={styles.itemRow}>
                                <ProductImage
                                    uris={item.imageUrls}
                                    imageStyle={styles.itemImage}
                                    placeholderStyle={styles.itemImage}
                                    emojiStyle={{ fontSize: 22 }}
                                />
                                <View style={{ flex: 1, gap: 6 }}>
                                    <Text
                                        style={styles.itemName}
                                        numberOfLines={expandedNames.has(item.id) ? undefined : 1}
                                        suppressHighlighting
                                        onPress={() => setExpandedNames(prev => {
                                            const next = new Set(prev);
                                            if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                                            return next;
                                        })}
                                    >
                                        {item.productName}
                                    </Text>
                                    <View style={styles.itemActionRow}>
                                        {readOnly ? (
                                            <Text style={styles.itemQtyText}>
                                                {item.quantity} {weighable ? (item.canonicalUnit === 'l' ? t('units.l') : t('units.kg')) : t('units.vnt')}
                                            </Text>
                                        ) : (
                                            <>
                                                <AddOrStepper
                                                    product={{
                                                        id: item.productId,
                                                        name: item.productName,
                                                        canonicalUnit: item.canonicalUnit,
                                                        canonicalStep: item.canonicalStep,
                                                        canonicalFamily: item.canonicalFamily,
                                                        isWeighable: weighable,
                                                    }}
                                                    quantity={Number(item.quantity) || 0}
                                                    onCommit={(qty) => {
                                                        if (qty <= 0) { removeItem(item.id); return; }
                                                        void updateQuantity(item.id, qty);
                                                    }}
                                                    style={styles.itemStepper}
                                                />
                                                <TouchableOpacity onPress={() => removeItem(item.id)} hitSlop={8}>
                                                    <Ionicons name="trash-outline" size={22} color={colors.textMuted} />
                                                </TouchableOpacity>
                                            </>
                                        )}
                                    </View>
                                </View>
                            </View>
                        );
                    }}
                />

                {calcError && (
                    <View style={[styles.errorBanner, { marginBottom: dockClearance + 16 }]}>
                        <Ionicons name="alert-circle" size={16} color={colors.error} />
                        <Text style={styles.errorBannerText}>{calcError}</Text>
                    </View>
                )}

                {basket != null && (
                    <DockedGlassSheet
                        ref={settingsSheetRef}
                        colors={colors}
                        onCollapsedClearance={setDockClearance}
                        barRowHeight={barRowH}
                        barRow={
                            <View
                                style={styles.barRow}
                                onLayout={e => { const h = Math.round(e.nativeEvent.layout.height); if (h > 0) setBarRowH(h); }}
                            >
                                {basket?.status === 'inProgress' || basket?.status === 'completed' ? (
                                    <ScalePressable
                                        style={[styles.storesPill, { flex: 1 }]}
                                        onPress={() => router.push(`/basket/results/${id}`)}
                                    >
                                        <Text style={styles.storesPillText}>
                                            {basket?.status === 'inProgress' ? t('basketDetail.viewInProgress') : t('basketDetail.viewCompleted')}
                                        </Text>
                                    </ScalePressable>
                                ) : (
                                    <>
                                        <TouchableOpacity style={styles.addMoreBtn} onPress={handleAddItem} activeOpacity={0.7}>
                                            <Ionicons name="add" size={20} color={colors.primary} />
                                            <Text style={styles.addMoreText}>{t('basketDetail.addMore')}</Text>
                                        </TouchableOpacity>
                                        <ScalePressable
                                            style={[styles.storesPill, busy && styles.buttonCalcing, (routeIncomplete || items.length === 0) && styles.buttonDisabled]}
                                            onPress={basket?.status === 'compared'
                                                ? () => router.push(`/basket/results/${id}`)
                                                : handleCalculate}
                                            disabled={busy || routeIncomplete || items.length === 0}
                                            scaleTo={busy || routeIncomplete ? 1 : 0.95}
                                        >
                                            {busy
                                                ? <MaterialProgress size="small" color={colors.onPrimary} />
                                                : (
                                                    <>
                                                        <Text style={styles.storesPillText}>{t('basketDetail.stores')}</Text>
                                                        <Ionicons name="chevron-forward" size={16} color={colors.onPrimary} />
                                                    </>
                                                )}
                                        </ScalePressable>
                                    </>
                                )}
                            </View>
                        }
                        sheet={sheetExpandable ? {
                            maxStage: 2,
                            content: (
                                <View style={styles.sheetPanelContent}>
                                    <Text style={styles.sheetTitle}>{t('basketDetail.actionsTitle')}</Text>
                                    {/* iOS-style big actions, two per row. */}
                                    <View style={styles.bigBtnRow}>
                                        {!fromTemplate && (
                                            <TouchableOpacity style={styles.bigActionBtn} onPress={() => setSaveTplVisible(true)} activeOpacity={0.7}>
                                                <ChefToqueGlyph size={24} color={colors.primary} />
                                                <Text style={styles.bigActionTitle}>{t('basketDetail.saveTitle')}</Text>
                                                <Text style={styles.bigActionSub}>{t('basketDetail.saveSub')}</Text>
                                            </TouchableOpacity>
                                        )}
                                        <TouchableOpacity style={styles.bigActionBtn} onPress={() => void openInvite()} activeOpacity={0.7}>
                                            <Ionicons name="person-add" size={24} color={colors.primary} />
                                            <Text style={styles.bigActionTitle}>{t('basketDetail.inviteTitle')}</Text>
                                            <Text style={styles.bigActionSub}>{t('basketDetail.inviteSub')}</Text>
                                        </TouchableOpacity>
                                    </View>
                                    {/* Settings section. */}
                                    <TouchableOpacity style={styles.sheetRow} onPress={() => router.push('/settings' as any)}>
                                        <Ionicons name="settings-outline" size={20} color={colors.primary} />
                                        <Text style={[styles.sheetRowText, { flex: 1 }]}>{t('basketDetail.settings')}</Text>
                                        <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
                                    </TouchableOpacity>
                                    <View style={styles.sectionSep} />
                                    <TouchableOpacity style={styles.sheetRow} onPress={removeBasket}>
                                        <Text style={[styles.sheetRowTextRegular, { color: colors.error }]}>{t('basketDetail.removeBasket')}</Text>
                                    </TouchableOpacity>
                                </View>
                            ),
                        } : undefined}
                    />
                )}

                {/* Trip invite QR. */}
                <Modal visible={inviteOpen} transparent animationType="fade" onRequestClose={() => setInviteOpen(false)}>
                    <TouchableOpacity style={styles.qrBackdrop} activeOpacity={1} onPress={() => setInviteOpen(false)}>
                        <View style={styles.qrCard} onStartShouldSetResponder={() => true}>
                            <Text style={styles.sheetRowText}>{t('trips.tripQrTitle')}</Text>
                            {inviteUrl
                                ? <BrandedQR value={inviteUrl} size={200} />
                                : <MaterialProgress size="large" color={colors.primary} />}
                            {inviteUrl && (
                                <TouchableOpacity
                                    style={styles.storesPill}
                                    onPress={() => { void Share.share({ message: inviteUrl }); }}
                                >
                                    <Ionicons name="share-outline" size={18} color={colors.onPrimary} />
                                    <Text style={styles.storesPillText}>{t('basketDetail.shareLink')}</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    </TouchableOpacity>
                </Modal>

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
                        <MaterialProgress size="large" color={colors.primary} />
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
        borderRadius: radius.lg,
    },
    errorBannerText: {
        flex: 1,
        fontSize: 13,
        color: c.error,
    },
    // Action row inside the floating glass bar-sheet (the sheet owns the
    // surface, pill and radii — this is just the row layout).
    barRow: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, paddingHorizontal: 4,
    },
    addMoreBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 6 },
    addMoreText: { fontSize: 15, fontWeight: '700', color: c.primary },
    storesPill: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
        backgroundColor: c.primary, borderRadius: radius.pill,
        paddingHorizontal: 20, paddingVertical: 10,
    },
    storesPillText: { fontSize: 15, fontWeight: '700', color: c.onPrimary },
    itemRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 10 },
    itemImage: { width: 56, height: 56, borderRadius: 8, backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
    itemName: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    itemActionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    itemQtyText: { fontSize: 14, fontWeight: '600', color: c.textSecondary },
    itemStepper: { alignSelf: 'flex-start', minWidth: 150 },
    // Separator: from the title start (past the image) to the trash end.
    rowSep: { height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: 56 + 12 },
    sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
    bigBtnRow: { flexDirection: 'row', gap: 12, marginBottom: 4 },
    bigActionBtn: {
        flex: 1, alignItems: 'flex-start', gap: 2,
        backgroundColor: c.surfaceMuted, borderRadius: radius.lg,
        paddingHorizontal: 14, paddingVertical: 14,
    },
    bigActionTitle: { fontSize: 16, fontWeight: '700', color: c.textPrimary, marginTop: 6 },
    bigActionSub: { fontSize: 12, fontWeight: '500', color: c.textSecondary },
    sheetRowText: { fontSize: 15, fontWeight: '600', color: c.textPrimary },
    sheetRowTextRegular: { fontSize: 15, fontWeight: '400' },
    sheetTitle: { fontSize: 22, fontWeight: '700', color: c.textPrimary, paddingBottom: 12 },
    sectionSep: { height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginVertical: 4 },
    qrBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
    qrCard: { backgroundColor: c.cardBackground, borderRadius: radius.xl, padding: 24, alignItems: 'center', gap: 16 },
    sheetPanelContent: {
        paddingHorizontal: 16,
        paddingBottom: 8,
    },
    showResultsButton: {
        flex: 1,
        backgroundColor: c.primary,
        borderRadius: radius.pill,
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
        borderRadius: radius.lg,
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
        borderRadius: radius.pill,
        backgroundColor: c.primary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    settingsBadgeText: {
        fontSize: 10,
        fontWeight: '700',
        color: c.onPrimary,
    },
    // "!" — route mode with a missing endpoint (find is disabled until fixed).
    settingsBadgeAlert: {
        backgroundColor: c.error,
    },
    buttonDisabled: {
        opacity: 0.45,
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
        borderRadius: radius.xl,
        paddingHorizontal: 32,
        paddingVertical: 28,
        alignItems: 'center',
        gap: 10,
        minWidth: 220,
        ...elevation.level3,
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
