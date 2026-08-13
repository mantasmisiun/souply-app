# souply-app

Mobile client for [Souply](https://souply.lt) — a grocery price-comparison platform for the
Lithuanian market. You build a basket, the app tells you what it costs at each shop near
you, and after you've shopped it reads your receipt to show what you actually paid against
what you would have paid elsewhere.

Souply is split across four repositories:

| Repo | Role |
|---|---|
| **`souply-app`** | **This repo — React Native / Expo client** |
| `souply-api` | Node/Express/MariaDB backend |
| `souply-web` | Web client — landing, creator auth, dashboard |
| `souply-shared` | Receipt parsers and recognition config, shared with the API |

## What it does

Four tabs: **Katalogas** (catalog), **Apsipirkimai** (shopping trips), **Receptai**
(recipes) and **Mano** (profile).

**A shopping trip is one continuous object**, not a set of disconnected screens. You
collect items — from the catalogue, from a recipe, or by typing them — and the same trip
carries you through comparison, shopping, receipt capture and the final numbers. Its stage
is derived rather than stored, and every entry point redirects to whichever single screen
that stage calls for:

| Stage | Screen | What you do |
|---|---|---|
| forming | `/basket/[id]` | edit items, then *Find stores* |
| compared | `/basket/results/[id]` | the comparison map — totals per shop, and whether splitting across two or three is worth the extra distance |
| shopping | `/shopping-list/[id]` | a per-store list, opening at the closest unfinished shop |
| need receipt | `/trip/receipts/[id]` | photograph what you actually bought |
| done | `/trip/stats/[id]` | what you paid vs. what it would have cost elsewhere |

The design rule is in the source: *a trip is a journey, not a workspace — one stage, one
screen, one primary action.* An earlier version gave a trip its own six-tab workspace; it
was removed.

**Recipes are imported from a URL.** Paste a link and the server reads the page's
schema.org `Recipe` markup rather than scraping per-site, so ingredients arrive structured
and land in a basket as real products. There is no parser per recipe site.

**Trips and recipes are both shareable.** A recipe gets a public URL
(`souply.lt/t/{slug}`) that opens in a browser without the app installed; a trip gets an
invite link, so a household can shop the same list together and see each other's progress.

**Receipts also work standalone**, without a trip — scan one and it becomes structured line
items, matched against the catalogue, feeding your price history either way.

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
app/                  expo-router routes — 66 screens
  (tabs)/             catalog · basket (trips) · templates (recipes) · menu
  basket/             basket editing, and results/[id] — the comparison map
  shopping-list/      per-store lists, plus split/[basketId]
  trip/               [id] stage redirector · receipts/[id] · stats/[id]
  receipt/            capture, processing, review, swipe matching
  template/           recipe editing            t/[slug]  public shared view
  family/             shared household expenses
  preset/ · profile/ · swipe/
components/           shared UI — sheets, dock, map surfaces, share panels
modules/              three native modules (see above)
shared/               synced copy of souply-shared (gitignored)
state/ · contexts/ · hooks/ · services/ · utils/
__tests__/            165 test files
```

Route names predate some renames: the `templates` tab is **Receptai** (recipes), and the
`basket` tab is **Apsipirkimai** (shopping trips).

## Status and licence

Actively developed; Android is in closed testing. Published so the work can be read; not
currently accepting contributions, and no open-source licence is granted — all rights
reserved.

The `google-services.json` and Maps API keys in this repository are Android client keys.
They ship inside every APK by design and are secured by package-name and signing-certificate
restrictions rather than by secrecy, per Google's guidance.
