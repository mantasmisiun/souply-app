import { useMemo, useState } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import { ChainLogoChip } from '../ChainLogoChip';
import { DockActionRow } from '../dock/DockActionRow';
import ReceiptPhotoView from './ReceiptPhotoView';
import { useSavedReceiptPhoto } from '../../hooks/useSavedReceiptPhoto';
import { useTheme, spacing, radius, typography, avatarSize, withAlpha, type AppTheme } from '../../constants/theme';
import { formatEuro, formatDate } from '../../utils/formatCurrency';
import { ltPluralSuffix } from '../../utils/ltPlural';
import { chainIdByName } from '../../utils/chainBrandName';
import { downloadReceiptImage } from '../../utils/downloadReceipt';
import { userDeleteReceipt, deleteReceiptImage } from '../../utils/receiptApi';
import { detachTripReceipt, type TripReceipt } from '../../utils/tripsApi';

/**
 * Contents of the receipt bottom sheet (hosted in <GlassSheet>). Mirrors the map
 * store-dock format: a title row ([logo] · name / date·items · paid) + two
 * DockActionCards (delete + download) + the full receipt photo with parser
 * legend (ReceiptPhotoView). The delete card MORPHS by the receipt's swipe
 * state — a full "hide + wipe photo" while the mandatory queue is still pending,
 * a photo-only delete once it has been cleared (prices are kept either way).
 */

// The recognised total the user PAID = the receipt's printed footer total. Only
// fall back to summing the line items when the printed total wasn't readable — a
// single mis-parsed line must never misstate what the card says was paid.
const receiptTotal = (r: TripReceipt): number =>
    r.printedTotal != null
        ? Number(r.printedTotal)
        : r.items.reduce((s, it) => s + (it.lineTotal != null ? Number(it.lineTotal)
            : it.price != null ? Number(it.price) : 0), 0);

