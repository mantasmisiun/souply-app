import Constants from 'expo-constants';
import { APP_ENV } from './env';

/**
 * API endpoint the mobile app talks to, keyed off the single APP_ENV source.
 *
 * Resolution order:
 *   1. Metro (`__DEV__=true`) → derive host from Metro's hostUri, so the LAN
 *      IP that serves the JS bundle is where Express on :3000 lives too.
 *   2. APP_ENV 'dev' (EAS dev variant, no Metro) → hardcoded laptop LAN IP.
 *   3. APP_ENV 'staging' (EAS staging variant) → souply-api.manofoto (souply_test).
 *   4. Production → api.souply.lt (souply_production).
 */

// Where the dev API lives when Metro can't tell us (EAS dev variant, or Metro
// served over USB — see getDevHost below). Bare host: no scheme, no port.
//
// Default is the device's own loopback, which is correct when the API port is
// forwarded over the cable:  adb reverse tcp:3000 tcp:3000
//
// On a network that allows client-to-client traffic, point it at the laptop's
// LAN IP instead so API calls survive unplugging the cable:
//     EXPO_PUBLIC_DEV_API_HOST=192.168.1.127
// in souply-app/.env. Kept out of the source so it doesn't go stale on a move —
// it was hardcoded to a previous flat's IP until 2026-08-18.
const DEV_VARIANT_LAN_HOST = process.env.EXPO_PUBLIC_DEV_API_HOST ?? '127.0.0.1';

/**
 * Pulls Metro's host (e.g. "192.168.1.127:8081") from expo-constants and
 * returns just the host part. Falls back to localhost only if the runtime
 * can't surface the host — which would be a misconfigured dev build, not
 * a healthy run.
 *
 * Sources tried, in order of expo-constants generation:
 *   - expoConfig.hostUri        (Expo SDK 49+ standard field)
 *   - expoGoConfig.debuggerHost (Expo Go, older builds)
 *   - manifest2.extra.expoGo... (newer EAS launcher metadata)
 */
const getDevHost = (): string => {
    const cfg = Constants as any;
    const hostUri =
        cfg?.expoConfig?.hostUri ??
        cfg?.expoGoConfig?.debuggerHost ??
        cfg?.manifest2?.extra?.expoGo?.developer?.tool ??
        cfg?.manifest?.debuggerHost ??
        '';
    const host = String(hostUri).split(':')[0].trim();
    // Metro over USB (adb reverse) reports localhost, which tells us nothing about
    // where the API is — so defer to DEV_VARIANT_LAN_HOST, which the developer sets
    // for their situation:
    //   • cable only (default 127.0.0.1) — needs `adb reverse tcp:3000 tcp:3000`,
    //     and API calls die when you unplug
    //   • laptop LAN IP via EXPO_PUBLIC_DEV_API_HOST — bundle streams over USB while
    //     API calls go over Wi-Fi, so they survive unplugging to photograph a receipt.
    //     Only works on a network that permits client-to-client traffic.
    // (On Wi-Fi Metro this branch isn't hit — the real LAN IP is returned below.)
    if (!host || host === 'localhost' || host === '127.0.0.1') return DEV_VARIANT_LAN_HOST;
    return host;
};

const DEV_LAN_URL = `http://${getDevHost()}:3000`;
const DEV_VARIANT_LAN_URL = `http://${DEV_VARIANT_LAN_HOST}:3000`;
// Staging API (souply-api-staging → souply_staging). LAN-gated by Traefik, so
// only reachable from the home network / WireGuard — fine for the staging app.
const STAGING_URL = 'https://souply-api.manofoto.dpdns.org';
// Permanent production endpoint (souply-api → souply_production).
const PROD_URL = 'https://api.souply.lt';

// __DEV__ (Metro) wins — it's the source of truth for the LAN host. Otherwise
// resolve off APP_ENV (baked in from APP_VARIANT).
export const API_BASE_URL = __DEV__
    ? DEV_LAN_URL
    : APP_ENV === 'dev'
        ? DEV_VARIANT_LAN_URL
        : APP_ENV === 'staging'
            ? STAGING_URL
            : PROD_URL;
console.log('[API] BASE_URL=', API_BASE_URL, 'APP_ENV=', APP_ENV, '__DEV__=', __DEV__);
