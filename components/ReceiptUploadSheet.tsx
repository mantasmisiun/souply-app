import { useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import * as DocumentPicker from 'expo-document-picker';
import { GlassSheet } from './GlassSheet';
import { scanDocumentOnly } from '../utils/launchDocumentScanner';
import { looksLikePdf } from '../utils/pdfToImages';
import { useReceiptQueueStore } from '../state/receiptQueueStore';
import { useNetworkStatus } from '../state/networkStatus';
import { useTheme, spacing, radius, typography, iconSize, type AppTheme } from '../constants/theme';

/**
 * Bottom sheet with the two receipt-entry options — Take photo and Upload
 * (file/PDF). BOTH route the receipt into the background queue (no full-screen
 * spinner/swipe flow); a global mini-banner shows progress and a "View" action
 * when done. Optional trip-linking context so the receipt attaches to the right
 * shopping list: `listMap` ("chainId:listId,…") for a multi-store trip, or a
 * single `shoppingListId`.
 */
export function ReceiptUploadSheet({
    visible, onClose, shoppingListId, listMap,
}: {
    visible: boolean;
    onClose: () => void;
    shoppingListId?: string;
    listMap?: string;
}) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = makeStyles(colors);
    const isOnline = useNetworkStatus(s => s.isOnline);
    const addItems = useReceiptQueueStore(s => s.addItems);

    // Chain→list linking for the background queue: a multi-store `listMap`
    // becomes a chainId→listId map; a lone `shoppingListId` (chain unknown)
    // links unconditionally via fallbackLinkId. Same precedence as the scan.
    const link = useMemo(() => {
        if (listMap) {
            const map: Record<number, number> = {};
            for (const pair of listMap.split(',')) {
                const [chainId, listId] = pair.split(':').map(Number);
                if (chainId && listId) map[chainId] = listId;
            }
            return { linkMap: map, fallbackLinkId: null as number | null };
        }
        if (shoppingListId) return { linkMap: undefined, fallbackLinkId: Number(shoppingListId) };
        return { linkMap: undefined, fallbackLinkId: null as number | null };
    }, [listMap, shoppingListId]);

    const takePhoto = useCallback(async () => {
        onClose();
        if (!isOnline) {
            setTimeout(() => Alert.alert(t('receipts.offline.title'), t('receipts.offline.body')), 350);
            return;
        }
        // scanDocumentOnly waits for the modal to dismiss, then returns the
        // page URIs WITHOUT navigating — the queue processes them silently.
        const uris = await scanDocumentOnly();
        if (!uris) return;
        addItems([{ uris, linkMap: link.linkMap, fallbackLinkId: link.fallbackLinkId }]);
    }, [onClose, isOnline, addItems, link, t]);

    const upload = useCallback(async () => {
        onClose();
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
            linkMap: link.linkMap,
            fallbackLinkId: link.fallbackLinkId,
        }));
        if (entries.length === 0) {
            Alert.alert(t('receipts.uploadFail.title'), t('receipts.uploadFail.body'));
            return;
        }
        addItems(entries);
    }, [onClose, addItems, link, t]);

    if (!visible) return null;

    return (
        <GlassSheet autoHeight onClose={onClose}>
            <View style={styles.content}>
                <Text style={styles.title}>{t('shoppingListDetail.uploadReceipt')}</Text>
                <TouchableOpacity style={styles.row} onPress={takePhoto} activeOpacity={0.7}>
                    <Ionicons name="camera-outline" size={iconSize.lg} color={colors.primary} />
                    <Text style={styles.rowText}>{t('receipts.menu.uploadCamera')}</Text>
                </TouchableOpacity>
                <View style={styles.divider} />
                <TouchableOpacity style={styles.row} onPress={upload} activeOpacity={0.7}>
                    <Ionicons name="cloud-upload-outline" size={iconSize.lg} color={colors.primary} />
                    <Text style={styles.rowText}>{t('receipts.menu.uploadAction')}</Text>
                </TouchableOpacity>
            </View>
        </GlassSheet>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    content: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs },
    title: { ...typography.subheading, color: c.textPrimary, marginBottom: spacing.sm },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingVertical: spacing.lg, paddingHorizontal: spacing.xs, borderRadius: radius.md },
    rowText: { ...typography.bodyStrong, fontWeight: '700', color: c.textPrimary },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: 40 },
});
