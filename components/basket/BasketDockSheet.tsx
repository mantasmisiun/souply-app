import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { usePathname } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { DockedGlassSheet, type DockedSheetControls } from '../DockedGlassSheet';
import { useTheme, spacing, type AppTheme } from '../../constants/theme';
import { useBasketSession, type ChooserOption } from '../../state/basketSession';
import { useBasketState } from '../../state/basketState';
import { applyChooserPick } from '../../utils/basketUtils';
import { formatDate } from '../../utils/formatCurrency';

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
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { t } = useTranslation();
    const pathname = usePathname();
    const { setDraftBasketId } = useBasketState();

    const target = useBasketSession(s => s.target);
    const barVisible = useBasketSession(s => s.barVisible);
    const dormant = useBasketSession(s => s.dormant);
    const dockOptions = useBasketSession(s => s.dockOptions);
    const setCollapseDock = useBasketSession(s => s.setCollapseDock);
    const browseListRef = useBasketSession(s => s.browseListRef);
    const dockExpandRequest = useBasketSession(s => s.dockExpandRequest);
    const cancelPending = useBasketSession(s => s.cancelPending);

    const onTabRoot = pathname === '/catalog';
    // The whole catalog tree is a session surface, so the swipe-up chooser is
    // available on every catalog screen (home, L2, discounts, product, search)
    // — not just the tab root. Without this the dock degrades to a static tab
    // bar on the sub-screens and you can't pull up the basket sheet.
    const onSurface = pathname === '/catalog' || pathname.startsWith('/catalog/');
    const sessionActive = target != null && barVisible;
    // Chooser shows whenever a resumable basket exists and no session is live
    // (a live session is owned by the root BasketListSheet, which already spans
    // the whole catalog tree).
    const hasSheet = onSurface && !sessionActive && dormant != null;

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

    const optionLabel = (o: ChooserOption) =>
        o.key === 'family' ? t('basketSession.optionFamily')
        : o.key === 'previous' ? t('basketSession.optionPrevious')
        : t('basketSession.optionNew');
    const optionIcon = (o: ChooserOption): keyof typeof Ionicons.glyphMap =>
        o.key === 'family' ? 'home-outline' : o.key === 'previous' ? 'cart-outline' : 'add-circle-outline';

    const chooserRows = (dockOptions ?? []).filter(o => o.key !== 'new');
    const chooserContent = (
        <View style={styles.body}>
            <View style={styles.header}>
                <Text style={styles.title}>{t('basketSession.sheetTitle')}</Text>
                <TouchableOpacity
                    style={styles.newBtn}
                    hitSlop={8}
                    onPress={() => { applyChooserPick({ key: 'new', basketId: null, itemCount: 0 }, setDraftBasketId).catch(() => {}); }}
                >
                    <Ionicons name="add" size={28} color={colors.primary} />
                </TouchableOpacity>
            </View>
            {chooserRows.map((o, i) => (
                <View key={o.basketId ?? o.key}>
                    <TouchableOpacity style={styles.row} onPress={() => { applyChooserPick(o, setDraftBasketId).catch(() => {}); }}>
                        <View style={styles.rowIcon}>
                            <Ionicons name={optionIcon(o)} size={20} color={colors.primary} />
                        </View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.rowLabel}>{optionLabel(o)}</Text>
                            {o.updatedAt != null && <Text style={styles.rowMeta}>{formatDate(o.updatedAt)}</Text>}
                        </View>
                        <Text style={styles.rowCount}>{o.itemCount}</Text>
                    </TouchableOpacity>
                    {i < chooserRows.length - 1 && <View style={styles.sep} />}
                </View>
            ))}
        </View>
    );

    if (!hasSheet) {
        return <DockedGlassSheet barRow={tabsRow} barRowHeight={tabsRowHeight} colors={colors} />;
    }

    return (
        <DockedGlassSheet
            ref={controls}
            colors={colors}
            barRow={tabsRow}
            barRowHeight={tabsRowHeight}
            blockScrollRef={onTabRoot ? browseListRef : null}
            sheet={{
                content: chooserContent,
                maxStage: 1,
                // Collapsed back to the bar with adds still queued and no basket
                // picked ⇒ the user dismissed the chooser: release those adds so
                // their Add buttons stop spinning.
                onStageChange: (stage) => {
                    if (stage !== 0) return;
                    const s = useBasketSession.getState();
                    if (s.target == null && s.pendingAdds.length > 0) cancelPending();
                },
            }}
        />
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    body: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    header: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: spacing.md, paddingBottom: spacing.md,
    },
    title: { fontSize: 22, fontWeight: '800', color: c.textPrimary },
    newBtn: {
        width: 42, height: 42, borderRadius: 21,
        backgroundColor: c.primaryMuted ?? c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center',
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 12 },
    rowIcon: {
        width: 40, height: 40, borderRadius: 20,
        backgroundColor: c.primaryMuted ?? c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center',
    },
    rowLabel: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
    rowMeta: { fontSize: 12, color: c.textSecondary, marginTop: 1 },
    rowCount: { fontSize: 16, fontWeight: '800', color: c.textPrimary, marginLeft: spacing.md },
    sep: { height: StyleSheet.hairlineWidth, backgroundColor: c.borderSubtle },
});
