/**
 * API endpoint the mobile app talks to.
 *
 * `__DEV__` is React Native's bundle-time flag — true for `expo run`
 * / Metro debug builds, false for release APKs (gradlew assembleRelease).
 *
 *   dev build    → laptop Express on the home LAN. Requires phone to
 *                  be on the same Wi-Fi. Convenient for iterating on
 *                  the parser / API without a deploy round-trip.
 *   release build → production Cloudflare-proxied API on OMV.
 *
 * Update the LAN IP below if your laptop's address changes — run
 * `ip route get 1.1.1.1 | awk '{print $7; exit}'` on the laptop to
 * check it.
 */
const DEV_LAN_URL = 'http://192.168.1.167:3000';
const PROD_URL = 'https://api.manofoto.dpdns.org';

export const API_BASE_URL = __DEV__ ? DEV_LAN_URL : PROD_URL;
console.log('[API] BASE_URL=', API_BASE_URL, '__DEV__=', __DEV__);
