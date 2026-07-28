import { View, Text, TouchableOpacity, StyleSheet, Image, Alert } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, withDelay, interpolateColor, FadeInDown } from 'react-native-reanimated';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { MaterialProgress } from '@/components/MaterialProgress';
import { AddOrStepper } from '@/components/AddOrStepper';
import { DockedGlassSheet, type DockedSheetControls } from '../DockedGlassSheet';
import { SheetCloseButton } from '../SheetCloseButton';
import { DockActionRow } from '../dock/DockActionRow';
import { ConfirmModal } from '../ConfirmModal';
import { BasketGlyph, ChefToqueGlyph } from '../icons/tabGlyphs';
import { useTheme, useResolvedScheme, radius, spacing, DIVIDER_ITEM_HEIGHT, type AppTheme } from '../../constants/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { API_BASE_URL } from '../../config/api';
import { useBasketSession, targetKey } from '../../state/basketSession';
import { useTemplateAddState } from '../../state/templateAddState';
import { useTemplateShop } from '../../hooks/useTemplateShop';
import { getTemplate, patchTemplateItem, deleteTemplateItem } from '../../utils/basketTemplatesApi';
import { viewSessionTarget, deleteSessionTarget } from '../../utils/sessionTargetActions';

/**
 * BasketListSheet — the ACTIVE-session view ("collecting items"), rendered
 * ONCE at the app root (above the Stack) so it stays pinned and stable while
 * you navigate the shopping flow: Naršyti → L2 → Discounts → Search → Product.
 * A single DockedGlassSheet instance persists across those routes (no remount,
 * no reload). Its collapsed bar is the session header ([X] Prekės: N
 * [Krepšelis ›]); dragging up previews the basket's items (Find-My reveal).
 *
 * The tab-bar dock (BasketDockSheet) only starts sessions (the chooser); once
 * a basket is picked this takes over as the persistent indicator.
 */

// The whole catalog tree (index, browse/L2, discounts, product, search) now
// lives under the Catalog tab, so one prefix covers every session surface. The
// root-level /search (receipt matching) is intentionally excluded.
const ROUTE_PREFIXES = ['/catalog'];
// Product image size — the item separator indents past it (image + gap).
const IMG_W = 56;

interface PreviewItem {
    id: number;
    productId: number;
    quantity: number;
    name: string | null;
    imageUrl: string | null;
    isWeighable: boolean;
    canonicalUnit: string | null;
    canonicalFamily: 'fluid' | 'count' | null;
    canonicalStep: number | null;
}

