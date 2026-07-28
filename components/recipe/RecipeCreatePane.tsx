import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { MaterialProgress } from '@/components/MaterialProgress';
import { GlassButton } from '../GlassButton';
import { CoverIdentityControls, DEFAULT_COVER_DRAFT_COLOR, type CoverDraft } from '../TemplateCoverEditor';
import { EMOJI_CATALOG } from '../../utils/emojiCatalog';
import { importRecipe, type RecipeImportErrorCode, type RecipeImportPreview } from '../../utils/recipeImportApi';
import {
    looksLikeRecipeUrl, mergePreviewIntoFields, UNTOUCHED,
    type CoverFields, type CoverTouched,
} from '../../utils/recipeCreateDraft';
import { useRecipeImportState } from '../../state/recipeImportState';
import { createTemplate } from '../../utils/basketTemplatesApi';
import { getUserId } from '../../config/user';
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

/** Typed input settles this long before an import fires; a paste skips it. */
const TYPE_DEBOUNCE_MS = 700;

/**
 * "Naujas receptas" — the Receptai dock's in-sheet create pane (SheetPaneSpec
 * content; the bar row with the back chevron lives with the host).
 *
 * ONE surface for both ways in: a URL row on top (paste/type a link → the
 * import runs by itself and prefills the identity below) and the cover
 * controls + Sukurti underneath. No URL, or a failed import, degrades to the
 * plain blank-recipe path — the cover half always works.
 *
 * Sukurti with an imported preview stages it and hands over to the
 * /recipe-import review screen (nothing is written until the product list is
 * approved — a misread page writes nothing); without one it creates the empty
 * template directly. Both collapse the sheet first, so the pane is never left
 * open behind the navigation (collapse also fires the pane's onDismiss).
 */
