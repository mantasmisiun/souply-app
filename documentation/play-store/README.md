# Play Store listing assets

Graphics for the Google Play store listing (package `lt.souply.app`, category **Shopping**).
Styled to match the website landing carousel (brand pink, "SOUPLY" pill, lucide feature
icon in a phone mockup). Copy is Lithuanian.

## Files

| Asset | File | Spec | Status |
|---|---|---|---|
| App icon | `logo-512.png` | 512×512 PNG | ✅ |
| Feature graphic (primary) | `feature-graphic.png` | 1024×500, no transparency | ✅ (= compare) |
| Feature graphic variants ×8 | `feature-graphics/01–08-*.png` | 1024×500 | ✅ pick/rotate as you like |
| **Screenshots** | — | phone + 7″ + 10″ tablet | ☐ **Mantas provides real app screenshots** |

The 8 variants are the top-8 carousel features (compare, scan, habits, discounts,
history, bestStore, perKg, quickRepeat). Play only shows **one** feature graphic at a
time — `feature-graphic.png` is the default (compare); swap in any of the variants by
copying it over `feature-graphic.png`.

## Screenshots — provided separately
Designed cards can't be used as screenshots (Play wants real in-app screens). Capture
those from the installed build. Specs: PNG/JPEG, 16:9 or 9:16, phone/7″ 320–3840 px/side,
10″ 1080–7680 px/side. Drop raw captures here or in `/tmp` and I can frame them to match.

## Regenerate
`generate-graphics.mjs` — uses `souply-api`'s `sharp` + `souply-web`'s `lucide-react`
icon paths. Edit the `FEATURES` array (titles/bodies/icons) and run
`node generate-graphics.mjs`. Swap LT strings for EN to produce an English set.