export function BasketListSheet() {
    const colors = useTheme();
    const isDark = useResolvedScheme() === 'dark';
    const styles = useMemo(() => makeStyles(colors, isDark), [colors, isDark]);
    const { t } = useTranslation();
    const router = useRouter();
    const pathname = usePathname();
    const insets = useSafeAreaInsets();

    const target = useBasketSession(s => s.target);
    const barVisible = useBasketSession(s => s.barVisible);
    const itemCount = useBasketSession(s => s.itemCount);
    const dismissBar = useBasketSession(s => s.dismissBar);
    const setCount = useBasketSession(s => s.setCount);
    const browseListRef = useBasketSession(s => s.browseListRef);
    const basketRev = useBasketSession(s => s.basketRev);
    const setCollapseDock = useBasketSession(s => s.setCollapseDock);
    const newProductIds = useBasketSession(s => s.newProductIds);
    const setSessionBarClearance = useBasketSession(s => s.setSessionBarClearance);

    const onSurface = ROUTE_PREFIXES.some(p => pathname === p || pathname.startsWith(`${p}/`));
    const onTabRoot = pathname === '/catalog';
    const sessionActive = target != null && barVisible;
    const visible = onSurface && sessionActive;

    const controls = useRef<DockedSheetControls | null>(null);

    // Items load only when the BASKET changes — never on navigation, so the
    // sheet stays visually stable as you move between shopping screens.
    const [items, setItems] = useState<PreviewItem[] | null>(null);
    // Long names are single-line (ellipsised); a tap on the name toggles the
    // full multi-line name open/closed.
    const [expandedNames, setExpandedNames] = useState<Set<number>>(new Set());
    const toggleName = useCallback((id: number) => {
        setExpandedNames(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);
    const tKey = target ? targetKey(target) : null;
    const loadItems = useCallback(async () => {
        if (!target) return;
        try {
            let raw: any[];
            if (target.kind === 'pending-new') {
                // Lazy cart: no server row yet — an empty preview.
                raw = [];
            } else if (target.kind === 'template') {
                const tpl = await getTemplate(target.templateId);
                raw = Array.isArray(tpl.items) ? tpl.items : [];
            } else {
                // Self-heal: a basket that graduated to a shopping list
                // (inProgress/completed) or was deleted must stop being the
                // session target — otherwise it keeps painting catalog steppers
                // and this sheet. Clear it and bail.
                const bres = await fetch(`${API_BASE_URL}/api/baskets/${target.basketId}`);
                if (bres.status === 404) { useBasketSession.getState().clearTarget(); setItems([]); setCount(0); return; }
                if (bres.ok) {
                    const b = await bres.json().catch(() => null);
                    if (b?.status === 'inProgress' || b?.status === 'completed') {
                        useBasketSession.getState().clearTarget(); setItems([]); setCount(0); return;
                    }
                }
                const res = await fetch(`${API_BASE_URL}/api/baskets/${target.basketId}/items`);
                const data = await res.json();
                raw = Array.isArray(data) ? data : [];
            }
            const rows: PreviewItem[] = raw.map((it: any) => ({
                id: it.id,
                productId: it.productId,
                quantity: Number(it.quantity) || 1,
                name: it.productName ?? it.name ?? null,
                imageUrl: Array.isArray(it.imageUrls) ? it.imageUrls.find(Boolean) ?? null : null,
                isWeighable: !!it.isWeighable,
                canonicalUnit: it.canonicalUnit ?? null,
                canonicalFamily: it.canonicalFamily ?? null,
                canonicalStep: it.canonicalStep ?? null,
            }));
            setItems(rows);
            setCount(rows.length);
        } catch { setItems([]); }
    }, [target, setCount]);
    useEffect(() => { if (target != null) loadItems(); else setItems(null); }, [tKey]); // eslint-disable-line react-hooks/exhaustive-deps
    // An add from a product/search/L2 "Add" button bumps basketRev — re-fetch so
    // the new item actually appears (the counter alone was updating).
    const firstRev = useRef(basketRev);
    useEffect(() => {
        if (basketRev !== firstRev.current && target != null && visible) loadItems();
        firstRev.current = basketRev;
    }, [basketRev]); // eslint-disable-line react-hooks/exhaustive-deps

    // When the session bar isn't the visible bottom bar, clear its published
    // clearance so screens fall back to the tab-bar clearance.
    useEffect(() => {
        if (!visible) setSessionBarClearance(null);
        return () => setSessionBarClearance(null);
    }, [visible, setSessionBarClearance]);

    // Current detent — at FULL the list behind is covered, so an up-drag on the
    // sheet that hands off to it must NOT collapse (else the sheet closes on
    // drag-up at full); at medium the list is visible so collapse-on-scroll
    // stays valid.
    const stageRef = useRef(0);

    // While the session view owns the bottom, page scrolls collapse it.
    useEffect(() => {
        if (!visible) return;
        setCollapseDock(() => { if (stageRef.current >= 2) return; controls.current?.collapse(); });
        return () => setCollapseDock(null);
    }, [visible, setCollapseDock]);

    // Navigating to a new screen (e.g. tapping a product to open its detail)
    // collapses the sheet so it doesn't cover the destination — the header
    // stays pinned, the expanded list drops away.
    const prevPath = useRef(pathname);
    useEffect(() => {
        if (pathname !== prevPath.current) {
            prevPath.current = pathname;
            controls.current?.collapse();
        }
    }, [pathname]);

    // A freshly-targeted basket stays COLLAPSED (just the bar) — the user picked
    // where the item goes and keeps browsing; they pull the sheet up to review,
    // where this-session adds carry a "New" badge. (Was: auto-expand on pick.)
    const prevBasket = useRef<string | null>(null);
    useEffect(() => {
        if (tKey != null && tKey !== prevBasket.current) {
            prevBasket.current = tKey;
            const id = setTimeout(() => controls.current?.collapse(), 60);
            return () => clearTimeout(id);
        }
        if (tKey == null) prevBasket.current = null;
    }, [tKey]);  

    // Remove the whole line (the trash icon) — from the basket or the template.
    const removeItem = useCallback((item: PreviewItem) => {
        setItems(prev => prev?.filter(i => i.id !== item.id) ?? null);
        useBasketSession.getState().bumpCount(-1);
        const t = useBasketSession.getState().target;
        if (t?.kind === 'template') deleteTemplateItem(t.templateId, item.id).catch(() => {});
        else fetch(`${API_BASE_URL}/api/basket-items/${item.id}`, { method: 'DELETE' }).catch(() => {});
    }, []);

    // Persist a new quantity for a line (AddOrStepper does the canonical
    // stepping; 0 = remove) — basket item PUT or template item PATCH.
    const commitItem = useCallback((item: PreviewItem, qty: number) => {
        if (qty <= 0) { removeItem(item); return; }
        setItems(prev => prev?.map(i => (i.id === item.id ? { ...i, quantity: qty } : i)) ?? null);
        const t = useBasketSession.getState().target;
        if (t?.kind === 'template') {
            patchTemplateItem(t.templateId, item.id, { quantity: qty }).catch(() => {});
        } else {
            fetch(`${API_BASE_URL}/api/basket-items/${item.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quantity: qty }),
            }).catch(() => {});
        }
    }, [removeItem]);

    // Title size: compact in the collapsed bar, screen-title size once the sheet
    // is open. It animates on RELEASE (stage settle), not continuously mid-drag.
    const titleP = useSharedValue(0);
    const titleAnimStyle = useAnimatedStyle(() => ({ fontSize: 16 + 6 * titleP.value }));

    // The bar row height is MEASURED from the header's natural content height
    // (tallest child — currently the 40px X chip), so the dock's collapsed
    // vertical padding stays exactly `peek` — matching the sides — no matter how
    // the buttons or text are resized later.
    const [barH, setBarH] = useState(40);
    const onHeaderLayout = useCallback((e: { nativeEvent: { layout: { height: number } } }) => {
        const h = Math.round(e.nativeEvent.layout.height);
        if (h > 0) setBarH(prev => (prev === h ? prev : h));
    }, []);

    // Add feedback WITHOUT a toast: the count flips in (keyed entering
    // animation) in souply pink and settles back to the regular colour.
    const countFlash = useSharedValue(0);
    const prevCountRef = useRef(itemCount);
    useEffect(() => {
        if (itemCount === prevCountRef.current) return;
        prevCountRef.current = itemCount;
        countFlash.value = 1;
        countFlash.value = withDelay(650, withTiming(0, { duration: 450 }));
    }, [itemCount, countFlash]);
    const countColorStyle = useAnimatedStyle(() => ({
        color: interpolateColor(countFlash.value, [0, 1], [colors.textPrimary, colors.primary]),
    }));

    /**
     * Landing for the template session's "Parduotuvės ›": the recipe just
     * became a real shopping basket, so the collecting session is over — clear
     * the template-add overlay + session target, then build the back-stack
     * EXPLICITLY instead of trusting whatever the tab switch leaves behind:
     * Shopping tab (a tab switch, no stack entry) → the new basket's screen →
     * (when the calc succeeded) the stores map. Back from the map lands on the
     * basket, back again on the Shopping tab — the stack a basket born on the
     * Shopping tab would have had.
     */
    const finishToShopping = useCallback((basketId: number, compared: boolean) => {
        useTemplateAddState.getState().clear();
        useBasketSession.getState().endSession();
        router.navigate('/(tabs)/basket' as any);
        router.push(`/basket/${basketId}` as any);
        if (compared) router.push(`/basket/results/${basketId}` as any);
    }, [router]);

    /**
     * "Parduotuvės ›" while the session targets a RECIPE = the SAME create →
     * compare → map flow as the recipe detail pill (hooks/useTemplateShop —
     * pantry keep-or-drop, resume-or-new, spinner over the whole leg,
     * calc-failure fallback). Only the landings differ: every exit rebuilds
     * the Shopping-tab stack above, because the session surface (catalog) is
     * not where the resulting basket lives.
     */
    const shop = useTemplateShop({
        // Fetched fresh at tap time — the bar only knows the template's id, and
        // this session's adds must be in the basket that gets created.
        getDetail: async () => {
            const tgt = useBasketSession.getState().target;
            if (tgt?.kind !== 'template') throw new Error('no active recipe session');
            return getTemplate(tgt.templateId);
        },
        nav: {
            onCompared: (basketId) => finishToShopping(basketId, true),
            onCalcFailed: (basketId) => finishToShopping(basketId, false),
            onResume: (basketId) => finishToShopping(basketId, false),
        },
    });

    // An EMPTY recipe cannot become a basket (nothing to compare) — the same
    // guard as the recipe detail pill. Basket targets never disable: their
    // button just opens the results map.
    const canShop = target?.kind !== 'template' || itemCount > 0;

    // ── Target-level actions (the two cards above the item list) ─────────
    // `pending-new` has NO server row yet (lazy cart) — nothing to open or
    // delete, so both cards render disabled rather than vanish (a stable row
    // beats a layout jump the moment the first add mints the basket).
    const isTemplate = target?.kind === 'template';
    const isPendingNew = target?.kind === 'pending-new';
    // The target kind, as the cards' subtitle — reuses the existing words.
    // ACCUSATIVE, not nominative: the card reads as one phrase, "Ištrinti
    // krepšelĮ" / "Peržiūrėti receptĄ". The nominative keys reused elsewhere
    // (optionTemplate / createBasketTitle) are wrong as a verb's object in LT.
    const kindLabel = t(isTemplate ? 'basketSession.subjectRecipe' : 'basketSession.subjectBasket');

    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleting, setDeleting] = useState(false);
    // Confirm accepted → delete the TARGET itself (utils/sessionTargetActions
    // owns the teardown: end session + clear overlays + collapse). On failure
    // the session stays intact and the error surfaces like the sibling delete
    // flows (template/[id].tsx handleDelete).
    const doDeleteTarget = useCallback(async () => {
        const tgt = useBasketSession.getState().target;
        if (!tgt || tgt.kind === 'pending-new') return;
        setDeleting(true);
        try {
            await deleteSessionTarget(tgt, () => controls.current?.collapse());
            setDeleteOpen(false);
        } catch {
            setDeleteOpen(false);
            Alert.alert(
                t('basketTab.errorGeneric'),
                t(tgt.kind === 'template' ? 'basketTab.templates.errorDelete' : 'basketSession.deleteBasketError'),
            );
        } finally {
            setDeleting(false);
        }
    }, [t]);

    // "View" opens the target's own screen with an explicit back-stack (its
    // home tab under the detail — the finishToShopping shape). The session
    // stays alive: leaving the catalog hides this sheet, returning resumes it.
    const openTarget = useCallback(() => {
        const tgt = useBasketSession.getState().target;
        if (!tgt || tgt.kind === 'pending-new') return;
        controls.current?.collapse();
        // Adapter: the helper speaks plain path strings; expo-router's typed
        // Href needs the same `as any` every literal route in this file uses.
        viewSessionTarget(tgt, {
            navigate: (p) => router.navigate(p as any),
            push: (p) => router.push(p as any),
        });
    }, [router]);

    const targetActions = (
        <DockActionRow
            colors={colors}
            style={styles.targetActions}
            actions={[
                {
                    icon: 'trash-outline',
                    title: t('basketSession.deleteTitle'),
                    subtitle: kindLabel,
                    disabled: isPendingNew || deleting,
                    onPress: () => setDeleteOpen(true),
                },
                {
                    // The tab bar's own glyph for the kind — the card points at
                    // the tab the target lives on.
                    iconNode: isTemplate
                        ? <ChefToqueGlyph size={24} color={colors.primary} />
                        : <BasketGlyph size={24} color={colors.primary} />,
                    title: t('basketSession.viewTitle'),
                    subtitle: kindLabel,
                    disabled: isPendingNew,
                    onPress: openTarget,
                },
            ]}
        />
    );

    const sessionHeader = (
        <View style={styles.header} onLayout={onHeaderLayout}>
            {/* THE sheet ✕ (SheetCloseButton) — outside a GlassSheet it renders
                the same 40px surfaceMuted chip and falls back to onPress, so the
                session bar's close is the one system-wide close, not a copy. */}
            <SheetCloseButton onPress={dismissBar} />
            <View style={styles.headerTitleRow}>
                <Animated.Text style={[styles.headerText, titleAnimStyle]} numberOfLines={1}>
                    {t('basketSession.itemsLabel')}
                </Animated.Text>
                <Animated.Text
                    key={itemCount}
                    entering={FadeInDown.duration(220)}
                    style={[styles.headerText, titleAnimStyle, countColorStyle]}
                >
                    {' '}{itemCount}
                </Animated.Text>
            </View>
            <TouchableOpacity
                style={[styles.basketBtn, (!canShop || shop.busy) && styles.basketBtnDisabled]}
                disabled={!canShop || shop.busy}
                onPress={() => {
                    if (!target || target.kind === 'pending-new') return;
                    if (target.kind === 'template') {
                        // Parduotuvės › on a recipe session — the shared shop
                        // flow (see `shop` above), NOT a hop back to the recipe
                        // screen: collecting is done, shopping starts.
                        void shop.start();
                        return;
                    }
                    // Stores ›: go STRAIGHT to the store-results map, skipping the
                    // basket-edit screen the trip redirector bounces a still-
                    // forming basket to. The map prices the basket itself when it
                    // has no cached results (StoreResultsSurface.loadResults →
                    // needsCalc) — until that existed this path landed on a map of
                    // bare chain logos with no prices.
                    router.push(`/basket/results/${target.basketId}` as any);
                }}
                activeOpacity={0.85}
            >
                {shop.busy
                    ? <MaterialProgress size="small" color={colors.onPrimary} />
                    : (
                        <>
                            <Text style={styles.basketBtnText}>{t('basketSession.openStores')}</Text>
                            <Ionicons name="chevron-forward" size={14} color={colors.onPrimary} />
                        </>
                    )}
            </TouchableOpacity>
        </View>
    );

    // Bare items — no section card/background, divided by the item separator,
    // pulled up from the bottom under the title as the sheet expands.
    const listContent = (
        items == null ? (
            <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                <MaterialProgress size="large" color={colors.primary} />
            </View>
        ) : items.length === 0 ? (
            <Text style={styles.emptyText}>
                {t(target?.kind === 'template' ? 'basketSession.templateEmpty' : 'basketSession.empty')}
            </Text>
        ) : (
            <View>
                {[...items].sort((a, b) => {
                    const ai = newProductIds.indexOf(a.productId);
                    const bi = newProductIds.indexOf(b.productId);
                    if ((ai >= 0) !== (bi >= 0)) return ai >= 0 ? -1 : 1;
                    if (ai >= 0 && bi >= 0) return bi - ai; // latest add on top
                    return 0;
                }).map((item, i) => (
                    <React.Fragment key={item.id}>
                        {/* Separator only BETWEEN items — none above the first (it sits under the title). */}
                        {i > 0 && <View style={styles.sep} />}
                        <View style={styles.item}>
                            {/* Image left; right column = one-line name, then the
                                stepper + trash on the row the 2nd name line used
                                to occupy. */}
                            {item.imageUrl
                                ? <Image source={{ uri: item.imageUrl }} style={styles.itemImage} />
                                : <View style={[styles.itemImage, styles.itemImageFallback]}><Text style={{ opacity: 0.5 }}>🫜</Text></View>}
                            <View style={styles.itemBody}>
                                <View style={styles.nameRow}>
                                    <Text
                                        style={styles.itemName}
                                        numberOfLines={expandedNames.has(item.id) ? undefined : 1}
                                        onPress={() => toggleName(item.id)}
                                        suppressHighlighting
                                    >
                                        {item.name ?? `#${item.productId}`}
                                    </Text>
                                    {newProductIds.includes(item.productId) && (
                                        <View style={styles.newBadge}>
                                            <Text style={styles.newBadgeText}>{t('basketSession.newBadge')}</Text>
                                        </View>
                                    )}
                                </View>
                                <View style={styles.actionRow}>
                                    <AddOrStepper
                                        product={item}
                                        quantity={item.quantity}
                                        onCommit={(qty) => commitItem(item, qty)}
                                        noPicker
                                        style={styles.stepper}
                                    />
                                    <TouchableOpacity onPress={() => removeItem(item)} hitSlop={8} style={styles.trashBtn}>
                                        <Ionicons name="trash-outline" size={22} color={colors.textMuted} />
                                    </TouchableOpacity>
                                </View>
                            </View>
                        </View>
                    </React.Fragment>
                ))}
            </View>
        )
    );

    if (!visible) return null;

    return (
        <>
        <DockedGlassSheet
            ref={controls}
            colors={colors}
            onCollapsedClearance={setSessionBarClearance}
            barRow={sessionHeader}
            barRowHeight={barH}
            // Title bar at the TOP, rising with the sheet; items revealed below it.
            // (The tab dock renders null while this sheet is visible, so this is
            // the only bottom dock — it carries the normal constant shadow.)
            barAtTop
            blockScrollRef={onTabRoot ? browseListRef : null}
            sheet={{
                // Target-level cards first, then the bare item list.
                content: <>{targetActions}{listContent}</>,
                maxStage: 2,
                // Horizontal inset + shadow room come from the sheet's own
                // SheetContent wrapper — it matches the bar row's inset, so
                // cards and item rows line up with the title row. This style is
                // EXTRAS only (additive): the safe-area clearance at the
                // docked-full bottom edge.
                contentContainerStyle: {
                    paddingBottom: insets.bottom + spacing.lg,
                },
                // Title grows when a drag SETTLES open (stage 1+) and shrinks
                // back when it settles collapsed — animated, but only on release.
                onStageChange: (s) => { stageRef.current = s; titleP.value = withTiming(s > 0 ? 1 : 0, { duration: 200 }); },
            }}
        />
        {/* The shop flow's pantry + resume modals. Only reachable from this
            bar's Parduotuvės pill, so unmounting with the bar (visible=false)
            can never strand an open sheet. */}
        {shop.modals}
        {/* Delete-target confirm — the same souply-styled ConfirmModal (and
            the same wording keys) as the basket-detail / recipe-detail delete
            flows, branched on the target kind. */}
        <ConfirmModal
            visible={deleteOpen}
            title={t(isTemplate ? 'basketTab.templates.deleteTitle' : 'basketDetail.removeTitle')}
            body={isTemplate
                ? (target?.kind === 'template' && target.name
                    ? t('basketTab.templates.deleteBody', { name: target.name })
                    : undefined)
                : t('basketDetail.removeBody')}
            confirmLabel={t(isTemplate ? 'basketTab.templates.deleteConfirm' : 'basketDetail.removeConfirm')}
            cancelLabel={t(isTemplate ? 'basketTab.templates.deleteCancel' : 'common.cancel')}
            destructive
            busy={deleting}
            onConfirm={doDeleteTarget}
            onClose={() => setDeleteOpen(false)}
        />
        </>
    );
}

const makeStyles = (c: AppTheme, isDark: boolean) => StyleSheet.create({
    header: {
        // No padding and no flex — the row keeps its NATURAL content height
        // (measured via onLayout) so the dock can size itself to content + peek
        // on every side. The dock centres it; the peek insets give the edges.
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    },
    // Compact controls, centred in the row — the row is a sheet TITLE bar now,
    // so the ✕ (SheetCloseButton's own 40px chip) / Stores pill sit smaller
    // than the row height by design.
    // fontSize is ANIMATED (16 collapsed → 22, the ScreenHeading size, when the
    // sheet settles open) — the base here is the collapsed size.
    headerTitleRow: { flex: 1, flexDirection: 'row', alignItems: 'baseline' },
    headerText: { fontSize: 16, fontWeight: '700', color: c.textPrimary },
    basketBtn: {
        flexDirection: 'row', alignItems: 'center', gap: 2,
        backgroundColor: c.primary, borderRadius: radius.pill,
        paddingLeft: 14, paddingRight: 10, paddingVertical: 10,
    },
    basketBtnText: { color: c.onPrimary, fontSize: 14, fontWeight: '800' },
    // Empty recipe / flow in flight — same dimming as the recipe detail pill.
    basketBtnDisabled: { opacity: 0.45 },

    // The separator starts where the name/stepper column starts (past the
    // image + gap) and runs to the trash can's right edge — never under the
    // product picture.
    // The two target cards sit above the bare list; the gap separates them
    // from the first item row (which carries no separator above it).
    // Only the extra breathing room above the cards; the shadow halo and the
    // side inset are the sheet's job now (the sheet's SheetContent wrapper).
    targetActions: { marginTop: spacing.md, marginBottom: spacing.md },
    sep: { height: DIVIDER_ITEM_HEIGHT, backgroundColor: c.dividerItem, marginLeft: IMG_W + spacing.md },
    emptyText: { fontSize: 13, color: c.textMuted, textAlign: 'center', paddingVertical: 20 },

    // One horizontal row: image | body column (name row over action row).
    item: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: spacing.md },
    itemBody: { flex: 1, gap: spacing.sm },
    nameRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
    // Stepper pinned left, trash pinned right — on the old 2nd name line.
    actionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    itemImage: { width: IMG_W, height: IMG_W, borderRadius: 8, backgroundColor: c.surfaceMuted },
    itemImageFallback: { alignItems: 'center', justifyContent: 'center' },
    itemName: { fontSize: 14, fontWeight: '600', color: c.textPrimary, flex: 1 },
    newBadge: {
        backgroundColor: c.primary, borderRadius: radius.pill,
        paddingHorizontal: 8, paddingVertical: 2,
    },
    newBadgeText: { color: c.onPrimary, fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
    trashBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    // Wider stepper: more space between −/+ and the amount/unit (space-between
    // spreads them across the wider container).
    stepper: { alignSelf: 'flex-start', minWidth: 150 },
});
