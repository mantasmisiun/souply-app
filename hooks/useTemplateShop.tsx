import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../constants/theme';
import { compareBasket } from '../utils/basketCalc';
import { loadCachedCoords, tryGpsCoords, VILNIUS_FALLBACK } from '../utils/location';
import { getUserId } from '../config/user';
import { instantiateTemplate, type BasketTemplateDetail } from '../utils/basketTemplatesApi';

/**
 * THE recipe → shopping-basket flow ("Parduotuvės ›"): pantry keep-or-drop,
 * instantiate (with the resume-or-new choice when an in-progress instance
 * exists), then the silent comparison — resolve a position the way basket
 * detail does (cached fix ≤30 min → GPS → Vilnius centre), run the shared
 * compareBasket, and only then hand off to navigation. Extracted from the
 * recipe detail screen so the catalog session bar's Parduotuvės pill runs the
 * IDENTICAL flow instead of a re-implementation; the only thing that
 * legitimately differs between the two callers is where each lands afterwards,
 * which is why navigation comes in as callbacks and everything else lives here.
 *
 * A calc failure must NOT strand the shopper or lose the basket that was just
 * created: surface basket detail's own calc error, then `onCalcFailed` opens
 * the basket screen, where the normal "Rasti parduotuves" button retries.
 * `busy` covers the WHOLE leg (create + compare + hand-off), so a caller's
 * spinner never reads "done" while the calc is still working.
 */

/** The slice of a template the flow needs — the detail screen passes its live
 *  copy; the session bar fetches a fresh one at tap time. */
export type TemplateShopDetail = Pick<BasketTemplateDetail, 'id' | 'items'>;

export interface TemplateShopNav {
    /** Basket created AND priced (status 'compared') — open the stores map. */
    onCompared: (basketId: number) => void;
    /** The comparison failed after the basket was created (the error alert has
     *  already been shown) — open the basket screen so the shopper can retry. */
    onCalcFailed: (basketId: number) => void;
    /** "Tęsti" on the resume-or-new choice — open the in-progress basket. */
    onResume: (basketId: number) => void;
}

