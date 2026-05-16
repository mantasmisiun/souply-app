import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import i18n from '../i18n';

/**
 * App-wide user settings — language preference + which UI modals to show.
 *
 * Source of truth for the language choice. Mirrors into `i18next` on every
 * change so the rest of the app uses the standard `useTranslation` hook
 * without needing to know this store exists.
 *
 * Persistence is plain AsyncStorage (one key per setting) to match the
 * pattern already used by levelStore / profileStore. Zustand persist
 * middleware was an option but adds a layer of indirection that fights
 * with hydration ordering — every hydrate call here is explicit.
 */

export type AppLanguage = 'lt' | 'en';
export type ThemeMode = 'light' | 'dark' | 'system';

const KEY_LANGUAGE = 'settings_language';
const KEY_SHOW_LEVELUP = 'settings_show_levelup_modal';
const KEY_SHOW_NEPRISKIRTA_EXPLAINER = 'settings_show_nepriskirta_explainer';
const KEY_THEME_MODE = 'settings_theme_mode';

interface SettingsState {
    /** Null = not yet hydrated. Once hydrated, always 'lt' or 'en'. */
    language: AppLanguage | null;
    /** Show the level-up celebration modal. */
    showLevelUpModal: boolean;
    /** Show the Neatpažinta explainer modal on tap. */
    showNepriskirtaExplainer: boolean;
    /**
     * Theme preference. Default 'system' — follows the OS appearance.
     * Read synchronously by `useTheme` on every render, so initial render
     * uses 'system' until `hydrate()` resolves and applies the user's
     * persisted choice.
     */
    themeMode: ThemeMode;
    /** Whether the store has loaded from AsyncStorage. */
    hydrated: boolean;
    hydrate: () => Promise<void>;
    setLanguage: (lang: AppLanguage) => Promise<void>;
    setShowLevelUpModal: (value: boolean) => Promise<void>;
    setShowNepriskirtaExplainer: (value: boolean) => Promise<void>;
    setThemeMode: (mode: ThemeMode) => Promise<void>;
}

/**
 * Pick the closest supported language for the device. Falls back to LT
 * for anything that isn't English — Souply's primary market is Lithuania.
 */
function detectDeviceLanguage(): AppLanguage {
    try {
        const locales = getLocales();
        for (const l of locales) {
            const code = (l.languageCode ?? '').toLowerCase();
            if (code === 'en') return 'en';
            if (code === 'lt') return 'lt';
        }
    } catch {
        /* getLocales can throw in test environments — fall through */
    }
    return 'lt';
}

export const useSettingsStore = create<SettingsState>((set, _get) => ({
    language: null,
    showLevelUpModal: true,
    showNepriskirtaExplainer: true,
    themeMode: 'system',
    hydrated: false,

    hydrate: async () => {
        const [langRaw, lvlRaw, nepRaw, themeRaw] = await Promise.all([
            AsyncStorage.getItem(KEY_LANGUAGE),
            AsyncStorage.getItem(KEY_SHOW_LEVELUP),
            AsyncStorage.getItem(KEY_SHOW_NEPRISKIRTA_EXPLAINER),
            AsyncStorage.getItem(KEY_THEME_MODE),
        ]);

        let language: AppLanguage;
        if (langRaw === 'lt' || langRaw === 'en') {
            language = langRaw;
        } else {
            // First launch — pick from device locale and persist immediately
            // so subsequent boots don't re-detect (user might have travelled
            // and their device locale temporarily changed).
            language = detectDeviceLanguage();
            await AsyncStorage.setItem(KEY_LANGUAGE, language);
        }

        const showLevelUpModal = lvlRaw === null ? true : lvlRaw === '1';
        const showNepriskirtaExplainer = nepRaw === null ? true : nepRaw === '1';
        const themeMode: ThemeMode = (themeRaw === 'light' || themeRaw === 'dark' || themeRaw === 'system')
            ? themeRaw
            : 'system';

        // Sync into i18next before flipping the hydrated flag so the first
        // render with `hydrated=true` already has the right translations.
        if (i18n.language !== language) {
            await i18n.changeLanguage(language);
        }

        set({ language, showLevelUpModal, showNepriskirtaExplainer, themeMode, hydrated: true });
    },

    setLanguage: async (lang: AppLanguage) => {
        await AsyncStorage.setItem(KEY_LANGUAGE, lang);
        await i18n.changeLanguage(lang);
        set({ language: lang });
    },

    setShowLevelUpModal: async (value: boolean) => {
        await AsyncStorage.setItem(KEY_SHOW_LEVELUP, value ? '1' : '0');
        set({ showLevelUpModal: value });
    },

    setShowNepriskirtaExplainer: async (value: boolean) => {
        await AsyncStorage.setItem(KEY_SHOW_NEPRISKIRTA_EXPLAINER, value ? '1' : '0');
        set({ showNepriskirtaExplainer: value });
    },

    setThemeMode: async (mode: ThemeMode) => {
        await AsyncStorage.setItem(KEY_THEME_MODE, mode);
        set({ themeMode: mode });
    },
}));
