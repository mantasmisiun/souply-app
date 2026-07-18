import { View, TouchableOpacity, Text, StyleSheet, BackHandler, Platform } from 'react-native';
import { useCallback, useMemo, useRef } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { Toast, type ToastHandle } from '../../../components/Toast';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, radius, elevation, type AppTheme } from '../../../constants/theme';
import { GlassIconButton } from '../../../components/GlassIconButton';
import { CategoriesList, type Category } from '../../../components/browse/CategoriesList';
import { ScreenHeading } from '../../../components/ScreenHeading';
import { useCollapsingHeader, CollapsingHeader } from '../../../components/CollapsingHeader';

export default function BrowseIndex() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    // Collapsing header: "Naršyti" title hides on scroll (no pinned filter here).
    const header = useCollapsingHeader();

    // Android double-back-to-exit on the HOME tab. Without this, back on
    // Naršyti pops the root stack to app/index.tsx, whose <Redirect> instantly
    // re-creates (tabs)/browse — visually "another Naršyti behind" — and the
    // pop/redirect cycle repeats forever instead of exiting.
    const toastRef = useRef<ToastHandle>(null);
    const lastBackPressAt = useRef(0);
    useFocusEffect(useCallback(() => {
        if (Platform.OS !== 'android') return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            const now = Date.now();
            if (now - lastBackPressAt.current < 2000) {
                BackHandler.exitApp();
                return true;
            }
            lastBackPressAt.current = now;
            toastRef.current?.show(t('catalog.backToExit'));
            return true;
        });
        return () => sub.remove();
    }, [t]));

    // Tap-debounce so a quick double-tap doesn't push /search twice.
    const lastSearchPushAt = useRef(0);
    const pushSearch = () => {
        const now = Date.now();
        if (now - lastSearchPushAt.current < 600) return;
        lastSearchPushAt.current = now;
        router.push({
            pathname: '/search',
            params: { mode: 'products', source: 'catalog' },
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
                <Text style={styles.discountsTitle}>{t('catalog.discountsCardTitle')}</Text>
                <Text style={styles.discountsSub}>{t('catalog.discountsSub')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.onPrimary} />
        </TouchableOpacity>
    );

    return (
        <View style={{ flex: 1 }}>
            {/* "Naršyti" collapses on scroll; the discounts shortcut scrolls with the list. */}
            <CollapsingHeader
                controller={header}
                background={colors.cardBackground}
                right={searchAction}
                collapsing={<ScreenHeading title={t('catalog.title')} />}
            />
            <CategoriesList
                onSelectL2={handleSelectL2}
                scroll={header.scroll}
                contentPaddingTop={header.paddingTop}
                header={discountsHeader}
            />
            <Toast ref={toastRef} />
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    discountsCard: {
        backgroundColor: c.primary,
        borderRadius: radius.lg,
        paddingHorizontal: 16,
        paddingVertical: 18,
        // Sits inside the list's 16px content padding now; this matches
        // the inter-card gap so it reads like the first row of the list.
        marginBottom: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        ...elevation.level2,
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
