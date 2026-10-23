import { Text, StyleSheet } from 'react-native';
import { useTheme, typography } from '../../constants/theme';

/**
 * THE single source of truth for a bottom-sheet's title. Every sheet (Discounts,
 * Impulse, Missed, Prognozė, Savings, Planning) renders its heading through this
 * so the size/weight can never drift between sheets. Pass `count` to append the
 * standard "· N" suffix.
 */
export function SheetTitle({ title, count }: { title: string; count?: number }) {
    const colors = useTheme();
    return (
        <Text style={[styles.title, { color: colors.textPrimary }]}>
            {count != null ? `${title} · ${count}` : title}
        </Text>
    );
}

// Font metrics live here (module-level, not per-sheet) so they're byte-identical.
const styles = StyleSheet.create({
    title: { ...typography.subheading },
});
