import { useEffect, useMemo, useRef } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, type AppTheme } from '../../constants/theme';
import { GlassIconButton } from '../../components/GlassIconButton';
import { CategoriesList, type Category } from '../../components/browse/CategoriesList';
import { ScreenHeading } from '../../components/ScreenHeading';
import { useCollapsingHeader, CollapsingHeader } from '../../components/CollapsingHeader';
import { TemplateReturnBanner } from '../../components/template/TemplateReturnBanner';
import { useTemplateAddState } from '../../state/templateAddState';

/**
 * Browse-categories screen pushed on top of the template editor when the
 * user taps "Pridėti prekę". Same L1/L2 layout as the Narsyti tab via the
 * shared CategoriesList, but every downstream push (L2 list, search,
 * discounts, product detail) carries a `templateId` param so the add
 * button on each surface targets the template instead of the basket.
 *
 * Also hydrates `useTemplateAddState` so downstream screens render
 * already-in-template products with a quantity stepper instead of the
 * "Į šabloną" add button, and the bottom Šablonas banner reflects the
 * live item count without each screen needing to re-fetch.
 */
export default function TemplateAddScreen() {
    const { templateId: rawId } = useLocalSearchParams<{ templateId: string }>();
    const templateId = Number(rawId);
    const colors = useTheme();
    const header = useCollapsingHeader();
    const { t } = useTranslation();
    const router = useRouter();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const hydrate = useTemplateAddState(s => s.hydrate);

    useEffect(() => {
        if (!Number.isFinite(templateId)) return;
        hydrate(templateId);
    }, [templateId, hydrate]);

    const lastSearchPushAt = useRef(0);
    const pushSearch = () => {
        const now = Date.now();
        if (now - lastSearchPushAt.current < 600) return;
        lastSearchPushAt.current = now;
        router.push({
            pathname: '/search',
            params: { mode: 'products', source: 'template-add', templateId: String(templateId) },
        });
    };

    const handleSelectL2 = useMemo(() => (l2: Category) => {
        router.push(
            `/browse/${l2.id}?name=${encodeURIComponent(l2.name)}&templateId=${templateId}`
        );
    }, [router, templateId]);

    return (
        <>
            <CollapsingHeader
                controller={header}
                background={colors.cardBackground}
                back
                right={<GlassIconButton icon="search" onPress={pushSearch} />}
                collapsing={<ScreenHeading title={t('basketTab.templates.addItemTitle')} />}
            />
            <View style={{ flex: 1 }}>
                <CategoriesList
                    onSelectL2={handleSelectL2}
                    scroll={header.scroll}
                    contentPaddingTop={header.paddingTop}
                    header={
                        // Nuolaidos shortcut (mirrors the Narsyti tab) — scrolls
                        // with the list; templateId forwarded so discounts add to
                        // the template, not the basket.
                        <TouchableOpacity
                            style={styles.discountsCard}
                            onPress={() => router.push(`/discounts?templateId=${templateId}` as any)}
                            activeOpacity={0.8}
                        >
                            <Text style={styles.discountsIcon}>🔥</Text>
                            <View style={styles.discountsTextWrap}>
                                <Text style={styles.discountsTitle}>{t('browse.discountsCardTitle')}</Text>
                                <Text style={styles.discountsSub}>{t('browse.discountsSub')}</Text>
                            </View>
                            <Ionicons name="chevron-forward" size={20} color={colors.onPrimary} />
                        </TouchableOpacity>
                    }
                />
                {Number.isFinite(templateId) && (
                    <TemplateReturnBanner templateId={templateId} />
                )}
            </View>
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    discountsWrap: {
        paddingHorizontal: 16,
        paddingTop: 12,
        backgroundColor: c.pageBackground,
    },
    discountsCard: {
        backgroundColor: c.primary,
        borderRadius: 14,
        marginBottom: 10,
        paddingHorizontal: 16,
        paddingVertical: 18,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        elevation: 2,
        shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.12, shadowRadius: 4,
    },
    discountsIcon: { fontSize: 28 },
    discountsTextWrap: { flex: 1 },
    discountsTitle: {
        fontSize: 17,
        fontWeight: '700',
        color: c.onPrimary,
    },
    discountsSub: {
        fontSize: 12,
        color: c.onPrimary,
        opacity: 0.8,
        marginTop: 2,
    },
});
