import { View, Text, TouchableOpacity, StyleSheet, Image, Dimensions } from 'react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, Easing, interpolate, runOnJS } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { SheetCard, SHEET_CARD_SHADOW_RADIUS } from '../SheetCard';
import { DockActionRow } from '../dock/DockActionRow';
import { FamilyShoppingPane } from './FamilyShoppingPane';
import { ReceiptUploadPane } from './ReceiptUploadPane';
import { useTheme, useResolvedScheme, spacing, radius, DIVIDER_ITEM_HEIGHT, type AppTheme } from '../../constants/theme';
import { useShoppingSheet } from '../../state/shoppingSheet';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import i18n from '../../i18n';

/**
 * Shopping-tab dock sheet content (shared/SMART_BASKET_SPEC.md §1–2):
 *   • date + status filters directly under the title (no card)
 *   • family list: toggle → members (owner removes, member leaves), invite sheet
 *   • "AI Basket" — gate → mode picker → staged AI progress → preview → accept.
 */

type Phase = 'menu' | 'loading' | 'gate' | 'preview';
type Mode = 'popular' | 'discounts' | 'personal';
type SheetView = 'main' | 'family' | 'upload';

const SCREEN_W = Dimensions.get('window').width;

interface PreviewItem {
    productId: number;
    name: string;
    imageUrls: unknown;
    quantity: number;
    isWeighable: boolean;
    source: 'personal' | 'both' | 'global';
    discountPct: number | null;
}

interface Preview {
    qualified: boolean;
    progress: { receipts: number; chains: number; needReceipts: number; needChains: number };
    slots: number;
    mode: Mode;
    items: PreviewItem[];
}

/** The 4 status filter options → trip stage sets (stage2 "Compared" folds
 *  into Forming — the trip is still being put together). */
/** Fake AI progress steps — the generation call is fast; this makes the work
 *  legible (and look substantial). Bar eases toward each checkpoint while the
 *  step label rotates; the real response is awaited alongside a minimum
 *  duration so the theatre always plays out. */
const AI_STEPS = ['aiStepReceipts', 'aiStepScores', 'aiStepPrices', 'aiStepBasket'] as const;
const AI_STEP_MS = 800;
const AI_MIN_MS = AI_STEPS.length * AI_STEP_MS;

const firstImage = (raw: unknown): string | null => {
    let v: unknown = raw;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
    if (!Array.isArray(v)) return null;
    const f = v.find(u => typeof u === 'string' && u.length > 0);
    return typeof f === 'string' ? f : null;
};

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function AiProgress() {
    const colors = useTheme();
    const { t } = useTranslation();
    const [step, setStep] = useState(0);
    const progress = useSharedValue(0);
    useEffect(() => {
        // Ease toward 95% across the steps; the bar completes on unmount
        // (preview swap) rather than stalling at 100% mid-wait.
        progress.value = withTiming(0.95, { duration: AI_MIN_MS + 600, easing: Easing.out(Easing.cubic) });
        const iv = setInterval(() => {
            setStep(s => Math.min(s + 1, AI_STEPS.length - 1));
        }, AI_STEP_MS);
        return () => clearInterval(iv);
    }, [progress]);
    const barStyle = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));
    return (
        <View style={{ alignItems: 'center', gap: spacing.md, paddingVertical: spacing.lg }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="sparkles" size={20} color={colors.primary} />
                <Text style={{ fontSize: 15, fontWeight: '700', color: colors.textPrimary }}>
                    {t(`smartBasket.${AI_STEPS[step]}`)}
                </Text>
            </View>
            <View style={{ alignSelf: 'stretch', height: 6, borderRadius: 3, backgroundColor: colors.surfaceMuted, overflow: 'hidden' }}>
                <Animated.View style={[{ height: 6, borderRadius: 3, backgroundColor: colors.primary }, barStyle]} />
            </View>
            <Text style={{ fontSize: 12, color: colors.textMuted }}>{t('smartBasket.generating')}</Text>
        </View>
    );
}

