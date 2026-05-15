import Constants from 'expo-constants';

/**
 * API endpoint the mobile app talks to.
 *
 * Three resolution paths in order:
 *   1. Metro debug build (`__DEV__=true`) → derive host from Metro's
 *      hostUri (Constants.expoConfig.hostUri). Whatever LAN IP Metro
 *      serves the JS bundle from, Express on :3000 lives at too.
 *   2. EAS internal-distribution DEV variant (Souply DEV, `__DEV__=false`
 *      because the bundle is minified release-style without Metro) →
 *      fall back to a hardcoded laptop LAN IP. Lets the dev build POST
 *      receipt-batch logs to the laptop instead of the production API.
 *      Change `DEV_VARIANT_LAN_HOST` when you move to a new network.
 *   3. Production build → Cloudflare-proxied API on OMV.
 */

// Hardcoded laptop LAN IP for the EAS `ios-dev` build (no Metro = no
// auto-discovery). Update when you switch networks. Format: bare host,
// no scheme, no port — the URL composer adds those.
const DEV_VARIANT_LAN_HOST = '192.168.1.127';
const IS_DEV_VARIANT = Constants.expoConfig?.name === 'Souply (DEV)';

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
    return host || 'localhost';
};

const DEV_LAN_URL = `http://${getDevHost()}:3000`;
const DEV_VARIANT_LAN_URL = `http://${DEV_VARIANT_LAN_HOST}:3000`;
const PROD_URL = 'https://api.manofoto.dpdns.org';

// Order matters:
//   __DEV__ wins (Metro is the source of truth for the LAN host).
//   DEV variant (Souply DEV without Metro) → hardcoded LAN.
//   Everything else → prod.
export const API_BASE_URL = __DEV__
    ? DEV_LAN_URL
    : IS_DEV_VARIANT
        ? DEV_VARIANT_LAN_URL
        : PROD_URL;
console.log('[API] BASE_URL=', API_BASE_URL, '__DEV__=', __DEV__, 'IS_DEV_VARIANT=', IS_DEV_VARIANT);
