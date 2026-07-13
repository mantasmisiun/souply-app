import {
    useMemo } from 'react';
import {
    Modal,
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    ScrollView,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { ProductImage } from '../ProductImage';
import { useTheme, type AppTheme } from '../../constants/theme';
import type { AdminProduct } from './AdminProductCard';

interface Props {
    visible: boolean;
    products: AdminProduct[] | null;
    loading: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

export default function MergeModal({ visible, products, loading, onConfirm, onCancel }: Props) {
    const { t } = useTranslation();
    const colors = useTheme();
    const { top, bottom } = useSafeAreaInsets();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    // Sort by globalScore desc — highest score wins. Ties by id asc.
    const sorted = useMemo(() => {
        if (!products) return [];
        return [...products].sort((a, b) => {
            const diff = (Number(b.globalScore) || 0) - (Number(a.globalScore) || 0);
            return diff !== 0 ? diff : a.id - b.id;
        });
    }, [products]);

    if (!products || products.length < 2) return null;

    const winner = sorted[0];
    const losers = sorted.slice(1);

    return (
        <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
            <View style={[styles.container, { paddingTop: top }]}>
                {/* Header */}
                <View style={styles.header}>
                    <TouchableOpacity onPress={onCancel} style={styles.headerBtn} disabled={loading}>
                        <Text style={[styles.cancelText, loading && { opacity: 0.4 }]}>{t('common.cancel')}</Text>
                    </TouchableOpacity>
                    <Text style={styles.title}>{t('admin.catalog.mergeTitle')}</Text>
                    <View style={{ width: 80 }} />
                </View>

                <ScrollView contentContainerStyle={[styles.body, { paddingBottom: Math.max(32, bottom) }]}>
                    <Text style={styles.subtitle}>
                        {t('admin.catalog.mergeSubtitle')}
                    </Text>

                    {/* Winner */}
                    <View style={styles.sectionLabel}>
                        <Ionicons name="star" size={12} color={colors.primary} />
                        <Text style={styles.sectionLabelText}>{t('admin.catalog.mergeWinnerLabel')}</Text>
                    </View>
                    <View style={[styles.row, styles.rowWinner]}>
                        <View style={styles.thumb}>
                            <ProductImage
                                uris={winner.imageUrls}
                                imageStyle={{ width: '100%', height: '100%' }}
                                placeholderStyle={styles.thumbPlaceholder}
                                emojiStyle={{ fontSize: 24, opacity: 0.4 }}
                            />
                        </View>
                        <View style={styles.rowInfo}>
                            <Text style={styles.rowName} numberOfLines={2}>{winner.name}</Text>
                            <Text style={styles.rowId}>ID {winner.id}</Text>
                            {winner.globalScore != null && (
                                <Text style={styles.score}>{t('admin.catalog.mergePopularity', { score: Number(winner.globalScore).toFixed(2) })}</Text>
                            )}
                        </View>
                        <View style={styles.winnerBadge}>
                            <Ionicons name="star" size={10} color={colors.onPrimary} />
                            <Text style={styles.winnerBadgeText}>{t('admin.catalog.mergeWinnerBadge')}</Text>
                        </View>
                    </View>

                    {/* Losers */}
                    <View style={styles.sectionLabel}>
                        <Ionicons name="git-merge-outline" size={12} color={colors.textMuted} />
                        <Text style={[styles.sectionLabelText, { color: colors.textMuted }]}>
                            {t('admin.catalog.mergeLosersLabel', { count: losers.length })}
                        </Text>
                    </View>
                    <View style={styles.list}>
                        {losers.map(product => (
                            <View key={product.id} style={[styles.row, styles.rowLoser]}>
                                <View style={styles.thumb}>
                                    <ProductImage
                                        uris={product.imageUrls}
                                        imageStyle={{ width: '100%', height: '100%' }}
                                        placeholderStyle={styles.thumbPlaceholder}
                                        emojiStyle={{ fontSize: 24, opacity: 0.4 }}
                                    />
                                </View>
                                <View style={styles.rowInfo}>
                                    <Text style={[styles.rowName, styles.rowNameLoser]} numberOfLines={2}>
                                        {product.name}
                                    </Text>
                                    <Text style={styles.rowId}>ID {product.id}</Text>
                                </View>
                                <Ionicons name="arrow-forward" size={16} color={colors.textMuted} />
                            </View>
                        ))}
                    </View>

                    {/* Summary */}
                    <View style={styles.summary}>
                        <Text style={styles.summaryText}>
                            {t('admin.catalog.mergeSummary', { count: products.length, name: winner.name })}
                        </Text>
                    </View>
                </ScrollView>

                {/* Confirm */}
                <View style={[styles.footer, { paddingBottom: Math.max(16, bottom) }]}>
                    <TouchableOpacity
                        style={[styles.confirmBtn, loading && styles.confirmBtnDisabled]}
                        onPress={loading ? undefined : onConfirm}
                        activeOpacity={loading ? 1 : 0.8}
                    >
                        {loading ? (
                            <MaterialProgress color={colors.onPrimary} />
                        ) : (
                            <Text style={styles.confirmText}>
                                {t('admin.catalog.mergeConfirmBtn', { count: products.length })}
                            </Text>
                        )}
                    </TouchableOpacity>
                </View>
            </View>
        </Modal>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: c.cardBackground,
        borderBottomWidth: 0.5,
        borderBottomColor: c.border,
    },
    headerBtn: { width: 80 },
    cancelText: { fontSize: 16, color: c.primary },
    title: { fontSize: 16, fontWeight: '700', color: c.textPrimary },

    body: { padding: 16, gap: 12 },
    subtitle: {
        fontSize: 13,
        color: c.textSecondary,
        lineHeight: 19,
    },

    sectionLabel: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        marginTop: 4,
    },
    sectionLabelText: {
        fontSize: 12,
        fontWeight: '700',
        color: c.primary,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },

    list: { gap: 8 },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: c.cardBackground,
        borderRadius: 12,
        padding: 12,
        gap: 12,
        borderWidth: 1.5,
        borderColor: c.border,
    },
    rowWinner: {
        borderColor: c.primary,
        backgroundColor: c.primary + '0A',
    },
    rowLoser: {
        opacity: 0.75,
    },
    thumb: {
        width: 52,
        height: 52,
        borderRadius: 8,
        overflow: 'hidden',
        backgroundColor: c.surfaceMuted,
        flexShrink: 0,
    },
    thumbPlaceholder: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: c.surfaceMuted,
    },
    rowInfo: { flex: 1, gap: 2 },
    rowName: { fontSize: 14, color: c.textPrimary, lineHeight: 19, fontWeight: '500' },
    rowNameLoser: { fontWeight: '400', color: c.textSecondary },
    rowId: { fontSize: 11, color: c.textMuted },
    score: { fontSize: 11, color: c.primary, marginTop: 1 },
    winnerBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        backgroundColor: c.primary,
        borderRadius: 10,
        paddingHorizontal: 8,
        paddingVertical: 4,
        flexShrink: 0,
    },
    winnerBadgeText: {
        fontSize: 10,
        fontWeight: '700',
        color: c.onPrimary,
    },

    summary: {
        backgroundColor: c.cardBackground,
        borderRadius: 12,
        padding: 14,
        marginTop: 4,
    },
    summaryText: { fontSize: 14, color: c.textSecondary, lineHeight: 20 },
    summaryWinner: { fontWeight: '700', color: c.primary },

    footer: {
        padding: 16,
        backgroundColor: c.cardBackground,
        borderTopWidth: 0.5,
        borderTopColor: c.border,
    },
    confirmBtn: {
        backgroundColor: c.primary,
        borderRadius: 12,
        paddingVertical: 14,
        alignItems: 'center',
    },
    confirmBtnDisabled: { opacity: 0.6 },
    confirmText: { color: c.onPrimary, fontWeight: '700', fontSize: 15 },

});
