import { View, Text, TouchableOpacity, StyleSheet, Image, Dimensions } from 'react-native';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { MaterialProgress } from '@/components/MaterialProgress';
import { DockedGlassSheet, type DockedSheetControls } from '../DockedGlassSheet';
import { useTheme, radius, spacing, type AppTheme } from '../../constants/theme';
import { API_BASE_URL } from '../../config/api';
import { useBasketSession, type ChooserOption } from '../../state/basketSession';
import { useBasketState } from '../../state/basketState';
import { applyChooserPick } from '../../utils/basketUtils';
import { formatDate } from '../../utils/formatCurrency';

/**
 * BasketDockSheet — the Naršyti basket dock, rendered INSIDE the floating tab
 * bar as a single glass panel (see DockedGlassSheet). The tab buttons are its
 * collapsed bar row; dragging up reveals the "Baskets" chooser above them.
 * Picking a basket swaps the bar row to a session header ([X] Prekės: N
 * [Krepšelis ›]) and the sheet to that basket's item list.
 *
 * This replaces the old root-mounted GlassStageSheet dock (two glass layers →
 * seam/double-tint/brightness/opacity artifacts). Non-tab surfaces (product,
 * search, discounts) keep their floating sheet in BasketSessionHost.
 */

const SESSION_H = 58;
const ROW_H = 64;
const MAX_CONTENT = Math.round(Dimensions.get('window').height * 0.5);

interface PreviewItem {
    id: number;
    productId: number;
    quantity: number;
    name: string | null;
    imageUrl: string | null;
}

