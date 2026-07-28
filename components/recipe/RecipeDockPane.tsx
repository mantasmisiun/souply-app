import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SHEET_CARD_SHADOW_RADIUS } from '../SheetCard';
import { DockActionRow } from '../dock/DockActionRow';
import { useTheme, spacing, type AppTheme } from '../../constants/theme';

/**
 * The Receptai tab's dock sheet ROOT — swipe up from the tab bar to start a
 * recipe.
 *
 * ONE action: "Receptas". Tapping does NOT collapse the sheet — it navigates
 * WITHIN it (the SheetPaneSpec contract) to the create pane, where the blank
 * and from-a-link paths are one combined surface (URL row + cover controls).
 * The host (BasketDockSheet) owns the pane state; this row only asks.
 */
export function RecipeDockPane({ openCreate }: { openCreate: () => void }) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    return (
        <View style={styles.body}>
            <DockActionRow
                colors={colors}
                actions={[
                    {
                        icon: 'add-circle-outline',
                        title: t('basketTab.templates.createTitle'),
                        subtitle: t('basketTab.templates.createSub'),
                        onPress: openCreate,
                    },
                ]}
            />
        </View>
    );
}

const makeStyles = (_c: AppTheme) => StyleSheet.create({
    // paddingBottom reserves the action card's shadow halo — the sheet's scroll
    // viewport clips overflow, so without it the shadow is cut off.
    body: {
        paddingHorizontal: spacing.lg, paddingTop: spacing.sm,
        paddingBottom: SHEET_CARD_SHADOW_RADIUS, gap: spacing.md,
    },
});
