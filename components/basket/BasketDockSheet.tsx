import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { DockedGlassSheet, type DockedSheetControls } from '../DockedGlassSheet';
import { SheetCard } from '../SheetCard';
import { useTheme, useResolvedScheme, spacing, DIVIDER_ITEM_HEIGHT, type AppTheme } from '../../constants/theme';
import { useBasketSession, type ChooserOption } from '../../state/basketSession';
import { useBasketState } from '../../state/basketState';
import { applyChooserPick } from '../../utils/basketUtils';
import { formatDate } from '../../utils/formatCurrency';
import { formatDayDate } from '../../utils/formatDayDate';
import { TemplateCoverEditor, type CoverDraft } from '../TemplateCoverEditor';
import { ShoppingSheet } from './ShoppingSheet';
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
    const sessionActive = target != null && barVisible;
    // Chooser shows whenever a resumable basket exists and no session is live
    // (a live session is owned by the root BasketListSheet, which already spans
    // the whole catalog tree).
    const hasSheet = (onSurface && !sessionActive && dormant != null) || onShoppingRoot;

    const controls = useRef<DockedSheetControls | null>(null);

    // External collapse (browse scroll / L1 toggle) — only while the chooser
    // owns the dock; the active-session List sheet registers its own.
    useEffect(() => {
        if (!hasSheet) return;
        setCollapseDock(() => controls.current?.collapse());
        return () => setCollapseDock(null);
    }, [hasSheet, setCollapseDock]);

    // Raise the chooser to medium when the Add flow requests it. Nonce-driven +
    // gated on hasSheet so it fires once the sheet is actually mounted (the
    // dormant flag that enables it may land in the same tick as the request).
    const handledExpand = useRef(dockExpandRequest);
    useEffect(() => {
        if (dockExpandRequest === handledExpand.current || !hasSheet) return;
        handledExpand.current = dockExpandRequest;
        controls.current?.expand();
    }, [dockExpandRequest, hasSheet]);

    // "Add new" template: opens the SAME identity sheet the Templates tab uses
    // (name/emoji/cover) → creates the template, adds it to the chooser list and
    // TARGETS it (queued adds flush into it via the normal pick path).
    const [createOpen, setCreateOpen] = useState(false);
    const setDockTemplates = useBasketSession(s => s.setDockTemplates);
    const onAddTemplate = () => setCreateOpen(true);
    const handleCreateTemplate = async (next: CoverDraft) => {
        try {
            const userId = await getUserId();
            const created = await createTemplate({
                userId, name: next.name, coverColor: next.coverColor, coverImage: next.coverImage,
            });
            setCreateOpen(false);
            const option: ChooserOption = {
                key: 'template', templateId: created.id, name: created.name,
                basketId: null, itemCount: 0, label: created.name, updatedAt: null,
            };
            setDockTemplates([...(dockTemplates ?? []), option]);
            await applyChooserPick(option, setDraftBasketId);
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorSave'));
        }
    };

    const baskets = (dockOptions ?? []).filter(o => o.key !== 'new');
    const templates = dockTemplates ?? [];

    // A row's title: family → its label, previous → last-edited date, template →
    // its name. The date is what disambiguates otherwise-identical draft rows.
    const rowTitle = (o: ChooserOption): string =>
        o.key === 'template' ? (o.name || t('basketSession.optionTemplate'))
        : o.key === 'family' ? t('basketSession.optionFamily')
        : o.name ? o.name
        : o.updatedAt ? formatDayDate(o.updatedAt, i18n.language) : t('basketSession.optionPrevious');
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

    const addNewRow = (keyId: string, onPress: () => void) => (
        <TouchableOpacity key={keyId} style={styles.row} onPress={onPress}>
            <View style={[styles.rowIcon, styles.addIcon]}>
                <Ionicons name="add" size={22} color={colors.onPrimary} />
            </View>
            <Text style={styles.addLabel}>{t('basketSession.addNew')}</Text>
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
                destination choice: pick a basket/template or add a new one. */}
            <Text style={styles.sheetHeading}>{t('basketSession.chooserPrompt')}</Text>
            {sectionCard(t('basketSession.sheetTitle'), withSeps([
                addNewRow('add-basket', () => { applyChooserPick({ key: 'new', basketId: null, itemCount: 0 }, setDraftBasketId).catch(() => {}); }),
                ...baskets.map(o => itemRow(o, o.basketId != null ? `b${o.basketId}` : o.key)),
            ]))}
            {sectionCard(t('tabs.templates'), withSeps([
                addNewRow('add-template', onAddTemplate),
                ...templates.map(o => itemRow(o, o.templateId != null ? `t${o.templateId}` : 'tpl')),
            ]))}
        </View>
    );

    // While the session list sheet owns the bottom (active session on a catalog
    // surface) the tab dock renders NOTHING. The session bar auto-sizes to its
    // own content, so a same-position dock behind it would poke out as a doubled
    // edge — and its tab icons would ghost through the transparent glass.
    if (sessionActive && onSurface) return null;

    // The identity sheet is an RN Modal — rendered alongside whichever dock
    // variant is live so it survives the chooser mounting/unmounting.
    const createEditor = (
        <TemplateCoverEditor
            visible={createOpen}
            onClose={() => setCreateOpen(false)}
            name=""
            coverColor={null}
            coverImage={null}
            submitLabel={t('basketTab.templates.createConfirm')}
            onSubmit={handleCreateTemplate}
        />
    );

    if (!hasSheet) {
        return (
            <>
                <DockedGlassSheet barRow={tabsRow} barRowHeight={tabsRowHeight} colors={colors} onCollapsedClearance={setTabBarClearance} />
                {createEditor}
            </>
        );
    }

    return (
        <>
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
                    : chooserContent,
                // Full detent so the sections have room; the shared geometry
                // keeps the collapsed tab bar symmetric + fixed and docks
                // edge-to-edge only at full.
                maxStage: 2,
                // Collapsed back to the bar with adds still queued and no basket
                // picked ⇒ the user dismissed the chooser: release those adds so
                // their Add buttons stop spinning.
                onStageChange: (stage) => {
                    if (stage !== 0 || onShoppingRoot) return;
                    const s = useBasketSession.getState();
                    if (s.target == null && s.pendingAdds.length > 0) cancelPending();
                },
            }}
        />
        {createEditor}
        </>
    );
}

const makeStyles = (c: AppTheme, isDark: boolean) => StyleSheet.create({
    body: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.sm, gap: spacing.md },
    // Same size as a screen's ScreenHeading title (22/700) — the sheet's own title.
    sheetHeading: { fontSize: 22, fontWeight: '700', color: c.textPrimary, paddingTop: spacing.xs, paddingBottom: spacing.xs },
    cardTitle: { fontSize: 20, fontWeight: '800', color: c.textPrimary, paddingVertical: spacing.md },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 10 },
    rowIcon: {
        width: 40, height: 40, borderRadius: 20,
        backgroundColor: c.primaryMuted ?? c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center',
    },
    addIcon: { backgroundColor: c.primary },
    // Count "dot" badge riding the icon's top-right corner.
    countBadge: {
        position: 'absolute', top: -3, right: -5,
        minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
        backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center',
        borderWidth: 2, borderColor: isDark ? c.surfaceContainer : c.cardBackground,
    },
    countBadgeText: { color: c.onPrimary, fontSize: 9, fontWeight: '800' },
    addLabel: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
    rowTitle: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
    rowPreview: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
    sep: { height: DIVIDER_ITEM_HEIGHT, backgroundColor: c.dividerItem },
});
