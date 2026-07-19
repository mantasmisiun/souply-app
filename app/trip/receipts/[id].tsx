/**
 * Trip receipts screen (stage 4 of the simplified flow — basic view).
 *
 * Empty: one big Upload button. With receipts: two big buttons (View receipt
 * / Upload) and the parsed items of every receipt below — chain logo on the
 * card when the trip spans several stores. "Wrong receipt" (trash on a
 * receipt row inside the View picker) detaches it — the server enforces the
 * time window (423 once the trip is a week old).
 */
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Image, Alert, Modal } from 'react-native';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { MaterialProgress } from '@/components/MaterialProgress';
import { ChainLogoChip } from '../../../components/ChainLogoChip';
import { ScreenBackButton } from '../../../components/ScreenBackButton';
import { chainIdByName } from '../../../utils/chainBrandName';
import { formatDate } from '../../../utils/formatCurrency';
import { useTheme, radius, spacing, type AppTheme } from '../../../constants/theme';
import { fetchTripReceipts, detachTripReceipt, type TripReceipt } from '../../../utils/tripsApi';

export default function TripReceiptsScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { t } = useTranslation();
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { id } = useLocalSearchParams<{ id: string }>();
    const tripId = Number(id);

    const [receipts, setReceipts] = useState<TripReceipt[] | null>(null);
    const [pickerOpen, setPickerOpen] = useState(false);

    const load = useCallback(async () => {
        try { setReceipts(await fetchTripReceipts(tripId)); } catch { setReceipts([]); }
    }, [tripId]);
    useFocusEffect(useCallback(() => { void load(); }, [load]));

    const openViewer = useCallback((receiptId: number) => {
        setPickerOpen(false);
        router.push(`/receipt-process?receiptId=${receiptId}` as any);
    }, [router]);

    const onView = useCallback(() => {
        if (!receipts || receipts.length === 0) return;
        if (receipts.length === 1) openViewer(receipts[0].id);
        else setPickerOpen(true);
    }, [receipts, openViewer]);

    const onWrongReceipt = useCallback((r: TripReceipt) => {
        Alert.alert(t('tripReceipts.wrongTitle'), t('tripReceipts.wrongBody'), [
            { text: t('common.cancel'), style: 'cancel' },
            {
                text: t('tripReceipts.wrongConfirm'),
                style: 'destructive',
                onPress: async () => {
                    try { await detachTripReceipt(tripId, r.id); setPickerOpen(false); await load(); }
                    catch { Alert.alert(t('tripReceipts.wrongClosedTitle'), t('tripReceipts.wrongClosedBody')); }
                },
            },
        ]);
    }, [tripId, t, load]);

    const multi = (receipts?.length ?? 0) > 1;

    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
                <View style={styles.chrome}>
                    <ScreenBackButton />
                    <Text style={styles.title}>{t('tripReceipts.title')}</Text>
                </View>

                {receipts == null ? (
                    <View style={styles.centered}><MaterialProgress size="large" color={colors.primary} /></View>
                ) : receipts.length === 0 ? (
                    <View style={styles.centered}>
                        <TouchableOpacity style={styles.bigBtn} onPress={() => router.push('/receipt' as any)}>
                            <Ionicons name="cloud-upload-outline" size={22} color={colors.onPrimary} />
                            <Text style={styles.bigBtnText}>{t('tripReceipts.upload')}</Text>
                        </TouchableOpacity>
                        <Text style={styles.hint}>{t('tripReceipts.emptyHint')}</Text>
                    </View>
                ) : (
                    <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}>
                        <View style={styles.bigRow}>
                            <TouchableOpacity style={[styles.bigBtn, { flex: 1 }]} onPress={onView}>
                                <Ionicons name="receipt-outline" size={20} color={colors.onPrimary} />
                                <Text style={styles.bigBtnText}>{t('tripReceipts.view')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={[styles.bigBtn, styles.bigBtnAlt, { flex: 1 }]} onPress={() => router.push('/receipt' as any)}>
                                <Ionicons name="cloud-upload-outline" size={20} color={colors.primary} />
                                <Text style={[styles.bigBtnText, { color: colors.primary }]}>{t('tripReceipts.upload')}</Text>
                            </TouchableOpacity>
                        </View>

                        {receipts.map(r => r.items.map(it => (
                            <View key={`${r.id}-${it.lineIdx}`} style={styles.itemRow}>
                                {multi && (
                                    <ChainLogoChip
                                        chainId={r.chainId ?? chainIdByName(r.chainName ?? '') ?? 0}
                                        name={r.chainName ?? undefined}
                                        size={22}
                                    />
                                )}
                                {it.storeProductImageUrl
                                    ? <Image source={{ uri: it.storeProductImageUrl }} style={styles.itemImage} />
                                    : <View style={styles.itemImage} />}
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.itemName} numberOfLines={1}>{it.matchedName ?? it.name}</Text>
                                    {it.quantity != null && it.quantity !== 1 && (
                                        <Text style={styles.itemMeta}>{it.quantity}{it.unit ? ` ${it.unit}` : ''}</Text>
                                    )}
                                </View>
                                {it.price != null && <Text style={styles.itemPrice}>€{Number(it.price).toFixed(2)}</Text>}
                            </View>
                        )))}
                    </ScrollView>
                )}
            </View>

            {/* Receipt picker (View with several receipts) + wrong-receipt. */}
            <Modal visible={pickerOpen} transparent animationType="slide" onRequestClose={() => setPickerOpen(false)}>
                <TouchableOpacity style={styles.pickBackdrop} activeOpacity={1} onPress={() => setPickerOpen(false)}>
                    <View style={[styles.pickCard, { paddingBottom: insets.bottom + spacing.lg }]} onStartShouldSetResponder={() => true}>
                        {(receipts ?? []).map(r => (
                            <View key={r.id} style={styles.pickRow}>
                                <TouchableOpacity style={styles.pickMain} onPress={() => openViewer(r.id)}>
                                    <ChainLogoChip chainId={r.chainId ?? chainIdByName(r.chainName ?? '') ?? 0} name={r.chainName ?? undefined} size={30} />
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.itemName} numberOfLines={1}>{r.storeName ?? r.chainName ?? `#${r.id}`}</Text>
                                        {r.receiptDate && <Text style={styles.itemMeta}>{formatDate(r.receiptDate)}</Text>}
                                    </View>
                                </TouchableOpacity>
                                <TouchableOpacity onPress={() => onWrongReceipt(r)} hitSlop={8}>
                                    <Ionicons name="trash-outline" size={20} color={colors.textMuted} />
                                </TouchableOpacity>
                            </View>
                        ))}
                    </View>
                </TouchableOpacity>
            </Modal>
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    chrome: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
    title: { fontSize: 22, fontWeight: '800', color: c.textPrimary },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg, padding: spacing.xl },
    hint: { fontSize: 13, color: c.textSecondary, textAlign: 'center' },
    bigRow: { flexDirection: 'row', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    bigBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
        backgroundColor: c.primary, borderRadius: radius.lg, paddingVertical: 14, paddingHorizontal: spacing.lg,
    },
    bigBtnAlt: { backgroundColor: c.cardBackground, borderWidth: 1, borderColor: c.primary },
    bigBtnText: { fontSize: 15, fontWeight: '700', color: c.onPrimary },
    itemRow: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
    },
    itemImage: { width: 40, height: 40, borderRadius: 8, backgroundColor: c.surfaceMuted },
    itemName: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    itemMeta: { fontSize: 12, color: c.textSecondary },
    itemPrice: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
    pickBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
    pickCard: {
        backgroundColor: c.cardBackground, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
        paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm,
    },
    pickRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
    pickMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
});
