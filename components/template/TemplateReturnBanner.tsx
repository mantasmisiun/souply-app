import { TouchableOpacity, Text, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useMemo } from 'react';
import { useTheme, radius, elevation, type AppTheme } from '../../constants/theme';
import { ScalePressable } from '../ScalePressable';
import { useTemplateAddState } from '../../state/templateAddState';
import { ltPluralSuffix } from '../../utils/ltPlural';

interface Props {
    templateId: number;
}

/**
 * Sticky bottom bar shown across the "add to template" flow
 * (template-add categories, /browse/[categoryId], /product/[id], /search
 * with templateId). Mirrors the browse-tab basket bar: item count on the
 * left, a "Šablonas" CTA on the right that pops the entire add-flow
 * stack back to the template editor in one tap.
 */
export function TemplateReturnBanner({ templateId }: Props) {
    const colors = useTheme();
    const { t, i18n } = useTranslation();
    const insets = useSafeAreaInsets();
    const router = useRouter();
    const itemCount = useTemplateAddState(s => s.items.length);
    const styles = useMemo(() => makeStyles(colors), [colors]);
    // Pick the Lithuanian noun form ourselves so we don't depend on the
    // runtime's `Intl.PluralRules` data (Hermes can collapse LT to
    // one/other on some Android builds). EN sticks with i18next's
    // default one/other resolution.
    const countLabel = i18n.language === 'lt'
        ? t(`items.count_${ltPluralSuffix(itemCount)}`, { count: itemCount })
        : t('items.count', { count: itemCount });

    const onPress = () => {
        try {
            router.dismissTo(`/template/${templateId}` as any);
        } catch {
            router.replace(`/template/${templateId}` as any);
        }
    };

    return (
        <View style={[styles.bar, { paddingBottom: Math.max(12, insets.bottom) }]}>
            <View style={styles.left}>
                <Ionicons name="albums-outline" size={20} color={colors.primary} />
                <Text style={styles.count}>{countLabel}</Text>
            </View>
            <ScalePressable style={styles.btn} onPress={onPress}>
                <Text style={styles.btnText}>{t('basketTab.templates.templateShortcut')}</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.onPrimary} />
            </ScalePressable>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    bar: {
        position: 'absolute', left: 0, right: 0, bottom: 0,
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: 16, paddingTop: 12, gap: 12,
        backgroundColor: c.cardBackground,
        borderTopLeftRadius: radius.lg,
        borderTopRightRadius: radius.lg,
        ...elevation.level3,
    },
    left: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
    count: { fontSize: 14, fontWeight: '600', color: c.primary },
    btn: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        backgroundColor: c.primary,
        paddingVertical: 10, paddingHorizontal: 16,
        borderRadius: radius.pill,
    },
    btnText: { fontSize: 14, fontWeight: '700', color: c.onPrimary },
});
