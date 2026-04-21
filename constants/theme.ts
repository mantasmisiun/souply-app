/**
 * Central theme definition for the app.
 *
 * The four-colour palette (`palette`) is the single source of truth for the
 * brand identity — change those four hex values and the entire app reskins.
 * Semantic tokens (`lightTheme` / `darkTheme`) map the palette to the roles
 * that screens actually reference (primary, pageBackground, etc.), so a later
 * palette swap doesn't require renaming every usage site.
 *
 * Consumption pattern (approach B):
 *   const colors = useTheme();
 *   const styles = useMemo(() => makeStyles(colors), [colors]);
 *
 * with `makeStyles(c: AppTheme) => StyleSheet.create({...})` at file bottom.
 *
 * Dark theme is stubbed to mirror light for now; fill in its values when
 * dark-mode support is wanted. Both themes must share the same keys — the
 * `AppTheme` type enforces that via `typeof lightTheme`.
 */

import { Platform, useColorScheme } from 'react-native';

// ---------- Palette ----------
// The four brand colours. Modify these to reskin the app end-to-end.
export const palette = {
  cream: '#FBF3E6',
  blush: '#F8D4DE',
  beet:  '#EB6784',
  teal:  '#5EA29A',
} as const;

// ---------- Light theme ----------
const lightTheme = {
  // Surfaces
  pageBackground:  palette.cream,
  cardBackground:  '#FFFFFF',
  surfaceMuted:    '#F3F4F6',
  surfaceSubtle:   '#FAFAFA',
  overlayBackdrop: 'rgba(17, 24, 39, 0.45)',

  // Brand / primary (beet — signature šaltibarščiai pink)
  primary:        palette.beet,
  primaryShadow:  palette.beet,
  primaryMuted:   '#FDE7ED',
  primaryStrong:  '#C95073',
  onPrimary:      '#FFFFFF',

  // Secondary (teal — completed / verified)
  success:        palette.teal,
  successMuted:   '#D8ECE9',
  onSuccess:      '#FFFFFF',

  // Soft accent (blush)
  softAccent:     palette.blush,
  softAccentWash: '#FDF1F4',

  // Text
  textPrimary:    '#212121',
  textSecondary:  '#757575',
  textMuted:      '#9E9E9E',
  textInverse:    '#FFFFFF',

  // Borders / dividers
  border:         '#E0E0E0',
  borderSubtle:   '#F0F0F0',
  borderMuted:    '#EEEEEE',

  // Status
  warning:        '#F57C00',
  warningMuted:   '#FFECB3',
  onWarning:      '#8D6E63',
  error:          '#C62828',
  errorMuted:     '#FFEBEE',
  errorStrong:    '#991B1B',
  info:           '#1565C0',
  infoMuted:      '#E3F2FD',
} as const;

// ---------- Dark theme (stub — copy of light for now) ----------
// TODO: populate with real dark values when dark-mode is wired in.
const darkTheme: typeof lightTheme = {
  ...lightTheme,
};

export type AppTheme = typeof lightTheme;

// ---------- Hook ----------
export function useTheme(): AppTheme {
  const scheme = useColorScheme();
  return scheme === 'dark' ? darkTheme : lightTheme;
}

// ---------- Legacy export ----------
// Kept for compatibility with Expo-template helpers (themed-text, themed-view,
// parallax-scroll-view, collapsible). Not used by the app's own screens.
const tintColorLight = palette.beet;
const tintColorDark = '#fff';

export const Colors = {
  light: {
    text: lightTheme.textPrimary,
    background: lightTheme.pageBackground,
    tint: tintColorLight,
    icon: lightTheme.textSecondary,
    tabIconDefault: lightTheme.textSecondary,
    tabIconSelected: tintColorLight,
  },
  dark: {
    text: '#ECEDEE',
    background: '#151718',
    tint: tintColorDark,
    icon: '#9BA1A6',
    tabIconDefault: '#9BA1A6',
    tabIconSelected: tintColorDark,
  },
};

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
