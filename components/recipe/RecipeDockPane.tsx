import { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SHEET_CARD_SHADOW_RADIUS } from '../SheetCard';
import { DockActionRow } from '../dock/DockActionRow';
import { useRecipeDock } from '../../state/recipeDock';
import { useTheme, spacing, type AppTheme } from '../../constants/theme';

/**
 * The Receptai tab's dock sheet — swipe up from the tab bar to start a recipe.
 *
 * Two ways in, one destination: both routes end at the same cover sheet
 * (emoji / colour / name), and the only thing chosen here is where the item
 * list comes from — nothing, or a web page.
 *
 * The actions themselves live on the Receptai SCREEN, which already owns the
 * cover editor and the URL sheet; this pane asks through `recipeDock` and
 * collapses itself first, so the sheet is never left hanging behind whatever it
 * opened.
 */
export function RecipeDockPane({ collapse }: { collapse: () => void }) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const startBlank = useRecipeDock(s => s.startBlank);
    const startFromUrl = useRecipeDock(s => s.startFromUrl);

    const start = (fn: (() => void) | null) => () => {
        collapse();
        fn?.();
    };

    return (
        <View style={styles.body}>
            {/* Screen-title font, matching the basket chooser's heading — the
                sheet reads as a destination, not a toolbar. */}
            <Text style={styles.heading}>{t('basketTab.templates.createSheetTitle')}</Text>
            <DockActionRow
                colors={colors}
                actions={[
                    {
                        icon: 'add-circle-outline',
                        title: t('basketTab.templates.createBlankTitle'),
                        subtitle: t('basketTab.templates.createBlankSub'),
                        onPress: start(startBlank),
                    },
                    {
                        icon: 'link-outline',
                        title: t('basketTab.templates.createFromUrlTitle'),
                        subtitle: t('basketTab.templates.createFromUrlSub'),
                        onPress: start(startFromUrl),
                    },
                ]}
            />
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    // paddingBottom reserves the action cards' shadow halo — the sheet's scroll
    // viewport clips overflow, so without it their shadow is cut off.
    body: {
        paddingHorizontal: spacing.lg, paddingTop: spacing.sm,
        paddingBottom: SHEET_CARD_SHADOW_RADIUS, gap: spacing.md,
    },
    heading: {
        fontSize: 22, fontWeight: '700', color: c.textPrimary,
        paddingTop: spacing.xs, paddingBottom: spacing.xs,
    },
});
