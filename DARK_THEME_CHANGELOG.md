# Dark theme — overnight work changelog

## Summary
- Real dark palette wired into `constants/theme.ts` (was a stub copy of light).
- New user preference: **System / Light / Dark** in Settings → Appearance.
- Persisted in `settingsStore` under `settings_theme_mode` AsyncStorage key.
- `useTheme()` now resolves: explicit user choice wins; otherwise follows OS scheme.
- StatusBar style in root layout follows the resolved scheme (not raw system).
- Audited 36 files for hardcoded hex/`rgba()`. Converted leaked semantic colors;
  kept intentional ones (shadows, chart palettes, brand-coupon, QR background,
  camera/image-preview blackdrops).

## What to QA tomorrow

1. **Open Settings → Appearance.** Verify picker shows three rows (System default /
   Light / Dark) with the right localized labels in both LT and EN.
2. **Switch to Dark.** Cycle through all five tabs (Naršyti, Krepšelis, Sąrašas,
   Analizė, Profilis). Verify:
   - Page backgrounds are dark
   - Cards are slightly lighter dark, distinguishable
   - Text is light/legible
   - Borders/dividers are subtle but visible
   - IOSTabHeader title reads in dark
   - FAB primary pink is bright enough on dark
   - Status bar icons are light (white)
3. **Donut + bar charts in Profilis.** Verify center text + axis labels are
   legible on dark; slice/bar colors still pop.
4. **Settings modals (delete account stage 1/2, goodbye).** GlassButton variants
   on dark should still render.
5. **Coupon badge** in shopping list — left intentionally branded yellow + dark
   blue (Lithuanian coupon standard). Confirm that's still what you want.
6. **Switch back to System / Light.** Verify everything still looks right.
7. **Force-quit, relaunch.** Verify the choice persists.

## Known intentional non-conversions (kept hardcoded)

- All `shadowColor: '#000'` — system shadow convention.
- Coupon badge (`#FFF3B0`, `#FFCC00`, `#003D8F`) in `app/shopping-list/[id].tsx`
  — Lithuanian branded coupon palette.
- Donut chart slice palette (8 fixed colors) in `ReceiptCategoryBreakdown.tsx`.
- Toast background `#1F2937` — intentionally dark in both modes for visibility.
- QR code background `#fff` — needs to stay white for scanner contrast.
- Camera scanner screen `#000` background — intentional for camera UX.
- Image preview backdrops `rgba(0,0,0,0.85)` — same.
- Discount % badge text (`#000`) — overlays a coloured emoji; needs black.
- Dev-only debug screens (`app/dev/receipt-detail.tsx`) — colour-coded region
  overlays for debugging; not user-facing.
- Expo template leftovers (`themed-text.tsx` `#0a7ea4`) — not used by app's
  active screens.

## Files touched

### Theme infrastructure
- `constants/theme.ts` — real `darkTheme`; new `useResolvedScheme()`,
  `resolveScheme()`, `ResolvedScheme` type; `useTheme()` consults store.
- `state/settingsStore.ts` — new `themeMode` field + setter + hydration.

### UI
- `app/settings.tsx` — Appearance section + theme picker modal.
- `app/_layout.tsx` — `useResolvedScheme` instead of raw `useColorScheme`.
- `i18n/locales/lt.json` — `settings.appearance.{section,label,system,light,dark}`.
- `i18n/locales/en.json` — same.

### Hardcoded-colour conversions
- `app/(tabs)/menu.tsx` — Legend text colours → `textSecondary` / `textPrimary`.
- `app/(tabs)/browse/[categoryId].tsx` — helpBackdrop → `overlayBackdrop` token.
- `components/DonutChart.tsx` — center text + emptyColor + cardBackground
  defaults pulled from `useTheme()`.
- `components/BarChart.tsx` — grid stroke + nav arrows + month labels +
  per-bar value labels pulled from `useTheme()`.
- `app/receipt-process.tsx` — dev crop-error text → `error` token.

## Commit + push

From `/home/mantas/Documents/Projects/basket-app`:

```sh
git add \
  DARK_THEME_CHANGELOG.md \
  constants/theme.ts \
  state/settingsStore.ts \
  app/settings.tsx \
  app/_layout.tsx \
  app/receipt-process.tsx \
  'app/(tabs)/menu.tsx' \
  'app/(tabs)/browse/[categoryId].tsx' \
  components/DonutChart.tsx \
  components/BarChart.tsx \
  i18n/locales/lt.json \
  i18n/locales/en.json
```

```sh
git commit -m "Dark theme + Appearance setting

- Real dark palette in constants/theme.ts (was stubbed to light).
- settingsStore: persist themeMode (light/dark/system); default system.
- useTheme: resolve user preference first, fall back to OS scheme.
- useResolvedScheme() exported so StatusBar + nav theme follow user choice.
- Settings: new Appearance section with picker (LT + EN).
- Audit pass: convert leaked text/surface/border hex codes in screens to
  semantic tokens; keep intentional brand/shadow/chart colours."
```

Then `eas update --branch dev --message "Dark theme + Appearance setting"`
preceded by `APP_VARIANT=dev`, and `git push` once you're happy.
