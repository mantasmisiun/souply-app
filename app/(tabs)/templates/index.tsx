/**
 * Šablonai tab — Souply 2.0 promotes the templates top-tab (formerly a
 * chip view inside the basket tab) to its own tab, behavior unchanged.
 */
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    RefreshControl,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import Animated from 'react-native-reanimated';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { ScreenHeading } from '../../../components/ScreenHeading';
import { useCollapsingHeader, CollapsingHeader } from '../../../components/CollapsingHeader';
import { useBackToExit } from '../../../hooks/useBackToExit';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { coverEmoji } from '../../../utils/templateCover';
import { useSafeBottomTabBarHeight } from '../../../hooks/useSafeBottomTabBarHeight';
import { useRecipeDock } from '../../../state/recipeDock';
import { useAuthState } from '../../../state/authState';
import { ltPluralSuffix } from '../../../utils/ltPlural';
import { getUserId } from '../../../config/user';
import { useTheme, radius, elevation, type AppTheme } from '../../../constants/theme';
import { SkeletonBox } from '../../../components/SkeletonBox';
import {
    listTemplates,
    type BasketTemplate,
} from '../../../utils/basketTemplatesApi';

export default function TemplatesScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const header = useCollapsingHeader();
    const tabBarHeight = useSafeBottomTabBarHeight();
    // Android back: collapse the dock sheet first, then fall through to
    // press-back-again-to-exit — otherwise back with the sheet open starts
    // leaving the app while a sheet is still covering the screen.
    const sheetIntercept = useCallback(() => {
        const s = useRecipeDock.getState();
        if (s.stage > 0 && s.collapse) { s.collapse(); return true; }
        return false;
    }, []);
    const { backToExitToast } = useBackToExit(sheetIntercept);
    const authUsername = useAuthState((s: any) => s.user?.username ?? null);

    const [templates, setTemplates] = useState<BasketTemplate[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [pullRefreshing, setPullRefreshing] = useState(false);

    const hasFetchedRef = useRef(false);

    const fetchAll = useCallback(async (silent: boolean) => {
        if (silent) setRefreshing(true);
        try {
            const userId = await getUserId();
            setTemplates(await listTemplates(userId).catch(() => []));
        } catch (error) {
            console.error('Failed to fetch templates:', error);
        } finally {
            if (silent) setRefreshing(false);
            setLoading(false);
        }
    }, []);

    useFocusEffect(useCallback(() => {
        const silent = hasFetchedRef.current;
        hasFetchedRef.current = true;
        fetchAll(silent);
    }, [fetchAll]));

    const handleTemplateTap = (template: BasketTemplate) => {
        // Tap opens the editor so the user can verify items before
        // spawning a basket. The "Create basket" CTA inside the editor
        // (template/[id].tsx) calls POST /instantiate.
        router.push(`/template/${template.id}` as any);
    };

    if (loading) return (
        <View style={styles.container}>
            <CollapsingHeader controller={header} smallTitle={t('tabs.templates')} />
            {backToExitToast}
            <View style={{ padding: 16, gap: 12 }}>
                <ScreenHeading title={t('tabs.templates')} />
                {Array.from({ length: 4 }).map((_, i) => (
                    <SkeletonBox key={i} width="100%" height={64} borderRadius={10} />
                ))}
            </View>
        </View>
    );

    return (
        <View style={styles.container}>
            <CollapsingHeader controller={header} smallTitle={t('tabs.templates')} />
            {backToExitToast}
            <Animated.FlatList
                {...header.scroll}
                style={styles.container}
                data={templates}
                keyExtractor={(item: any) => `t-${item.id}`}
                contentInsetAdjustmentBehavior="never"
                contentContainerStyle={[styles.list, { paddingTop: 0, paddingBottom: tabBarHeight + 24 }]}
                refreshControl={
                    <RefreshControl
                        refreshing={pullRefreshing}
                        onRefresh={async () => { setPullRefreshing(true); await fetchAll(false); setPullRefreshing(false); }}
                        colors={[colors.primary]}
                        tintColor={colors.primary}
                    />
                }
                ListHeaderComponent={
                    <>
                    <ScreenHeading title={t('tabs.templates')} bleedX={16} onLayout={header.onTitleLayout} />
                    {refreshing && (
                        <View style={styles.refreshingBanner}>
                            <MaterialProgress size="small" color={colors.primary} />
                            <Text style={styles.refreshingText}>{t('basketTab.loading')}</Text>
                        </View>
                    )}
                    </>
                }
                ListEmptyComponent={
                    <View style={styles.centered}>
                        <Ionicons name="bookmarks-outline" size={56} color={colors.textMuted} />
                        <Text style={styles.emptyText}>{t('basketTab.templates.emptyTitle')}</Text>
                        <Text style={styles.emptySubText}>{t('basketTab.templates.emptyBody')}</Text>
                    </View>
                }
                renderItem={({ item }) => {
                    const itemCount = Number(item.itemCount ?? 0);
                    const visitCount = Number(item.visitCount ?? 0);
                    const emoji = coverEmoji(item.coverImage);
                    const sourceSite = (item as any).sourceSite as string | null | undefined;
                    // Explicit LT plural suffix — RN Intl doesn't resolve LT `few`.
                    const itemsStr = t(`basketTab.templates.itemCount_${ltPluralSuffix(itemCount)}`, { count: itemCount });
                    const visitsStr = t(`basketTab.templates.visitCount_${ltPluralSuffix(visitCount)}`, { count: visitCount });
                    return (
                        <TouchableOpacity
                            style={[
                                styles.templateCard,
                                item.isDefault === 1
                                    ? styles.smartCard
                                    : item.coverColor ? { borderWidth: 4, borderColor: 'transparent', borderLeftColor: item.coverColor } : null,
                            ]}
                            onPress={() => handleTemplateTap(item)}
                            activeOpacity={0.75}
                        >
                            <View style={styles.cardLeft}>
                                {/* Smart template → AI sparkle. Otherwise the server-owned
                                    cover emoji (shared with web + share page), falling back
                                    to the bookmark icon when no cover is set. */}
                                <View style={styles.templateIcon}>
                                    {item.isDefault === 1
                                        ? <Ionicons name="sparkles" size={22} color={colors.primary} />
                                        : emoji
                                            ? <Text style={styles.templateCoverEmoji}>{emoji}</Text>
                                            : <Ionicons name="bookmark" size={22} color={colors.primary} />}
                                </View>
                            </View>
                            <View style={styles.cardContent}>
                                <Text style={styles.cardTitle} numberOfLines={1}>
                                    {item.isDefault === 1 ? t('basketTab.templates.smartName') : item.name}
                                </Text>
                                <Text style={styles.cardDate}>
                                    {itemsStr}
                                    {/* Where an imported recipe came from. `sourceSite` is
                                        the bare hostname the server stored at import time, so
                                        the byline needs no parsing — a hand-made recipe has
                                        none and simply shows nothing extra. */}
                                    {sourceSite ? ` · ${sourceSite}` : visitCount > 0 ? ` · ${visitsStr}` : ''}
                                </Text>
                                {/* Smart template → "auto-renews" pill, shown ONLY while
                                    learning is on (autoUpdate=1). Otherwise, for creators,
                                    the neutral visibility pill (mirrors web VisibilityTag). */}
                                {item.isDefault === 1 ? (
                                    item.autoUpdate === 1 ? (
                                        <View style={styles.autoBadge}>
                                            <Ionicons name="sync" size={10} color={colors.primary} />
                                            <Text style={styles.autoBadgeText}>{t('basketTab.templates.autoBadge')}</Text>
                                        </View>
                                    ) : null
                                ) : authUsername ? (() => {
                                    const isPriv = ((item as any).visibility ?? 'private') === 'private';
                                    return (
                                        <View style={styles.visBadge}>
                                            <Ionicons
                                                name={isPriv ? 'lock-closed' : 'globe-outline'}
                                                size={10}
                                                color={colors.textPrimary}
                                            />
                                            <Text style={styles.visBadgeText}>
                                                {isPriv ? t('basketTab.templates.tagPrivate') : t('basketTab.templates.tagPublic')}
                                            </Text>
                                        </View>
                                    );
                                })() : null}
                            </View>
                            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                        </TouchableOpacity>
                    );
                }}
            />
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    list: { padding: 16 },

    cardLeft: { marginRight: 12 },
    cardContent: { flex: 1, minWidth: 0 },
    cardTitle: { fontSize: 15, fontWeight: '600', color: c.textPrimary, flexShrink: 1 },
    cardDate: { fontSize: 13, color: c.textSecondary, marginTop: 2 },
    visBadge: {
        flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6, alignSelf: 'flex-start',
        backgroundColor: c.surfaceMuted, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3,
        elevation: 1, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 1.5,
    },
    visBadgeText: { fontSize: 10, fontWeight: '600', color: c.textPrimary },
    autoBadge: {
        flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6, alignSelf: 'flex-start',
        backgroundColor: (c as any).primaryMuted ?? c.surfaceMuted, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3,
    },
    autoBadgeText: { fontSize: 10, fontWeight: '700', color: c.primary },

    templateCard: {
        backgroundColor: c.cardBackground, borderRadius: radius.lg, padding: 14, marginBottom: 10,
        flexDirection: 'row', alignItems: 'center',
        ...elevation.level1,
        borderWidth: 3, borderColor: 'transparent', borderLeftColor: c.primary,
    },
    // Smart (auto) template — full pink fill so it stands out from manual cards.
    smartCard: {
        backgroundColor: (c as any).primaryMuted ?? c.surfaceMuted,
        borderWidth: 1.5, borderColor: c.primary,
        borderLeftWidth: 1.5, borderLeftColor: c.primary,
    },
    templateIcon: {
        width: 36, height: 36, borderRadius: radius.md,
        // The light-pink chip this card has always had — and now the source of
        // truth for the sheets' ✕ chip too (SheetCloseButton), so the cover
        // emoji and every close button read as one family.
        backgroundColor: (c as any).primaryMuted ?? c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center',
    },
    templateCoverEmoji: { fontSize: 20 },

    emptyText: { fontSize: 16, color: c.textSecondary, fontWeight: '600', marginTop: 16, textAlign: 'center' },
    emptySubText: { fontSize: 13, color: c.textMuted, marginTop: 6, textAlign: 'center', lineHeight: 18 },

    refreshingBanner: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: 6, paddingVertical: 4,
        backgroundColor: c.surfaceSubtle,
    },
    refreshingText: { fontSize: 11, color: c.textSecondary, fontWeight: '500' },
});
