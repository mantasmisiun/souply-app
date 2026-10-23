import { Text, type StyleProp, type TextStyle } from 'react-native';
import { type AppTheme } from '../../constants/theme';

/**
 * THE dock-sheet title (22/700) — one definition for every sheet.
 *
 * It existed as three separate copies of the same literal (`sheetHeading` in
 * BasketDockSheet and ShoppingSheet, `sheetTitle` on the recipe screen), and two
 * of them carried an extra `paddingTop: spacing.xs` while the third did not — so
 * those two titles sat 4px lower than the others.
 *
 * There is NO vertical padding here on purpose: the sheet's own content inset
 * (the shared SheetContent wrapper) owns the gap to the sheet's top edge.
 * A title that adds its own padding double-counts against it, which is exactly
 * how the drift happened. Spacing BELOW the title belongs to the content column's
 * `gap`, not to the title.
 */
export function SheetTitle({ colors, children, style, numberOfLines }: {
    colors: AppTheme;
    children: React.ReactNode;
    /** Layout-only overrides (`flex: 1`, margins) — never the type itself. */
    style?: StyleProp<TextStyle>;
    numberOfLines?: number;
}) {
    return (
        <Text style={[{ fontSize: 22, fontWeight: '700', color: colors.textPrimary }, style]} numberOfLines={numberOfLines}>
            {children}
        </Text>
    );
}