export function RecipeCreatePane({ collapse, onCreateBlank }: {
    collapse: () => void;
    /**
     * CATALOG entry point: overrides the BLANK/manual create landing — the
     * host creates AND session-targets the template itself (no navigation),
     * so the catalog stays put and shows the session bar with the new recipe
     * active. Imports are deliberately NOT overridable: a URL import always
     * goes through the /recipe-import review screen (nothing is written from
     * a misread page), whichever surface hosts the pane.
     */
    onCreateBlank?: (draft: CoverDraft) => Promise<void>;
}) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();

    const [url, setUrl] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [preview, setPreview] = useState<RecipeImportPreview | null>(null);
    const [creating, setCreating] = useState(false);
    const [fields, setFields] = useState<CoverFields>({
        name: '', color: DEFAULT_COVER_DRAFT_COLOR, emoji: EMOJI_CATALOG[0],
    });

    // Which fields the shopper edited THEMSELVES — a later auto-prefill must not
    // overwrite those. A ref, not state: only the import completion reads it.
    const touchedRef = useRef<CoverTouched>({ ...UNTOUCHED });
    const touch = useCallback(<K extends keyof CoverFields>(key: K) => (v: CoverFields[K]) => {
        touchedRef.current[key] = true;
        setFields(f => ({ ...f, [key]: v }));
    }, []);

    /** URL the current `preview` was imported for — a preview only stands for
     *  the exact address in the field. */
    const importedForRef = useRef<string | null>(null);
    /** URL an import is currently in flight for (dedupes the paste-now +
     *  debounce-later pair) and the guard against a stale result landing. */
    const pendingRef = useRef<string | null>(null);
    const seqRef = useRef(0);

    const runImport = useCallback(async (trimmed: string) => {
        const seq = ++seqRef.current;
        pendingRef.current = trimmed;
        setLoading(true);
        setError(null);
        const result = await importRecipe(trimmed);
        if (seq !== seqRef.current) return; // superseded by a newer import
        pendingRef.current = null;
        setLoading(false);
        if (!result.ok) {
            importedForRef.current = null;
            setPreview(null);
            setError(t(ERROR_KEY[result.code]));
            return; // cover half stays usable — name a blank recipe and Sukurti
        }
        importedForRef.current = trimmed;
        setPreview(result.preview);
        setFields(f => mergePreviewIntoFields(f, touchedRef.current, result.preview, DEFAULT_COVER_DRAFT_COLOR));
    }, [t]);

    const onChangeUrl = useCallback((v: string) => {
        setUrl(v);
        setError(null);
        // Editing away from the imported address invalidates its preview —
        // Sukurti must never stage a recipe for a URL no longer in the field.
        if (v.trim() !== importedForRef.current) {
            importedForRef.current = null;
            setPreview(null);
        }
    }, []);

    // AUTO-RECOGNITION on typed input: debounced, and only once the text looks
    // like a URL — never a request per keystroke.
    useEffect(() => {
        const trimmed = url.trim();
        if (!looksLikeRecipeUrl(trimmed)) return;
        if (trimmed === importedForRef.current || trimmed === pendingRef.current) return;
        const timer = setTimeout(() => runImport(trimmed), TYPE_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [url, runImport]);

    // Paste fires immediately (no debounce) — the address arrived whole.
    const paste = useCallback(async () => {
        const text = (await Clipboard.getStringAsync()).trim();
        if (!text) return;
        onChangeUrl(text);
        if (looksLikeRecipeUrl(text) && text !== importedForRef.current) runImport(text);
    }, [onChangeUrl, runImport]);

    const submit = useCallback(async () => {
        const name = fields.name.trim();
        if (!name || creating || loading) return;
        const draft: CoverDraft = {
            name, coverColor: fields.color, coverImage: { kind: 'emoji', emoji: fields.emoji },
        };
        if (preview) {
            // The existing import path, verbatim: stage the preview + draft and
            // hand over to the review screen, which creates the template WITH
            // its items once the product list is approved.
            useRecipeImportState.getState().stage(preview, draft);
            collapse();
            router.push('/recipe-import' as any);
            return;
        }
        setCreating(true);
        try {
            if (onCreateBlank) {
                // Host-owned landing (the catalog dock): create + target the
                // session there; this pane only collapses out of the way.
                await onCreateBlank(draft);
                collapse();
            } else {
                const userId = await getUserId();
                const created = await createTemplate({
                    userId, name, coverColor: draft.coverColor, coverImage: draft.coverImage,
                });
                collapse();
                router.push(`/template/${created.id}` as any);
            }
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorSave'));
        } finally {
            setCreating(false);
        }
    }, [fields, preview, creating, loading, collapse, onCreateBlank, router, t]);

    return (
        <View style={styles.body}>
            {/* URL field — the paste affordance lives INSIDE the field
                (standard trailing-icon pattern): one bordered box wraps the
                input and the icon. The import runs by itself; the spinner
                takes the icon's in-field slot so the field never resizes
                while it works. */}
            <View style={styles.urlField}>
                <TextInput
                    style={styles.input}
                    value={url}
                    onChangeText={onChangeUrl}
                    placeholder={t('basketTab.templates.urlPlaceholder')}
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    returnKeyType="done"
                    underlineColorAndroid="transparent"
                />
                <TouchableOpacity
                    style={styles.pasteBtn}
                    onPress={paste}
                    disabled={loading}
                    hitSlop={6}
                    activeOpacity={0.7}
                    accessibilityLabel={t('basketTab.templates.urlPasteA11y')}
                >
                    {loading
                        ? <MaterialProgress size="small" color={colors.primary} />
                        : <Ionicons name="clipboard-outline" size={iconSize.sm} color={colors.primary} />}
                </TouchableOpacity>
            </View>

            {error != null && <Text style={styles.error}>{error}</Text>}

            <View style={styles.separator} />

            <CoverIdentityControls
                name={fields.name}
                color={fields.color}
                emoji={fields.emoji}
                onChangeName={touch('name')}
                onChangeColor={touch('color')}
                onChangeEmoji={touch('emoji')}
            />

            {creating ? (
                // Spinner in the button's footprint so the pane doesn't resize
                // the moment the create starts (the URL sheet's old pattern).
                <View style={styles.loadingBtn}>
                    <MaterialProgress size="small" color={colors.onPrimary} />
                </View>
            ) : (
                <GlassButton
                    title={t('basketTab.templates.createConfirm')}
                    onPress={submit}
                    disabled={fields.name.trim().length === 0 || loading}
                />
            )}
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    body: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.lg, gap: spacing.md },
    // ONE bordered box for input + trailing paste icon — the border wraps
    // both, so the icon reads as part of the field, not a separate control.
    urlField: {
        flexDirection: 'row', alignItems: 'center',
        borderWidth: 1, borderColor: c.border, borderRadius: radius.md,
        backgroundColor: c.cardBackground,
    },
    input: {
        flex: 1,
        paddingLeft: spacing.md, paddingVertical: 11,
        fontSize: 15, color: c.textPrimary,
    },
    pasteBtn: {
        alignSelf: 'stretch', paddingHorizontal: spacing.md,
        alignItems: 'center', justifyContent: 'center',
    },
    error: { ...typography.labelSmall, color: c.error },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: c.border },
    loadingBtn: {
        borderRadius: 12, paddingVertical: 12,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: c.primaryStrong,
    },
});
