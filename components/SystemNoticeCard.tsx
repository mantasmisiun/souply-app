import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, type AppTheme } from '../constants/theme';

export type NoticeVariant = 'info' | 'success' | 'warning' | 'banner';

export interface NoticeAction {
    label: string;
    onPress: () => void;
    style?: 'primary' | 'secondary' | 'destructive';
}

interface Props {
    variant?: NoticeVariant;
    icon?: keyof typeof Ionicons.glyphMap;
    title: string;
    body?: string;
    actions?: NoticeAction[];
    /** Renders a small X in the top-right; only when provided. */
    onDismiss?: () => void;
    /**
     * Style hint: `card` is a full-width hero card (used for onboarding
     * gate + announcement). `banner` is a slim one-line strip (used for
     * the persistent post-dismiss banner + the auto-update nudge).
     * Defaults to `card`.
     */
    layout?: 'card' | 'banner';
}

/**
 * Single component the Krepselis tab uses for every "system says
 * something here" surface — onboarding gate, post-dismiss banner,
 * auto-generated template announcement, auto-update nudge.
 *
 * Source spec: Documentation/roadmap/sablonai.md Part 2.1 ("scoped to
 * Krepselis tab — not an app-wide modal").
 */
export function SystemNoticeCard({
    variant = 'info',
    icon,
    title,
    body,
    actions,
    onDismiss,
    layout = 'card',
}: Props) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const tint =
        variant === 'success' ? colors.success
        : variant === 'warning' ? colors.warning
        : colors.primary;

    if (layout === 'banner') {
        return (
            <View style={[styles.banner, { borderColor: tint }]}>
                {icon && <Ionicons name={icon} size={18} color={tint} />}
                <View style={{ flex: 1 }}>
                    <Text style={styles.bannerTitle} numberOfLines={2}>{title}</Text>
                    {body && <Text style={styles.bannerBody} numberOfLines={2}>{body}</Text>}
                </View>
                {actions && actions.length > 0 && (
                    <TouchableOpacity onPress={actions[0].onPress}>
                        <Text style={[styles.bannerAction, { color: tint }]}>
                            {actions[0].label}
                        </Text>
                    </TouchableOpacity>
                )}
                {onDismiss && (
                    <TouchableOpacity onPress={onDismiss} hitSlop={8}>
                        <Ionicons name="close" size={18} color={colors.textMuted} />
                    </TouchableOpacity>
                )}
            </View>
        );
    }

    return (
        <View style={[styles.card, { borderColor: tint }]}>
            {onDismiss && (
                <TouchableOpacity
                    style={styles.dismissBtn}
                    onPress={onDismiss}
                    hitSlop={8}
                >
                    <Ionicons name="close" size={18} color={colors.textMuted} />
                </TouchableOpacity>
            )}
            {icon && (
                <View style={[styles.iconWrap, { backgroundColor: colors.primaryMuted }]}>
                    <Ionicons name={icon} size={22} color={tint} />
                </View>
            )}
            <Text style={styles.title}>{title}</Text>
            {body && <Text style={styles.body}>{body}</Text>}
            {actions && actions.length > 0 && (
                <View style={styles.actions}>
                    {actions.map((a, i) => {
                        const isPrimary = a.style === 'primary' || (a.style === undefined && i === actions.length - 1);
                        return (
                            <TouchableOpacity
                                key={`${a.label}-${i}`}
                                style={[
                                    isPrimary ? styles.primaryBtn : styles.secondaryBtn,
                                    isPrimary && { backgroundColor: tint },
                                ]}
                                onPress={a.onPress}
                            >
                                <Text style={isPrimary ? styles.primaryBtnText : styles.secondaryBtnText}>
                                    {a.label}
                                </Text>
                            </TouchableOpacity>
                        );
                    })}
                </View>
            )}
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    card: {
        backgroundColor: c.cardBackground,
        borderRadius: 14, padding: 16, marginBottom: 14,
        gap: 8, borderWidth: 1,
        position: 'relative',
    },
    dismissBtn: { position: 'absolute', top: 10, right: 10, padding: 4, zIndex: 1 },
    iconWrap: {
        width: 36, height: 36, borderRadius: 18,
        alignItems: 'center', justifyContent: 'center',
        marginBottom: 4,
    },
    title: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
    body: { fontSize: 13, color: c.textSecondary, lineHeight: 18 },
    actions: { flexDirection: 'row', gap: 10, marginTop: 6 },
    secondaryBtn: {
        paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8,
        borderWidth: 1, borderColor: c.border,
    },
    secondaryBtnText: { fontSize: 13, fontWeight: '600', color: c.textSecondary },
    primaryBtn: {
        paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8,
    },
    primaryBtnText: { fontSize: 13, fontWeight: '700', color: c.onPrimary },

    banner: {
        flexDirection: 'row', alignItems: 'center', gap: 10,
        backgroundColor: c.cardBackground,
        paddingHorizontal: 14, paddingVertical: 10,
        marginBottom: 10,
        borderRadius: 10, borderLeftWidth: 3,
    },
    bannerTitle: { fontSize: 13, fontWeight: '600', color: c.textPrimary },
    bannerBody: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
    bannerAction: { fontSize: 13, fontWeight: '700' },
});
