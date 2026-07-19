/**
 * Šablonai tab — Souply 2.0 promotes the templates top-tab (formerly a
 * chip view inside the basket tab) to its own tab, behavior unchanged.
 * The auto-template onboarding gate/build banners live here because this
 * is where the earned template lands.
 */
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    Alert,
    RefreshControl,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import Animated from 'react-native-reanimated';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { ScreenHeading } from '../../../components/ScreenHeading';
import { useCollapsingHeader, CollapsingHeader } from '../../../components/CollapsingHeader';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../../config/api';
import { coverEmoji } from '../../../utils/templateCover';
import { useSafeBottomTabBarHeight } from '../../../hooks/useSafeBottomTabBarHeight';
import { TemplateCoverEditor, type CoverDraft } from '../../../components/TemplateCoverEditor';
import { useAuthState } from '../../../state/authState';
import { ltPluralSuffix } from '../../../utils/ltPlural';
import { getUserId } from '../../../config/user';
import { useTheme, radius, elevation, type AppTheme } from '../../../constants/theme';
import { SkeletonBox } from '../../../components/SkeletonBox';
import {
    listTemplates,
    createTemplate,
    buildDefaultTemplate,
    type BasketTemplate,
} from '../../../utils/basketTemplatesApi';
import { SystemNoticeCard } from '../../../components/SystemNoticeCard';
import { BuildingTemplateCard } from '../../../components/BuildingTemplateCard';

