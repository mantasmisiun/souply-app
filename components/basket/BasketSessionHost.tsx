import { View, Text, TouchableOpacity, StyleSheet, Modal, Image } from 'react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { MaterialProgress } from '@/components/MaterialProgress';
import { GlassStageSheet, SHEET_HANDLE_H } from '../GlassStageSheet';
import { useTheme, radius, spacing, type AppTheme } from '../../constants/theme';
import { API_BASE_URL } from '../../config/api';
import { useBasketSession, discoverOptions, openBasketChooser, type ChooserOption } from '../../state/basketSession';
import { useBasketState } from '../../state/basketState';
import { applyChooserPick } from '../../utils/basketUtils';

/**
 * Souply 2.0 basket-session surface, mounted ONCE at the root. Owns everything
 * OUTSIDE the tab bar:
 *   · DISCOVERY — the always-running pass that publishes the chooser options +
 *     the "resumable basket exists" (dormant) flag to the store; the Naršyti
 *     dock (BasketDockSheet, inside the tab bar) renders off these.
 *   · the FLOATING session sheet + re-entry chip on surfaces WITHOUT a tab bar
 *     (product, search, discounts) — a plain floating GlassStageSheet (no bar
 *     to merge with, so no glass artifacts).
 *   · the CHOOSER modal (explicit "switch basket").
 *
 * The Naršyti tab-root dock is NOT here anymore — it is one glass panel with
 * the tab bar (DockedGlassSheet via BasketDockSheet), which removed the old
 * two-layer seam/double-tint/brightness/opacity artifacts.
 */

const BAR_H = 58;
const ROUTE_PREFIXES = ['/browse', '/search', '/discounts', '/product'];

interface PreviewItem {
    id: number;
    productId: number;
    quantity: number;
    name: string | null;
    imageUrl: string | null;
}