export function BasketDockSheet({ tabsRow, tabsRowHeight }: { tabsRow: ReactNode; tabsRowHeight: number }) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { t } = useTranslation();
    const router = useRouter();
    const pathname = usePathname();
    const { setDraftBasketId } = useBasketState();

    const target = useBasketSession(s => s.target);
    const barVisible = useBasketSession(s => s.barVisible);
    const itemCount = useBasketSession(s => s.itemCount);
    const dormant = useBasketSession(s => s.dormant);
    const dockOptions = useBasketSession(s => s.dockOptions);
    const dismissBar = useBasketSession(s => s.dismissBar);
    const setCount = useBasketSession(s => s.setCount);
    const setCollapseDock = useBasketSession(s => s.setCollapseDock);
    const browseListRef = useBasketSession(s => s.browseListRef);

    const onTabRoot = pathname === '/browse';
    const hasSheet = onTabRoot && (target != null || dormant != null);
    // depth 1 = a session is live (basket picked): the bar row becomes the
    // session header and the sheet shows that basket's items.
    const depth: 0 | 1 = target != null && barVisible ? 1 : 0;

    const controls = useRef<DockedSheetControls | null>(null);

    // ── Basket items (loaded while a session is live) ─────────────────────────
    const [items, setItems] = useState<PreviewItem[] | null>(null);
    const loadItems = useCallback(async () => {
        if (!target) return;
        try {
            const res = await fetch(`${API_BASE_URL}/api/baskets/${target.basketId}/items`);
            const data = await res.json();
            const rows: PreviewItem[] = (Array.isArray(data) ? data : []).map((it: any) => ({
                id: it.id,
                productId: it.productId,
                quantity: Number(it.quantity) || 1,
                name: it.productName ?? it.name ?? null,
                imageUrl: Array.isArray(it.imageUrls) ? it.imageUrls.find(Boolean) ?? null : null,
            }));
            setItems(rows);
            setCount(rows.length);
        } catch { setItems([]); }
    }, [target, setCount]);
    useEffect(() => { if (depth === 1) loadItems(); else setItems(null); }, [depth, loadItems]);

    const changeQty = useCallback(async (item: PreviewItem, delta: number) => {
        const next = Math.max(0, item.quantity + delta);
        if (next === 0) {
            setItems(prev => prev?.filter(i => i.id !== item.id) ?? null);
            useBasketSession.getState().bumpCount(-1);
            fetch(`${API_BASE_URL}/api/basket-items/${item.id}`, { method: 'DELETE' }).catch(() => {});
            return;
        }
        setItems(prev => prev?.map(i => (i.id === item.id ? { ...i, quantity: next } : i)) ?? null);
        fetch(`${API_BASE_URL}/api/basket-items/${item.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quantity: next }),
        }).catch(() => {});
    }, []);

    // Register the external-collapse hook (browse scroll / L1 toggle).
    useEffect(() => {
        setCollapseDock(() => controls.current?.collapse());
        return () => setCollapseDock(null);
    }, [setCollapseDock]);

    // Picking a basket (depth 0→1) opens the item list expanded; X (1→0) drops
    // back to the collapsed chooser on the bar.
    const prevDepth = useRef(depth);
    useEffect(() => {
        if (depth !== prevDepth.current) {
            prevDepth.current = depth;
            if (depth === 1) controls.current?.expand();
            else controls.current?.collapse();
        }
    }, [depth]);

    const optionLabel = (o: ChooserOption) =>
        o.key === 'family' ? t('basketSession.optionFamily')
        : o.key === 'previous' ? t('basketSession.optionPrevious')
        : t('basketSession.optionNew');
    const optionIcon = (o: ChooserOption): keyof typeof Ionicons.glyphMap =>
        o.key === 'family' ? 'home-outline' : o.key === 'previous' ? 'cart-outline' : 'add-circle-outline';

    // ── Content per depth ─────────────────────────────────────────────────────
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
                <View key={o.key}>
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

    const listContent = (
        <View style={styles.body}>
            {items == null ? (
                <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                    <MaterialProgress size="large" color={colors.primary} />
                </View>
            ) : items.length === 0 ? (
                <Text style={styles.emptyText}>{t('basketSession.empty')}</Text>
            ) : items.map(item => (
                <View key={item.id} style={styles.itemRow}>
                    {item.imageUrl
                        ? <Image source={{ uri: item.imageUrl }} style={styles.itemImage} />
                        : <View style={[styles.itemImage, styles.itemImageFallback]}><Text style={{ opacity: 0.5 }}>🫜</Text></View>}
                    <Text style={styles.itemName} numberOfLines={2}>{item.name ?? `#${item.productId}`}</Text>
                    <View style={styles.stepper}>
                        <TouchableOpacity onPress={() => changeQty(item, -1)} hitSlop={8} style={styles.stepBtn}>
                            <Ionicons name={item.quantity <= 1 ? 'trash-outline' : 'remove'} size={16} color={colors.primary} />
                        </TouchableOpacity>
                        <Text style={styles.stepQty}>{item.quantity}</Text>
                        <TouchableOpacity onPress={() => changeQty(item, 1)} hitSlop={8} style={styles.stepBtn}>
                            <Ionicons name="add" size={16} color={colors.primary} />
                        </TouchableOpacity>
                    </View>
                </View>
            ))}
        </View>
    );

    // Session header — the collapsed bar row while a session is live.
    const sessionHeader = (
        <View style={styles.sessionHeader}>
            <TouchableOpacity onPress={() => dismissBar()} hitSlop={10} style={styles.xBtn}>
                <Ionicons name="close" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
            <Text style={styles.sessionText} numberOfLines={1}>
                {t('basketSession.itemsCount', { count: itemCount })}
            </Text>
            <TouchableOpacity
                style={styles.basketBtn}
                onPress={() => { if (target) router.push(`/basket/${target.basketId}` as any); }}
                activeOpacity={0.85}
            >
                <Text style={styles.basketBtnText}>{t('basketSession.openBasket')}</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.onPrimary} />
            </TouchableOpacity>
        </View>
    );

    // Content height per depth (capped; the panel grows upward from the bar).
    const contentHeight = useMemo(() => {
        if (depth === 1) {
            const inner = items == null ? 72 : items.length === 0 ? 56 : items.length * 60 + 8;
            return Math.min(MAX_CONTENT, inner + 8);
        }
        const inner = 74 + chooserRows.length * ROW_H + spacing.sm;
        return Math.min(MAX_CONTENT, inner);
    }, [depth, items, chooserRows.length]);

    if (!hasSheet) {
        return <DockedGlassSheet barRow={tabsRow} barRowHeight={tabsRowHeight} colors={colors} />;
    }

    return (
        <DockedGlassSheet
            ref={controls}
            colors={colors}
            barRow={depth === 1 ? sessionHeader : tabsRow}
            barRowHeight={depth === 1 ? SESSION_H : tabsRowHeight}
            blockScrollRef={browseListRef}
            sheet={{
                content: depth === 1 ? listContent : chooserContent,
                contentHeight,
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

    emptyText: { fontSize: 13, color: c.textMuted, textAlign: 'center', paddingVertical: 20 },
    itemRow: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.borderSubtle,
    },
    itemImage: { width: 44, height: 44, borderRadius: 8, backgroundColor: c.surfaceMuted },
    itemImageFallback: { alignItems: 'center', justifyContent: 'center' },
    itemName: { flex: 1, fontSize: 14, fontWeight: '600', color: c.textPrimary },
    stepper: {
        flexDirection: 'row', alignItems: 'center', gap: 2,
        backgroundColor: c.surfaceMuted, borderRadius: radius.pill, paddingHorizontal: 4, paddingVertical: 3,
    },
    stepBtn: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
    stepQty: { minWidth: 22, textAlign: 'center', fontSize: 14, fontWeight: '700', color: c.textPrimary },

    sessionHeader: {
        flex: 1,
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        paddingHorizontal: spacing.md,
    },
    xBtn: {
        width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
        backgroundColor: c.surfaceMuted,
    },
    sessionText: { flex: 1, fontSize: 15, fontWeight: '700', color: c.textPrimary },
    basketBtn: {
        flexDirection: 'row', alignItems: 'center', gap: 2,
        backgroundColor: c.primary, borderRadius: radius.pill,
        paddingLeft: 14, paddingRight: 10, paddingVertical: 8,
    },
    basketBtnText: { color: c.onPrimary, fontSize: 14, fontWeight: '800' },
});
