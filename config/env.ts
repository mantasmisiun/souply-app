import Constants from 'expo-constants';

/**
 * Single source of truth for which environment this build runs in.
 * Drives the EnvBanner (and any future env-specific behaviour).
 *
 *   dev      — Metro / `expo run` (local) OR the EAS `android-dev`/`ios-dev`
 *              variant (APP_VARIANT=dev)
 *   staging  — EAS `staging` variant (APP_VARIANT=staging) → api.souply.manofoto
 *   prod     — everything else (release builds, no APP_VARIANT) → api.souply.lt
 */
export type AppEnv = 'dev' | 'staging' | 'prod';

export const APP_ENV: AppEnv = (() => {
    // Metro / `expo run` always means local development, whatever the variant.
    if (__DEV__) return 'dev';
    // Otherwise trust the value app.config.js baked in from APP_VARIANT.
    const e = Constants.expoConfig?.extra?.appEnv;
    return e === 'staging' ? 'staging' : e === 'dev' ? 'dev' : 'prod';
})();

export const IS_PROD = APP_ENV === 'prod';

/**
 * Visual marker for non-production builds, consumed by <EnvBadge />.
 * Null in prod (no marker shown). DEV → blue · STAGING → amber
 * (red stays reserved for danger). Single source of truth for both the
 * label and the colour so the badge is identical on iOS and Android.
 */
export const ENV_BADGE: { label: string; color: string } | null =
    APP_ENV === 'dev' ? { label: 'DEV', color: '#2563EB' }
    : APP_ENV === 'staging' ? { label: 'STAGING', color: '#D97706' }
    : null;
