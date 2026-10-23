import type { ReactNode } from 'react';
import { View, Text, StyleSheet, type LayoutChangeEvent } from 'react-native';
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
    leading,
    trailing,
    topInset,
    bleed,
    bleedX,
    onLayout,
}: {
    title: string;
    /** Optional second line — a plain string or custom JSX (e.g. a breadcrumb). */
    subtitle?: ReactNode;
    /** Optional node LEFT of the title (e.g. a recipe's cover-emoji chip). Same
     *  row as the title, so the screen keeps ONE heading component instead of
     *  hand-rolling a title row with its own (smaller, drifting) type. */
    leading?: ReactNode;
    /** Optional node on the right of the TITLE line (e.g. an info button). */
    trailing?: ReactNode;
    /** Status-bar inset to reserve when this heading sits at the very top with
     *  no native bar above it (e.g. loading states of bar-less screens). */
    topInset?: number;
    /**
     * Only when rendered as the first item INSIDE a padded scroll/list: the
     * parent content padding to cancel so the band stays flush + full-width.
     * Omit for the normal fixed-header placement (outside the scroll).
     */
    bleed?: number;
    /** HORIZONTAL-only bleed (marginHorizontal). Use in the new collapsing-bar
     *  pattern when the title sits inside a horizontally-padded scroll but must
     *  align full-width — unlike `bleed`, it never shifts marginTop (which would
     *  pull the title under the bar now that content paddingTop is 0). */
    bleedX?: number;
    /** Reports the heading's measured height — the collapsing bar uses it to
     *  time the small-title fade (fade in once the large title has scrolled by
     *  this height). Wire to `header.onTitleLayout`. */
    onLayout?: (e: LayoutChangeEvent) => void;
}) {
    const colors = useTheme();
    return (
        <View
            onLayout={onLayout}
            style={[
                styles.wrap,
                // No background — the heading sits directly on the page; the
                // top-of-screen fade (CollapsingHeader) handles scroll-out.
                bleed ? { marginHorizontal: -bleed, marginTop: -bleed } : null,
                bleedX ? { marginHorizontal: -bleedX } : null,
                topInset ? { paddingTop: topInset + 6 } : null,
            ]}
        >
            {(trailing != null || leading != null) ? (
                <View style={styles.titleRow}>
                    {leading}
                    <Text style={[styles.title, styles.titleFlex, { color: colors.textPrimary }]} numberOfLines={2}>
                        {title}
                    </Text>
                    {trailing}
                </View>
            ) : (
                <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={2}>
                    {title}
                </Text>
            )}
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
    // THE large screen title (Kategorijos, Apsipirkimai, Receptai, a recipe's
    // name …). Deliberately a different level from the sheet titles
    // (SheetTitle, 22) — those must NOT follow this.
    title: { fontSize: 33, lineHeight: 38, fontWeight: '700' },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    titleFlex: { flex: 1 },
    subtitle: { fontSize: 12, marginTop: 3 },
    subtitleWrap: { marginTop: 3 },
});
