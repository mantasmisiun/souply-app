import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { DockedGlassSheet, type DockedSheetControls } from '../DockedGlassSheet';
import { SheetCard, SHEET_CARD_SHADOW_RADIUS } from '../SheetCard';
import { useTheme, useResolvedScheme, spacing, DIVIDER_ITEM_HEIGHT, type AppTheme } from '../../constants/theme';
import { useBasketSession, templateChooserOption, type ChooserOption } from '../../state/basketSession';
import { useBasketState } from '../../state/basketState';
import { applyChooserPick } from '../../utils/basketUtils';
import { formatWeekdayDate } from '../../utils/formatDayDate';
import { type CoverDraft } from '../TemplateCoverEditor';
import { DockActionRow } from '../dock/DockActionRow';
import { ShoppingSheet } from './ShoppingSheet';
import { useShoppingSheet } from '../../state/shoppingSheet';
import { RecipeDockPane } from '../recipe/RecipeDockPane';
import { RecipeCreatePane } from '../recipe/RecipeCreatePane';
import { useRecipeDock } from '../../state/recipeDock';
import { createTemplate } from '../../utils/basketTemplatesApi';
import { getUserId } from '../../config/user';

/**
 * BasketDockSheet — the Naršyti tab bar's basket CHOOSER, rendered inside the
 * floating tab bar as one glass panel (DockedGlassSheet). The tab buttons are
 * its collapsed bar row; dragging up reveals the "Baskets" chooser above them.
 *
 * It only STARTS sessions: picking a basket sets the session target, and the
 * ACTIVE session view (item list) is the root-level BasketListSheet, which
 * persists across the whole shopping flow. So while a session is live this
 * reverts to plain tabs (the List sheet owns the bottom).
 */


