import {
    View,
    Text,
    FlatList,
    TouchableOpacity,
    StyleSheet,
    Alert,
    RefreshControl,
    Switch,
    Linking,
    BackHandler,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import Animated from 'react-native-reanimated';
import { useCollapsingHeader, CollapsingHeader } from '../../components/CollapsingHeader';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, radius, elevation, spacing, DIVIDER_ITEM_HEIGHT, type AppTheme } from '../../constants/theme';
import { AddOrStepper } from '../../components/AddOrStepper';
import { TemplateCoverEditor } from '../../components/TemplateCoverEditor';
import { coverEmoji } from '../../utils/templateCover';
import { inkOn } from '../../utils/contrastColor';
import { isWeighableDisplay } from '../../utils/weighable';
import { formatItemAmount } from '../../utils/amountDisplay';
import { formatEuro } from '../../utils/formatCurrency';
import { GlassIconButton } from '../../components/GlassIconButton';
import { GlassSheet } from '../../components/GlassSheet';
import { SheetCloseButton } from '../../components/SheetCloseButton';
import { ProductImage } from '../../components/ProductImage';
import { SkeletonBox } from '../../components/SkeletonBox';
import { ScalePressable } from '../../components/ScalePressable';
import { DockedGlassSheet, type DockedSheetControls } from '../../components/DockedGlassSheet';
import { DockActionRow } from '../../components/dock/DockActionRow';
import { DockSection } from '../../components/dock/DockSection';
import { SHEET_CARD_SHADOW_RADIUS } from '../../components/SheetCard';
import { TemplateSharePane } from '../../components/TemplateSharePane';
import { PublishWallModal } from '../../components/PublishWallModal';
import { ConfirmModal } from '../../components/ConfirmModal';
import { StatsHelpModal } from '../../components/StatsHelpModal';
import { authedFetch } from '../../utils/authApi';
import { useTemplateShop } from '../../hooks/useTemplateShop';
import { useAuthState, DEV_SESSION_TOKEN } from '../../state/authState';
import { useBasketSession } from '../../state/basketSession';
import { useTemplateAddState } from '../../state/templateAddState';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import {
    getTemplate,
    patchTemplate,
    deleteTemplate as deleteTemplateApi,
    duplicateTemplate,
    patchTemplateItem,
    deleteTemplateItem,
    type BasketTemplateDetail,
} from '../../utils/basketTemplatesApi';

/** Result of a visibility change: ok = applied; wall = publish wall opened;
 *  dev = blocked because the DEV fake token can't publish; error = other. */
type VisResult = 'ok' | 'wall' | 'dev' | 'error';

