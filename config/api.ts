import Constants from 'expo-constants';

/**
 * API endpoint the mobile app talks to.
 *
 * `__DEV__` is React Native's bundle-time flag — true for `expo run`
 * / Metro debug builds, false for release APKs (gradlew assembleRelease).
 *
 *   dev build    → derives the laptop's host from Metro itself (the
 *                  same address the JS bundle was downloaded from) and
 *                  hits Express on port 3000. No hardcoded IP, no ADB
 *                  reverse choreography — wherever Metro is reachable,
 *                  the API is too.
 *   release build → production Cloudflare-proxied API on OMV.
 */

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
const PROD_URL = 'https://api.manofoto.dpdns.org';

export const API_BASE_URL = __DEV__ ? DEV_LAN_URL : PROD_URL;
console.log('[API] BASE_URL=', API_BASE_URL, '__DEV__=', __DEV__);
