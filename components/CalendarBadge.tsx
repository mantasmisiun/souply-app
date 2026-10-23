import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatMonthAbbr, formatDayNum } from '../utils/formatDayDate';
import { useTheme, type AppTheme } from '../constants/theme';

/**
 * Compact tear-off calendar icon — a coloured month strip ("LIE") over a big day
 * number ("16"). Used for auto-named baskets/trips so the last-activity date
 * reads at a glance instead of the cryptic "Ket liepos 16" string. Renders
 * nothing when the date is invalid.
 */
export default function CalendarBadge({
    date,
    size = 32,
}: {
    date: string | Date | null | undefined;
    size?: number;
}) {
    const colors = useTheme();
    const { i18n } = useTranslation();
    const styles = useMemo(() => makeStyles(colors, size), [colors, size]);
    const month = formatMonthAbbr(date, i18n.language);
    const day = formatDayNum(date);
    if (!day) return null;
    return (
        <View style={styles.badge} accessibilityLabel={`${month} ${day}`}>
            <View style={styles.strip}>
                <Text style={styles.month} allowFontScaling={false} numberOfLines={1}>{month.toUpperCase()}</Text>
            </View>
            <View style={styles.body}>
                <Text style={styles.day} allowFontScaling={false} numberOfLines={1}>{day}</Text>
            </View>
        </View>
    );
}

const makeStyles = (c: AppTheme, size: number) => {
    const stripH = Math.round(size * 0.36);
    return StyleSheet.create({
        badge: {
            width: Math.round(size * 0.92),
            height: size,
            borderRadius: Math.max(5, Math.round(size * 0.2)),
            overflow: 'hidden',
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: c.border,
            backgroundColor: c.cardBackground,
        },
        strip: {
            height: stripH,
            backgroundColor: c.primary,
            alignItems: 'center',
            justifyContent: 'center',
        },
        month: { color: c.onPrimary, fontSize: Math.round(size * 0.24), fontWeight: '800', letterSpacing: 0.3 },
        body: { flex: 1, alignItems: 'center', justifyContent: 'center' },
        day: {
            color: c.textPrimary,
            fontSize: Math.round(size * 0.42),
            fontWeight: '800',
            lineHeight: Math.round(size * 0.46),
        },
    });
};
