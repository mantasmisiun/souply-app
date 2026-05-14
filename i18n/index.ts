import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import lt from './locales/lt.json';
import en from './locales/en.json';

/**
 * i18next initialisation.
 *
 * Source of truth for the *current* language is `settingsStore` (which
 * persists to AsyncStorage and mirrors changes into i18next via
 * `i18n.changeLanguage`). This module just registers the resources and
 * the React binding; language detection lives in the store so its
 * hydration is observable from the rest of the app.
 *
 * `fallbackLng` is Lithuanian — Souply's primary market — so missing keys
 * surface in LT rather than as the raw key string.
 *
 * `returnObjects` is enabled because some screens (e.g. the delete-account
 * stage-1 modal) translate bullet lists as arrays.
 */

i18n
    .use(initReactI18next)
    .init({
        resources: {
            lt: { translation: lt },
            en: { translation: en },
        },
        lng: 'lt',
        fallbackLng: 'lt',
        defaultNS: 'translation',
        interpolation: { escapeValue: false },
        returnObjects: true,
        // React Native has no DOM `Suspense` boundary at the root by default;
        // disabling suspense keeps the initial render synchronous even when
        // the store hasn't yet pushed the persisted language into i18next.
        react: { useSuspense: false },
    });

export default i18n;
