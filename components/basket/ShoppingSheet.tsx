import { View, Text, TouchableOpacity, StyleSheet, Image, Modal, Switch, Share } from 'react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, Easing } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { MaterialProgress } from '../MaterialProgress';
import { SheetCard } from '../SheetCard';
import { ConfirmModal } from '../ConfirmModal';
import { BrandedQR } from '../BrandedQR';
import { useTheme, useResolvedScheme, spacing, radius, DIVIDER_ITEM_HEIGHT, type AppTheme } from '../../constants/theme';
import { useShoppingSheet } from '../../state/shoppingSheet';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import {
    createOwnHousehold, fetchOwnHousehold, createHouseholdInviteUrl,
    leaveHousehold, removeHouseholdMember,
} from '../../utils/tripsApi';
import { formatDate } from '../../utils/formatCurrency';
import i18n from '../../i18n';

/**
 * Shopping-tab dock sheet content (shared/SMART_BASKET_SPEC.md §1–2):
 *   • date + status filters directly under the title (no card)
 *   • family list: toggle → members (owner removes, member leaves), invite sheet
 *   • "AI Basket" — gate → mode picker → staged AI progress → preview → accept.
 */

type Phase = 'menu' | 'loading' | 'gate' | 'preview';
type Mode = 'popular' | 'discounts' | 'personal';

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

    const [myId, setMyId] = useState<string | null>(null);
    useEffect(() => { void getUserId().then(setMyId); }, []);

    // ── Family section ───────────────────────────────────────────────────
    const [familyOpen, setFamilyOpen] = useState(false);
    const [familyBusy, setFamilyBusy] = useState(false);
    const [inviteOpen, setInviteOpen] = useState(false);
    const [inviteUrl, setInviteUrl] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<
        | { kind: 'remove'; userId: string }
        | { kind: 'leave' }
        | null
    >(null);
    const [confirmBusy, setConfirmBusy] = useState(false);

    const refreshHousehold = async () => {
        const hh = await fetchOwnHousehold().catch(() => null);
        useShoppingSheet.getState().setHousehold(hh);
    };

    const onFamilyToggle = async (on: boolean) => {
        setFamilyOpen(on);
        if (on && !household && !familyBusy) {
            // First enable mints the household (the old create-card behavior).
            setFamilyBusy(true);
            try {
                await createOwnHousehold();
                await refreshHousehold();
                refreshTrips?.();
            } catch { setFamilyOpen(false); }
            finally { setFamilyBusy(false); }
        }
    };

    const openInvite = async () => {
        setInviteOpen(true);
        setInviteUrl(null);
        try { setInviteUrl(await createHouseholdInviteUrl()); }
        catch { setInviteOpen(false); }
    };

    const runConfirm = async () => {
        if (!confirm || confirmBusy) return;
        setConfirmBusy(true);
        try {
            if (confirm.kind === 'remove') await removeHouseholdMember(confirm.userId);
            else await leaveHousehold();
            await refreshHousehold();
            refreshTrips?.();
            if (confirm.kind === 'leave') setFamilyOpen(false);
            setConfirm(null);
        } catch { /* keep modal open — user can retry/cancel */ }
        finally { setConfirmBusy(false); }
    };

    const isOwner = household?.role === 'owner';
    const memberLabel = (m: { userId: string; joinedAt: string }, idx: number): string =>
        m.userId === myId ? t('smartBasket.familyYou') : t('smartBasket.familyMember', { n: idx + 1 });

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
            for (const item of preview.items) {
                await fetch(`${API_BASE_URL}/api/basket-items`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-User-Id': uid },
                    body: JSON.stringify({ basketId: basket.id, productId: item.productId, quantity: item.quantity }),
                }).catch(() => {});
            }
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

    return (
        <View style={styles.body}>
            <Text style={styles.sheetHeading}>{t('smartBasket.sheetTitle')}</Text>



            {/* ── Family list ─────────────────────────────────────────── */}
            <SheetCard>
                <View style={styles.row}>
                    <View style={styles.rowIcon}>
                        <Ionicons name="home-outline" size={20} color={colors.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.rowTitle}>{household?.name ?? t('smartBasket.familyTitle')}</Text>
                        {household ? (
                            <Text style={styles.rowSub}>{t('trips.householdMembers', { count: household.members.length })}</Text>
                        ) : null}
                    </View>
                    {familyBusy
                        ? <MaterialProgress size="small" color={colors.primary} />
                        : (
                            <Switch
                                value={familyOpen}
                                onValueChange={(v) => { void onFamilyToggle(v); }}
                                trackColor={{ false: colors.border, true: colors.primary }}
                                thumbColor={colors.onPrimary}
                            />
                        )}
                </View>
                {familyOpen && household && (
                    <>
                        {sep}
                        {isOwner && (
                            <TouchableOpacity style={styles.row} onPress={() => { void openInvite(); }}>
                                <View style={[styles.rowIcon, styles.addIcon]}>
                                    <Ionicons name="person-add" size={18} color={colors.onPrimary} />
                                </View>
                                <Text style={styles.rowTitle}>{t('smartBasket.familyAddMember')}</Text>
                            </TouchableOpacity>
                        )}
                        {household.members.map((m, idx) => (
                            <View key={m.userId}>
                                {(isOwner || idx > 0) && sep}
                                <View style={styles.row}>
                                    <View style={styles.rowIcon}>
                                        <Ionicons name={m.role === 'owner' ? 'star-outline' : 'person-outline'} size={18} color={colors.primary} />
                                    </View>
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.rowTitle}>{memberLabel(m, idx)}</Text>
                                        <Text style={styles.rowSub}>{formatDate(m.joinedAt)}</Text>
                                    </View>
                                    {isOwner && m.userId !== myId && (
                                        <TouchableOpacity onPress={() => setConfirm({ kind: 'remove', userId: m.userId })} hitSlop={8}>
                                            <Ionicons name="close-circle-outline" size={22} color={colors.textMuted} />
                                        </TouchableOpacity>
                                    )}
                                </View>
                            </View>
                        ))}
                        {!isOwner && (
                            <>
                                {sep}
                                <TouchableOpacity style={styles.row} onPress={() => setConfirm({ kind: 'leave' })}>
                                    <View style={[styles.rowIcon, styles.leaveIcon]}>
                                        <Ionicons name="exit-outline" size={18} color="#E53E3E" />
                                    </View>
                                    <Text style={[styles.rowTitle, { color: '#E53E3E' }]}>{t('smartBasket.familyLeave')}</Text>
                                </TouchableOpacity>
                            </>
                        )}
                    </>
                )}
            </SheetCard>

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

            {/* ── Invite sheet (Add new member) ───────────────────────── */}
            <Modal visible={inviteOpen} transparent animationType="slide" onRequestClose={() => setInviteOpen(false)}>
                <TouchableOpacity style={styles.inviteBackdrop} activeOpacity={1} onPress={() => setInviteOpen(false)}>
                    <View style={styles.inviteSheet} onStartShouldSetResponder={() => true}>
                        <View style={styles.grabber} />
                        <Text style={styles.inviteTitle}>{t('smartBasket.inviteTitle')}</Text>
                        <Text style={styles.rowSub}>{t('smartBasket.inviteBody')}</Text>
                        <View style={styles.qrWrap}>
                            {inviteUrl
                                ? <BrandedQR value={inviteUrl} size={200} />
                                : <MaterialProgress size="large" color={colors.primary} />}
                        </View>
                        <TouchableOpacity
                            style={[styles.createBtn, !inviteUrl && { opacity: 0.5 }]}
                            disabled={!inviteUrl}
                            onPress={() => { if (inviteUrl) void Share.share({ message: inviteUrl }); }}
                        >
                            <Text style={styles.createBtnText}>{t('smartBasket.inviteShare')}</Text>
                        </TouchableOpacity>
                    </View>
                </TouchableOpacity>
            </Modal>

            <ConfirmModal
                visible={confirm != null}
                title={confirm?.kind === 'leave' ? t('smartBasket.leaveTitle') : t('smartBasket.removeTitle')}
                body={confirm?.kind === 'leave' ? t('smartBasket.leaveBody') : t('smartBasket.removeBody')}
                confirmLabel={confirm?.kind === 'leave' ? t('smartBasket.familyLeave') : t('smartBasket.removeConfirm')}
                cancelLabel={t('common.cancel')}
                destructive
                busy={confirmBusy}
                onConfirm={() => { void runConfirm(); }}
                onClose={() => { if (!confirmBusy) setConfirm(null); }}
            />
        </View>
    );
}

