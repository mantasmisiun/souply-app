import type { ReactNode } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../constants/theme';

/**
 * Left-aligned page title (+ optional subtitle/breadcrumb), rendered as a fixed
 * header band directly under the native bar — pinned, never scrolls.
 *
 * Why in the body and not the nav bar: on iOS, react-native-screens always
 * CENTERS the bar title and (on 4.16) can't strip the iOS-26 glass capsule off
 * a left-bar title. So an always-left, glass-free title with room for a
 * subtitle has to live here. The native bar above carries only the glass back
 * chevron + glass actions (its title is left empty).
 *
 * One component, used by every screen — identical on iOS and Android.
 */
export function ScreenHeading({
    title,
    subtitle,
    topInset,
    bleed,
}: {
    title: string;
    /** Optional second line — a plain string or custom JSX (e.g. a breadcrumb). */
    subtitle?: ReactNode;
    /** Status-bar inset to reserve when this heading sits at the very top with
     *  no native bar above it (e.g. loading states of bar-less screens). */
    topInset?: number;
    /**
     * Only when rendered as the first item INSIDE a padded scroll/list: the
     * parent content padding to cancel so the band stays flush + full-width.
     * Omit for the normal fixed-header placement (outside the scroll).
     */
    bleed?: number;
}) {
    const colors = useTheme();
    return (
        <View
            style={[
                styles.wrap,
                { backgroundColor: colors.cardBackground },
                bleed ? { marginHorizontal: -bleed, marginTop: -bleed } : null,
                topInset ? { paddingTop: topInset + 6 } : null,
            ]}
        >
            <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={2}>
                {title}
            </Text>
            {subtitle != null
                ? typeof subtitle === 'string'
                    ? (
                        <Text style={[styles.subtitle, { color: colors.textMuted }]} numberOfLines={1}>
                            {subtitle}
                        </Text>
                    )
                    : <View style={styles.subtitleWrap}>{subtitle}</View>
                : null}
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 12 },
    title: { fontSize: 22, fontWeight: '700' },
    subtitle: { fontSize: 12, marginTop: 3 },
    subtitleWrap: { marginTop: 3 },
});
