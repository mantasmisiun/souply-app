import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ScrollView,
    Modal,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import Animated from 'react-native-reanimated';
import { useCollapsingHeader, CollapsingHeader } from '../../components/CollapsingHeader';
import { ScreenHeading } from '../../components/ScreenHeading';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as Updates from 'expo-updates';
import { useTheme, type AppTheme } from '../../constants/theme';
import {
    extractRecoveryFieldsFromFile,
    type RecoveryReceiptExtract,
} from '../../services/recoveryOcr';
import { attemptRestore } from '../../services/restoreClient';
import { formatEuro, formatDate } from '../../utils/formatCurrency';

/**
 * 3-receipt account recovery screen.
 *
 * Flow:
 *   1. User taps "Pridėti failus" → multi-select images and/or PDFs.
 *   2. Each picked file fills one of three slots; on-device OCR
 *      extracts {receiptNo, date, total, chainHint} per slot.
 *   3. When all 3 slots are filled, the submit button enables.
 *   4. Submit → POST /api/users/recover. On success, the recovered
 *      UUID is adopted locally and the app reloads via `expo-updates`
 *      so every Zustand store hydrates against the new identity.
 *   5. On any failure → generic modal "Couldn't identify account, try
 *      later" (per spec; attempts-remaining isn't surfaced).
 */

type Slot =
    | { state: 'empty' }
    | { state: 'processing' }
    | { state: 'invalid' }
    | { state: 'filled'; extract: RecoveryReceiptExtract };

const EMPTY_SLOTS: Slot[] = [{ state: 'empty' }, { state: 'empty' }, { state: 'empty' }];

