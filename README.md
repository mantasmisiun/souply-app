# souply-app

The native [Souply](https://souply.lt) experience — receipt scanning,
basket templates, price comparison across Lithuanian grocery chains,
the swipe-based product cluster system, and creator publishing.

Web client lives in `souply-web`. Backend in `souply-api`.

## Stack

- **Expo SDK 54 / React Native 0.81 / React 19** — new architecture on
- **TypeScript** with strict + typed routes via `expo-router`
- **Zustand** for cross-screen state (basket, auth, template-add)
- **i18next** with Lithuanian (default) + English
- **MLKit text recognition** for on-device receipt OCR
- **expo-share-intent** for receiving PDFs/images from the system share sheet
- **Jest + jest-expo** for unit tests; ad-hoc EAS preview builds for QA
- Cross-stack `shared/` folder pulled in via `npm run sync-shared`
  before each EAS build (canonical source lives at the monorepo root)

## Bundle / identity

| | Production | Dev |
|---|---|---|
| iOS bundle ID | `lt.souply.app` | `lt.souply.app.dev` |
| Android package | `lt.souply.app` | `lt.souply.app.dev` |
| App Group | `group.lt.souply.app` | `group.lt.souply.app.dev` |
| Share extension | `lt.souply.app.ShareExtension` | `lt.souply.app.dev.ShareExtension` |
| Display name | `Souply` | `Souply (DEV)` |
| EAS slug | `souply-app` | `souply-app` |
| EAS owner | `souply-solutions` | `souply-solutions` |
| Deep-link scheme | `souply://` | `souply://` |
| Universal Links | `souply.lt/t/{slug}`, `souply.lt/@{username}` | (same) |

## Commands

```bash
# Variant flag — controls icon, bundle ID, display name, OTA channel.
APP_VARIANT=dev npm run start   # interactive Expo CLI on the dev variant
npm run start                   # production variant
npm run android                 # local Android dev build (eas not required)
npm run ios                     # local iOS dev build
npm run web                     # web preview (limited; full web lives in souply-web)
npm run lint                    # expo lint
npm test                        # jest

# EAS — always target the `dev` channel for OTA pushes
APP_VARIANT=dev eas update --branch dev
eas build --profile preview --platform android
npm run sync-shared             # pull /Project/shared into ./shared before EAS upload
npm run build:apk               # sync-shared + EAS preview Android build
```

## Layout

```
app/
├── _layout.tsx                 ← root Stack + providers (auth, i18n, query)
├── (tabs)/                     ← Krepšelis, Naršyti, Šablonai, Profilis tabs
├── (admin)/                    ← moderation queues (Žymos, Kvitai, etc.)
├── basket/[id].tsx, results/   ← basket detail + comparison results
├── browse/[categoryId].tsx     ← L2 product list (stack-pushed, supports template-add mode)
├── product/[id].tsx            ← product detail (price history + add to basket / template)
├── template/[id].tsx           ← template editor
├── template-add/[id].tsx       ← browse-on-top-of-template flow
├── t/[slug].tsx                ← shared template preview from Universal Link
├── search.tsx, discounts.tsx, settings.tsx
└── profile/                    ← edit, audit log, restore-account
components/                     ← shared UI (BasketProductCard, GlassIconButton, etc.)
utils/                          ← parsers, formatters, fuzzy search, OAuth helpers
state/                          ← Zustand stores (basket, auth, templateAdd)
i18n/                           ← LT + EN locales (LT is the source of truth)
shared/                         ← synced from monorepo root before EAS uploads
constants/                      ← theme palette mirrored in souply-web
```

## Receipt-batch test pipeline

```bash
npm run receipts:stage          # stages receipt PDFs as PNGs to ./assets/_batch_test
# then on the phone: Kvitų paketinis testas screen → "Run batch"
# raw OCR output lands under ../souply-api/receipts/_logs/<chain>/<file>/raw.txt
```
