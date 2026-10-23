import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { MaterialProgress } from '@/components/MaterialProgress';
import { CoverIdentityControls, DEFAULT_COVER_DRAFT_COLOR, type CoverDraft } from '../TemplateCoverEditor';
import { EMOJI_CATALOG } from '../../utils/emojiCatalog';
import { importRecipe, type RecipeImportErrorCode, type RecipeImportPreview } from '../../utils/recipeImportApi';
import {
    looksLikeRecipeUrl, mergePreviewIntoFields, UNTOUCHED,
    type CoverFields, type CoverTouched,
} from '../../utils/recipeCreateDraft';
import { useRecipeImportState } from '../../state/recipeImportState';
import { createTemplate, type TemplateCoverImage } from '../../utils/basketTemplatesApi';
import { coverEmoji } from '../../utils/templateCover';
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
 * The pane's submit action, reported UP to the host: the ‹ title row (and so
 * the Sukurti/Išsaugoti pill riding it) belongs to the pane HOST per the
 * SheetPaneSpec contract, while the state the pill needs — the name gate, an
 * import or create in flight — lives in the pane. The pane pushes this object
 * through `onSubmitControls` whenever any of it changes; the host feeds it
 * straight into an ActionPill.
 */
export type PaneSubmitControls = {
    submit: () => void;
    /** Name empty, or a URL import in flight — the old button's disable rule. */
    disabled: boolean;
    /** A create/save POST in flight — the pill shows the spinner. */
    busy: boolean;
};

/**
 * "Naujas receptas" — the Receptai dock's in-sheet create pane (SheetPaneSpec
 * content; the bar row with the back chevron lives with the host).
 *
 * ONE surface for both ways in: a URL row on top (paste/type a link → the
 * import runs by itself and prefills the identity below) and the cover
 * controls underneath; the Sukurti action itself rides the HOST's bar row as
 * a pill (see PaneSubmitControls). No URL, or a failed import, degrades to
 * the plain blank-recipe path — the cover half always works.
 *
 * Sukurti with an imported preview stages it and hands over to the
 * /recipe-import review screen (nothing is written until the product list is
 * approved — a misread page writes nothing); without one it creates the empty
 * template directly. Both collapse the sheet first, so the pane is never left
 * open behind the navigation (collapse also fires the pane's onDismiss).
 *
 * EDIT MODE (`edit` prop): the SAME surface, prefilled with an existing
 * recipe's identity. The URL row turns into a read-only display of where the
 * recipe was imported from (hidden entirely for a hand-made recipe — an empty
 * permanently-disabled field would read as a broken affordance, not a fact);
 * no import can ever run, and Išsaugoti hands the draft to `edit.onSubmit`
 * instead of any create/import path. The create path is untouched: every
 * edit branch is gated on the prop.
 */