export function ReceiptDetailSheet({
    receipt, tripId, isUploader, canModerate, onClose, onChanged,
}: {
    receipt: TripReceipt;
    tripId: number;
    /** The viewer uploaded this receipt → may delete it (hide / photo). */
    isUploader: boolean;
    /** The viewer owns the trip (but didn't upload) → may remove it from the trip. */
    canModerate: boolean;
    /** Dismiss the sheet (animate out). */
    onClose: () => void;
    /** Data changed on the server (deleted / detached / photo wiped) → host reloads. */
    onChanged: () => void;
}) {
    const colors = useTheme();
    const { t, i18n } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const photo = useSavedReceiptPhoto(receipt.id);
    const [busy, setBusy] = useState<'delete' | 'download' | null>(null);

    // "Cleared" = the receipt HAD a mandatory queue and the user finished it. A
    // receipt with no queue is never swipe-locked (nothing to commit), so full
    // delete stays available — matching "delete until they swipe the queue".
    const swipesCleared = receipt.mandatorySwipesRequired > 0
        && receipt.mandatorySwipesCompleted >= receipt.mandatorySwipesRequired;

    const chainId = receipt.chainId ?? chainIdByName(receipt.chainName ?? '') ?? 0;
    const itemN = receipt.items.length;
    const subtitle = [
        receipt.receiptDate ? formatDate(receipt.receiptDate) : null,
        t(`items.count_${ltPluralSuffix(itemN)}`, { count: itemN }),
    ].filter(Boolean).join('  ·  ');

    const handleDownload = async () => {
        if (busy) return;
        setBusy('download');
        const ok = await downloadReceiptImage(receipt.id);
        setBusy(null);
        Alert.alert(
            ok ? t('tripFinal.dlDoneTitle') : t('tripFinal.dlFailTitle'),
            ok ? t('tripFinal.dlDoneBody', { count: 1 }) : t('tripFinal.dlFailBody'),
        );
    };

    const runDelete = async () => {
        setBusy('delete');
        try {
            if (swipesCleared) await deleteReceiptImage(receipt.id);
            else await userDeleteReceipt(receipt.id);
            setBusy(null);
            onChanged();
            onClose();
        } catch {
            setBusy(null);
            Alert.alert(t('receiptSheet.deleteFailTitle'), t('receiptSheet.deleteFailBody'));
        }
    };

    const handleDelete = () => {
        if (busy) return;
        const title = swipesCleared ? t('receiptSheet.deletePhotoConfirmTitle') : t('receiptSheet.deleteConfirmTitle');
        const body = swipesCleared ? t('receiptSheet.deletePhotoConfirmBody') : t('receiptSheet.deleteConfirmBody');
        Alert.alert(title, body, [
            { text: t('common.cancel'), style: 'cancel' },
            { text: swipesCleared ? t('receiptSheet.deletePhoto') : t('receiptSheet.delete'), style: 'destructive', onPress: runDelete },
        ]);
    };

    // Trip-owner moderation: remove another member's receipt from this trip
    // (detach only — the receipt + its data stay with the uploader).
    const handleRemoveFromTrip = () => {
        if (busy) return;
        Alert.alert(t('receiptSheet.removeFromTripConfirmTitle'), t('receiptSheet.removeFromTripConfirmBody'), [
            { text: t('common.cancel'), style: 'cancel' },
            {
                text: t('receiptSheet.removeFromTrip'), style: 'destructive',
                onPress: async () => {
                    setBusy('delete');
                    try {
                        await detachTripReceipt(tripId, receipt.id);
                        setBusy(null);
                        onChanged();
                        onClose();
                    } catch {
                        setBusy(null);
                        Alert.alert(t('receiptSheet.deleteFailTitle'), t('receiptSheet.deleteFailBody'));
                    }
                },
            },
        ]);
    };

    return (
        <View style={styles.body}>
            {/* ONE horizontal inset for everything: the sheet's SheetContent
                wrapper. Title/actions add none of their own, and the photo card
                renders `flush` so it lines up with them. */}
            <View style={styles.padded}>
                {/* Old-receipt warning — the purchase date is >30 days old. Shown to
                    every trip member (anti-fraud transparency). */}
                {!!receipt.staleReceipt && (
                    <View style={styles.staleNote}>
                        <Ionicons name="alert-circle" size={18} color={colors.error} />
                        <Text style={styles.staleNoteText}>
                            {t('receiptSheet.stale', { date: receipt.receiptDate ? formatDate(receipt.receiptDate) : '' })}
                        </Text>
                    </View>
                )}

                {/* Title row — same hero format as the map store dock's bar. */}
                <View style={styles.titleRow}>
                    <ChainLogoChip chainId={chainId} name={receipt.chainName ?? undefined} size={avatarSize.md} />
                    <View style={styles.titleCol}>
                        <Text style={styles.titleName} numberOfLines={1}>
                            {receipt.chainName ?? receipt.storeName ?? `#${receipt.id}`}
                        </Text>
                        <Text style={styles.titleSub} numberOfLines={1}>{subtitle}</Text>
                    </View>
                    <Text style={styles.titlePaid} allowFontScaling={false}>{formatEuro(receiptTotal(receipt))}</Text>
                </View>

                {/* Actions — uploader may delete (label morphs by swipe state); a
                    trip owner who didn't upload may remove it; everyone downloads. */}
                <DockActionRow
                    colors={colors}
                    actions={[
                        // The uploader may delete; a moderator may only detach.
                        isUploader ? {
                            icon: 'trash-outline',
                            title: t('receiptSheet.delete'),
                            subtitle: swipesCleared ? t('receiptSheet.deletePhotoSub') : t('receiptSheet.deleteSub'),
                            onPress: handleDelete,
                            loading: busy === 'delete',
                        } : canModerate ? {
                            icon: 'exit-outline',
                            title: t('receiptSheet.removeFromTrip'),
                            subtitle: t('receiptSheet.removeFromTripSub'),
                            onPress: handleRemoveFromTrip,
                            loading: busy === 'delete',
                        } : null,
                        {
                            iconNode: <MaterialIcons name="file-download" size={24} color={colors.primary} />,
                            title: t('tripFinal.download'),
                            subtitle: t('receiptSheet.downloadSub'),
                            onPress: handleDownload,
                            loading: busy === 'download',
                        },
                    ]}
                />
            </View>

            {/* Full receipt photo + parser legend (scrolls into view at full). */}
            <ReceiptPhotoView
                flush
                imageUri={photo.imageUri}
                imageDims={photo.imageDims}
                headerRegions={photo.headerRegions}
                productRegions={photo.productRegions}
                footerRegions={photo.footerRegions}
                skippedRegions={photo.skippedRegions}
                drawMasks={false}
                loading={photo.loading}
            />
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    body: { gap: spacing.sm },
    // Horizontal inset comes from the sheet's SheetContent wrapper — none here.
    padded: { gap: spacing.md },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    titleCol: { flex: 1, minWidth: 0 },
    titleName: { ...typography.bodyStrong, color: c.textPrimary },
    titleSub: { ...typography.labelSmall, color: c.textSecondary, marginTop: 2 },
    titlePaid: { fontSize: 22, fontWeight: '800', color: c.textPrimary, fontVariant: ['tabular-nums'] },
    // Red old-receipt banner at the top of the sheet.
    staleNote: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
        backgroundColor: withAlpha(c.error, 0.12), borderRadius: radius.md,
        paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
    },
    staleNoteText: { flex: 1, ...typography.labelSmall, color: c.error },
});
