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
  // The opaque backdrop a docked sheet fades into at the FULL detent — WHITE, the
  // same white as the section cards; at stage 3 the sections are set off from it
  // only by a very soft, gradual shadow (not a colour difference).
  sheetSurface:    '#FFFFFF',
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

  // Material-3 tonal roles (Android modernization). Keyed to the beet brand
  // instead of wallpaper dynamic colour, so the identity stays intact while
  // gaining M3's container / state-layer / surface-tint vocabulary.
  secondaryContainer:   '#F6D9E2',              // active-indicator / filled-tonal fill
  onSecondaryContainer: '#7A2E45',              // icon/label/text ON the tonal fill
  surfaceContainer:     '#F4EEF0',              // tinted elevated surface (nav bar, sheets)
  surfaceContainerHigh: '#FBF6F8',              // one elevation step higher
  surfaceTint:          palette.beet as string, // elevation-tint overlay colour
  outlineVariant:       '#E6DDE1',              // tinted hairline divider
  // The TWO canonical separators (see DIVIDER_ITEM_HEIGHT). `Item` divides rows
  // inside a section — a clearly-visible gray, readable from a distance/angle.
  // `Bar` divides the bottom bar from its sheet — very thin, found only if
  // sought. Use ONLY these two; never invent another divider.
  dividerItem:          'rgba(60,60,67,0.24)',
  dividerBar:           'rgba(60,60,67,0.10)',

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
  // Sheet backdrop sits BELOW the cards — near-black so the #1C1C1E cards read
  // as raised.
  sheetSurface:    '#0E0E10',
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

  // Material-3 tonal roles (mirror of light; lifted for dark surfaces).
  secondaryContainer:   '#4A2A34',
  onSecondaryContainer: '#FBD3DE',
  surfaceContainer:     '#262227',
  surfaceContainerHigh: '#2F2A30',
  surfaceTint:          palette.beet,
  outlineVariant:       '#3A3236',
  // Dark: item divider is a VERY light gray (visible on the dark card); bar
  // divider stays whisper-thin. See the light-theme note.
  dividerItem:          'rgba(255,255,255,0.26)',
  dividerBar:           'rgba(255,255,255,0.10)',

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

/** Corner-radius scale. `pill` is a large-but-FINITE value for fully-rounded (stadium)
 *  shapes: RN clamps every corner to min(w,h)/2, so 100 renders identically to a huge
 *  value for any pill/button/avatar we use (all ≤200px in their smaller dimension), while
 *  avoiding the pathological 999 that has repeatedly crashed Android's new-arch
 *  Border/BackgroundDrawable ("Required value was null"). Do NOT raise this back to 999. */
export const radius = {
  sm: 8,
  md: 12,
  lg: 20,
  xl: 28,
  pill: 100,
} as const;

/** Height of the canonical ITEM separator (theme.dividerItem) — thick enough to
 *  read a section's rows apart at a glance. The BAR separator (theme.dividerBar)
 *  is always StyleSheet.hairlineWidth. These two are the ONLY dividers. */
export const DIVIDER_ITEM_HEIGHT = 1;

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
  display:         { fontSize: 32, lineHeight: 38, fontWeight: '700' as const },
  title:           { fontSize: 24, lineHeight: 30, fontWeight: '700' as const },
  heading:         { fontSize: 20, lineHeight: 26, fontWeight: '600' as const },
  subheading:      { fontSize: 18, lineHeight: 24, fontWeight: '700' as const },
  body:            { fontSize: 16, lineHeight: 22, fontWeight: '400' as const },
  bodyStrong:      { fontSize: 16, lineHeight: 22, fontWeight: '600' as const },
  bodySmall:       { fontSize: 14, lineHeight: 20, fontWeight: '400' as const },
  bodySmallStrong: { fontSize: 14, lineHeight: 20, fontWeight: '600' as const },
  label:           { fontSize: 13, lineHeight: 18, fontWeight: '600' as const },
  labelSmall:      { fontSize: 12, lineHeight: 16, fontWeight: '600' as const },
  caption:         { fontSize: 11, lineHeight: 15, fontWeight: '500' as const },
  // Price figures — bespoke weights/sizes kept as named tokens so they read
  // identically everywhere (results sheet, list, basket).
  price:           { fontSize: 18, lineHeight: 22, fontWeight: '700' as const },
  priceLarge:      { fontSize: 22, lineHeight: 26, fontWeight: '800' as const },
} as const;

/** Motion primitives — durations (ms) + easing/spring for reanimated. */
export const motion = {
  duration: { fast: 150, base: 250, slow: 400 },
  /** Material-3 easing as cubic-bezier control points (feed to Easing.bezier). */
  easing: { standard: [0.2, 0, 0, 1] as const, emphasized: [0.05, 0.7, 0.1, 1] as const },
  /** Default spring for press + the tab-bar active indicator. */
  spring: { damping: 18, stiffness: 220, mass: 1 },
  /** Bouncier spring for expressive shape-morph / stretch (M3 Expressive). */
  springExpressive: { damping: 13, stiffness: 200, mass: 1 },
} as const;

/** Material-3 state-layer opacities — a translucent overlay of the role colour
 *  laid over a surface on interaction (hover/focus/press). Pair with `withAlpha`. */
export const stateLayer = { hover: 0.08, focus: 0.1, pressed: 0.1, dragged: 0.16 } as const;

/** Apply an alpha channel to a #RRGGBB hex → rgba() string (for ripples +
 *  state layers). Falls back to the input if it isn't a 6-digit hex. */
export const withAlpha = (hex: string, alpha: number): string => {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

/** Material-3 elevation tiers → RN shadow (iOS) + `elevation` (Android).
 *  Neutral shadow; reads softer on dark surfaces automatically. */
export const elevation = {
  level0: {},
  level1: { shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 3,  shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  level2: { shadowColor: '#000', shadowOpacity: 0.10, shadowRadius: 6,  shadowOffset: { width: 0, height: 2 }, elevation: 3 },
  level3: { shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  level4: { shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 10 },
} as const;
