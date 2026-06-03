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