export function BasketDockSheet({ tabsRow, tabsRowHeight }: { tabsRow: ReactNode; tabsRowHeight: number }) {
    const colors = useTheme();
    const isDark = useResolvedScheme() === 'dark';
    const styles = useMemo(() => makeStyles(colors, isDark), [colors, isDark]);
    const { t, i18n } = useTranslation();
    const pathname = usePathname();
    const { setDraftBasketId } = useBasketState();

    const target = useBasketSession(s => s.target);
    const barVisible = useBasketSession(s => s.barVisible);
    const dormant = useBasketSession(s => s.dormant);
    const dockOptions = useBasketSession(s => s.dockOptions);
    const dockTemplates = useBasketSession(s => s.dockTemplates);
    const setCollapseDock = useBasketSession(s => s.setCollapseDock);
    const browseListRef = useBasketSession(s => s.browseListRef);
    const dockExpandRequest = useBasketSession(s => s.dockExpandRequest);
    const cancelPending = useBasketSession(s => s.cancelPending);
    const setTabBarClearance = useBasketSession(s => s.setTabBarClearance);

    const onTabRoot = pathname === '/catalog';
    // The whole catalog tree is a session surface, so the swipe-up chooser is
    // available on every catalog screen (home, L2, discounts, product, search)
    // — not just the tab root. Without this the dock degrades to a static tab
    // bar on the sub-screens and you can't pull up the basket sheet.
    const onSurface = pathname === '/catalog' || pathname.startsWith('/catalog/');
    // Shopping tab root gets its OWN sheet (date filter + family + generate
    // with AI — shared/SMART_BASKET_SPEC.md §1).
    const onShoppingRoot = pathname === '/basket';
    // Receptai tab root: swipe up to start a recipe (blank, or from a link).
    // Same dock as the other two tabs — a recipe is created from the bar, not
    // from a floating button parked over the list.
    const onTemplatesRoot = pathname === '/templates';
    const sessionActive = target != null && barVisible;
    // Chooser shows whenever a resumable basket exists and no session is live
    // (a live session is owned by the root BasketListSheet, which already spans
    // the whole catalog tree).
    const hasSheet = (onSurface && !sessionActive && dormant != null) || onShoppingRoot || onTemplatesRoot;

    const controls = useRef<DockedSheetControls | null>(null);
    // Current detent (0 collapsed → last = full). At FULL the sheet is
    // edge-to-edge and the list behind it is covered, so a "list scroll" there
    // is really the sheet's own up-drag handing off — collapseDock must ignore
    // it (else dragging the sheet up at full closes it). At medium the list is
    // visible, so collapse-on-scroll stays valid.
    const stageRef = useRef(0);
    const atFull = () => stageRef.current >= 2;

    // The Receptai screen collapses the dock when it acts on a choice.
    useEffect(() => {
        if (!onTemplatesRoot) return;
        useRecipeDock.getState().setCollapse(() => controls.current?.collapse());
        return () => useRecipeDock.getState().setCollapse(null);
    }, [onTemplatesRoot]);

    // The catalog chooser variant of this sheet (neither the Shopping nor the
    // Receptai root) — it now hosts the recipe create pane too, so it needs a
    // name of its own.
    const onCatalogChooser = hasSheet && !onShoppingRoot && !onTemplatesRoot;

    // Recipe create pane — an IN-SHEET page (SheetPaneSpec), the share pane's
    // navigation model: an action card swaps the dock's content to the
    // combined create pane (URL + cover) and raises the sheet to full so the
    // fields sit high, clear of the keyboard. ONE pane definition, TWO entry
    // points: the Receptai root's lone card and the catalog chooser's Receptas
    // card (which lands the created recipe in the catalog session instead of
    // navigating — see createRecipeIntoSession). The sheet itself clears the
    // pane on every collapse (onDismiss); leaving the hosting surface clears
    // it too so a return can't resurrect a stale pane.
    const paneSurface = onTemplatesRoot ? 'templates' : onCatalogChooser ? 'catalog' : null;
    const [recipePane, setRecipePane] = useState(false);
    const openRecipeCreate = () => { setRecipePane(true); controls.current?.snapTo(2); };
    useEffect(() => { setRecipePane(false); }, [paneSurface]);

    // External collapse (browse scroll / L1 toggle) — only while the chooser
    // owns the dock; the active-session List sheet registers its own.
    useEffect(() => {
        if (!hasSheet) return;
        setCollapseDock(() => { if (atFull()) return; controls.current?.collapse(); });
        return () => setCollapseDock(null);
    }, [hasSheet, setCollapseDock]);

    // Android back bridge: expose collapse while on the Shopping root so the
    // tab's back handler can close the dock; reset stage on leave.
    useEffect(() => {
        if (!onShoppingRoot) return;
        useShoppingSheet.getState().setCollapseSheet(() => controls.current?.collapse());
        return () => {
            const s = useShoppingSheet.getState();
            s.setCollapseSheet(null);
            s.setSheetStage(0);
        };
    }, [onShoppingRoot]);

    // Raise the chooser to medium when the Add flow requests it. Nonce-driven +
    // gated on hasSheet so it fires once the sheet is actually mounted (the
    // dormant flag that enables it may land in the same tick as the request).
    const handledExpand = useRef(dockExpandRequest);
    useEffect(() => {
        if (dockExpandRequest === handledExpand.current || !hasSheet) return;
        handledExpand.current = dockExpandRequest;
        controls.current?.expand();
    }, [dockExpandRequest, hasSheet]);

    // Recipe create from the CATALOG chooser (RecipeCreatePane.onCreateBlank):
    // create the template, then run the chooser's own template-pick path —
    // applyChooserPick targets it and flushes any queued adds — so the catalog
    // stays put and shows the session bar with the new recipe active
    // (✕ Prekės: 0 · Parduotuvės ›), exactly like resuming an existing one.
    // Errors propagate: the pane owns the alert + spinner.
    const setDockTemplates = useBasketSession(s => s.setDockTemplates);
    const createRecipeIntoSession = async (draft: CoverDraft) => {
        const userId = await getUserId();
        const created = await createTemplate({
            userId, name: draft.name, coverColor: draft.coverColor, coverImage: draft.coverImage,
        });
        const option = templateChooserOption(created);
        setDockTemplates([...(dockTemplates ?? []), option]);
        await applyChooserPick(option, setDraftBasketId);
    };

    const baskets = (dockOptions ?? []).filter(o => o.key !== 'new');
    const templates = dockTemplates ?? [];

    // A row's title: family → its label, previous → last-edited date, template →
    // its name. The date is what disambiguates otherwise-identical draft rows.
    const rowTitle = (o: ChooserOption): string =>
        o.key === 'template' ? (o.name || t('basketSession.optionTemplate'))
        : o.key === 'family' ? t('basketSession.optionFamily')
        : o.name ? o.name
        : o.updatedAt ? formatWeekdayDate(o.updatedAt, i18n.language) : t('basketSession.optionPrevious');
    // Newest-first names, each capped so ≥3 fit on one line; middle-dot joined.
    const previewLine = (names: string[]): string =>
        names.slice(0, 4).map(n => (n.length > 18 ? `${n.slice(0, 17).trimEnd()}…` : n)).join('  ·  ');

    const itemRow = (o: ChooserOption, keyId: string) => (
        <TouchableOpacity key={keyId} style={styles.row} onPress={() => { applyChooserPick(o, setDraftBasketId).catch(() => {}); }}>
            <View style={styles.rowIcon}>
                <Ionicons name={o.key === 'template' ? 'bookmark' : 'cart'} size={20} color={colors.primary} />
                {o.itemCount > 0 && (
                    <View style={styles.countBadge}>
                        <Text style={styles.countBadgeText}>{o.itemCount > 99 ? '99+' : o.itemCount}</Text>
                    </View>
                )}
            </View>
            <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>{rowTitle(o)}</Text>
                {o.itemPreview && o.itemPreview.length > 0 && (
                    <Text style={styles.rowPreview} numberOfLines={1}>{previewLine(o.itemPreview)}</Text>
                )}
            </View>
        </TouchableOpacity>
    );

    const sectionCard = (title: string, rows: ReactNode[]) => (
        <SheetCard>
            <Text style={styles.cardTitle}>{title}</Text>
            {rows}
        </SheetCard>
    );

    const withSeps = (nodes: ReactNode[]): ReactNode[] =>
        nodes.flatMap((n, i) => (i === 0 ? [n] : [<View key={`sep-${i}`} style={styles.sep} />, n]));

    const chooserContent = (
        <View style={styles.body}>
            {/* Sheet title (screen-title font) — frames the whole sheet as a
                destination choice: pick a basket/template or start a new one. */}
            <Text style={styles.sheetHeading}>{t('basketSession.chooserPrompt')}</Text>
            {/* CREATE pair — the standard dock cards. Krepšelis runs the
                chooser's old "add new basket" pick verbatim; Receptas opens
                the SAME in-sheet create pane the Receptai dock uses (the
                sheet.pane contract), landing the recipe in the catalog
                session. The old per-section "+ Pridėti naują" rows folded
                into these cards, so the sections below list EXISTING
                baskets/templates only (and hide when empty). */}
            <DockActionRow
                colors={colors}
                actions={[
                    {
                        icon: 'cart-outline',
                        title: t('basketSession.createBasketTitle'),
                        subtitle: t('basketSession.createBasketSub'),
                        onPress: () => { applyChooserPick({ key: 'new', basketId: null, itemCount: 0 }, setDraftBasketId).catch(() => {}); },
                    },
                    {
                        icon: 'add-circle-outline',
                        title: t('basketTab.templates.createTitle'),
                        subtitle: t('basketTab.templates.createSub'),
                        onPress: openRecipeCreate,
                    },
                ]}
            />
            {baskets.length > 0 && sectionCard(t('basketSession.sheetTitle'), withSeps(
                baskets.map(o => itemRow(o, o.basketId != null ? `b${o.basketId}` : o.key)),
            ))}
            {templates.length > 0 && sectionCard(t('tabs.templates'), withSeps(
                templates.map(o => itemRow(o, o.templateId != null ? `t${o.templateId}` : 'tpl')),
            ))}
        </View>
    );

    // While the session list sheet owns the bottom (active session on a catalog
    // surface) the tab dock renders NOTHING. The session bar auto-sizes to its
    // own content, so a same-position dock behind it would poke out as a doubled
    // edge — and its tab icons would ghost through the transparent glass.
    if (sessionActive && onSurface) return null;

    if (!hasSheet) {
        return (
            <DockedGlassSheet barRow={tabsRow} barRowHeight={tabsRowHeight} colors={colors} onCollapsedClearance={setTabBarClearance} />
        );
    }

    return (
        <DockedGlassSheet
            ref={controls}
            colors={colors}
            barRow={tabsRow}
            barRowHeight={tabsRowHeight}
            onCollapsedClearance={setTabBarClearance}
            blockScrollRef={onTabRoot ? browseListRef : null}
            sheet={{
                // Shopping tab root → the shopping sheet (date filter / family /
                // generate with AI). Catalog surfaces → the basket chooser.
                content: onShoppingRoot
                    ? <ShoppingSheet collapse={() => controls.current?.collapse()} />
                    : onTemplatesRoot
                        ? <RecipeDockPane openCreate={openRecipeCreate} />
                        : chooserContent,
                // The create pane, in the sheet's own pane contract (the recipe
                // share pane's shape): its bar row — "‹ Naujas receptas" —
                // REPLACES the tab row while open (pinned to the sheet's TOP,
                // per the SheetPaneSpec contract), the body page-slides in, and
                // the sheet fires onDismiss on every collapse so a re-opened
                // dock always lands on the root. `pane` is DEFINED only on the
                // two surfaces that host it — the Receptai root and the catalog
                // chooser — so the Shopping sheet (and every other variant)
                // keeps its exact pre-pane layout (paneEnabled stays off).
                pane: paneSurface != null
                    ? (recipePane ? {
                        key: 'recipe-create',
                        barRow: (
                            <View style={styles.paneHeaderRow}>
                                <TouchableOpacity
                                    onPress={() => setRecipePane(false)}
                                    hitSlop={10}
                                    accessibilityLabel={t('common.back')}
                                >
                                    <Ionicons name="chevron-back" size={26} color={colors.primary} />
                                </TouchableOpacity>
                                <Text style={styles.paneTitle} numberOfLines={1}>
                                    {t('basketTab.templates.createPaneTitle')}
                                </Text>
                            </View>
                        ),
                        content: (
                            <RecipeCreatePane
                                collapse={() => controls.current?.collapse()}
                                // Catalog entry point: blank create lands in the
                                // catalog session bar, not on /template/{id}.
                                // Imports keep the review-screen path either way.
                                onCreateBlank={paneSurface === 'catalog' ? createRecipeIntoSession : undefined}
                            />
                        ),
                        onDismiss: () => setRecipePane(false),
                    } : null)
                    : undefined,
                // Full detent so the sections have room; the shared geometry
                // keeps the collapsed tab bar symmetric + fixed and docks
                // edge-to-edge only at full.
                // Every tab's dock behaves identically: medium floats, and only the
                // full raise docks edge-to-edge.
                maxStage: 2,
                // Collapsed back to the bar with adds still queued and no basket
                // picked ⇒ the user dismissed the chooser: release those adds so
                // their Add buttons stop spinning.
                onStageChange: (stage) => {
                    stageRef.current = stage;
                    if (onShoppingRoot) useShoppingSheet.getState().setSheetStage(stage);
                    if (onTemplatesRoot) useRecipeDock.getState().setStage(stage);
                    if (stage !== 0 || onShoppingRoot || onTemplatesRoot) return;
                    const s = useBasketSession.getState();
                    if (s.target == null && s.pendingAdds.length > 0) cancelPending();
                },
            }}
        />
    );
}

