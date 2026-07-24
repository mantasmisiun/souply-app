import { useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import * as DocumentPicker from 'expo-document-picker';
import { SheetCard } from '../SheetCard';
import { scanDocumentOnly } from '../../utils/launchDocumentScanner';
import { looksLikePdf } from '../../utils/pdfToImages';
import { useReceiptQueueStore } from '../../state/receiptQueueStore';
import { useNetworkStatus } from '../../state/networkStatus';
import { useTheme, spacing, iconSize, type AppTheme } from '../../constants/theme';

/**
 * Receipt-upload PANE — an in-sheet content swap (NOT a stacked sheet): the
 * Shopping sheet renders this in place of its main body when "Įkelti kvitą" is
 * tapped. Header row (back + title) + the two entry options, Fotografuoti /
 * Įkelti. Both enqueue into the background receipt queue with NO list link, so
 * the receipt becomes an ad-hoc (stats-only) trip. Mirrors ReceiptUploadSheet's
 * handlers minus the linking context.
 */
export function ReceiptUploadPane({ onBack }: { onBack: () => void }) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { t } = useTranslation();
    const isOnline = useNetworkStatus(s => s.isOnline);
    const addItems = useReceiptQueueStore(s => s.addItems);

    const takePhoto = useCallback(async () => {
        onBack();
        if (!isOnline) {
            setTimeout(() => Alert.alert(t('receipts.offline.title'), t('receipts.offline.body')), 350);
            return;
        }
        const uris = await scanDocumentOnly();
        if (!uris) return;
        addItems([{ uris }]);
    }, [onBack, isOnline, addItems, t]);

    const upload = useCallback(async () => {
        onBack();
        const picked = await DocumentPicker.getDocumentAsync({
            type: ['image/*', 'application/pdf'],
            copyToCacheDirectory: true,
            multiple: true,
        });
        if (picked.canceled || !picked.assets?.length) return;
        const entries = picked.assets.map(a => ({
            uris: [a.uri],
            name: a.name ?? undefined,
            isPdf: looksLikePdf(a.uri, a.mimeType, a.name),
        }));
        if (entries.length === 0) {
            Alert.alert(t('receipts.uploadFail.title'), t('receipts.uploadFail.body'));
            return;
        }
        addItems(entries);
    }, [onBack, addItems, t]);

    return (
        <>
            <View style={styles.headerRow}>
                <TouchableOpacity onPress={onBack} hitSlop={10} accessibilityLabel={t('common.back')}>
                    <Ionicons name="chevron-back" size={26} color={colors.primary} />
                </TouchableOpacity>
                <Text style={styles.title}>{t('shoppingListDetail.uploadReceipt')}</Text>
            </View>

            <SheetCard>
                <TouchableOpacity style={styles.row} onPress={takePhoto} activeOpacity={0.7}>
                    <Ionicons name="camera-outline" size={iconSize.lg} color={colors.primary} />
                    <Text style={styles.rowText}>{t('receipts.menu.uploadCamera')}</Text>
                </TouchableOpacity>
                <View style={styles.divider} />
                <TouchableOpacity style={styles.row} onPress={upload} activeOpacity={0.7}>
                    <Ionicons name="cloud-upload-outline" size={iconSize.lg} color={colors.primary} />
                    <Text style={styles.rowText}>{t('receipts.menu.uploadAction')}</Text>
                </TouchableOpacity>
            </SheetCard>
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingTop: spacing.xs, paddingBottom: spacing.xs },
    title: { fontSize: 22, fontWeight: '700', color: c.textPrimary },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingVertical: spacing.lg, paddingHorizontal: spacing.xs },
    rowText: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: 40 },
});
