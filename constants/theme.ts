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
 * `useTheme` resolves the active palette by reading the user preference from
 * `useSettingsStore` (light/dark/system) and falling back to the system
 * scheme when the user hasn't overridden. Both themes must share the same
 * keys — the `AppTheme` type enforces that via `typeof lightTheme`.
 */

import { Platform, useColorScheme } from 'react-native';
import { useSettingsStore, type ThemeMode } from '../state/settingsStore';

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
  pageBackground:  palette.cream as string,
  cardBackground:  '#FFFFFF',
  surfaceMuted:    '#F3F4F6',
  surfaceSubtle:   '#FAFAFA',
  overlayBackdrop: 'rgba(17, 24, 39, 0.45)',

  // Brand / primary (beet — signature šaltibarščiai pink)
  primary:        palette.beet as string,
  primaryShadow:  palette.beet as string,
  primaryMuted:   '#FDE7ED',
  primaryStrong:  '#C95073',
  onPrimary:      '#FFFFFF',

  // Secondary (teal — completed / verified)
  success:        palette.teal as string,
  successMuted:   '#D8ECE9',
  onSuccess:      '#FFFFFF',

  // Soft accent (blush)
  softAccent:     palette.blush as string,
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
};

// ---------- Dark theme ----------
// Surfaces follow iOS dark-mode conventions (near-black page bg, elevated
// cards). Brand colours stay recognisable but are lifted slightly for
// contrast against dark surfaces. Status colours use lighter shades that
// remain legible on dark.
const darkTheme: typeof lightTheme = {
  // Surfaces
  pageBackground:  '#121214',
  cardBackground:  '#1C1C1E',
  surfaceMuted:    '#2A2A2C',
  surfaceSubtle:   '#1A1A1C',
  overlayBackdrop: 'rgba(0, 0, 0, 0.6)',

  // Brand / primary — beet works on dark; muted/strong remapped for dark surfaces
  primary:        palette.beet,
  primaryShadow:  '#000000',
  primaryMuted:   '#3A1F26',
  primaryStrong:  '#FB9AB1',
  onPrimary:      '#FFFFFF',

  // Success
  success:        '#7CB8B0',
  successMuted:   '#1F3835',
  onSuccess:      '#0F1F1D',

  // Soft accent
  softAccent:     '#5C3340',
  softAccentWash: '#2A1A1F',

  // Text
  textPrimary:    '#F2F2F7',
  textSecondary:  '#A0A0A6',
  textMuted:      '#6C6C70',
  textInverse:    '#0F0F10',

  // Borders / dividers
  border:         '#3A3A3C',
  borderSubtle:   '#2A2A2C',
  borderMuted:    '#222224',

  // Status
  warning:        '#F59E0B',
  warningMuted:   '#3A2A0F',
  onWarning:      '#FED7AA',
  error:          '#F87171',
  errorMuted:     '#3A1212',
  errorStrong:    '#FCA5A5',
  info:           '#60A5FA',
  infoMuted:      '#1E2F4D',
};

export type AppTheme = typeof lightTheme;
export type ResolvedScheme = 'light' | 'dark';
export type { ThemeMode };

/**
 * Resolve the active scheme from the user's preference + the system
 * scheme. Exported so non-React contexts (e.g., crash reporters, status
 * bar setup) can resolve the same way.
 */
export function resolveScheme(mode: ThemeMode, systemScheme: 'light' | 'dark' | null | undefined): ResolvedScheme {
  if (mode === 'light' || mode === 'dark') return mode;
  return systemScheme === 'dark' ? 'dark' : 'light';
}

// ---------- Hook ----------
export function useTheme(): AppTheme {
  const systemScheme = useColorScheme();
  const themeMode = useSettingsStore((s) => s.themeMode);
  const scheme = resolveScheme(themeMode, systemScheme);
  return scheme === 'dark' ? darkTheme : lightTheme;
}

/** Same as useTheme but returns the resolved scheme name instead of the palette. */
export function useResolvedScheme(): ResolvedScheme {
  const systemScheme = useColorScheme();
  const themeMode = useSettingsStore((s) => s.themeMode);
  return resolveScheme(themeMode, systemScheme);
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

// ---------- Design tokens (non-colour, shared light/dark) ----------
// Added for the Android modernization pass. Spacing / radius / type / motion
// are theme-independent — consume directly: `import { spacing, radius } from
// '../constants/theme'`. Elevation maps Material-3 tiers to RN shadow (iOS) +
// `elevation` (Android). These give every screen one consistent vocabulary so
// the floating tab bar, cards, and future polish stop using magic numbers.

/** 4-pt spacing scale. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

/** Corner-radius scale. `pill` is intentionally huge for fully-rounded shapes. */
export const radius = {
  sm: 8,
  md: 12,
  lg: 20,
  xl: 28,
  pill: 999,
} as const;

/** Icon sizes (Ionicons & co). `xs` for inline meta chips, `md` for standard
 *  action icons. Explicit scale so glyphs stay consistent across screens. */
export const iconSize = {
  xs: 13,
  sm: 16,
  md: 20,
  lg: 24,
  xl: 28,
} as const;

/** Avatar / chain-badge diameters, on the 8-pt grid. Used by ChainLogoChip and
 *  the results sheet logos. */
export const avatarSize = {
  sm: 32,
  md: 40,
  lg: 48,
} as const;

/** Type scale (size / line-height / weight). Spread into a Text style:
 *  `style={[typography.title, { color: colors.textPrimary }]}`. */
export const typography = {
  display:    { fontSize: 32, lineHeight: 38, fontWeight: '700' as const },
  title:      { fontSize: 24, lineHeight: 30, fontWeight: '700' as const },
  heading:    { fontSize: 20, lineHeight: 26, fontWeight: '600' as const },
  body:       { fontSize: 16, lineHeight: 22, fontWeight: '400' as const },
  bodyStrong: { fontSize: 16, lineHeight: 22, fontWeight: '600' as const },
  label:      { fontSize: 13, lineHeight: 18, fontWeight: '600' as const },
  caption:    { fontSize: 11, lineHeight: 15, fontWeight: '500' as const },
} as const;

/** Motion primitives — durations (ms) + easing/spring for reanimated. */
export const motion = {
  duration: { fast: 150, base: 250, slow: 400 },
  /** Material-3 easing as cubic-bezier control points (feed to Easing.bezier). */
  easing: { standard: [0.2, 0, 0, 1] as const, emphasized: [0.05, 0.7, 0.1, 1] as const },
  /** Default spring for press + the tab-bar active indicator. */
  spring: { damping: 18, stiffness: 220, mass: 1 },
} as const;

/** Material-3 elevation tiers → RN shadow (iOS) + `elevation` (Android).
 *  Neutral shadow; reads softer on dark surfaces automatically. */
export const elevation = {
  level0: {},
  level1: { shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 3,  shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  level2: { shadowColor: '#000', shadowOpacity: 0.10, shadowRadius: 6,  shadowOffset: { width: 0, height: 2 }, elevation: 3 },
  level3: { shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  level4: { shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 10 },
} as const;
