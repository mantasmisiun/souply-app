import { useCallback, useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialProgress } from '@/components/MaterialProgress';
import { useSafeBottomTabBarHeight } from '../../hooks/useSafeBottomTabBarHeight';
import { GlassSheet } from '../GlassSheet';
import { SheetCloseButton } from '../SheetCloseButton';
import { GlassButton } from '../GlassButton';
import { importRecipe, type RecipeImportErrorCode, type RecipeImportPreview } from '../../utils/recipeImportApi';
import { useTheme, spacing, radius, typography, iconSize, type AppTheme } from '../../constants/theme';

/** Server failure → the sentence the shopper reads. */
const ERROR_KEY: Record<RecipeImportErrorCode, string> = {
    bad_url: 'basketTab.templates.urlErrorBadUrl',
    blocked_host: 'basketTab.templates.urlErrorBlockedHost',
    no_recipe: 'basketTab.templates.urlErrorNoRecipe',
    rate_limited: 'basketTab.templates.urlErrorRateLimited',
    fetch_failed: 'basketTab.templates.urlErrorFetch',
    unknown: 'basketTab.templates.urlErrorGeneric',
};

/**
 * "Iš nuorodos" — paste a recipe page's address and get a preview back.
 *
 * Mount only while open (the GlassSheet contract): it animates itself in and
 * calls `onClose` after animating out. On success the host raises the cover
 * sheet with the imported title/emoji; this sheet never writes anything.
 */
export function RecipeUrlSheet({ onClose, onImported }: {
    onClose: () => void;
    /** Fired with the preview once the server (or the device fallback) read the page. */
    onImported: (preview: RecipeImportPreview) => void;
}) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const insets = useSafeAreaInsets();
    // The sheet is bottom-anchored inside an edge-to-edge window, so nothing
    // moves it out from under the keyboard. Padding the CONTENT grows the
    // autoHeight sheet by the same amount, which lifts the field into view.
    // The sheet already reserves the home-indicator inset — don't pay it twice.
    const keyboardHeight = useKeyboardState(s => s.height);
    // The tab bar is an absolute overlay ABOVE the tab's content, so it paints
    // over this sheet — clear it, or the submit button hides behind the pill.
    // With the keyboard up the pill is buried under it, so the taller wins.
    const tabBarHeight = useSafeBottomTabBarHeight();
    const bottomClear = Math.max(0, Math.max(keyboardHeight, tabBarHeight) - insets.bottom);

    const [url, setUrl] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const paste = useCallback(async () => {
        const text = (await Clipboard.getStringAsync()).trim();
        if (!text) return;
        setUrl(text);
        setError(null);
    }, []);

    const submit = useCallback(async () => {
        const trimmed = url.trim();
        if (!trimmed || loading) return;
        setLoading(true);
        setError(null);
        const result = await importRecipe(trimmed);
        if (!result.ok) {
            setLoading(false);
            setError(t(ERROR_KEY[result.code]));
            return;
        }
        setLoading(false);
        onImported(result.preview);
    }, [url, loading, t, onImported]);

    return (
        <GlassSheet autoHeight onClose={onClose}>
            <View style={[styles.body, { paddingBottom: bottomClear }]}>
                <View style={styles.titleRow}>
                    <Text style={styles.title}>{t('basketTab.templates.urlSheetTitle')}</Text>
                    <SheetCloseButton />
                </View>
                <Text style={styles.explainer}>{t('basketTab.templates.urlSheetBody')}</Text>

                <TextInput
                    style={styles.input}
                    value={url}
                    onChangeText={(v) => { setUrl(v); setError(null); }}
                    placeholder={t('basketTab.templates.urlPlaceholder')}
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    returnKeyType="go"
                    onSubmitEditing={submit}
                    editable={!loading}
                    underlineColorAndroid="transparent"
                />

                <TouchableOpacity style={styles.pasteRow} onPress={paste} disabled={loading} hitSlop={6} activeOpacity={0.7}>
                    <Ionicons name="clipboard-outline" size={iconSize.sm} color={colors.primary} />
                    <Text style={styles.pasteText}>{t('basketTab.templates.urlPaste')}</Text>
                </TouchableOpacity>

                {error != null && <Text style={styles.error}>{error}</Text>}

                {loading ? (
                    // Spinner in the button's place — same footprint, so the sheet
                    // doesn't resize the moment the import starts.
                    <View style={styles.loadingBtn}>
                        <MaterialProgress size="small" color={colors.onPrimary} />
                    </View>
                ) : (
                    <GlassButton
                        title={t('basketTab.templates.urlSubmit')}
                        onPress={submit}
                        disabled={url.trim().length === 0}
                    />
                )}
            </View>
        </GlassSheet>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    body: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs, gap: spacing.md },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    title: { flex: 1, ...typography.subheading, color: c.textPrimary },
    explainer: { ...typography.bodySmall, color: c.textSecondary },
    input: {
        borderWidth: 1, borderColor: c.border, borderRadius: radius.md,
        paddingHorizontal: spacing.md, paddingVertical: 11,
        fontSize: 15, color: c.textPrimary, backgroundColor: c.cardBackground,
    },
    pasteRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, alignSelf: 'flex-start' },
    pasteText: { ...typography.label, color: c.primary },
    error: { ...typography.labelSmall, color: c.error },
    loadingBtn: {
        borderRadius: 12, paddingVertical: 12,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: c.primaryStrong,
    },
});