export default function TemplateDetailScreen() {
    const colors = useTheme();
    const header = useCollapsingHeader();
    const { t } = useTranslation();
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { id: rawId } = useLocalSearchParams<{ id: string }>();
    const templateId = Number(rawId);

    const [template, setTemplate] = useState<BasketTemplateDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);

    // The bottom dock: bar row collapsed, actions sheet expanded. Its measured
    // bar height feeds the detents and its collapsed clearance pads the list, so
    // the last item is never stranded under the floating bar.
    const sheetRef = useRef<DockedSheetControls>(null);
    const [barRowH, setBarRowH] = useState(44);
    const [dockClearance, setDockClearance] = useState(120);

    // Share = an IN-SHEET pane (dock content swap), not a modal — the map
    // dock's Pakviesti already navigates this way, and the recipe dock must
    // not be the one sheet that throws a modal on top of itself instead.
    const [sharePane, setSharePane] = useState(false);
    // Mirror of the dock's stage, so hardware back can peel ONE layer at a
    // time (share pane → expanded sheet → default navigation) — the map
    // surface's invite-pane back model.
    const [dockExpanded, setDockExpanded] = useState(false);
    const [publishWallOpen, setPublishWallOpen] = useState(false);
    const [coverEditorOpen, setCoverEditorOpen] = useState(false);
    // Creator stats (Statistika) — used to be a second tab that swapped the
    // whole body out; now a glass sheet raised from the nav-bar stats icon, so
    // the items list never leaves the screen. Same tiles, same data.
    const [statsOpen, setStatsOpen] = useState(false);

    const authedUser = useAuthState(s => s.user);

    const setVisibility = useCallback(async (target: 'private' | 'unlisted' | 'public'): Promise<VisResult> => {
        if (!template) return 'error';
        if (target === template.visibility) return 'ok';
        try {
            // X-User-Id authorises ownership even when the Bearer isn't a real
            // server session (e.g. the DEV quick-login's fake token); the
            // public upgrade still needs a genuine verified user server-side.
            const ownerId = await getUserId();
            const res = await authedFetch(`${API_BASE_URL}/api/basket-templates/${template.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'X-User-Id': ownerId },
                body: JSON.stringify({ visibility: target }),
            });
            if (res.status === 401 || res.status === 412) {
                // Publish wall: server needs auth + username for 'public'. BUT if
                // the user already has a token + handle, the wall would just
                // auto-complete → retry → fail → reopen forever. Report instead.
                // The DEV quick-login uses a fake token the server rejects — call
                // that out specifically so dev testing isn't confusing.
                const auth = useAuthState.getState();
                if (auth.token && auth.user?.username) {
                    return auth.token === DEV_SESSION_TOKEN ? 'dev' : 'error';
                }
                // The wall is the ONLY RN Modal in this flow now (the share
                // pane lives inside the dock, not a second Modal), so the old
                // two-stacked-Modals Android flicker can't happen — the pane
                // stays put behind the wall and is right there on success.
                setPublishWallOpen(true);
                return 'wall';
            }
            if (!res.ok) return 'error';
            const data = await res.json();
            setTemplate(prev => prev ? { ...prev, visibility: data.visibility ?? target } : prev);
            return 'ok';
        } catch {
            return 'error';
        }
    }, [template]);

    // After OAuth + username flow completes, retry the 'public' upgrade and
    // re-raise the share pane so the now-public QR/link is right there.
    const handlePublishWallComplete = useCallback(async () => {
        setPublishWallOpen(false);
        if (template && template.visibility !== 'public') {
            const r = await setVisibility('public');
            if (r === 'ok') { setSharePane(true); sheetRef.current?.snapTo(2); }
        }
    }, [template, setVisibility]);

    /**
     * Dalintis → swap the dock's CONTENT to the share pane and raise the
     * sheet to full, exactly like the map dock's Pakviesti. The dock must NOT
     * collapse: the tap is a navigation WITHIN the sheet, and collapsing first
     * (the old modal flow) read as the sheet dismissing itself.
     */
    const openSharePane = useCallback(() => {
        setSharePane(true);
        sheetRef.current?.snapTo(2);
    }, []);

    // Hardware back peels ONE layer: share pane → expanded sheet → (default
    // navigation). Registered only while a layer is open so normal back is
    // untouched otherwise — same shape as the map surface's invite pane.
    useEffect(() => {
        if (!sharePane && !dockExpanded) return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            if (sharePane) { setSharePane(false); return true; }
            if (dockExpanded) { sheetRef.current?.collapse(); return true; }
            return false;
        });
        return () => sub.remove();
    }, [sharePane, dockExpanded]);

    // ── Data load ─────────────────────────────────────────────────────────
    const fetchTemplate = useCallback(async (silent: boolean) => {
        if (!Number.isFinite(templateId)) return;
        if (!silent) setLoading(true);
        try {
            const data = await getTemplate(templateId);
            setTemplate(data);
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorLoad'));
        } finally {
            setLoading(false);
        }
    }, [templateId, t]);

    useFocusEffect(useCallback(() => { fetchTemplate(false); }, [fetchTemplate]));

    // ── Item quantity ─────────────────────────────────────────────────────
    const setQty = useCallback(async (itemId: number, raw: number) => {
        if (!template) return;
        const item = template.items.find(it => it.id === itemId);
        // Round to integer for piece-counted items, 2 decimal places for
        // weighable — the AmountPickerModal legitimately hands back 0.25 kg,
        // which the old 1-decimal rounding (a TextInput-era rule) corrupted
        // to 0.3. Mirrors basket detail's updateQuantity for the same class.
        const isWeighable = isWeighableDisplay(item?.isWeighable, item?.quantity ?? raw);
        let rounded = isWeighable
            ? Math.round(raw * 100) / 100
            : Math.round(raw);
        const next = Math.max(0, Math.min(9999, rounded));
        if (next <= 0) {
            await removeItem(itemId);
            return;
        }
        setTemplate(prev => prev ? {
            ...prev,
            items: prev.items.map(it => it.id === itemId ? { ...it, quantity: String(next) } : it),
        } : prev);
        try {
            await patchTemplateItem(template.id, itemId, { quantity: next });
        } catch {
            // Reload on error so we don't end up with a phantom quantity.
            fetchTemplate(true);
        }
    }, [template, fetchTemplate]);

    const removeItem = useCallback(async (itemId: number) => {
        if (!template) return;
        setTemplate(prev => prev ? {
            ...prev,
            items: prev.items.filter(it => it.id !== itemId),
        } : prev);
        try {
            await deleteTemplateItem(template.id, itemId);
        } catch {
            fetchTemplate(true);
        }
    }, [template, fetchTemplate]);

    // ── Delete template ───────────────────────────────────────────────────
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [statsHelpOpen, setStatsHelpOpen] = useState(false);
    const confirmDelete = useCallback(() => {
        if (!template) return;
        setDeleteOpen(true);
    }, [template]);
    const handleDelete = useCallback(async () => {
        if (!template || deleting) return;
        try {
            setDeleting(true);
            await deleteTemplateApi(template.id);
            setDeleteOpen(false);
            router.back();
        } catch {
            setDeleting(false);
            setDeleteOpen(false);
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorDelete'));
        }
    }, [template, deleting, router, t]);

    // ── Instantiate ───────────────────────────────────────────────────────
    /**
     * "Parduotuvės ›" = the shared recipe → shopping-basket flow
     * (hooks/useTemplateShop): pantry keep-or-drop, instantiate with the
     * resume-or-new choice, then the silent comparison. Only the landings are
     * this screen's: `router.replace` keeps the half-finished flow off the
     * stack — back from the map lands where the recipe was opened from
     * (Receptai). The catalog session bar runs the SAME hook with its own
     * landings (an explicit Shopping-tab stack).
     */
    const shop = useTemplateShop({
        // The live copy this screen is editing — the pill is disabled until it
        // has loaded, so the throw is a can't-happen guard, not a user path.
        getDetail: async () => {
            if (!template) throw new Error('template not loaded');
            return template;
        },
        nav: {
            onCompared: (basketId) => router.replace(`/basket/results/${basketId}` as any),
            // The calc failed after creation — the basket screen's own
            // "Rasti parduotuves" button is the retry.
            onCalcFailed: (basketId) => router.replace(`/basket/${basketId}` as any),
            onResume: (basketId) => router.replace(`/basket/${basketId}` as any),
        },
    });

    /**
     * Build the recipe through the normal Catalog: point the session at this
     * template, then drop into the tab — adds land in the template via
     * addProductToBasket's target branch. The dock bar's "Pridėti prekes" is
     * the ONLY entry point (the top-of-screen dashed row is gone — one action,
     * one affordance).
     */
    const startAddingItems = useCallback(() => {
        if (!template) return;
        useTemplateAddState.getState().hydrate(template.id);
        useBasketSession.getState().setTarget({ kind: 'template', templateId: template.id, name: template.name });
        /**
         * Leave WITHOUT a pop transition — this is the grey/white-tint fix; do
         * not "simplify" it back to a plain navigate.
         *
         * router.navigate here is a root-stack POP that runs CONCURRENTLY with
         * a tab switch (Receptai → Katalogas) and the catalog's freezeOnBlur
         * unfreeze, with the session sheet mounting its glass dock in the same
         * frames. Under that load the pop's native close transition is
         * interrupted mid-flight and the REVEALED root (tabs) screen is
         * stranded at partial alpha — a wash over EVERY screen inside the tab
         * group (device-probe confirmed: the wash sampled as the root
         * backdrop bleeding through the semi-transparent tab container).
         *
         * A runtime navigation.setOptions({ animation: 'none' }) did NOT
         * survive into the native pop transaction (the on-device wash matched
         * the DEFAULT close tween cancelled mid-flight), so the 'none' now
         * travels through the STATIC screen options instead: leaveInstant
         * flips app/_layout.tsx's template/[id] declaration to
         * animation:'none', React commits that options render THIS frame, and
         * the one-frame-deferred navigate pops on the next — by which point
         * the native screen's stackAnimation prop is already 'none'. Android
         * maps 'none' to a 1→1 alpha tween, so even an interrupted commit
         * cannot strand a wash. The flag resets in this screen's unmount
         * cleanup, so the ordinary push into a recipe keeps the platform
         * animation. The user reads the switch as a mode change (recipe →
         * catalog picking), where an instant cut is fine.
         */
        useTemplateAddState.getState().setLeaveInstant(true);
        requestAnimationFrame(() => router.navigate('/(tabs)/catalog' as any));
    }, [template, router]);

    // Reset the instant-leave flag once this screen is actually GONE: the
    // unmount happens in the same commit as the root-stack pop, and the
    // native transaction is created from that commit's props, so restoring
    // the default here cannot re-animate the leave — it only hands the NEXT
    // recipe push its ordinary platform transition back. Also covers the
    // normal back-pop (no-op — the flag is already false).
    useEffect(() => () => useTemplateAddState.getState().setLeaveInstant(false), []);

    /** The recipe's cupboard staples (isPantry = 1), in list order. Feeds BOTH
     *  the keep-or-drop sheet at basket creation (unchanged) and the bordered
     *  "Įprastos prekės" section at the bottom of the item list — the flag's
     *  meaning at creation time is untouched; only the grouping is visual. */
    const pantryItems = useMemo(
        () => (template?.items ?? []).filter(it => Number(it.isPantry) === 1),
        [template],
    );
    /** Everything else — the main list renders only these; staples live in
     *  their own section AFTER them, so the recipe reads ingredients-first. */
    const regularItems = useMemo(
        () => (template?.items ?? []).filter(it => Number(it.isPantry) !== 1),
        [template],
    );

    // ── Copy (duplicate into an editable template) ────────────────────────
    const [duplicating, setDuplicating] = useState(false);
    const handleDuplicate = useCallback(async () => {
        if (!template || duplicating) return;
        try {
            setDuplicating(true);
            const dup = await duplicateTemplate(template.id);
            router.replace(`/template/${dup.id}` as any);
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorSave'));
            setDuplicating(false);
        }
    }, [template, duplicating, router, t]);

    // ── Learning switch (default template only) = autoUpdate ──────────────
    const toggleLearning = useCallback(async (value: boolean) => {
        if (!template) return;
        setTemplate(prev => prev ? { ...prev, autoUpdate: value ? 1 : 0 } : prev);
        try {
            await patchTemplate(template.id, { autoUpdate: value });
        } catch {
            setTemplate(prev => prev ? { ...prev, autoUpdate: value ? 0 : 1 } : prev);
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorSave'));
        }
    }, [template, t]);

    // ── Skeleton ──────────────────────────────────────────────────────────
    // Mirrors the LOADED layout (the product-detail skeleton's approach: real
    // containers — styles.card, styles.titleRow — holding SkeletonBox
    // placeholders shaped like the content), so the data arriving is a
    // fill-in, not a re-layout: cover band (emoji chip + title), the item
    // cards (image · name · stepper pill), and the floating dock bar.
    if (loading || !template) {
        return (
            <>
                {/* Same chrome as the loaded branch (the standard custom bar,
                    native header hidden) on the neutral card colour — the cover
                    colour isn't known yet, and swapping bar TYPES on load would
                    re-layout the whole screen instead of just tinting the bar. */}
                <CollapsingHeader controller={header} background={colors.cardBackground} back />
                <View style={styles.container}>
                    <View style={styles.list}>
                        {/* Title band: emoji chip + a name-width bar. */}
                        <View style={styles.titleRow}>
                            <SkeletonBox width={34} height={34} borderRadius={10} />
                            <SkeletonBox width={210} height={20} borderRadius={7} />
                        </View>
                        {/* Item cards: image square, two-line name, stepper pill. */}
                        {Array.from({ length: 6 }).map((_, i) => (
                            <View key={i} style={styles.card}>
                                <SkeletonBox width={44} height={44} borderRadius={radius.md} />
                                <View style={styles.cardContent}>
                                    <SkeletonBox width="75%" height={13} borderRadius={5} />
                                    <SkeletonBox width={150} height={30} borderRadius={radius.pill} />
                                </View>
                            </View>
                        ))}
                    </View>
                    {/* The dock's collapsed bar: same float margins/height as the
                        real DockedGlassSheet (26 ≈ its COLLAPSED_MARGIN, 72 =
                        bar row + peeks), holding the two bar affordances. */}
                    <View style={styles.skeletonDock}>
                        <SkeletonBox width={130} height={16} borderRadius={7} />
                        <SkeletonBox width={140} height={38} borderRadius={radius.pill} />
                    </View>
                </View>
            </>
        );
    }

    // The auto "default" template is read-only: no rename/cover/share/edit/
    // delete — only use (create basket), copy, and the learning switch. Its
    // name is always the branded "Smart template", regardless of the stored
    // value (older defaults were created as "Pirkinių sąrašas").
    const isDefault = template.isDefault === 1;
    const titleText = isDefault
        ? t('basketTab.templates.smartName')
        : (template.name || t('basketTab.templates.fallbackName'));
    // Colour the nav bar with the template's cover colour; text/icons flip to
    // white for contrast. Falls back to the neutral header when no cover set.
    const headerColor = template.coverColor ?? colors.cardBackground;
    // Ink is CHOSEN against the cover, not assumed white. The palette's amber
    // (#F0AE3F) gives white text a 1.94:1 contrast ratio — below WCAG's 3:1 floor
    // even for large text — which is why a yellow cover's title was unreadable.
    // The dark ink is the FIXED near-black, not colors.textPrimary: the cover
    // colour never changes with the theme, but textPrimary flips to white in
    // dark mode — which handed amber covers white-on-yellow "dark" ink.
    // onCover is ONLY for elements sitting on the cover-coloured bar (the
    // CollapsingHeader titleColor); the body title sits on the page background
    // and takes textPrimary.
    const onCover = template.coverColor
        ? inkOn(template.coverColor)
        : colors.textPrimary;
    const headerEmoji = coverEmoji(template.coverImage) ?? '🫜';

    /**
     * The page a recipe was imported FROM.
     *
     * `BasketTemplate.sourceUrl`/`sourceSite` are real columns now, written by
     * the import flow — so this reads the row instead of the hardcoded null that
     * stood here while the server had nowhere to put the address. A hand-made
     * recipe still has none, which is what keeps the Svetainė card disabled
     * for those; the layout stays honest either way.
     *
     * `sourceSite` is stored alongside the URL so the byline needs no parsing,
     * but it is derived here as a fallback for rows written before that column.
     */
    const sourceUrl: string | null = template.sourceUrl ?? null;
    const sourceSite = template.sourceSite ?? (() => {
        if (!sourceUrl) return null;
        try { return new URL(sourceUrl).hostname.replace(/^www\./, ''); } catch { return null; }
    })();
    const openSource = (url: string | null) => { if (url) Linking.openURL(url).catch(() => {}); };

    // An EMPTY recipe cannot become a basket — a basket with nothing in it has
    // nothing to compare — so the shopping action stays dead until it has items.
    const canShop = template.items.length > 0;

    // ONE item-card renderer for both the main list and the staples section
    // below it — the pantry rows must be the same card, just grouped, so the
    // markup cannot drift between the two placements.
    const renderItemCard = (item: BasketTemplateDetail['items'][number]) => {
        const qty = Number(item.quantity) || 0;
        return (
            <View style={styles.card}>
                <ProductImage
                    uris={item.imageUrls}
                    imageStyle={styles.productImage}
                    placeholderStyle={styles.productImagePlaceholder}
                    emojiStyle={styles.productImageEmoji}
                />
                <View style={styles.cardContent}>
                    <Text style={styles.itemName} numberOfLines={2}>{item.productName}</Text>
                    {isDefault ? (
                        // The auto template is read-only — same static
                        // amount string basket detail's locked rows use.
                        <Text style={styles.readonlyQty}>
                            {formatItemAmount({ quantity: qty, isWeighable: item.isWeighable, unit: item.unit }, t)}
                        </Text>
                    ) : (
                        // THE app-wide "Add ⇄ stepper" control (basket
                        // detail, product card/detail, search, discounts)
                        // — the recipe editor must not be the one screen
                        // with a bespoke quantity UI. The API's template
                        // items don't carry canonicalUnit/Step/Family
                        // (getTemplateItems selects bti.* + derived
                        // isWeighable only), so `isWeighable` alone
                        // drives the weight-vs-count decision — signal
                        // #2 in utils/amountDisplay's priority order.
                        <AddOrStepper
                            product={{
                                id: item.productId,
                                name: item.productName,
                                isWeighable: Number(item.isWeighable) === 1,
                                unit: item.unit,
                            }}
                            quantity={qty}
                            onCommit={(next) => {
                                if (next <= 0) { void removeItem(item.id); return; }
                                void setQty(item.id, next);
                            }}
                            style={styles.itemStepper}
                        />
                    )}
                </View>
                {!isDefault && (
                    <TouchableOpacity style={styles.removeButton} onPress={() => removeItem(item.id)}>
                        <Ionicons name="trash-outline" size={20} color={colors.error} />
                    </TouchableOpacity>
                )}
            </View>
        );
    };

    return (
        <>
            {/* Unified header — the STANDARD CollapsingHeader custom bar
                (native header hidden), the same hosting shape as basket detail
                and every other DockedGlassSheet screen: the dock's full detent
                spans the window up to the status bar, and only in-screen chrome
                can be covered by it (a native bar lives in the navigator's own
                container, where screen content can never paint over it).
                Cover-coloured bar carrying back and the stats icon (creator
                recipes); the collapsed title fades in only once the body title
                scrolls under the bar — the component's own measured-title rule,
                fed by header.onTitleLayout on the title row, so a two-line
                cover title fades the bar copy in later. `titleColor` flips the
                title ink WHITE-or-dark by the COVER's contrast (it sits on the
                cover-coloured bar, unlike the body title below, which sits on
                the page). The back chevron keeps the component default — ALWAYS
                the app pink inside its own circle, never the cover ink, which
                handed it white-on-white on pink covers. The actions live in the
                bottom dock — glass pills on a coloured bar wash out into empty
                white outlines. */}
            <CollapsingHeader
                controller={header}
                background={headerColor}
                titleColor={onCover}
                back
                smallTitle={titleText}
                // Creator stats — shown exactly where the Stats tab used to be
                // (signed-in, non-default recipes); raises the glass sheet.
                right={authedUser && !isDefault
                    ? (
                        <GlassIconButton
                            icon="stats-chart-outline"
                            onPress={() => setStatsOpen(true)}
                            accessibilityLabel={t('basketTab.templates.tabStats')}
                        />
                    )
                    : undefined}
            />

            <View style={styles.container}>
                <Animated.FlatList
                    {...header.scroll}
                    style={{ flex: 1 }}
                    // Staples (isPantry) are pulled OUT of the main list and
                    // grouped in their own section after it (ListFooter below).
                    data={regularItems}
                    keyExtractor={(item: any) => `i-${item.id}`}
                    contentContainerStyle={[styles.list, { paddingTop: 0, paddingBottom: dockClearance + 28 }]}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={async () => { setRefreshing(true); await fetchTemplate(true); setRefreshing(false); }}
                            colors={[colors.primary]}
                            tintColor={colors.primary}
                        />
                    }
                    ListHeaderComponent={
                        <>
                        {/* The body title sits on the PAGE background (it scrolls
                            with the list), so it takes textPrimary — onCover here
                            painted it white-on-cream whenever the cover was pink
                            (white passes on pink, and the ink followed the cover
                            instead of the surface it actually sits on). Same for
                            the emoji chip: the translucent-white fill was designed
                            for a coloured band it no longer sits on. */}
                        {<TouchableOpacity
                        onPress={isDefault ? undefined : () => setCoverEditorOpen(true)}
                        activeOpacity={isDefault ? 1 : 0.7}
                        disabled={isDefault}
                        style={styles.titleRow}
                        // Feeds the bar-title fade threshold — a two-line title
                        // fades the bar copy in later (CollapsingHeader measures
                        // this row via the controller).
                        onLayout={header.onTitleLayout}
                    >
                        <View style={[styles.titleEmoji, {
                            backgroundColor: colors.surfaceMuted ?? colors.cardBackground,
                        }]}>
                            {isDefault
                                ? <Ionicons name="sparkles" size={20} color={colors.primary} />
                                : <Text style={{ fontSize: 20 }}>{headerEmoji}</Text>}
                        </View>
                        <Text style={[styles.titleText, { color: colors.textPrimary }]} numberOfLines={2}>
                            {titleText}
                        </Text>
                    </TouchableOpacity>}
                        {/* No top-of-screen add button: the dock's "Pridėti prekes"
                            is THE entry point for adding — two affordances for the
                            same action had one of them (this one) pushing the list
                            down on every recipe. */}
                        {isDefault && (
                            <View style={styles.settingRow}>
                                <View style={{ flex: 1, marginRight: 12 }}>
                                    <Text style={styles.settingLabel}>{t('basketTab.templates.learnLabel')}</Text>
                                    <Text style={styles.settingHint}>{t('basketTab.templates.learnHint')}</Text>
                                </View>
                                <Switch
                                    value={template.autoUpdate === 1}
                                    onValueChange={toggleLearning}
                                    trackColor={{ false: colors.border, true: colors.primary }}
                                    thumbColor={colors.onPrimary}
                                />
                            </View>
                        )}
                        </>
                    }
                    // Only a truly item-less recipe shows the empty state — an
                    // all-staples recipe has an empty MAIN list but real items
                    // in the section below, and "no items yet" would be a lie.
                    ListEmptyComponent={template.items.length === 0 ? (
                        <View style={styles.centered}>
                            <Ionicons name="albums-outline" size={56} color={colors.textMuted} />
                            <Text style={styles.emptyText}>{t('basketTab.templates.emptyItemsTitle')}</Text>
                            <Text style={styles.emptySubText}>{t('basketTab.templates.emptyItemsBody')}</Text>
                        </View>
                    ) : null}
                    renderItem={({ item }) => renderItemCard(item)}
                    // The cupboard staples, grouped AFTER the ingredients in a
                    // pink-bordered section of the same item cards. Display
                    // only: the flag still drives the keep-or-drop choice at
                    // basket creation (pantryItems feeds that sheet unchanged).
                    ListFooterComponent={pantryItems.length > 0 ? (
                        <View style={styles.pantrySection}>
                            <View style={styles.pantrySectionHeader}>
                                <Ionicons name="home-outline" size={15} color={colors.primary} />
                                <Text style={styles.pantrySectionTitle}>
                                    {t('basketTab.templates.commonSection')}
                                </Text>
                            </View>
                            {pantryItems.map(it => (
                                <View key={`p-${it.id}`}>{renderItemCard(it)}</View>
                            ))}
                        </View>
                    ) : null}
                />

                {/* Bottom dock — the recipe's actions, mirroring basket detail:
                    collapsed it is a bar (add items · Parduotuvės), swiped up it
                    is the sheet that took over from the nav bar's glass pills. */}
                <DockedGlassSheet
                    ref={sheetRef}
                    colors={colors}
                    onCollapsedClearance={setDockClearance}
                    barRowHeight={barRowH}
                    // The bar row RIDES THE SHEET'S TOP EDGE as it expands — the
                    // catalog list sheet's layout. Without this the dock ran the
                    // default Find-My layout: the glass grew ABOVE a bottom-pinned
                    // bar, so on a drag the sheet CONTENT travelled with the top
                    // edge while "+ Pridėti prekes"/"Parduotuvės" sat still — the
                    // wrong row moved with the sheet.
                    barAtTop
                    barRow={
                        <View
                            style={styles.barRow}
                            onLayout={e => { const h = Math.round(e.nativeEvent.layout.height); if (h > 0) setBarRowH(h); }}
                        >
                            {/* The auto template is read-only — nothing to add to. */}
                            {!isDefault && (
                                <TouchableOpacity style={styles.addMoreBtn} onPress={startAddingItems} activeOpacity={0.7}>
                                    <Ionicons name="add" size={20} color={colors.primary} />
                                    <Text style={styles.addMoreText}>{t('basketTab.templates.addItemsCta')}</Text>
                                </TouchableOpacity>
                            )}
                            <ScalePressable
                                style={[styles.shopPill, isDefault && { flex: 1 }, (!canShop || shop.busy) && styles.shopPillDisabled]}
                                onPress={shop.start}
                                disabled={!canShop || shop.busy}
                                scaleTo={!canShop || shop.busy ? 1 : 0.95}
                            >
                                {shop.busy
                                    ? <MaterialProgress size="small" color={colors.onPrimary} />
                                    : (
                                        <>
                                            <Text style={styles.shopPillText}>{t('basketTab.templates.storesCta')}</Text>
                                            <Ionicons name="chevron-forward" size={16} color={colors.onPrimary} />
                                        </>
                                    )}
                            </ScalePressable>
                        </View>
                    }
                    sheet={{
                        maxStage: 2,
                        // barAtTop clips content at the sheet's BOTTOM edge (the
                        // screen bottom once docked at full) instead of above a
                        // bottom bar, so the last row needs the safe-area pad —
                        // same contract as the catalog list sheet's content.
                        contentContainerStyle: { paddingTop: spacing.xs, paddingBottom: insets.bottom + spacing.lg },
                        onStageChange: (st) => setDockExpanded(st > 0),
                        // The share pane, in the sheet's own pane contract: it
                        // swaps the TOP ROW to "‹ Dalintis" (replacing the
                        // add/shop action row), page-slides the body, and — via
                        // onDismiss — is cleared by the sheet on every collapse,
                        // so re-expanding the dock always lands on the action
                        // cards, never a stale share view (the collapsed bar
                        // gives no hint one is open). None of that is this
                        // screen's job any more.
                        pane: sharePane ? {
                            key: 'share',
                            // ‹ back · share icon · title — the map invite
                            // pane's header row, so the way back out of the
                            // pane is where the map already taught it.
                            barRow: (
                                <View style={styles.paneHeaderRow}>
                                    <TouchableOpacity
                                        onPress={() => setSharePane(false)}
                                        hitSlop={10}
                                        accessibilityLabel={t('common.back')}
                                    >
                                        <Ionicons name="chevron-back" size={26} color={colors.primary} />
                                    </TouchableOpacity>
                                    <Ionicons name="share-social-outline" size={18} color={colors.primary} />
                                    <Text style={styles.sheetTitle} numberOfLines={1}>
                                        {t('basketTab.templates.shareNative')}
                                    </Text>
                                </View>
                            ),
                            content: (
                                <View style={styles.sheetPanelContent}>
                                    <TemplateSharePane
                                        templateId={template.id}
                                        templateName={template.name}
                                        itemCount={template.items.length}
                                        visibility={template.visibility}
                                        isCreator={!!authedUser?.username}
                                        onSetVisibility={(next) => setVisibility(next)}
                                    />
                                </View>
                            ),
                            onDismiss: () => setSharePane(false),
                        } : null,
                        content: (
                            <View style={styles.sheetPanelContent}>
                                <Text style={styles.sheetTitle}>{t('basketDetail.actionsTitle')}</Text>
                                {/* Svetainė + Dalintis — the map dock's card pair,
                                    verbatim (DockActionRow). Svetainė opens the RECIPE
                                    page, not the site's front page: it is the only way
                                    back to the instructions, and a shopper tapping the
                                    source wants the page they imported, not lamaistas.lt.
                                    A hand-made recipe has no sourceUrl, so the card sits
                                    disabled rather than lying about where it came from. */}
                                <DockActionRow
                                    colors={colors}
                                    gap={14}
                                    actions={[
                                        {
                                            icon: 'globe-outline',
                                            title: t('basketTab.templates.websiteTitle'),
                                            subtitle: sourceSite ?? t('basketTab.templates.sourceUnknown'),
                                            onPress: () => openSource(sourceUrl),
                                            disabled: !sourceUrl,
                                        },
                                        // Share — same card design as the map's Pakviesti,
                                        // and now the same NAVIGATION too: the tap swaps
                                        // the dock's content to the share pane (QR ·
                                        // link · download) and raises the sheet to full.
                                        // The map dock does this for Pakviesti; the
                                        // recipe dock must not be the one sheet that
                                        // collapses itself to throw a modal instead. The
                                        // auto template has no card at all (it was never
                                        // shareable); an empty recipe keeps the card but
                                        // disabled — nothing to share.
                                        !isDefault && {
                                            icon: 'share-social-outline',
                                            title: t('basketTab.templates.shareNative'),
                                            subtitle: t('basketTab.templates.shareCardSub'),
                                            onPress: openSharePane,
                                            disabled: !canShop,
                                        },
                                    ]}
                                />

                                {/* What the nav bar's ellipsis used to hold, under the
                                    same section chrome every dock uses (DockSection —
                                    map dock's Settings, invite roster). Copy is
                                    available for every recipe — it is the only way to
                                    "edit" the auto one; the auto one can't be deleted. */}
                                <DockSection
                                    colors={colors}
                                    icon="settings-outline"
                                    title={t('basketTab.templates.settingsSection')}
                                >
                                    <TouchableOpacity
                                        style={styles.sheetRow}
                                        onPress={() => { sheetRef.current?.collapse(); handleDuplicate(); }}
                                    >
                                        <Text style={[styles.sheetRowText, { color: colors.textPrimary }]}>
                                            {t('basketTab.templates.copyTemplate')}
                                        </Text>
                                    </TouchableOpacity>
                                    {!isDefault && (
                                        <>
                                            <View style={styles.sectionSep} />
                                            <TouchableOpacity
                                                style={styles.sheetRow}
                                                onPress={() => { sheetRef.current?.collapse(); confirmDelete(); }}
                                            >
                                                <Text style={[styles.sheetRowText, { color: colors.error }]}>
                                                    {t('basketTab.templates.deleteConfirm')}
                                                </Text>
                                            </TouchableOpacity>
                                        </>
                                    )}
                                </DockSection>
                            </View>
                        ),
                    }}
                />
            </View>

            <PublishWallModal
                visible={publishWallOpen}
                onClose={() => setPublishWallOpen(false)}
                onComplete={handlePublishWallComplete}
            />

            <ConfirmModal
                visible={deleteOpen}
                title={t('basketTab.templates.deleteTitle')}
                body={template ? t('basketTab.templates.deleteBody', { name: template.name }) : undefined}
                confirmLabel={t('basketTab.templates.deleteConfirm')}
                cancelLabel={t('basketTab.templates.deleteCancel')}
                destructive
                busy={deleting}
                onConfirm={handleDelete}
                onClose={() => setDeleteOpen(false)}
            />

            {/* Statistika — real creator metrics, same tiles the website shows on
                the template card, in the app's glass sheet (autoHeight: four
                tiles, no scroll needed). Only reachable when signed in — the
                nav-bar stats icon is hidden otherwise. The help icon rides the
                sheet's title row so the explainer survived the tab's removal;
                StatsHelpModal is an RN Modal, so it stacks fine over this
                non-Modal sheet (the two-Modal Android flicker doesn't apply). */}
            {statsOpen && (
                <GlassSheet autoHeight onClose={() => setStatsOpen(false)}>
                    {/* GlassSheet's scroll is edge-to-edge — content owns its padding. */}
                    <View style={styles.statsSheetBody}>
                        <View style={styles.statsSheetTitleRow}>
                            <Text style={[styles.sheetTitle, { flex: 1 }]}>{t('basketTab.templates.tabStats')}</Text>
                            <TouchableOpacity
                                onPress={() => setStatsHelpOpen(true)}
                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                            >
                                <Ionicons name="help-circle-outline" size={22} color={colors.textMuted} />
                            </TouchableOpacity>
                            <SheetCloseButton />
                        </View>
                        <View style={styles.metricsGrid}>
                            <View style={styles.metricTile}>
                                <Text style={styles.metricValue}>{Number(template.visitCount ?? 0).toLocaleString('lt-LT')}</Text>
                                <Text style={styles.metricLabel}>{t('basketTab.templates.metricVisits')}</Text>
                            </View>
                            <View style={styles.metricTile}>
                                <Text style={styles.metricValue}>{Number(template.useCount ?? 0).toLocaleString('lt-LT')}</Text>
                                <Text style={styles.metricLabel}>{t('basketTab.templates.metricUses')}</Text>
                            </View>
                            <View style={styles.metricTile}>
                                <Text style={[styles.metricValue, { color: colors.primary }]}>
                                    {formatEuro(Number(template.collectiveSavingsEur ?? 0))}
                                </Text>
                                <Text style={styles.metricLabel}>{t('basketTab.templates.metricSaved')}</Text>
                            </View>
                            <View style={styles.metricTile}>
                                {(() => {
                                    // Same rule as the web: `editedAt` is set only on real
                                    // content edits (name/cover/items) → flips Sukurta → Redaguota.
                                    const tplEdited = !!template.editedAt;
                                    return (
                                        <>
                                            <Text style={styles.metricValue}>
                                                {new Date(tplEdited ? template.editedAt! : template.createdAt).toLocaleDateString('lt-LT')}
                                            </Text>
                                            <Text style={styles.metricLabel}>
                                                {t(tplEdited ? 'basketTab.templates.metricUpdated' : 'basketTab.templates.metricCreated')}
                                            </Text>
                                        </>
                                    );
                                })()}
                            </View>
                        </View>
                    </View>
                </GlassSheet>
            )}

            <StatsHelpModal visible={statsHelpOpen} onClose={() => setStatsHelpOpen(false)} />

            {/* Pantry keep-or-drop + resume-or-new — the shared shop flow's
                modals (hooks/useTemplateShop owns their state and confirm
                wiring; this screen only picks the landings above). */}
            {shop.modals}

            <TemplateCoverEditor
                visible={coverEditorOpen}
                onClose={() => setCoverEditorOpen(false)}
                name={template.name}
                coverColor={template.coverColor}
                coverImage={template.coverImage}
                onSubmit={(next) => {
                    setTemplate(prev => prev ? { ...prev, name: next.name, coverColor: next.coverColor, coverImage: next.coverImage } : prev);
                    patchTemplate(template.id, next).catch(() => {});
                }}
            />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    list: { padding: 12, paddingBottom: 24 },
    centered: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },

    // ── Setting row ───────────────────────────────────────────────────────
    settingRow: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        backgroundColor: c.cardBackground, borderRadius: 12, padding: 14, marginBottom: 12,
    },
    settingLabel: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    settingHint: { fontSize: 12, color: c.textSecondary, marginTop: 2 },

    // ── Title band + collapsed bar title ──────────────────────────────────
    // Title band (emoji + name), scrolls with the list. Sits on the PAGE
    // background — its ink is textPrimary, never the cover's (see render).
    titleRow: {
        flexDirection: 'row', alignItems: 'center', gap: 10,
        paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12,
    },
    titleEmoji: {
        width: 34, height: 34, borderRadius: 10,
        alignItems: 'center', justifyContent: 'center',
    },
    titleText: { flex: 1, fontSize: 18, fontWeight: '700' },

    // ── Statistika sheet — creator metrics ────────────────────────────────
    statsSheetBody: { paddingHorizontal: 16, paddingTop: 4, gap: 14 },
    statsSheetTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    metricsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
    metricTile: {
        width: '47%', flexGrow: 1, backgroundColor: c.cardBackground,
        borderRadius: 16, padding: 16,
    },
    metricValue: { fontSize: 22, fontWeight: '800', color: c.textPrimary },
    metricLabel: { fontSize: 12, color: c.textSecondary, marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600' },
    statsCard: {
        backgroundColor: c.cardBackground, borderRadius: 16, padding: 18,
        gap: 12, borderWidth: 4, borderColor: 'transparent', borderLeftColor: c.primary,
    },
    statsTitle: { fontSize: 18, fontWeight: '700', color: c.textPrimary },
    statsIntro: { fontSize: 14, color: c.textSecondary, lineHeight: 20 },
    statsBulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    statsBulletText: { flex: 1, fontSize: 14, color: c.textPrimary, lineHeight: 20 },
    statsCta: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        backgroundColor: c.primary, paddingVertical: 12, borderRadius: 10,
        marginTop: 8,
    },
    statsCtaText: { fontSize: 14, fontWeight: '700', color: c.onPrimary },
    statsAlready: {
        fontSize: 13, fontWeight: '600', color: c.success,
        textAlign: 'center', marginTop: 8,
    },

    // ── Item card ─────────────────────────────────────────────────────────
    card: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: c.cardBackground, borderRadius: radius.lg,
        padding: 12, marginBottom: 8, gap: 12,
        ...elevation.level1,
    },
    productImage: { width: 44, height: 44, borderRadius: radius.md },
    productImagePlaceholder: {
        width: 44, height: 44, borderRadius: radius.md,
        backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center',
    },
    productImageEmoji: { fontSize: 24, opacity: 0.5 },
    cardContent: { flex: 1, gap: 6 },
    itemName: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    // Cap the stepper's footprint (basket detail's itemStepper, verbatim) —
    // AddOrStepper stretches to its parent otherwise, and a full-width
    // QuantityControl reads as a bar, not a control.
    itemStepper: { alignSelf: 'flex-start', minWidth: 150 },
    readonlyQty: { fontSize: 13, fontWeight: '600', color: c.textSecondary },
    removeButton: { padding: 4 },

    // ── "Įprastos prekės" (cupboard staples) section ──────────────────────
    // A pink-bordered group after the main list, holding the SAME item cards.
    // No section/card component in the app draws a full outlined group on the
    // page body (DockSection is dock-sheet chrome, SheetCard a shadowed
    // surface), so this is a plain bordered View on the app pink. The outer
    // radius is concentric with the cards' radius.lg at 8px padding, and the
    // bottom pad is 0 because the last card's own marginBottom (8) closes the
    // gap — a full pad there doubled it.
    pantrySection: {
        marginTop: 10, marginBottom: 4,
        borderWidth: 1.5, borderColor: c.primary, borderRadius: radius.xl,
        padding: 8, paddingBottom: 0,
    },
    pantrySectionHeader: {
        flexDirection: 'row', alignItems: 'center', gap: 6,
        paddingHorizontal: 6, paddingTop: 2, paddingBottom: 8,
    },
    pantrySectionTitle: {
        fontSize: 13, fontWeight: '800', color: c.primary,
        textTransform: 'uppercase', letterSpacing: 0.5,
    },

    // ── Bottom dock ───────────────────────────────────────────────────────
    // Row layout only — the sheet owns the glass surface, pill and radii.
    barRow: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, paddingHorizontal: 4,
    },
    addMoreBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 6 },
    addMoreText: { fontSize: 15, fontWeight: '700', color: c.primary },
    shopPill: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
        backgroundColor: c.primary, borderRadius: radius.pill,
        paddingHorizontal: 20, paddingVertical: 10,
    },
    shopPillDisabled: { opacity: 0.45 },
    shopPillText: { fontSize: 15, fontWeight: '700', color: c.onPrimary },
    sheetPanelContent: {
        paddingHorizontal: 16,
        // Reserves the cards' shadow halo — the sheet's scroll viewport clips
        // overflow, so a smaller pad cuts the bottom card's shadow off.
        paddingBottom: SHEET_CARD_SHADOW_RADIUS,
        // ONE gap: between the source cards, and between every section below.
        gap: 14,
    },
    sheetTitle: { fontSize: 22, fontWeight: '700', color: c.textPrimary },
    // Share-pane BAR row (‹ back · icon · title) — the map invite pane's row.
    // Lives in the dock's bar slot now (SheetPaneSpec.barRow), replacing the
    // add/shop action row while the pane is open; same side inset as barRow.
    paneHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4 },
    sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
    sheetRowText: { fontSize: 15, fontWeight: '400' },
    sectionSep: { height: DIVIDER_ITEM_HEIGHT, backgroundColor: c.dividerItem },

    // ── Skeleton-only: the collapsed dock's stand-in ──────────────────────
    // Mirrors DockedGlassSheet's collapsed geometry (symmetric 26px float
    // margin, 72px = bar row + 2·peek) as a flat card — no glass, it lives
    // for one load.
    skeletonDock: {
        position: 'absolute', left: 26, right: 26, bottom: 26, height: 72,
        borderRadius: radius.xl, backgroundColor: c.cardBackground,
        borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: 18,
    },

    // ── Empty states ──────────────────────────────────────────────────────
    emptyText: { fontSize: 16, color: c.textSecondary, fontWeight: '600', textAlign: 'center' },
    emptySubText: { fontSize: 13, color: c.textMuted, textAlign: 'center', lineHeight: 18 },
    hintText: { fontSize: 13, color: c.textMuted, textAlign: 'center' },

});
