/**
 * Shared-template preview screen.
 *
 * Source spec: Documentation/roadmap/sablonai.md Part 4.2 + Part 4.4.
 *
 * Reached two ways:
 *   • Universal/App Link: souply.lt/t/{slug} → app deep link
 *   • Clipboard-deferred deep link on first launch after install (souply://t/{slug})
 *
 * Shows the template + creator + snapshot price + item list, with a
 * single "Sukurti krepšelį" CTA that calls POST /instantiate (using the
 * resolved templateId from the API) and routes to the spawned basket.
 */
import {
    View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator,
    Alert, Image,
} from 'react-native';
import { useEffect, useMemo, useState } from 'react';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../constants/theme';
import { ScreenBackButton } from '../../components/ScreenBackButton';
import { ProductImage } from '../../components/ProductImage';
import { SkeletonBox } from '../../components/SkeletonBox';
import { getUserId } from '../../config/user';
import {
    fetchSharedTemplate,
    instantiateTemplate,
    type SharedTemplate,
} from '../../utils/basketTemplatesApi';

export default function SharedTemplatePreviewScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const router = useRouter();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { slug } = useLocalSearchParams<{ slug: string }>();

    const [data, setData] = useState<SharedTemplate | null>(null);
    const [loading, setLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!slug) return;
        setLoading(true);
        setNotFound(false);
        fetchSharedTemplate(String(slug))
            .then(setData)
            .catch(err => {
                if (String(err?.message ?? '').includes('HTTP 404')) setNotFound(true);
                else setNotFound(true);
            })
            .finally(() => setLoading(false));
    }, [slug]);

    const handleInstantiate = async () => {
        if (!data || busy) return;
        try {
            setBusy(true);
            const userId = await getUserId();
            const result = await instantiateTemplate(data.template.id, userId);
            router.replace(`/basket/${result.basketId}` as any);
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorInstantiate'));
        } finally {
            setBusy(false);
        }
    };

    if (loading) {
        return (
            <>
                <Stack.Screen options={{
                    title: '',
                    headerStyle: { backgroundColor: colors.cardBackground },
                    headerShadowVisible: false,
                    headerLeft: () => <ScreenBackButton />,
                }} />
                <View style={[styles.container, { padding: 16, gap: 12 }]}>
                    <SkeletonBox width="60%" height={24} borderRadius={6} />
                    <SkeletonBox width="40%" height={16} borderRadius={6} />
                    <View style={{ height: 16 }} />
                    <SkeletonBox width="100%" height={80} borderRadius={14} />
                    <View style={{ height: 12 }} />
                    {Array.from({ length: 5 }).map((_, i) => (
                        <SkeletonBox key={i} width="100%" height={56} borderRadius={10} />
                    ))}
                </View>
            </>
        );
    }

    if (notFound || !data) {
        return (
            <>
                <Stack.Screen options={{
                    title: '',
                    headerStyle: { backgroundColor: colors.cardBackground },
                    headerShadowVisible: false,
                    headerLeft: () => <ScreenBackButton />,
                }} />
                <View style={styles.errorWrap}>
                    <Ionicons name="link-outline" size={56} color={colors.textMuted} />
                    <Text style={styles.errorTitle}>{t('basketTab.templates.previewError')}</Text>
                    <Text style={styles.errorBody}>{t('basketTab.templates.previewErrorBody')}</Text>
                </View>
            </>
        );
    }

    const { template, snapshot, items } = data;
    const cheapest = snapshot.cheapestTotalEur;
    const runnerUp = snapshot.runnerUpTotalEur;
    const savings =
        cheapest != null && runnerUp != null && runnerUp > cheapest
            ? (runnerUp - cheapest).toFixed(2)
            : null;
    const calculatedWhen = snapshot.calculatedAt
        ? new Date(snapshot.calculatedAt).toLocaleDateString()
        : null;

    return (
        <>
            <Stack.Screen options={{
                title: '',
                headerStyle: { backgroundColor: colors.cardBackground },
                headerShadowVisible: false,
                headerLeft: () => <ScreenBackButton />,
            }} />
            <View style={styles.container}>
                <FlatList
                    data={items}
                    keyExtractor={item => `i-${item.productId}`}
                    contentContainerStyle={styles.list}
                    ListHeaderComponent={
                        <View style={{ gap: 12, marginBottom: 4 }}>
                            <Text style={styles.title}>{template.name}</Text>
                            {template.creatorHandle && (
                                <Text style={styles.creator}>
                                    {t('basketTab.templates.shareBranded', { handle: template.creatorHandle })}
                                </Text>
                            )}
                            {template.useCount > 0 && (
                                <Text style={styles.useCount}>
                                    {t('basketTab.templates.shareSocialProof', { count: template.useCount })}
                                </Text>
                            )}
                            {cheapest != null && (
                                <View style={styles.snapshotCard}>
                                    <Text style={styles.snapshotLabel}>
                                        Pigiausia
                                    </Text>
                                    <Text style={styles.snapshotPrice}>
                                        €{cheapest.toFixed(2)}
                                    </Text>
                                    {savings && (
                                        <Text style={styles.snapshotSavings}>
                                            {t('basketTab.templates.shareSavings', { amount: savings })}
                                        </Text>
                                    )}
                                    {calculatedWhen && (
                                        <Text style={styles.snapshotWhen}>
                                            {t('basketTab.templates.shareGeneratedAt', { when: calculatedWhen })}
                                        </Text>
                                    )}
                                </View>
                            )}
                        </View>
                    }
                    renderItem={({ item }) => (
                        <View style={styles.itemRow}>
                            <ProductImage
                                uris={item.imageUrls}
                                imageStyle={styles.itemImage}
                                placeholderStyle={styles.itemImagePlaceholder}
                                emojiStyle={styles.itemImageEmoji}
                            />
                            <View style={{ flex: 1 }}>
                                <Text style={styles.itemName} numberOfLines={2}>{item.productName}</Text>
                                <Text style={styles.itemQty}>
                                    {item.quantity} {item.unit ?? ''}
                                </Text>
                            </View>
                        </View>
                    )}
                />

                <View style={styles.footer}>
                    <TouchableOpacity
                        style={[styles.cta, busy && styles.ctaDisabled]}
                        onPress={handleInstantiate}
                        disabled={busy}
                    >
                        {busy
                            ? <ActivityIndicator color={colors.onPrimary} />
                            : <Text style={styles.ctaText}>{t('basketTab.templates.sharePreviewCta')}</Text>}
                    </TouchableOpacity>
                </View>
            </View>
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    list: { padding: 16, paddingBottom: 24 },

    title: { fontSize: 24, fontWeight: '700', color: c.textPrimary },
    creator: { fontSize: 14, color: c.primary, fontWeight: '600' },
    useCount: { fontSize: 13, color: c.textSecondary },

    snapshotCard: {
        backgroundColor: c.cardBackground, borderRadius: 14,
        padding: 16, marginTop: 8, gap: 4,
        borderLeftWidth: 4, borderLeftColor: c.success,
    },
    snapshotLabel: { fontSize: 12, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 },
    snapshotPrice: { fontSize: 28, fontWeight: '700', color: c.textPrimary },
    snapshotSavings: { fontSize: 14, color: c.success, fontWeight: '600' },
    snapshotWhen: { fontSize: 12, color: c.textMuted, marginTop: 2 },

    itemRow: {
        flexDirection: 'row', alignItems: 'center', gap: 12,
        backgroundColor: c.cardBackground, borderRadius: 10,
        padding: 12, marginBottom: 8,
    },
    itemImage: { width: 44, height: 44, borderRadius: 8 },
    itemImagePlaceholder: {
        width: 44, height: 44, borderRadius: 8,
        backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center',
    },
    itemImageEmoji: { fontSize: 24, opacity: 0.5 },
    itemName: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    itemQty: { fontSize: 12, color: c.textSecondary, marginTop: 2 },

    footer: {
        padding: 16,
        backgroundColor: c.cardBackground,
        borderTopWidth: 0.5, borderTopColor: c.border,
    },
    cta: {
        paddingVertical: 14, borderRadius: 12,
        backgroundColor: c.primary, alignItems: 'center',
    },
    ctaDisabled: { backgroundColor: c.border },
    ctaText: { fontSize: 15, fontWeight: '700', color: c.onPrimary },

    errorWrap: {
        flex: 1, alignItems: 'center', justifyContent: 'center',
        padding: 32, gap: 12, backgroundColor: c.pageBackground,
    },
    errorTitle: { fontSize: 18, fontWeight: '700', color: c.textPrimary, textAlign: 'center' },
    errorBody: { fontSize: 14, color: c.textSecondary, textAlign: 'center', lineHeight: 20 },
});