const makeStyles = (c: AppTheme, _isDark: boolean) => StyleSheet.create({
    body: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.sm, gap: spacing.md },
    sheetHeading: { fontSize: 22, fontWeight: '700', color: c.textPrimary, paddingTop: spacing.xs, paddingBottom: spacing.xs },
    cardTitle: { fontSize: 20, fontWeight: '800', color: c.textPrimary, paddingVertical: spacing.md },
    filterRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 10 },
    rowIcon: {
        width: 40, height: 40, borderRadius: 20,
        backgroundColor: c.primaryMuted ?? c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center',
    },
    addIcon: { backgroundColor: c.primary },
    leaveIcon: { backgroundColor: 'rgba(229,62,62,0.12)' },
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
    inviteBackdrop: { flex: 1, backgroundColor: c.overlayBackdrop, justifyContent: 'flex-end' },
    inviteSheet: {
        backgroundColor: c.cardBackground,
        borderTopLeftRadius: radius.xl ?? 24, borderTopRightRadius: radius.xl ?? 24,
        padding: spacing.xl, gap: spacing.sm, alignItems: 'stretch',
    },
    grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: c.border, marginBottom: spacing.sm },
    inviteTitle: { fontSize: 18, fontWeight: '800', color: c.textPrimary },
    qrWrap: { alignItems: 'center', paddingVertical: spacing.lg, minHeight: 220, justifyContent: 'center' },
});