export function useTemplateShop(opts: {
    /** Resolve the template about to be shopped. Invoked on EVERY start, so an
     *  edit made seconds before the tap is what gets instantiated. A rejection
     *  surfaces as the instantiate error alert. */
    getDetail: () => Promise<TemplateShopDetail>;
    nav: TemplateShopNav;
}) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    // Callers pass inline objects — refs keep the latest without re-wiring the
    // callbacks below every render (and without stale-closure surprises).
    const getDetailRef = useRef(opts.getDetail);
    getDetailRef.current = opts.getDetail;
    const navRef = useRef(opts.nav);
    navRef.current = opts.nav;

    const [busy, setBusy] = useState(false);
    // Set to an existing in-progress basket's id when the server says one is
    // resumable → opens the Souply-themed "continue or start new" choice.
    const [resumeBasketId, setResumeBasketId] = useState<number | null>(null);
    /** The detail snapshot the current attempt runs against (feeds the pantry
     *  sheet's rows). */
    const [detail, setDetail] = useState<TemplateShopDetail | null>(null);
    const [pantryOpen, setPantryOpen] = useState(false);
    /** Ticked-off staples while the sheet is open; committed on confirm. */
    const [pantryDraft, setPantryDraft] = useState<Set<number>>(new Set());
    /**
     * Staples the shopper says they already have, chosen JUST BEFORE the basket
     * is made. The recipe itself is never edited by this — salt is part of the
     * recipe whether or not the cupboard has any today. `choice: null` means the
     * choice has not been offered yet, which is what makes the sheet open
     * exactly once per attempt. KEYED by template id in a ref (read
     * synchronously by `start`): the session-bar host never unmounts, so recipe
     * A's "I have salt" must not silently skip recipe B's sheet.
     */
    const flowRef = useRef<{ templateId: number; choice: Set<number> | null } | null>(null);

    /** The recipe's cupboard staples (isPantry = 1), in list order. */
    const pantryItems = useMemo(
        () => (detail?.items ?? []).filter(it => Number(it.isPantry) === 1),
        [detail],
    );

    /**
     * The silent leg between "the basket exists" and "pick a store on the
     * map": cached fix (≤30 min) → GPS → Vilnius centre, then the shared
     * comparison (utils/basketCalc's compareBasket: candidate pool, POST
     * /calculate, both cache keys, persistCoords). No address modal here: the
     * one-tap promise beats a perfect origin, and the map's own location
     * settings can re-run the calc from anywhere.
     */
    const compareAndGo = useCallback(async (basketId: number) => {
        try {
            const coords = (await loadCachedCoords()) ?? (await tryGpsCoords()) ?? VILNIUS_FALLBACK;
            await compareBasket(basketId, coords);
            navRef.current.onCompared(basketId);
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketDetail.errorCalculate'));
            navRef.current.onCalcFailed(basketId);
        }
    }, [t]);

    const runInstantiate = useCallback(async (templateId: number, force: boolean, skip: number[]) => {
        try {
            setBusy(true);
            const userId = await getUserId();
            const result = await instantiateTemplate(templateId, userId, {
                force,
                skipPantryProductIds: skip,
            });
            // The pantry-confirm path reaches here WITHOUT the resume check the
            // main entry does — honour it here too, or an in-progress basket
            // would be silently re-compared.
            if (!force && result.action === 'resume') {
                setResumeBasketId(result.basketId);
                return;
            }
            // Created → the comparison runs inside the same busy window, so the
            // caller's spinner covers the whole leg.
            await compareAndGo(result.basketId);
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorInstantiate'));
        } finally {
            setBusy(false);
        }
    }, [compareAndGo, t]);

    /** Entry point — the caller's Parduotuvės pill. */
    const start = useCallback(async () => {
        if (busy) return;
        setBusy(true);
        try {
            let d: TemplateShopDetail;
            try {
                d = await getDetailRef.current();
            } catch {
                Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorInstantiate'));
                return;
            }
            setDetail(d);
            // A different recipe than the last attempt → its pantry choice and
            // half-ticked draft are void.
            if (flowRef.current?.templateId !== d.id) {
                flowRef.current = { templateId: d.id, choice: null };
                setPantryDraft(new Set());
            }
            /**
             * ASK BEFORE BUYING SALT AGAIN. A recipe carries its staples for
             * good; whether THIS trip needs them is a different question, and it
             * is the shopper's to answer — offered once per attempt (`choice`
             * is set, possibly to an empty set, by the sheet's confirm).
             */
            const pantry = d.items.filter(it => Number(it.isPantry) === 1);
            if (pantry.length > 0 && flowRef.current.choice === null) {
                setPantryOpen(true);
                return;
            }
            await runInstantiate(d.id, false, [...(flowRef.current.choice ?? [])]);
        } finally {
            setBusy(false);
        }
    }, [busy, runInstantiate, t]);

    /** The two flow modals — render these once, anywhere in the caller's tree. */
    const modals = (
        <>
            {/*
              * "What do you already have?" — the ONLY place a staple can be
              * dropped. Default is keep: nothing leaves the basket unless the
              * shopper says so, and the recipe is untouched either way.
              */}
            <Modal
                visible={pantryOpen}
                transparent
                animationType="fade"
                statusBarTranslucent
                onRequestClose={() => setPantryOpen(false)}
            >
                <Pressable style={styles.resumeBackdrop} onPress={() => setPantryOpen(false)}>
                    <Pressable style={styles.resumeCard} onPress={() => {}}>
                        <Text style={styles.resumeTitle}>{t('basketTab.templates.pantryTitle')}</Text>
                        <Text style={styles.resumeBody}>{t('basketTab.templates.pantryBody')}</Text>

                        <ScrollView style={styles.pantryList} bounces={false}>
                            {pantryItems.map(it => {
                                const dropped = pantryDraft.has(it.productId);
                                return (
                                    <TouchableOpacity
                                        key={it.id}
                                        style={styles.pantryRow}
                                        activeOpacity={0.7}
                                        onPress={() => setPantryDraft(prev => {
                                            const next = new Set(prev);
                                            if (next.has(it.productId)) next.delete(it.productId);
                                            else next.add(it.productId);
                                            return next;
                                        })}
                                    >
                                        <Ionicons
                                            name={dropped ? 'checkbox' : 'square-outline'}
                                            size={22}
                                            color={dropped ? colors.primary : colors.textSecondary}
                                        />
                                        <Text
                                            style={[styles.pantryName, dropped && styles.pantryNameDropped]}
                                            numberOfLines={1}
                                        >
                                            {it.productName}
                                        </Text>
                                    </TouchableOpacity>
                                );
                            })}
                        </ScrollView>

                        <TouchableOpacity
                            style={styles.resumeCancelBtn}
                            activeOpacity={0.7}
                            onPress={() => setPantryDraft(prev =>
                                prev.size === pantryItems.length
                                    ? new Set()
                                    : new Set(pantryItems.map(it => it.productId)))}
                        >
                            <Text style={styles.resumeCancelText}>
                                {t(pantryDraft.size === pantryItems.length
                                    ? 'basketTab.templates.pantryKeepAll'
                                    : 'basketTab.templates.pantryRemoveAll')}
                            </Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={styles.resumePrimaryBtn}
                            activeOpacity={0.85}
                            onPress={() => {
                                setPantryOpen(false);
                                // Commit the choice AND carry it into this attempt
                                // explicitly — state has not re-rendered yet when
                                // runInstantiate needs the list.
                                const skip = [...pantryDraft];
                                if (flowRef.current) flowRef.current.choice = new Set(pantryDraft);
                                const tid = flowRef.current?.templateId;
                                if (tid != null) void runInstantiate(tid, false, skip);
                            }}
                        >
                            <Text style={styles.resumePrimaryText}>{t('basketTab.templates.pantryConfirm')}</Text>
                        </TouchableOpacity>
                    </Pressable>
                </Pressable>
            </Modal>

            {/* Resume-or-new choice (Souply-themed, replaces the native Alert). */}
            <Modal
                visible={resumeBasketId !== null}
                transparent
                animationType="fade"
                statusBarTranslucent
                onRequestClose={() => setResumeBasketId(null)}
            >
                <Pressable style={styles.resumeBackdrop} onPress={() => setResumeBasketId(null)}>
                    <Pressable style={styles.resumeCard} onPress={() => {}}>
                        <Text style={styles.resumeTitle}>{t('basketTab.templates.resumeTitle')}</Text>
                        <Text style={styles.resumeBody}>{t('basketTab.templates.resumeBody')}</Text>
                        <TouchableOpacity
                            style={styles.resumePrimaryBtn}
                            activeOpacity={0.85}
                            onPress={() => {
                                const bid = resumeBasketId;
                                setResumeBasketId(null);
                                if (bid != null) navRef.current.onResume(bid);
                            }}
                        >
                            <Text style={styles.resumePrimaryText}>{t('basketTab.templates.resumeContinue')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.resumeSecondaryBtn}
                            activeOpacity={0.85}
                            onPress={() => {
                                setResumeBasketId(null);
                                const tid = flowRef.current?.templateId;
                                if (tid != null) void runInstantiate(tid, true, [...(flowRef.current?.choice ?? [])]);
                            }}
                        >
                            <Text style={styles.resumeSecondaryText}>{t('basketTab.templates.resumeNew')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.resumeCancelBtn} activeOpacity={0.7} onPress={() => setResumeBasketId(null)}>
                            <Text style={styles.resumeCancelText}>{t('basketTab.templates.resumeBasketCancel')}</Text>
                        </TouchableOpacity>
                    </Pressable>
                </Pressable>
            </Modal>
        </>
    );

    return { start, busy, modals };
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    // The pantry sheet reuses the resume choice's card chrome — one modal
    // language for both flow questions.
    pantryList: { maxHeight: 260, marginBottom: 12 },
    pantryRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
    pantryName: { flex: 1, fontSize: 15, fontWeight: '600', color: c.textPrimary },
    pantryNameDropped: { color: c.textSecondary, textDecorationLine: 'line-through' },
    resumeBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 28 },
    resumeCard: { width: '100%', maxWidth: 420, backgroundColor: c.cardBackground, borderRadius: 22, padding: 22 },
    resumeTitle: { fontSize: 18, fontWeight: '800', color: c.textPrimary, textAlign: 'center' },
    resumeBody: { fontSize: 14, color: c.textSecondary, textAlign: 'center', marginTop: 8, marginBottom: 18, lineHeight: 20 },
    resumePrimaryBtn: { backgroundColor: c.primary, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
    resumePrimaryText: { color: c.onPrimary, fontSize: 15, fontWeight: '700' },
    resumeSecondaryBtn: { marginTop: 10, borderRadius: 14, paddingVertical: 14, alignItems: 'center', borderWidth: 1.5, borderColor: c.primary },
    resumeSecondaryText: { color: c.primary, fontSize: 15, fontWeight: '700' },
    resumeCancelBtn: { marginTop: 6, paddingVertical: 12, alignItems: 'center' },
    resumeCancelText: { color: c.textSecondary, fontSize: 15, fontWeight: '600' },
});
