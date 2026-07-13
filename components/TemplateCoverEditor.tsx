import {
    View, Text, TextInput, TouchableOpacity, StyleSheet, Modal, Pressable,
    Animated, PanResponder,
} from 'react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import Reanimated, { runOnJS, FadeInDown, FadeOutUp, LinearTransition } from 'react-native-reanimated';
import ColorPicker, { Panel1, HueSlider } from 'reanimated-color-picker';
import { useTheme, radius, type AppTheme } from '../constants/theme';
import { type TemplateCoverImage } from '../utils/basketTemplatesApi';
import { coverEmoji } from '../utils/templateCover';
import { EMOJI_CATALOG } from '../utils/emojiCatalog';

export interface CoverDraft { name: string; coverColor: string; coverImage: TemplateCoverImage; }

const COLORS = ['#EB6784', '#D44B6C', '#F0AE3F', '#4FAE52', '#5571E1', '#A65EE0'];
const DEFAULT_COLOR = COLORS[0];
const LAST_COLOR_KEY = 'cover_last_custom_color';

function normalizeHex(raw: string): string | null {
    const h = raw.trim().replace(/^#/, '');
    return /^[0-9a-fA-F]{6}$/.test(h) ? `#${h.toUpperCase()}` : null;
}

/**
 * Draggable bottom-sheet editor for a template's identity. Top row: emoji
 * (left, with a pink "+" that opens the emoji grid) + name field (right).
 * Colour: brand swatches + an eyedropper (painted with the current/last
 * custom colour) revealing a wheel; the last custom colour is cached.
 *
 * The emoji grid + colour wheel reveal/collapse with reanimated enter/exit
 * animations (LayoutAnimation is a no-op on the new architecture), and the
 * colour block uses a layout transition so it slides as panels open/close.
 * Sheet itself: Modal `slide` + Animated.Value translateY via a PanResponder
 * on the pill (same mechanic as TemplateShareSheet). A KeyboardAvoidingView
 * lifts the sheet so the keyboard never covers the name field.
 */
export function TemplateCoverEditor({
    visible,
    onClose,
    name,
    coverColor,
    coverImage,
    onSubmit,
    submitLabel,
}: {
    visible: boolean;
    onClose: () => void;
    name: string;
    coverColor: string | null;
    coverImage: TemplateCoverImage | null;
    /** Caller persists the chosen identity (create / patch / create-from-basket). */
    onSubmit: (next: CoverDraft) => void;
    /** Footer button label; defaults to the generic "save". */
    submitLabel?: string;
}) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { t } = useTranslation();
    const { bottom: bottomInset } = useSafeAreaInsets();

    const [draftName, setDraftName] = useState(name);
    const [draftColor, setDraftColor] = useState(coverColor ?? DEFAULT_COLOR);
    const [draftEmoji, setDraftEmoji] = useState<string>(coverEmoji(coverImage) ?? EMOJI_CATALOG[0]);
    const [hexInput, setHexInput] = useState('');
    const [customOpen, setCustomOpen] = useState(false);
    const [emojiOpen, setEmojiOpen] = useState(false);
    const [lastCustom, setLastCustom] = useState<string | null>(null);

    useEffect(() => { AsyncStorage.getItem(LAST_COLOR_KEY).then((v) => { if (v) setLastCustom(v); }); }, []);

    const translateY = useRef(new Animated.Value(0)).current;
    const panResponder = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4,
            onPanResponderMove: (_, g) => { if (g.dy > 0) translateY.setValue(g.dy); },
            onPanResponderRelease: (_, g) => {
                if (g.dy > 120 || g.vy > 1.2) {
                    Animated.timing(translateY, { toValue: 700, duration: 180, useNativeDriver: true }).start(() => onClose());
                } else {
                    Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
                }
            },
        }),
    ).current;

    useEffect(() => {
        if (!visible) return;
        translateY.setValue(0);
        setDraftName(name);
        setDraftColor(coverColor ?? DEFAULT_COLOR);
        setDraftEmoji(coverEmoji(coverImage) ?? EMOJI_CATALOG[0]);
        setHexInput('');
        setCustomOpen(false);
        setEmojiOpen(false);
    }, [visible, name, coverColor, coverImage, translateY]);

    const rememberCustom = useCallback((hex: string) => {
        setLastCustom(hex);
        AsyncStorage.setItem(LAST_COLOR_KEY, hex).catch(() => {});
    }, []);

    const applyPickedColor = useCallback((hex: string) => {
        if (!hex) return;
        const h = hex.slice(0, 7).toUpperCase();
        setDraftColor(h);
        setHexInput(h.replace('#', '')); // reflect the wheel selection in the hex field
        rememberCustom(h);
    }, [rememberCustom]);

    const onHexChange = useCallback((raw: string) => {
        setHexInput(raw);
        const hex = normalizeHex(raw);
        if (hex) { setDraftColor(hex); rememberCustom(hex); }
    }, [rememberCustom]);

    const save = useCallback(() => {
        const cleanName = draftName.trim() || name;
        onClose();
        onSubmit({ name: cleanName, coverColor: draftColor, coverImage: { kind: 'emoji', emoji: draftEmoji } });
    }, [draftName, name, draftColor, draftEmoji, onSubmit, onClose]);

    const isPresetColor = COLORS.includes(draftColor);
    const chipColor = isPresetColor ? lastCustom : draftColor;

    const onTapCustom = useCallback(() => {
        const opening = !customOpen;
        if (opening) {
            const base = isPresetColor && lastCustom ? lastCustom : draftColor;
            if (isPresetColor && lastCustom) setDraftColor(lastCustom);
            setHexInput(base.replace('#', '')); // seed the hex field with the current colour
            setEmojiOpen(false); // one panel open at a time so the body never needs to scroll
        }
        setCustomOpen(opening);
    }, [customOpen, isPresetColor, lastCustom, draftColor]);

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <View style={styles.modalRoot}>
                {/* Backdrop is a sibling BEHIND the sheet (not an ancestor
                    touchable) so it never captures the responder — otherwise
                    the colour-wheel/slider drags get starved and only taps
                    register. Tapping above the sheet closes it. */}
                <Pressable style={styles.backdrop} onPress={onClose} />
                <Animated.View style={[styles.sheet, { paddingBottom: Math.max(bottomInset, 16), transform: [{ translateY }] }]}>
                    <View style={styles.grabArea} {...panResponder.panHandlers}>
                        <View style={styles.pill} />
                    </View>

                    <GestureHandlerRootView style={styles.bodyWrap}>
                        <KeyboardAwareScrollView
                            contentContainerStyle={styles.body}
                            keyboardShouldPersistTaps="handled"
                            bottomOffset={16}
                            scrollEnabled={!customOpen}
                        >
                                {/* Emoji (left) + name (right) */}
                                <View style={styles.topRow}>
                                    <TouchableOpacity
                                        style={[styles.emojiSquircle, { backgroundColor: draftColor }]}
                                        onPress={() => { const opening = !emojiOpen; if (opening) setCustomOpen(false); setEmojiOpen(opening); }}
                                        activeOpacity={0.8}
                                    >
                                        <Text style={styles.emojiSquircleGlyph}>{draftEmoji}</Text>
                                        <View style={styles.emojiPlus}>
                                            <Ionicons name="add" size={13} color="#FFFFFF" />
                                        </View>
                                    </TouchableOpacity>
                                    <TextInput
                                        style={styles.nameInput}
                                        value={draftName}
                                        onChangeText={setDraftName}
                                        placeholder={t('basketTab.templates.fallbackName')}
                                        placeholderTextColor={colors.textMuted}
                                        maxLength={100}
                                    />
                                </View>

                                {/* Emoji grid — opens from the + on the emoji; picking closes it. */}
                                {emojiOpen && (
                                    <Reanimated.View
                                        entering={FadeInDown.duration(200)}
                                        exiting={FadeOutUp.duration(160)}
                                        style={styles.emojiGrid}
                                    >
                                        {EMOJI_CATALOG.map((e, i) => (
                                            <TouchableOpacity
                                                key={`${e}-${i}`}
                                                style={[styles.emojiCell, draftEmoji === e && styles.emojiCellActive]}
                                                onPress={() => { setDraftEmoji(e); setEmojiOpen(false); }}
                                            >
                                                <Text style={styles.emojiGlyph}>{e}</Text>
                                            </TouchableOpacity>
                                        ))}
                                    </Reanimated.View>
                                )}

                                {/* Colour — layout transition so it slides as the panels open/close. */}
                                <Reanimated.View layout={LinearTransition.duration(220)}>
                                    <Text style={styles.section}>{t('basketTab.templates.coverColour')}</Text>
                                    <View style={styles.swatchRow}>
                                        {COLORS.map((c) => (
                                            <TouchableOpacity
                                                key={c}
                                                style={[styles.swatch, { backgroundColor: c }, draftColor === c && styles.swatchActive]}
                                                onPress={() => { setDraftColor(c); setHexInput(''); setCustomOpen(false); }}
                                            />
                                        ))}
                                        <TouchableOpacity
                                            style={[styles.swatch, styles.customChip, chipColor ? { backgroundColor: chipColor, borderColor: 'transparent' } : null, customOpen && styles.swatchActive]}
                                            onPress={onTapCustom}
                                        >
                                            <Ionicons name="eyedrop-outline" size={16} color={chipColor ? '#FFFFFF' : colors.textSecondary} />
                                        </TouchableOpacity>
                                    </View>

                                    {customOpen && (
                                        <Reanimated.View
                                            entering={FadeInDown.duration(200)}
                                            exiting={FadeOutUp.duration(160)}
                                            style={styles.customWrap}
                                        >
                                            <ColorPicker
                                                style={{ gap: 14 }}
                                                value={draftColor}
                                                onComplete={(c) => { 'worklet'; runOnJS(applyPickedColor)(c.hex); }}
                                            >
                                                <Panel1 style={styles.wheelPanel} />
                                                <HueSlider style={styles.hue} />
                                            </ColorPicker>
                                            <View style={styles.hexRow}>
                                                <Text style={styles.hexPrefix}>#</Text>
                                                <TextInput
                                                    style={styles.hexInput}
                                                    value={hexInput}
                                                    onChangeText={onHexChange}
                                                    autoCapitalize="characters"
                                                    autoCorrect={false}
                                                    maxLength={7}
                                                    placeholder={t('basketTab.templates.coverHexPlaceholder')}
                                                    placeholderTextColor={colors.textMuted}
                                                />
                                            </View>
                                        </Reanimated.View>
                                    )}
                                </Reanimated.View>
                        </KeyboardAwareScrollView>
                    </GestureHandlerRootView>

                        <View style={styles.actions}>
                            <TouchableOpacity style={styles.cancelBtn} onPress={onClose} activeOpacity={0.7}>
                                <Text style={styles.cancelText}>{t('basketTab.templates.deleteCancel')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.doneBtn} onPress={save} activeOpacity={0.85}>
                                <Text style={styles.doneText}>{submitLabel ?? t('basketTab.templates.coverDone')}</Text>
                            </TouchableOpacity>
                        </View>
                    </Animated.View>
            </View>
        </Modal>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    modalRoot: { flex: 1, justifyContent: 'flex-end' },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
    sheet: { backgroundColor: c.pageBackground, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, maxHeight: '90%', paddingBottom: 12 },
    grabArea: { alignItems: 'center', paddingTop: 10, paddingBottom: 4 },
    pill: { width: 40, height: 5, borderRadius: 3, backgroundColor: c.border },
    bodyWrap: { flexShrink: 1 },
    body: { paddingHorizontal: 20, paddingTop: 8 },
    topRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 18 },
    emojiSquircle: { width: 60, height: 60, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
    emojiSquircleGlyph: { fontSize: 32 },
    emojiPlus: {
        position: 'absolute', right: -4, bottom: -4,
        width: 22, height: 22, borderRadius: 11, backgroundColor: c.primary,
        alignItems: 'center', justifyContent: 'center',
        borderWidth: 2, borderColor: c.pageBackground,
    },
    nameInput: { flex: 1, fontSize: 17, fontWeight: '600', color: c.textPrimary, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12 },
    section: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1, color: c.textSecondary, marginBottom: 8, marginTop: 4 },
    swatchRow: { flexDirection: 'row', gap: 12, marginBottom: 12, flexWrap: 'wrap' },
    swatch: { width: 36, height: 36, borderRadius: 18, borderWidth: 3, borderColor: 'transparent' },
    swatchActive: { borderColor: c.textPrimary },
    customChip: { backgroundColor: c.surfaceMuted ?? c.cardBackground, alignItems: 'center', justifyContent: 'center', borderColor: c.border },
    customWrap: { marginBottom: 12 },
    wheelPanel: { height: 160, borderRadius: radius.lg },
    hue: { borderRadius: 8, marginTop: 4 },
    hexRow: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, marginTop: 10 },
    hexPrefix: { fontSize: 16, fontWeight: '700', color: c.textSecondary },
    hexInput: { flex: 1, fontSize: 16, color: c.textPrimary, paddingVertical: 10 },
    emojiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 18 },
    emojiCell: { width: 46, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: c.cardBackground, borderWidth: 2, borderColor: 'transparent' },
    emojiCellActive: { borderColor: c.primary },
    emojiGlyph: { fontSize: 26 },
    actions: { flexDirection: 'row', gap: 12, paddingHorizontal: 20, paddingTop: 10 },
    cancelBtn: { flex: 1, borderRadius: radius.pill, paddingVertical: 15, alignItems: 'center', backgroundColor: c.cardBackground },
    cancelText: { color: c.textSecondary, fontSize: 16, fontWeight: '700' },
    doneBtn: { flex: 2, backgroundColor: c.primary, borderRadius: radius.pill, paddingVertical: 15, alignItems: 'center' },
    doneText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