const makeStyles = (c: AppTheme, isDark: boolean) => StyleSheet.create({
    // paddingBottom reserves the SheetCard shadow halo so the sheet's scroll
    // viewport (overflow:'hidden') can't clip the last section's shadow.
    body: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: SHEET_CARD_SHADOW_RADIUS, gap: spacing.md },
    // Same size as a screen's ScreenHeading title (22/700) — the sheet's own title.
    sheetHeading: { fontSize: 22, fontWeight: '700', color: c.textPrimary, paddingTop: spacing.xs, paddingBottom: spacing.xs },
    cardTitle: { fontSize: 20, fontWeight: '800', color: c.textPrimary, paddingVertical: spacing.md },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 10 },
    rowIcon: {
        width: 40, height: 40, borderRadius: 20,
        backgroundColor: c.primaryMuted ?? c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center',
    },
    // Count "dot" badge riding the icon's top-right corner.
    countBadge: {
        position: 'absolute', top: -3, right: -5,
        minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
        backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center',
        borderWidth: 2, borderColor: isDark ? c.surfaceContainer : c.cardBackground,
    },
    countBadgeText: { color: c.onPrimary, fontSize: 9, fontWeight: '800' },
    rowTitle: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
    rowPreview: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
    sep: { height: DIVIDER_ITEM_HEIGHT, backgroundColor: c.dividerItem },
    // Create-pane BAR row (‹ back · title) — the template share pane's header
    // row shape, riding the dock's bar slot (SheetPaneSpec.barRow) in place of
    // the tab row while the pane is open.
    paneHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4 },
    paneTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: c.textPrimary },
});