export default function TemplatesScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const header = useCollapsingHeader();
    const tabBarHeight = useSafeBottomTabBarHeight();
    const authUsername = useAuthState((s: any) => s.user?.username ?? null);

    const [templates, setTemplates] = useState<BasketTemplate[]>([]);
    // Receipt counts power the onboarding gate: 3 receipts × 2 chains.
    const [receiptCount, setReceiptCount] = useState(0);
    const [distinctChainCount, setDistinctChainCount] = useState(0);
    const [gateDismissed, setGateDismissed] = useState(false);
    const [buildDismissed, setBuildDismissed] = useState(false);
    const [building, setBuilding] = useState(false);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [pullRefreshing, setPullRefreshing] = useState(false);
    const [coverSheetOpen, setCoverSheetOpen] = useState(false);

    const hasFetchedRef = useRef(false);

    const fetchAll = useCallback(async (silent: boolean) => {
        if (silent) setRefreshing(true);
        try {
            const userId = await getUserId();
            const [templateRes, receiptRes] = await Promise.all([
                listTemplates(userId).catch(() => []),
                fetch(`${API_BASE_URL}/api/users/${userId}/receipts`).then(r => r.json()).catch(() => []),
            ]);
            setTemplates(templateRes);
            const receipts: { chainName?: string | null }[] = Array.isArray(receiptRes) ? receiptRes : [];
            setReceiptCount(receipts.length);
            const distinctChains = new Set(receipts.map(r => r.chainName).filter(c => !!c));
            setDistinctChainCount(distinctChains.size);
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

    const defaultTemplate = useMemo(
        () => templates.find(t => t.isDefault === 1) ?? null,
        [templates],
    );

    // Onboarding gate dismissal persists across sessions (same keys as the
    // pre-2.0 basket-tab placement, so prior dismissals carry over).
    useEffect(() => {
        AsyncStorage.getItem('template_gate_dismissed')
            .then(v => { if (v === '1') setGateDismissed(true); });
    }, []);
    const dismissGate = useCallback(async () => {
        setGateDismissed(true);
        try { await AsyncStorage.setItem('template_gate_dismissed', '1'); } catch {}
    }, []);

    const meetsThreshold = receiptCount >= 3 && distinctChainCount >= 2;
    const showGate = !defaultTemplate && !meetsThreshold && !gateDismissed;
    const showGateBanner = !defaultTemplate && !meetsThreshold && gateDismissed;

    useEffect(() => {
        AsyncStorage.getItem('default_build_dismissed')
            .then(v => { if (v === '1') setBuildDismissed(true); });
    }, []);
    const dismissBuild = useCallback(async () => {
        setBuildDismissed(true);
        try { await AsyncStorage.setItem('default_build_dismissed', '1'); } catch {}
    }, []);
    const showBuildBanner = meetsThreshold && !defaultTemplate && !buildDismissed && !building;

    const handleBuild = useCallback(async () => {
        if (building) return;
        setBuilding(true);
        // Artificial floor so the "AI working" card is visible even if the
        // server answers instantly (per spec — pretend to think for ~5s).
        const minDelay = new Promise(resolve => setTimeout(resolve, 5000));
        try {
            await Promise.all([buildDefaultTemplate(), minDelay]);
            await fetchAll(true); // refetch → the new default card appears
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.buildFailed'));
        } finally {
            setBuilding(false);
        }
    }, [building, t, fetchAll]);

    const handleTemplateTap = (template: BasketTemplate) => {
        // Tap opens the editor so the user can verify items before
        // spawning a basket. The "Create basket" CTA inside the editor
        // (template/[id].tsx) calls POST /instantiate.
        router.push(`/template/${template.id}` as any);
    };

    // FAB → identity sheet → create the template with the chosen name/emoji/
    // colour, then route into the editor to add items.
    const handleCreateTemplate = useCallback(async (next: CoverDraft) => {
        try {
            const userId = await getUserId();
            const created = await createTemplate({ userId, name: next.name, coverColor: next.coverColor, coverImage: next.coverImage });
            router.push(`/template/${created.id}` as any);
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorSave'));
        }
    }, [router, t]);

    if (loading) return (
        <View style={styles.container}>
            <CollapsingHeader controller={header} smallTitle={t('tabs.templates')} />
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
                    {// "Įkelkite kvitus, kad gautumėte savo šabloną" lives here —
                    // this is where the auto-generated template lands, so the
                    // prompt to earn it belongs on this tab.
                    <>
                        {showGate && (
                            <SystemNoticeCard
                                variant="info"
                                icon="sparkles"
                                title={t('basketTab.templates.gateTitle')}
                                body={`${t('basketTab.templates.gateBody')}\n\n${t('basketTab.templates.gateBodyDetail')}`}
                                onDismiss={dismissGate}
                                actions={[
                                    { label: t('basketTab.templates.gateLater'), onPress: dismissGate, style: 'secondary' },
                                    { label: t('basketTab.templates.gateUpload'), onPress: () => router.navigate('/receipt' as any), style: 'primary' },
                                ]}
                            />
                        )}
                        {showGateBanner && (
                            <SystemNoticeCard
                                layout="banner"
                                variant="info"
                                icon="receipt-outline"
                                title={t('basketTab.templates.gateBannerTitle')}
                                body={t('basketTab.templates.gateBannerBody', {
                                    progress: Math.min(receiptCount, 3),
                                    chains: Math.min(distinctChainCount, 2),
                                })}
                                actions={[{ label: t('basketTab.templates.gateBannerCta'), onPress: () => router.navigate('/receipt' as any) }]}
                            />
                        )}
                        {/* Qualified → offer to build the auto template. */}
                        {showBuildBanner && (
                            <SystemNoticeCard
                                variant="success"
                                icon="sparkles"
                                title={t('basketTab.templates.buildOfferTitle')}
                                body={t('basketTab.templates.buildOfferBody')}
                                onDismiss={dismissBuild}
                                actions={[
                                    { label: t('basketTab.templates.buildDismiss'), onPress: dismissBuild, style: 'secondary' },
                                    { label: t('basketTab.templates.buildCta'), onPress: handleBuild, style: 'primary' },
                                ]}
                            />
                        )}
                        {/* While building → AI placeholder card. */}
                        {building && <BuildingTemplateCard />}
                    </>}
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
                                    {visitCount > 0 && ` · ${visitsStr}`}
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
            <TemplateCoverEditor
                visible={coverSheetOpen}
                onClose={() => setCoverSheetOpen(false)}
                name=""
                coverColor={null}
                coverImage={null}
                submitLabel={t('basketTab.templates.createConfirm')}
                onSubmit={handleCreateTemplate}
            />

            {/* FAB — pink "+" matching the other tabs. */}
            <TouchableOpacity
                style={[styles.fab, { bottom: tabBarHeight + 16 }]}
                onPress={() => setCoverSheetOpen(true)}
                activeOpacity={0.85}
                accessibilityLabel={t('basketTab.templates.addCard')}
            >
                <Ionicons name="add" size={28} color={colors.onPrimary} />
            </TouchableOpacity>
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
        backgroundColor: c.primaryMuted ?? c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center',
    },
    templateCoverEmoji: { fontSize: 20 },
    fab: {
        position: 'absolute', right: 20,
        width: 56, height: 56, borderRadius: 28,
        backgroundColor: c.primary,
        alignItems: 'center', justifyContent: 'center',
        elevation: 4, shadowColor: c.primary,
        shadowOpacity: 0.35, shadowRadius: 8, shadowOffset: { width: 0, height: 4 },
    },

    emptyText: { fontSize: 16, color: c.textSecondary, fontWeight: '600', marginTop: 16, textAlign: 'center' },
    emptySubText: { fontSize: 13, color: c.textMuted, marginTop: 6, textAlign: 'center', lineHeight: 18 },

    refreshingBanner: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: 6, paddingVertical: 4,
        backgroundColor: c.surfaceSubtle,
    },
    refreshingText: { fontSize: 11, color: c.textSecondary, fontWeight: '500' },
});