export function BasketSessionHost() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const pathname = usePathname();
    const { bottom: bottomInset } = useSafeAreaInsets();
    const { setDraftBasketId } = useBasketState();

    const target = useBasketSession(s => s.target);
    const barVisible = useBasketSession(s => s.barVisible);
    const itemCount = useBasketSession(s => s.itemCount);
    const chooserOpen = useBasketSession(s => s.chooserOpen);
    const chooserOptions = useBasketSession(s => s.chooserOptions);
    const dismissBar = useBasketSession(s => s.dismissBar);
    const closeChooser = useBasketSession(s => s.closeChooser);
    const setCount = useBasketSession(s => s.setCount);
    const dormant = useBasketSession(s => s.dormant);
    const setDormant = useBasketSession(s => s.setDormant);
    const setDockOptions = useBasketSession(s => s.setDockOptions);

    const onSurface = ROUTE_PREFIXES.some(p => pathname === p || pathname.startsWith(`${p}/`));
    const onTabRoot = pathname === '/browse';

    // ── DISCOVERY — publish chooser options + dormant flag to the store ───────
    useEffect(() => {
        if (!onSurface || (target != null && barVisible)) return;
        let alive = true;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        const check = (retriesLeft: number) => {
            discoverOptions()
                .then(opts => {
                    if (!alive) return;
                    setDockOptions(opts ?? []);
                    const prev = opts?.find(o => o.key === 'previous') ?? opts?.find(o => o.key === 'family') ?? null;
                    setDormant(prev ? { count: prev.itemCount } : null);
                })
                .catch(() => {
                    // Auth not ready at cold start (or transient) — retry rather
                    // than concluding "no baskets".
                    if (alive && retriesLeft > 0) retryTimer = setTimeout(() => check(retriesLeft - 1), 1500);
                });
        };
        check(2);
        return () => { alive = false; if (retryTimer) clearTimeout(retryTimer); };
    }, [target, barVisible, onSurface, pathname, setDormant, setDockOptions]);

    // ── Floating session sheet (non-tab surfaces) ─────────────────────────────
    const [items, setItems] = useState<PreviewItem[] | null>(null);
    const [stage, setStage] = useState(0);
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
    useEffect(() => { if (stage > 0) loadItems(); }, [stage, loadItems]);

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

    const switchBasket = useCallback(() => { openBasketChooser(); }, []);

    const optionLabel = (o: ChooserOption) =>
        o.key === 'family' ? t('basketSession.optionFamily')
        : o.key === 'previous' ? t('basketSession.optionPrevious')
        : t('basketSession.optionNew');
    const optionIcon = (o: ChooserOption): keyof typeof Ionicons.glyphMap =>
        o.key === 'family' ? 'home-outline' : o.key === 'previous' ? 'cart-outline' : 'add-circle-outline';

    const snaps = useMemo(() => {
        const contentH = Math.min(560, 120 + (items?.length ?? 3) * 64);
        return [BAR_H + SHEET_HANDLE_H, Math.min(360, contentH + BAR_H + SHEET_HANDLE_H), Math.max(420, contentH + BAR_H + SHEET_HANDLE_H)];
    }, [items]);

    const showBarNow = onSurface && !onTabRoot && target != null && barVisible;
    const pillRelevant = target != null ? !barVisible : dormant != null;
    const showPill = onSurface && !onTabRoot && !showBarNow && pillRelevant;

    const sessionBar = (
        <View style={[styles.bar, { height: BAR_H }]}>
            <TouchableOpacity onPress={dismissBar} hitSlop={10} style={styles.xBtn}>
                <Ionicons name="close" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity
                style={styles.barBody}
                onPress={() => { if (target) router.push(`/basket/${target.basketId}` as any); }}
                activeOpacity={0.8}
            >
                <Text style={styles.barText} numberOfLines={1}>
                    {target?.isFamily ? t('basketSession.familyBar', { count: itemCount }) : t('basketSession.bar', { count: itemCount })}
                </Text>
                <Ionicons name="chevron-forward" size={18} color={colors.primary} />
            </TouchableOpacity>
        </View>
    );

    const itemsList = items == null ? (
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
    ));

    return (
        <>
            {showBarNow && (
                <GlassStageSheet
                    snaps={snaps}
                    initialStage={0}
                    onStageChange={setStage}
                    dockAtLast
                    bar={sessionBar}
                    colors={colors}
                    bottomInset={bottomInset}
                >
                    <View style={styles.sheetBody}>
                        <TouchableOpacity style={styles.switchRow} onPress={switchBasket}>
                            <Ionicons name="swap-horizontal" size={18} color={colors.primary} />
                            <Text style={styles.switchText}>{t('basketSession.switch')}</Text>
                        </TouchableOpacity>
                        {itemsList}
                    </View>
                </GlassStageSheet>
            )}

            {showPill && (
                <TouchableOpacity
                    style={[styles.rePill, { bottom: bottomInset + 140 }]}
                    onPress={switchBasket}
                    activeOpacity={0.8}
                >
                    <Ionicons name="cart-outline" size={14} color={colors.onPrimary} />
                    <Text style={styles.rePillText}>{target != null ? itemCount : dormant?.count ?? 0}</Text>
                </TouchableOpacity>
            )}

            {/* Chooser modal — explicit "switch basket". */}
            <Modal visible={chooserOpen} transparent animationType="slide" onRequestClose={closeChooser}>
                <TouchableOpacity style={styles.chooserBackdrop} activeOpacity={1} onPress={closeChooser}>
                    <View style={[styles.chooserSheet, { paddingBottom: Math.max(bottomInset, 16) }]} onStartShouldSetResponder={() => true}>
                        <Text style={styles.chooserTitle}>{t('basketSession.chooserTitle')}</Text>
                        {chooserOptions.map(o => (
                            <TouchableOpacity
                                key={o.key}
                                style={styles.chooserOption}
                                onPress={() => { applyChooserPick(o, setDraftBasketId).catch(() => {}); }}
                            >
                                <View style={styles.chooserIcon}>
                                    <Ionicons name={optionIcon(o)} size={20} color={colors.primary} />
                                </View>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.chooserLabel}>{optionLabel(o)}</Text>
                                    {o.key !== 'new' && (
                                        <Text style={styles.chooserMeta}>{t('basketSession.optionCount', { count: o.itemCount })}</Text>
                                    )}
                                </View>
                                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                            </TouchableOpacity>
                        ))}
                    </View>
                </TouchableOpacity>
            </Modal>
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    bar: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
        paddingHorizontal: spacing.md,
    },
    xBtn: {
        width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
        backgroundColor: c.surfaceMuted,
    },
    barBody: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    barText: { fontSize: 15, fontWeight: '700', color: c.textPrimary, flex: 1 },

    sheetBody: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
    switchRow: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        paddingVertical: 10,
    },
    switchText: { fontSize: 13, fontWeight: '700', color: c.primary },
    emptyText: { fontSize: 13, color: c.textMuted, textAlign: 'center', paddingVertical: 24 },
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

    rePill: {
        position: 'absolute', right: 16,
        flexDirection: 'row', alignItems: 'center', gap: 5,
        backgroundColor: c.primary, borderRadius: radius.pill,
        paddingHorizontal: 12, paddingVertical: 7,
        elevation: 4, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    },
    rePillText: { color: c.onPrimary, fontSize: 12, fontWeight: '800' },

    chooserBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
    chooserSheet: {
        backgroundColor: c.cardBackground,
        borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
        paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: 4,
    },
    chooserTitle: { fontSize: 16, fontWeight: '800', color: c.textPrimary, marginBottom: spacing.sm },
    chooserOption: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        paddingVertical: 12,
    },
    chooserIcon: {
        width: 40, height: 40, borderRadius: 20,
        backgroundColor: c.primaryMuted ?? c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center',
    },
    chooserLabel: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
    chooserMeta: { fontSize: 12, color: c.textSecondary, marginTop: 1 },
});