export default function RestoreAccountScreen() {
    const router = useRouter();
    const header = useCollapsingHeader();
    const { t } = useTranslation();
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const [slots, setSlots] = useState<Slot[]>(EMPTY_SLOTS);
    const [submitting, setSubmitting] = useState(false);
    const [failedOpen, setFailedOpen] = useState(false);
    const [lockedOpen, setLockedOpen] = useState(false);
    // Once the server says locked, every subsequent attempt will be locked
    // for the next 24h. Persist that fact in component state so the user
    // can't keep tapping submit/add — they'd burn cycles getting the same
    // "locked" response with no useful action available. Resets when the
    // screen unmounts (closing + reopening the screen gives them a fresh
    // chance to try; the server will re-lock instantly if 24h hasn't
    // passed, but at least the UI doesn't feel broken).
    const [locked, setLocked] = useState(false);
    const [successOpen, setSuccessOpen] = useState(false);

    const filledCount = slots.filter(s => s.state === 'filled').length;
    const submitEnabled = filledCount === 3 && !submitting && !locked;
    const pickEnabled = !locked && !submitting;

    const onPickFiles = useCallback(async () => {
        if (!pickEnabled) return;
        const picked = await DocumentPicker.getDocumentAsync({
            type: ['image/*', 'application/pdf'],
            copyToCacheDirectory: true,
            multiple: true,
        });
        if (picked.canceled || !picked.assets?.length) return;

        // Fill slots left-to-right with the picked files. If the user picks
        // more than empty slots can hold, the extras are silently dropped —
        // a future "swap into slot" interaction isn't worth the complexity
        // for v1 (the user can always tap Pridėti again).
        const emptyIndices: number[] = [];
        slots.forEach((s, i) => { if (s.state !== 'filled') emptyIndices.push(i); });
        const pairs = picked.assets.slice(0, emptyIndices.length).map((asset, k) => ({
            slotIdx: emptyIndices[k],
            uri: asset.uri,
        }));

        // Set every targeted slot to 'processing' up front so the user sees
        // immediate feedback while OCR runs sequentially in the background.
        setSlots(prev => prev.map((s, i) =>
            pairs.some(p => p.slotIdx === i) ? { state: 'processing' } : s,
        ));

        // Run extractions one at a time. OCR is CPU-bound — parallelising
        // doesn't help on a single-threaded RN bridge and risks OOM on
        // PDF-heavy picks.
        for (const { slotIdx, uri } of pairs) {
            const extract = await extractRecoveryFieldsFromFile(uri);
            setSlots(prev => prev.map((s, i) => {
                if (i !== slotIdx) return s;
                return extract
                    ? { state: 'filled', extract }
                    : { state: 'invalid' };
            }));
        }
    }, [slots]);

    const onClearSlot = useCallback((idx: number) => {
        setSlots(prev => prev.map((s, i) => i === idx ? { state: 'empty' } : s));
    }, []);

    const onReloadApp = useCallback(() => {
        Updates.reloadAsync().catch(e => {
            console.warn('[restore] reloadAsync failed', e);
            // Fallback when running in dev (Expo Go has no OTA-style
            // reload): bounce to root so the auth memo at least re-reads
            // AsyncStorage and downstream screens re-fetch.
            router.replace('/');
        });
    }, [router]);

    const onSubmit = useCallback(async () => {
        const filled = slots.filter(s => s.state === 'filled') as Extract<Slot, { state: 'filled' }>[];
        if (filled.length !== 3) return;

        setSubmitting(true);
        try {
            const result = await attemptRestore(
                filled.map(s => ({
                    receiptNo: s.extract.receiptNo,
                    receiptNos: s.extract.receiptNos,
                    date: s.extract.date,
                    total: s.extract.total,
                })),
            );

            if (result.status === 'success') {
                // Tap-driven reload (not auto) so the user clearly sees
                // *why* the app is about to restart — recovery only
                // becomes visible after stores re-hydrate against the
                // recovered UUID, and a silent restart looks like a crash.
                setSuccessOpen(true);
            } else if (result.status === 'locked') {
                // Distinct modal copy + persistent button-disable so the
                // user doesn't keep tapping a button that will burn 24h+
                // of rate-limit budget on every press.
                setLocked(true);
                setLockedOpen(true);
            } else {
                setFailedOpen(true);
            }
        } catch (e) {
            console.warn('[restore] submit failed', e);
            setFailedOpen(true);
        } finally {
            setSubmitting(false);
        }
    }, [slots, router]);

    return (
        <View style={styles.page}>
            <CollapsingHeader
                controller={header}
                back
            />
            <Animated.ScrollView {...header.scroll} contentContainerStyle={[styles.scroll, { paddingTop: header.paddingTop + 20 }]}>
                <ScreenHeading title={t('restore.title')} />
                <Text style={styles.intro}>{t('restore.intro')}</Text>

                {slots.map((slot, idx) => (
                    <SlotCard
                        key={idx}
                        slot={slot}
                        onClear={() => onClearSlot(idx)}
                        colors={colors}
                        styles={styles}
                        t={t}
                    />
                ))}

                <TouchableOpacity
                    style={[styles.addBtn, !pickEnabled && styles.addBtnDisabled]}
                    onPress={onPickFiles}
                    disabled={!pickEnabled}
                >
                    <Ionicons name="add" size={18} color={pickEnabled ? colors.primary : colors.textMuted} />
                    <Text style={[styles.addBtnText, !pickEnabled && styles.addBtnTextDisabled]}>
                        {t('restore.addFiles')}
                    </Text>
                </TouchableOpacity>
            </Animated.ScrollView>

            <View style={styles.footer}>
                <TouchableOpacity
                    style={[styles.submitBtn, !submitEnabled && styles.submitBtnDisabled]}
                    onPress={onSubmit}
                    disabled={!submitEnabled}
                >
                    {submitting ? (
                        <MaterialProgress color={colors.onPrimary} />
                    ) : (
                        <Text style={styles.submitBtnText}>{t('restore.submit')}</Text>
                    )}
                </TouchableOpacity>
            </View>

            <Modal visible={failedOpen} transparent animationType="fade" onRequestClose={() => setFailedOpen(false)}>
                <View style={styles.modalBackdrop}>
                    <View style={styles.modalCard}>
                        <Ionicons name="alert-circle-outline" size={48} color={colors.error} />
                        <Text style={styles.modalTitle}>{t('restore.failedTitle')}</Text>
                        <Text style={styles.modalBody}>{t('restore.failedBody')}</Text>
                        <TouchableOpacity style={styles.modalBtn} onPress={() => setFailedOpen(false)}>
                            <Text style={styles.modalBtnText}>{t('restore.failedClose')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>

            <Modal visible={lockedOpen} transparent animationType="fade" onRequestClose={() => setLockedOpen(false)}>
                <View style={styles.modalBackdrop}>
                    <View style={styles.modalCard}>
                        <Ionicons name="lock-closed-outline" size={48} color={colors.warning} />
                        <Text style={styles.modalTitle}>{t('restore.lockedTitle')}</Text>
                        <Text style={styles.modalBody}>{t('restore.lockedBody')}</Text>
                        <TouchableOpacity style={styles.modalBtn} onPress={() => setLockedOpen(false)}>
                            <Text style={styles.modalBtnText}>{t('restore.lockedClose')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>

            <Modal visible={successOpen} transparent animationType="fade">
                <View style={styles.modalBackdrop}>
                    <View style={styles.modalCard}>
                        <Ionicons name="checkmark-circle-outline" size={48} color={colors.success} />
                        <Text style={styles.modalTitle}>{t('restore.successTitle')}</Text>
                        <Text style={styles.modalBody}>{t('restore.successBody')}</Text>
                        <TouchableOpacity style={styles.modalBtn} onPress={onReloadApp}>
                            <Text style={styles.modalBtnText}>{t('restore.successReload')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>
        </View>
    );
}

function SlotCard({
    slot, onClear, colors, styles, t,
}: {
    slot: Slot;
    onClear: () => void;
    colors: AppTheme;
    styles: ReturnType<typeof makeStyles>;
    t: ReturnType<typeof useTranslation>['t'];
}) {
    if (slot.state === 'empty') {
        return (
            <View style={[styles.slot, styles.slotEmpty]}>
                <Ionicons name="document-outline" size={22} color={colors.textMuted} />
                <Text style={styles.slotEmptyText}>{t('restore.slotEmpty')}</Text>
            </View>
        );
    }
    if (slot.state === 'processing') {
        return (
            <View style={[styles.slot, styles.slotProcessing]}>
                <MaterialProgress color={colors.primary} />
                <Text style={styles.slotProcessingText}>{t('restore.slotProcessing')}</Text>
            </View>
        );
    }
    if (slot.state === 'invalid') {
        return (
            <TouchableOpacity style={[styles.slot, styles.slotInvalid]} onPress={onClear}>
                <Ionicons name="alert-circle-outline" size={22} color={colors.error} />
                <Text style={styles.slotInvalidText}>{t('restore.slotInvalid')}</Text>
            </TouchableOpacity>
        );
    }
    // filled
    return (
        <View style={[styles.slot, styles.slotFilled]}>
            <Ionicons name="checkmark-circle" size={22} color={colors.success} />
            <View style={styles.slotFilledBody}>
                <Text style={styles.slotChain}>{slot.extract.chainName}</Text>
                <Text style={styles.slotMeta}>
                    {formatDate(slot.extract.date)} · {formatEuro(slot.extract.total)}
                </Text>
                <Text style={styles.slotReceiptNo} numberOfLines={1}>
                    № {slot.extract.receiptNo}
                </Text>
            </View>
            <TouchableOpacity onPress={onClear} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close" size={20} color={colors.textMuted} />
            </TouchableOpacity>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    page: { flex: 1, backgroundColor: c.pageBackground },
    scroll: { padding: 20, paddingBottom: 32, gap: 12 },
    intro: { fontSize: 14, color: c.textSecondary, lineHeight: 20, marginBottom: 16 },

    slot: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        padding: 14,
        borderRadius: 12,
        borderWidth: 1,
        backgroundColor: c.cardBackground,
    },
    slotEmpty: { borderColor: c.border, borderStyle: 'dashed' },
    slotEmptyText: { fontSize: 14, color: c.textMuted },
    slotProcessing: { borderColor: c.border },
    slotProcessingText: { fontSize: 14, color: c.textSecondary },
    slotInvalid: { borderColor: c.error },
    slotInvalidText: { fontSize: 14, color: c.error, flex: 1 },
    slotFilled: { borderColor: c.success },
    slotFilledBody: { flex: 1 },
    slotChain: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
    slotMeta: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
    slotReceiptNo: { fontSize: 12, color: c.textMuted, marginTop: 2 },

    addBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingVertical: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: c.primary,
        marginTop: 4,
    },
    addBtnDisabled: { borderColor: c.border },
    addBtnText: { fontSize: 14, fontWeight: '600', color: c.primary },
    addBtnTextDisabled: { color: c.textMuted },

    footer: { padding: 16, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.cardBackground },
    submitBtn: {
        backgroundColor: c.primary,
        paddingVertical: 14,
        borderRadius: 12,
        alignItems: 'center',
    },
    submitBtnDisabled: { backgroundColor: c.surfaceMuted },
    submitBtnText: { color: c.onPrimary, fontSize: 16, fontWeight: '700' },

    modalBackdrop: {
        flex: 1,
        backgroundColor: c.overlayBackdrop,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 32,
    },
    modalCard: {
        backgroundColor: c.cardBackground,
        borderRadius: 16,
        padding: 24,
        alignItems: 'center',
        width: '100%',
        gap: 8,
    },
    modalTitle: { fontSize: 18, fontWeight: '700', color: c.textPrimary, textAlign: 'center', marginTop: 8 },
    modalBody: { fontSize: 14, color: c.textSecondary, textAlign: 'center', lineHeight: 20 },
    modalBtn: { marginTop: 12, paddingVertical: 12, paddingHorizontal: 32, backgroundColor: c.primary, borderRadius: 10 },
    modalBtnText: { color: c.onPrimary, fontSize: 15, fontWeight: '600' },
});
