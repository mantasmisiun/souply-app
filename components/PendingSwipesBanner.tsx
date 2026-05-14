import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useTheme, type AppTheme } from "../constants/theme";

interface Props {
  /** Total cards the user still needs to swipe across all recent receipts. */
  pendingCount: number;
  /** Disabled visual when true (offline / batch still processing). */
  disabled: boolean;
  /** Sub-line shown when disabled, e.g. "Laukiama tinklo" or "Apdorojami kvitai". */
  disabledHint?: string;
  onPress: () => void;
}

export function PendingSwipesBanner({
  pendingCount,
  disabled,
  disabledHint,
  onPress,
}: Props) {
  const colors = useTheme();
  const { t } = useTranslation();
  const styles = makeStyles(colors);

  if (pendingCount <= 0) return null;

  // i18next plural selection (lt: one/few/other, en: one/other) — picks
  // the right form automatically from the count param.
  const label = t('banners.pendingSwipes.label', { count: pendingCount });

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      disabled={disabled}
      onPress={onPress}
      style={[styles.container, disabled && styles.disabled]}
    >
      <View style={styles.iconWrap}>
        <Ionicons name="sparkles" size={20} color={colors.onPrimary} />
      </View>
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {t('banners.pendingSwipes.title')}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {disabled && disabledHint ? disabledHint : label}
        </Text>
      </View>
      <View style={styles.cta}>
        <Text style={styles.ctaText}>{t('banners.pendingSwipes.cta')}</Text>
        <Ionicons name="arrow-forward" size={14} color={colors.primary} />
      </View>
    </TouchableOpacity>
  );
}

/**
 * Lithuanian product-count pluralisation:
 *   1            → "prekė"
 *   2..9, 22..29 → "prekės"
 *   0, 10..19, 20, 30 etc. → "prekių"
 */
export function pluralProduct(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod10 === 0 || (mod100 >= 11 && mod100 <= 19)) return "prekių";
  if (mod10 === 1) return "prekė";
  return "prekės";
}

const makeStyles = (c: AppTheme) =>
  StyleSheet.create({
    container: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: c.primaryMuted,
      borderRadius: 14,
      paddingVertical: 12,
      paddingLeft: 12,
      paddingRight: 14,
      marginBottom: 12,
      borderLeftWidth: 3,
      borderLeftColor: c.primary,
    },
    disabled: {
      opacity: 0.55,
    },
    iconWrap: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: c.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    body: {
      flex: 1,
      minWidth: 0,
    },
    title: {
      fontSize: 14,
      fontWeight: "700",
      color: c.textPrimary,
    },
    subtitle: {
      fontSize: 12,
      color: c.textSecondary,
      marginTop: 2,
    },
    cta: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: c.cardBackground,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 10,
    },
    ctaText: {
      fontSize: 13,
      fontWeight: "700",
      color: c.primary,
    },
  });