export function RecipeCreatePane({ collapse, onSubmitControls, onCreateBlank, edit }: {
    collapse: () => void;
    /**
     * Receives the submit pill's controls (action + disabled + busy) every
     * time they change — the host renders the Sukurti/Išsaugoti pill in its
     * own bar row from the latest value. Required: a pane whose host drops
     * this has no way to submit at all.
     */
    onSubmitControls: (controls: PaneSubmitControls) => void;
    /**
     * CATALOG entry point: overrides the BLANK/manual create landing — the
     * host creates AND session-targets the template itself (no navigation),
     * so the catalog stays put and shows the session bar with the new recipe
     * active. Imports are deliberately NOT overridable: a URL import always
     * goes through the /recipe-import review screen (nothing is written from
     * a misread page), whichever surface hosts the pane.
     */
    onCreateBlank?: (draft: CoverDraft) => Promise<void>;
    /**
     * EDIT an existing recipe instead of creating one. The pane prefills
     * name/colour/emoji from the recipe, shows `sourceUrl` read-only (or no
     * URL row at all when the recipe wasn't imported), and submits the drafted
     * identity to `onSubmit` — never to the import/create paths. `onSubmit` is
     * fire-and-forget: the HOST owns the optimistic apply + failure revert,
     * so the pane collapses immediately (no in-pane spinner).
     */
    edit?: {
        name: string;
        coverColor: string | null;
        coverImage: TemplateCoverImage | null;
        sourceUrl: string | null;
        onSubmit: (draft: CoverDraft) => void;
    };
}) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();

    // Stable for the pane's lifetime — the host mounts a fresh pane per open
    // (SheetPaneSpec content), so a mount-time read can never go stale.
    const isEdit = edit != null;

    const [url, setUrl] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [preview, setPreview] = useState<RecipeImportPreview | null>(null);
    const [creating, setCreating] = useState(false);
    const [fields, setFields] = useState<CoverFields>(() => edit
        // Prefill from the recipe being edited — the same stored-identity →
        // draft mapping TemplateCoverEditor's open effect uses.
        ? {
            name: edit.name,
            color: edit.coverColor ?? DEFAULT_COVER_DRAFT_COLOR,
            emoji: coverEmoji(edit.coverImage) ?? EMOJI_CATALOG[0],
        }
        : { name: '', color: DEFAULT_COVER_DRAFT_COLOR, emoji: EMOJI_CATALOG[0] });

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
    // like a URL — never a request per keystroke. NEVER in edit mode: the URL
    // is a read-only fact there, and an import must not be able to fire even
    // though the (frozen) field holds a perfectly importable address.
    useEffect(() => {
        if (isEdit) return;
        const trimmed = url.trim();
        if (!looksLikeRecipeUrl(trimmed)) return;
        if (trimmed === importedForRef.current || trimmed === pendingRef.current) return;
        const timer = setTimeout(() => runImport(trimmed), TYPE_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [url, runImport, isEdit]);

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
        if (edit) {
            // Edit mode routes FIRST — before the preview branch — so an edit
            // can never stage an import, even if a preview somehow existed.
            // Fire-and-forget: the host applies optimistically and owns the
            // failure revert; the pane just gets out of the way (collapse
            // also fires the pane's onDismiss).
            edit.onSubmit(draft);
            collapse();
            return;
        }
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
    }, [fields, preview, creating, loading, collapse, onCreateBlank, edit, router, t]);

    // Report the submit pill's state to the host on every change: disabled
    // until a name exists or while an import is in flight (the old full-width
    // button's exact rule), busy while the create POST runs (the pill holds
    // the spinner in the label's footprint, so the bar row never resizes).
    const submitDisabled = fields.name.trim().length === 0 || loading;
    useEffect(() => {
        onSubmitControls({ submit, disabled: submitDisabled, busy: creating });
    }, [onSubmitControls, submit, submitDisabled, creating]);

    // Edit mode: the URL is a FACT, not an input — an imported recipe shows
    // its frozen source address; a hand-made one has no row at all (nothing to
    // display, nothing to do — an empty disabled field would only pose a
    // question it can't answer). The separator goes with the row: without a
    // URL half there is nothing to separate the cover controls from.
    const showUrlRow = !isEdit || !!edit?.sourceUrl;

    return (
        <View style={styles.body}>
            {/* URL field — the paste affordance lives INSIDE the field
                (standard trailing-icon pattern): one bordered box wraps the
                input and the icon. The import runs by itself; the spinner
                takes the icon's in-field slot so the field never resizes
                while it works. In edit mode the same box renders read-only
                and greyed, with a lock in the icon's slot — the address a
                recipe was imported from can never be changed. */}
            {showUrlRow && (
                <View style={[styles.urlField, isEdit && styles.urlFieldDisabled]}>
                    <TextInput
                        style={[styles.input, isEdit && styles.inputDisabled]}
                        value={isEdit ? (edit?.sourceUrl ?? '') : url}
                        onChangeText={onChangeUrl}
                        placeholder={t('basketTab.templates.urlPlaceholder')}
                        placeholderTextColor={colors.textMuted}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                        returnKeyType="done"
                        underlineColorAndroid="transparent"
                        editable={!isEdit}
                    />
                    {isEdit ? (
                        <View style={styles.pasteBtn}>
                            <Ionicons name="lock-closed-outline" size={iconSize.sm} color={colors.textMuted} />
                        </View>
                    ) : (
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
                    )}
                </View>
            )}

            {error != null && <Text style={styles.error}>{error}</Text>}

            {showUrlRow && <View style={styles.separator} />}

            <CoverIdentityControls
                name={fields.name}
                color={fields.color}
                emoji={fields.emoji}
                onChangeName={touch('name')}
                onChangeColor={touch('color')}
                onChangeEmoji={touch('emoji')}
            />
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    // Horizontal inset comes from the sheet's SheetContent wrapper.
    body: { paddingTop: spacing.sm, paddingBottom: spacing.lg, gap: spacing.md },
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
    // Edit mode's frozen URL: muted surface + faded box, muted ink — reads as
    // a disabled field at a glance, not an input awaiting a tap.
    urlFieldDisabled: { backgroundColor: c.surfaceMuted ?? c.cardBackground, opacity: 0.6 },
    inputDisabled: { color: c.textMuted },
    error: { ...typography.labelSmall, color: c.error },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: c.border },
});