export function ShoppingSheet({ collapse }: { collapse: () => void }) {
    const colors = useTheme();
    const isDark = useResolvedScheme() === 'dark';
    const styles = useMemo(() => makeStyles(colors, isDark), [colors, isDark]);
    const { t } = useTranslation();

    const household = useShoppingSheet(s => s.household);
    const refreshTrips = useShoppingSheet(s => s.refreshTrips);

    // ── Top actions: family-shopping + receipt-upload (in-sheet panes) ───
    const [view, setView] = useState<SheetView>('main');

    // ── AI Basket flow ───────────────────────────────────────────────────
    const [phase, setPhase] = useState<Phase>('menu');
    const [preview, setPreview] = useState<Preview | null>(null);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const generationSeq = useRef(0);

    const generate = async (mode: Mode) => {
        setPhase('loading');
        setError(null);
        const seq = ++generationSeq.current;
        try {
            const uid = await getUserId();
            const call = fetch(`${API_BASE_URL}/api/smart-basket/preview`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-User-Id': uid,
                    'Accept-Language': i18n.language ?? 'lt',
                },
                body: JSON.stringify({ mode }),
            }).then(async res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json() as Promise<Preview>;
            });
            // The AI theatre always plays out its steps, even on a fast API.
            const [data] = await Promise.all([call, delay(AI_MIN_MS + 400)]);
            if (seq !== generationSeq.current) return; // superseded
            setPreview(data);
            setPhase(data.qualified ? 'preview' : 'gate');
        } catch {
            if (seq !== generationSeq.current) return;
            setError(t('smartBasket.error'));
            setPhase('menu');
        }
    };

    const removeItem = (productId: number) => {
        setPreview(prev => prev
            ? { ...prev, items: prev.items.filter(i => i.productId !== productId) }
            : prev);
    };

    const accept = async () => {
        if (!preview || preview.items.length === 0 || creating) return;
        setCreating(true);
        try {
            const uid = await getUserId();
            const bRes = await fetch(`${API_BASE_URL}/api/baskets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-User-Id': uid },
                body: JSON.stringify({ userId: uid, forceNew: true }),
            });
            if (!bRes.ok) throw new Error(`HTTP ${bRes.status}`);
            const basket = await bRes.json();
            // Bounded-concurrency add: the serial loop cost one round trip PER
            // item (20 items = 20 sequential waits behind one spinner). There
            // is no bulk basket-items endpoint (checked), so run 4 POSTs at a
            // time — workers pull from a shared cursor, preserving approximate
            // insertion order. Per-item failures stay non-fatal, as before.
            const toAdd = preview.items;
            let cursor = 0;
            const worker = async () => {
                while (cursor < toAdd.length) {
                    const item = toAdd[cursor++];
                    await fetch(`${API_BASE_URL}/api/basket-items`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-User-Id': uid },
                        body: JSON.stringify({ basketId: basket.id, productId: item.productId, quantity: item.quantity }),
                    }).catch(() => {});
                }
            };
            await Promise.all(Array.from({ length: Math.min(4, toAdd.length) }, worker));
            refreshTrips?.();
            setPhase('menu');
            setPreview(null);
            collapse();
        } catch {
            setError(t('smartBasket.error'));
        } finally {
            setCreating(false);
        }
    };

    const modeRow = (mode: Mode, icon: keyof typeof Ionicons.glyphMap, title: string, sub: string) => (
        <TouchableOpacity key={mode} style={styles.row} onPress={() => { void generate(mode); }}>
            <View style={styles.rowIcon}>
                <Ionicons name={icon} size={20} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{title}</Text>
                <Text style={styles.rowSub}>{sub}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </TouchableOpacity>
    );

    const sep = <View style={styles.sep} />;

    // ── In-sheet navigation: a horizontal push/pop between the main body and
    //    the sub-panes, matching the native screen transition — the incoming
    //    pane slides in from the right (main → sub), and Back reverses it. ──
    const [prevView, setPrevView] = useState<SheetView | null>(null);
    const slide = useSharedValue(1);   // 1 = settled
    const dir = useSharedValue(1);     // +1 forward (in from right), -1 back (in from left)
    const navigate = (to: SheetView) => {
        if (to === view) return;
        dir.value = to === 'main' ? -1 : 1;
        setPrevView(view);
        setView(to);
        slide.value = 0;
        slide.value = withTiming(1, { duration: 280, easing: Easing.out(Easing.cubic) }, (finished) => {
            if (finished) runOnJS(setPrevView)(null);
        });
    };
    const incomingStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: interpolate(slide.value, [0, 1], [dir.value * SCREEN_W, 0]) }],
    }));
    const outgoingStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: interpolate(slide.value, [0, 1], [0, -dir.value * SCREEN_W]) }],
    }));

    // Publish in-sheet nav to the Android back bridge (basket tab peels
    // sub-pane → main before collapsing the dock).
    const navigateRef = useRef(navigate);
    navigateRef.current = navigate;
    useEffect(() => { useShoppingSheet.getState().setSheetView(view); }, [view]);
    useEffect(() => {
        const s = useShoppingSheet.getState();
        s.setSheetGoBack(() => navigateRef.current('main'));
        return () => { s.setSheetGoBack(null); s.setSheetView('main'); };
    }, []);

    const renderView = (v: SheetView) => {
        if (v === 'family') return <FamilyShoppingPane onBack={() => navigate('main')} />;
        if (v === 'upload') return <ReceiptUploadPane onBack={() => navigate('main')} />;
        return renderMain();
    };

    return (
        <View style={styles.pager}>
            <Animated.View style={[styles.body, incomingStyle]}>
                {renderView(view)}
            </Animated.View>
            {prevView != null && (
                <Animated.View style={[styles.body, styles.pagerBelow, outgoingStyle]} pointerEvents="none">
                    {renderView(prevView)}
                </Animated.View>
            )}
        </View>
    );

    function renderMain() {
        return (
        <>
            <Text style={styles.sheetHeading}>{t('smartBasket.sheetTitle')}</Text>

            {/* ── Top actions: Family shopping + Receipt upload ─────────── */}
            <DockActionRow
                colors={colors}
                actions={[
                    {
                        icon: 'home',
                        title: t('smartBasket.familyTitle'),
                        subtitle: household
                            ? t('trips.householdMembers', { count: household.members.length })
                            : t('family.disabled'),
                        onPress: () => navigate('family'),
                    },
                    {
                        iconNode: (
                            <View style={styles.uploadIcon}>
                                <Ionicons name="receipt-outline" size={24} color={colors.primary} />
                                <View style={styles.uploadPlus}>
                                    <Ionicons name="add" size={11} color="#FFFFFF" />
                                </View>
                            </View>
                        ),
                        title: t('family.uploadTitle'),
                        subtitle: t('family.uploadSub'),
                        onPress: () => navigate('upload'),
                    },
                ]}
            />

            {/* ── AI Basket ───────────────────────────────────────────── */}
            <SheetCard>
                <Text style={styles.cardTitle}>{t('smartBasket.generateSection')}</Text>
                {error ? <Text style={styles.errorText}>{error}</Text> : null}

                {phase === 'menu' && (
                    <>
                        {modeRow('popular', 'trending-up', t('smartBasket.modePopular'), t('smartBasket.modePopularSub'))}
                        {sep}
                        {modeRow('discounts', 'pricetags-outline', t('smartBasket.modeDiscounts'), t('smartBasket.modeDiscountsSub'))}
                        {sep}
                        {modeRow('personal', 'person-outline', t('smartBasket.modePersonal'), t('smartBasket.modePersonalSub'))}
                    </>
                )}

                {phase === 'loading' && <AiProgress />}

                {phase === 'gate' && preview && (
                    <View style={{ gap: spacing.sm, paddingVertical: spacing.sm }}>
                        <Text style={styles.rowTitle}>{t('smartBasket.gateTitle')}</Text>
                        <Text style={styles.rowSub}>{t('smartBasket.gateBody')}</Text>
                        <Text style={styles.gateProgress}>
                            {t('smartBasket.gateProgress', {
                                receipts: preview.progress.receipts,
                                needReceipts: preview.progress.needReceipts,
                                chains: preview.progress.chains,
                                needChains: preview.progress.needChains,
                            })}
                        </Text>
                        <TouchableOpacity style={styles.backBtn} onPress={() => setPhase('menu')}>
                            <Text style={styles.backBtnText}>{t('common.back')}</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {phase === 'preview' && preview && (
                    <>
                        {preview.items.map((item, i) => (
                            <View key={item.productId}>
                                {i > 0 && sep}
                                <View style={styles.row}>
                                    {firstImage(item.imageUrls)
                                        ? <Image source={{ uri: firstImage(item.imageUrls)! }} style={styles.itemImage} />
                                        : <View style={[styles.itemImage, styles.itemImageFallback]}><Text style={{ opacity: 0.5 }}>🫜</Text></View>}
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.rowTitle} numberOfLines={2}>{item.name}</Text>
                                        <Text style={styles.rowSub}>
                                            {item.quantity} {item.isWeighable ? 'kg' : 'vnt.'}
                                            {item.discountPct ? `  ·  -${item.discountPct}%` : ''}
                                        </Text>
                                    </View>
                                    <TouchableOpacity onPress={() => removeItem(item.productId)} hitSlop={8}>
                                        <Ionicons name="close-circle-outline" size={22} color={colors.textMuted} />
                                    </TouchableOpacity>
                                </View>
                            </View>
                        ))}
                        {preview.items.length === 0 && (
                            <Text style={styles.rowSub}>{t('smartBasket.emptyPreview')}</Text>
                        )}
                        <View style={styles.previewActions}>
                            <TouchableOpacity style={styles.backBtn} onPress={() => { setPhase('menu'); setPreview(null); }}>
                                <Text style={styles.backBtnText}>{t('common.back')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[styles.createBtn, (creating || preview.items.length === 0) && { opacity: 0.5 }]}
                                onPress={() => { void accept(); }}
                                disabled={creating || preview.items.length === 0}
                            >
                                <Text style={styles.createBtnText}>
                                    {creating ? '…' : t('smartBasket.createBasket')}
                                </Text>
                            </TouchableOpacity>
                        </View>
                    </>
                )}
            </SheetCard>
        </>
        );
    }
}

const makeStyles = (c: AppTheme, _isDark: boolean) => StyleSheet.create({
    pager: { overflow: 'hidden' },
    pagerBelow: { position: 'absolute', top: 0, left: 0, right: 0 },
    // paddingBottom reserves the SheetCard shadow halo so the pager's
    // overflow:'hidden' (needed for the horizontal pane slide) can't clip it.
    body: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: SHEET_CARD_SHADOW_RADIUS, gap: spacing.md },
    sheetHeading: { fontSize: 22, fontWeight: '700', color: c.textPrimary, paddingTop: spacing.xs, paddingBottom: spacing.xs },
    cardTitle: { fontSize: 20, fontWeight: '800', color: c.textPrimary, paddingVertical: spacing.md },
    filterRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
    // Upload button glyph: receipt icon + a white "+" in a pink dot.
    uploadIcon: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
    uploadPlus: {
        position: 'absolute', top: -3, right: -4, width: 14, height: 14, borderRadius: 7,
        backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center',
        borderWidth: 1.5, borderColor: c.cardBackground,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 10 },
    rowIcon: {
        width: 40, height: 40, borderRadius: 20,
        backgroundColor: c.primaryMuted ?? c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center',
    },
    rowTitle: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
    rowSub: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
    sep: { height: DIVIDER_ITEM_HEIGHT, backgroundColor: c.dividerItem },
    gateProgress: { fontSize: 14, fontWeight: '700', color: c.primary },
    itemImage: { width: 44, height: 44, borderRadius: 8, backgroundColor: c.surfaceMuted },
    itemImageFallback: { alignItems: 'center', justifyContent: 'center' },
    previewActions: { flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.md },
    backBtn: {
        paddingHorizontal: 16, paddingVertical: 10, borderRadius: radius.pill,
        borderWidth: 1, borderColor: c.border, alignSelf: 'flex-start',
    },
    backBtnText: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
    createBtn: {
        flex: 1, paddingVertical: 10, borderRadius: radius.pill,
        backgroundColor: c.primary, alignItems: 'center',
    },
    createBtnText: { fontSize: 14, fontWeight: '800', color: c.onPrimary },
    errorText: { fontSize: 13, color: '#E53E3E', paddingBottom: spacing.xs },
});
