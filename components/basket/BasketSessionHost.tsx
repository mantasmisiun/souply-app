import { View, Text, TouchableOpacity, StyleSheet, Modal } from 'react-native';
import { useEffect, useMemo, useRef } from 'react';
import { usePathname } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme, radius, spacing, type AppTheme } from '../../constants/theme';
import { useBasketSession, discoverOptions, discoverTemplates, type ChooserOption } from '../../state/basketSession';
import { useBasketState } from '../../state/basketState';
import { applyChooserPick } from '../../utils/basketUtils';
import { BasketListSheet } from './BasketListSheet';
import { Toast, type ToastHandle } from '../Toast';

/**
 * Souply 2.0 basket-session root host, mounted ONCE at the app root. Owns the
 * bits that must live ABOVE the navigator:
 *   · DISCOVERY — publishes the chooser options + "resumable basket exists"
 *     (dormant) flag to the store; the Naršyti chooser (BasketDockSheet, in the
 *     tab bar) renders off these.
 *   · the ACTIVE-session LIST sheet (BasketListSheet) — the persistent
 *     "collecting items" indicator that stays pinned across the shopping flow.
 *   · the CHOOSER modal (explicit "switch basket", when triggered).
 */

// The whole catalog tree (index, browse/L2, discounts, product, search) now
// lives under the Catalog tab, so one prefix covers every session surface. The
// root-level /search (receipt matching) is intentionally excluded.
const ROUTE_PREFIXES = ['/catalog'];

export function BasketSessionHost() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const pathname = usePathname();
    const { bottom: bottomInset } = useSafeAreaInsets();
    const { setDraftBasketId } = useBasketState();

    const target = useBasketSession(s => s.target);
    const barVisible = useBasketSession(s => s.barVisible);
    const chooserOpen = useBasketSession(s => s.chooserOpen);
    const chooserOptions = useBasketSession(s => s.chooserOptions);
    const closeChooser = useBasketSession(s => s.closeChooser);
    const setDormant = useBasketSession(s => s.setDormant);
    const setDockOptions = useBasketSession(s => s.setDockOptions);
    const setDockTemplates = useBasketSession(s => s.setDockTemplates);

    // Transient add-flow notice (e.g. "already in this basket" when a resumed
    // basket already holds the product) — surfaced app-wide from one toast.
    const addNotice = useBasketSession(s => s.addNotice);
    const toastRef = useRef<ToastHandle>(null);
    useEffect(() => {
        if (addNotice) toastRef.current?.show(t(addNotice.key));
    }, [addNotice, t]);

    const onSurface = ROUTE_PREFIXES.some(p => pathname === p || pathname.startsWith(`${p}/`));

    // ── DISCOVERY — publish chooser options + dormant flag to the store ───────
    useEffect(() => {
        if (!onSurface || (target != null && barVisible)) return;
        let alive = true;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        const check = (retriesLeft: number) => {
            // Baskets + templates together so `dormant` (does the chooser have
            // anything to show) reflects EITHER — a template-only user still gets
            // the swipe-up chooser. discoverTemplates never rejects.
            Promise.all([discoverOptions(), discoverTemplates()])
                .then(([opts, templates]) => {
                    if (!alive) return;
                    setDockOptions(opts ?? []);
                    setDockTemplates(templates);
                    const prev = opts?.find(o => o.key === 'previous') ?? opts?.find(o => o.key === 'family') ?? null;
                    setDormant(prev != null || templates.length > 0 ? { count: prev?.itemCount ?? 0 } : null);
                })
                .catch(() => {
                    if (alive && retriesLeft > 0) retryTimer = setTimeout(() => check(retriesLeft - 1), 1500);
                });
        };
        check(2);
        return () => { alive = false; if (retryTimer) clearTimeout(retryTimer); };
    }, [target, barVisible, onSurface, pathname, setDormant, setDockOptions]);

    const optionLabel = (o: ChooserOption) =>
        o.key === 'family' ? t('basketSession.optionFamily')
        : o.key === 'previous' ? t('basketSession.optionPrevious')
        : t('basketSession.optionNew');
    const optionIcon = (o: ChooserOption): keyof typeof Ionicons.glyphMap =>
        o.key === 'family' ? 'home-outline' : o.key === 'previous' ? 'cart-outline' : 'add-circle-outline';

    return (
        <>
            {/* Persistent active-session indicator (root-level, stable). */}
            <BasketListSheet />

            {/* Chooser modal — explicit "switch basket". */}
            <Modal visible={chooserOpen} transparent animationType="slide" onRequestClose={closeChooser}>
                <TouchableOpacity style={styles.chooserBackdrop} activeOpacity={1} onPress={closeChooser}>
                    <View style={[styles.chooserSheet, { paddingBottom: Math.max(bottomInset, 16) }]} onStartShouldSetResponder={() => true}>
                        <Text style={styles.chooserTitle}>{t('basketSession.chooserTitle')}</Text>
                        {chooserOptions.map(o => (
                            <TouchableOpacity
                                key={o.basketId ?? o.key}
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

            {/* App-wide add-flow toast (already-in-basket etc.). */}
            <Toast ref={toastRef} />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
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
