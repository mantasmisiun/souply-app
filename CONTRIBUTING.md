# Contributing — souply-app

React Native / Expo app.

## Branches & flow
- `main` — **production** (App Store / Play). Protected: PRs only, CI must pass, no force-push.
- `staging` — integration; the `staging` app variant + EAS `staging` channel.
- `feature/*` — your work, off `staging`.

Flow: `feature/*` → PR into `staging` → validate on a device → PR `staging` → `main` → production build.

## Local setup
```bash
npm install
npm run sync-shared      # copies the GitHub `souply-shared` parsers from ../shared into ./shared (pure copy, no .git)
npx expo run:android     # local dev build (regular branding, talks to your LAN souply-api)
```
`./shared` is gitignored and always regenerated from the sibling **`../shared`** (GitHub `souply-shared`). Never edit `./shared` directly — edit `../shared`, push, then `npm run sync-shared`.

## Build variants (EAS)
`APP_VARIANT` selects the environment (drives name/package/API/banner):
| Variant | Name | Package | API | Channel |
|---|---|---|---|---|
| `dev` | Souply (DEV) | `…app.dev` | LAN | dev |
| `staging` | Souply (staging) | `…app.staging` | api.souply.manofoto | staging |
| (unset) | Souply | `lt.souply.app` | api.souply.lt | production |
```bash
eas build --platform android --profile android-staging   # or android-dev / production
```

## Tests & lint
```bash
npm test          # jest
npm run lint      # expo lint (0 errors required)
npx tsc --noEmit  # type gate (Metro strips types at build, so this is the check)
```

## Commits
Conventional Commits via commitlint (husky). **Header ≤ 100 chars.** Pre-commit runs `lint-staged`.

## CI (GitHub Actions)
On push/PR to `main`/`staging`: checks out `souply-shared` (needs the `SHARED_REPO_TOKEN` secret) then **typecheck + lint + test**. Must pass before merge to `main`.
