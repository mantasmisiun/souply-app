import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { useMemo, useRef } from 'react';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../../constants/theme';
import { GlassIconButton } from '../../../components/GlassIconButton';
import { CategoriesList, type Category } from '../../../components/browse/CategoriesList';
import { glassHeaderOptions } from '../../../constants/navHeader';
import { ScreenHeading } from '../../../components/ScreenHeading';

export default function BrowseIndex() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();

    // Tap-debounce so a quick double-tap doesn't push /search twice.
    const lastSearchPushAt = useRef(0);
    const pushSearch = () => {
        const now = Date.now();
        if (now - lastSearchPushAt.current < 600) return;
        lastSearchPushAt.current = now;
        router.push({
            pathname: '/search',
            params: { mode: 'products', source: 'browse' },
        });
    };

    const handleSelectL2 = (l2: Category) => {
        router.push(`/browse/${l2.id}?name=${encodeURIComponent(l2.name)}`);
    };

    const searchAction = (
        <GlassIconButton icon="search" onPress={pushSearch} />
    );

    // Nuolaidos shortcut — passed as the categories list HEADER so it
    // scrolls away with the list (like a category item) instead of being
    // pinned above it.
    const discountsHeader = (
        <TouchableOpacity
            style={styles.discountsCard}
            onPress={() => router.push('/discounts' as any)}
            activeOpacity={0.8}
        >
            <Text style={styles.discountsIcon}>🔥</Text>
            <View style={styles.discountsTextWrap}>
                <Text style={styles.discountsTitle}>{t('browse.discountsCardTitle')}</Text>
                <Text style={styles.discountsSub}>{t('browse.discountsSub')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.onPrimary} />
        </TouchableOpacity>
    );

    return (
        <View style={{ flex: 1 }}>
            <Stack.Screen options={glassHeaderOptions({ right: searchAction })} />
            {/* Heading lives in the list header so it scrolls away like product. */}
            <CategoriesList
                onSelectL2={handleSelectL2}
                header={<><ScreenHeading title={t('browse.title')} bleed={16} />{discountsHeader}</>}
            />
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    discountsCard: {
        backgroundColor: c.primary,
        borderRadius: 14,
        paddingHorizontal: 16,
        paddingVertical: 18,
        // Sits inside the list's 16px content padding now; this matches
        // the inter-card gap so it reads like the first row of the list.
        marginBottom: 10,
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
