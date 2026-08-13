# souply-app

Mobile client for [Souply](https://souply.lt) — a grocery price-comparison platform for the
Lithuanian market. You photograph a receipt, it becomes structured line items on-device,
and the app tells you what the same basket would cost at each shop near you.

Souply is split across four repositories:

| Repo | Role |
|---|---|
| **`souply-app`** | **This repo — React Native / Expo client** |
| `souply-api` | Node/Express/MariaDB backend |
| `souply-web` | Web client — landing, creator auth, dashboard |
| `souply-shared` | Receipt parsers and recognition config, shared with the API |

## Stack

- **Expo SDK 57 · React Native 0.86 · React 19** — new architecture enabled
- **TypeScript**, strict, with typed routes via **expo-router** (66 screens)
- **Zustand** for cross-screen state; **TanStack Query** for server state
- **React Native Skia** for map overlays and canvas rendering
- **Reanimated 4** and **Gesture Handler** for the sheet and dock interactions
- **react-native-maps** for store maps
- **i18next** — Lithuanian default, English fallback
- **Sentry**, **expo-secure-store**, **expo-share-intent**
- **Jest + jest-expo**, 165 test files

## Things worth a look

**OCR runs on the device, not the server.** Receipt photographs never need to leave the
phone to be read. iOS uses a custom native module wrapping **Apple Vision**; Android uses
**ML Kit**. The two engines disagree about where lines break on the same receipt, which is
most of what makes receipt parsing hard — the parsers in `souply-shared` are written
against that disagreement rather than against one engine's output.

**Three native modules**, in `modules/`:

| | |
|---|---|
| `souply-vision-ocr` | Apple Vision text recognition with per-word geometry |
| `souply-receipt-pdf` | on-device PDF rendering for receipts shared into the app |
| `souply-progress` | native progress reporting for long OCR passes |

**Parsing is shared with the backend, deliberately.** The same parser code has to produce
identical output on a phone and on a server, so it lives in `souply-shared` and is copied
in by `npm run sync-shared` rather than duplicated. Divergence between the two copies was
a real source of bugs, which is why there's a parity checklist in that repo.

**One patch is carried against `react-native-maps`.** `patches/react-native-maps+1.27.2.patch`
adds crash guards found the hard way — under Fabric, `mapPadding` is applied after layout
but before `onMapReady`, so an unguarded native call could dereference a map that doesn't
exist yet.

**Variants are a build-time flag.** `APP_VARIANT` controls the bundle ID, icon, display
name and OTA channel, so development, staging and production installs coexist on one
device without touching each other's data.

## Identity per variant

| | Production | Staging | Dev |
|---|---|---|---|
| Bundle ID / package | `lt.souply.app` | `lt.souply.app.staging` | `lt.souply.app.dev` |
| Display name | Souply | Souply (STAGING) | Souply (DEV) |
| Deep link | `souply://` | same | same |
| Universal links | `souply.lt/t/{slug}`, `souply.lt/@{username}` | — | — |

## Running locally

Requires a **development build** — Expo Go can't load the native modules.

```bash
npm install
npm run sync-shared        # pull souply-shared into ./shared
npm run dev                # Metro on the dev variant
```

```bash
npm run run:dev:android    # local Android dev build
npm run run:dev:ios        # local iOS dev build
npm run dev:usb            # Metro over adb reverse, for networks that block client-to-client
npm test                   # jest
npm run lint
```

`npm run dev:usb` exists because some routers block client-to-client traffic, which stops a
phone reaching Metro over Wi-Fi entirely. It maps port 8081 over the USB cable instead.

## Layout

```
app/            expo-router routes — 66 screens
  (tabs)/       main tab navigation
  receipt/      capture, processing, review, swipe matching
  basket/       basket building and comparison
  trip/         shopping trips and store results
  family/       shared household expenses
  shopping-list/ · template/ · preset/ · profile/
components/     shared UI — sheets, dock, map surfaces, cards
modules/        three native modules (see above)
shared/         synced copy of souply-shared (gitignored)
state/ · contexts/ · hooks/ · services/ · utils/
__tests__/      165 test files
```

## Status and licence

Actively developed; Android is in closed testing. Published so the work can be read; not
currently accepting contributions, and no open-source licence is granted — all rights
reserved.

The `google-services.json` and Maps API keys in this repository are Android client keys.
They ship inside every APK by design and are secured by package-name and signing-certificate
restrictions rather than by secrecy, per Google's guidance.
