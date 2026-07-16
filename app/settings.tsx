import {
    View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch,
    Modal, Pressable, TextInput, ActivityIndicator, Alert, Linking,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { useCollapsingHeader, CollapsingHeader } from '../components/CollapsingHeader';
import { ScreenHeading } from '../components/ScreenHeading';
import { useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useTheme, type AppTheme } from '../constants/theme';
import { useSettingsStore, type AppLanguage, type ThemeMode } from '../state/settingsStore';
import { useAuthState } from '../state/authState';
import { getUserId, resetUserId } from '../config/user';
import { API_BASE_URL } from '../config/api';
import { GlassButton } from '../components/GlassButton';

/**
 * Single source of truth for the languages we ship. Adding a new one is
 * just a row here + a new locale JSON + a translation pass.
 */
const LANGUAGE_OPTIONS: { code: AppLanguage; label: string }[] = [
    { code: 'lt', label: 'Lietuvių' },
    { code: 'en', label: 'English' },
];

const THEME_MODES: ThemeMode[] = ['system', 'light', 'dark'];

export default function SettingsScreen() {
    const router = useRouter();
    const header = useCollapsingHeader();
    const { t } = useTranslation();
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const language = useSettingsStore((s) => s.language);
    const setLanguage = useSettingsStore((s) => s.setLanguage);
    const showLevelUpModal = useSettingsStore((s) => s.showLevelUpModal);
    const setShowLevelUpModal = useSettingsStore((s) => s.setShowLevelUpModal);
    const showNepriskirtaExplainer = useSettingsStore((s) => s.showNepriskirtaExplainer);
    const setShowNepriskirtaExplainer = useSettingsStore((s) => s.setShowNepriskirtaExplainer);
    const themeMode = useSettingsStore((s) => s.themeMode);
    const setThemeMode = useSettingsStore((s) => s.setThemeMode);

    const authUser = useAuthState((s) => s.user);
    const signOut = () => {
        Alert.alert(
            t('profilis.signOutConfirm.title'),
            t('profilis.signOutConfirm.body'),
            [
                { text: t('profilis.signOutConfirm.cancel'), style: 'cancel' },
                {
                    text: t('profilis.signOutConfirm.confirm'), style: 'destructive',
                    onPress: async () => {
                        try {
                            await useAuthState.getState().clear();
                            await resetUserId();
                            try { const Updates = await import('expo-updates'); await Updates.reloadAsync(); }
                            catch { router.replace('/receipts' as any); }
                        } catch { /* best-effort */ }
                    },
                },
            ],
        );
    };

    const [langPickerOpen, setLangPickerOpen] = useState(false);
    const [themePickerOpen, setThemePickerOpen] = useState(false);
    const [deleteStage, setDeleteStage] = useState<0 | 1 | 2 | 'goodbye'>(0);
    const [deleteInput, setDeleteInput] = useState('');
    const [deleting, setDeleting] = useState(false);

    const currentLangLabel = LANGUAGE_OPTIONS.find((l) => l.code === language)?.label
        ?? LANGUAGE_OPTIONS[0].label;
    const currentThemeLabel = t(`settings.appearance.${themeMode}`);

    const handleDelete = async () => {
        setDeleting(true);
        try {
            const userId = await getUserId();
            const res = await fetch(
                `${API_BASE_URL}/api/users/${encodeURIComponent(userId)}`,
                { method: 'DELETE' },
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            // Server account is gone — reset the local identity immediately so
            // the dead UUID can't be reused (e.g. if the user closes the app on
            // the goodbye screen before tapping "open new account"). Best-effort:
            // a reset failure must not revert the already-succeeded deletion.
            try { await resetUserId(); } catch { /* next getUserId() retries */ }
            setDeleteStage('goodbye');
        } catch (e) {
            Alert.alert(t('delete.errorTitle'), t('delete.errorBody'));
            setDeleteStage(0);
            setDeleteInput('');
        } finally {
            setDeleting(false);
        }
    };

    const handleOpenNewAccount = async () => {
        // Reset device identity, drop back to the receipts tab. The next
        // getUserId() call in any subsequent fetch will mint a fresh UUID
        // and POST /api/users to register it.
        await resetUserId();
        router.replace('/receipts' as any);
    };

    return (
        <>
        <CollapsingHeader
            controller={header}
            background={colors.cardBackground}
            back
            collapsing={<ScreenHeading title={t('settings.title')} />}
        />
        <Animated.ScrollView
            {...header.scroll}
            style={styles.page}
            contentContainerStyle={[styles.pageContent, { paddingTop: header.paddingTop + 16 }]}
        >
            {/* ── Language ─────────────────────────────────────────────── */}
            <Section title={t('settings.language.section')} styles={styles}>
                <TouchableOpacity
                    style={styles.row}
                    onPress={() => setLangPickerOpen(true)}
                    activeOpacity={0.7}
                >
                    <View style={styles.rowMain}>
                        <Text style={styles.rowLabel}>{t('settings.language.label')}</Text>
                        <Text style={styles.rowValue}>{currentLangLabel}</Text>
                    </View>
                    <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
                </TouchableOpacity>
            </Section>

            {/* ── Appearance ────────────────────────────────────────────── */}
            <Section title={t('settings.appearance.section')} styles={styles}>
                <TouchableOpacity
                    style={styles.row}
                    onPress={() => setThemePickerOpen(true)}
                    activeOpacity={0.7}
                >
                    <View style={styles.rowMain}>
                        <Text style={styles.rowLabel}>{t('settings.appearance.label')}</Text>
                        <Text style={styles.rowValue}>{currentThemeLabel}</Text>
                    </View>
                    <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
                </TouchableOpacity>
            </Section>

            {/* ── Notifications / modal toggles ────────────────────────── */}
            <Section title={t('settings.notifications.section')} styles={styles}>
                <ToggleRow
                    label={t('settings.notifications.levelUp.label')}
                    hint={t('settings.notifications.levelUp.hint')}
                    value={showLevelUpModal}
                    onChange={setShowLevelUpModal}
                    styles={styles}
                    colors={colors}
                />
                <Divider styles={styles} />
                <ToggleRow
                    label={t('settings.notifications.nepriskirtaExplainer.label')}
                    hint={t('settings.notifications.nepriskirtaExplainer.hint')}
                    value={showNepriskirtaExplainer}
                    onChange={setShowNepriskirtaExplainer}
                    styles={styles}
                    colors={colors}
                />
            </Section>

            {/* ── Account ──────────────────────────────────────────────── */}
            <Section title={t('settings.account.section')} styles={styles}>
                {authUser && (
                    <>
                        <TouchableOpacity style={styles.row} onPress={signOut} activeOpacity={0.7}>
                            <View style={styles.rowMain}>
                                <Text style={styles.rowLabel}>{t('profilis.signOut')}</Text>
                            </View>
                            <Ionicons name="log-out-outline" size={20} color={colors.textMuted} />
                        </TouchableOpacity>
                        <Divider styles={styles} />
                    </>
                )}
                <TouchableOpacity
                    style={styles.row}
                    onPress={() => router.push('/profile/restore-account' as any)}
                    activeOpacity={0.7}
                >
                    <View style={styles.rowMain}>
                        <Text style={styles.rowLabel}>{t('settings.account.restore.label')}</Text>
                        <Text style={styles.rowHint}>{t('settings.account.restore.hint')}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                </TouchableOpacity>
                <Divider styles={styles} />
                <TouchableOpacity
                    style={styles.row}
                    onPress={() => setDeleteStage(1)}
                    activeOpacity={0.7}
                >
                    <View style={styles.rowMain}>
                        <Text style={[styles.rowLabel, styles.rowLabelDanger]}>
                            {t('settings.account.delete.label')}
                        </Text>
                        <Text style={styles.rowHint}>{t('settings.account.delete.hint')}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={colors.error} />
                </TouchableOpacity>
            </Section>

            {/* ── About ────────────────────────────────────────────────── */}
            <Section title={t('settings.about.section')} styles={styles}>
                <View style={styles.row}>
                    <View style={styles.rowMain}>
                        <Text style={styles.rowLabel}>{t('settings.about.version')}</Text>
                        <Text style={styles.rowValue}>
                            {Constants.expoConfig?.version
                                ? `${Constants.expoConfig.version}${Constants.nativeBuildVersion ? ` (build ${Constants.nativeBuildVersion})` : ''}`
                                : '—'}
                        </Text>
                    </View>
                </View>
                <Divider styles={styles} />
                {/* Links to the canonical web policy (single source of truth)
                    so the app and site never drift. Required by both stores. */}
                <TouchableOpacity
                    style={styles.row}
                    onPress={() => Linking.openURL('https://souply.lt/legal/privacy')}
                    activeOpacity={0.7}
                >
                    <View style={styles.rowMain}>
                        <Text style={styles.rowLabel}>{t('settings.about.privacy')}</Text>
                    </View>
                    <Ionicons name="open-outline" size={18} color={colors.textMuted} />
                </TouchableOpacity>
                <Divider styles={styles} />
                <TouchableOpacity
                    style={styles.row}
                    onPress={() => Linking.openURL('https://souply.lt/legal/terms')}
                    activeOpacity={0.7}
                >
                    <View style={styles.rowMain}>
                        <Text style={styles.rowLabel}>{t('settings.about.terms')}</Text>
                    </View>
                    <Ionicons name="open-outline" size={18} color={colors.textMuted} />
                </TouchableOpacity>
            </Section>

            {/* ── Language picker modal ────────────────────────────────── */}
            <Modal
                visible={langPickerOpen}
                transparent
                animationType="fade"
                onRequestClose={() => setLangPickerOpen(false)}
            >
                <Pressable
                    style={styles.modalBackdrop}
                    onPress={() => setLangPickerOpen(false)}
                >
                    <Pressable
                        style={styles.modalCard}
                        onPress={(e) => e.stopPropagation()}
                    >
                        <Text style={styles.modalTitle}>{t('settings.language.label')}</Text>
                        {LANGUAGE_OPTIONS.map((opt) => {
                            const selected = opt.code === language;
                            return (
                                <TouchableOpacity
                                    key={opt.code}
                                    style={styles.langOption}
                                    onPress={async () => {
                                        await setLanguage(opt.code);
                                        setLangPickerOpen(false);
                                    }}
                                >
                                    <Text style={[styles.langLabel, selected && styles.langLabelSelected]}>
                                        {opt.label}
                                    </Text>
                                    {selected ? (
                                        <Ionicons name="checkmark" size={20} color={colors.primary} />
                                    ) : null}
                                </TouchableOpacity>
                            );
                        })}
                    </Pressable>
                </Pressable>
            </Modal>

            {/* ── Theme picker modal ───────────────────────────────────── */}
            <Modal
                visible={themePickerOpen}
                transparent
                animationType="fade"
                onRequestClose={() => setThemePickerOpen(false)}
            >
                <Pressable
                    style={styles.modalBackdrop}
                    onPress={() => setThemePickerOpen(false)}
                >
                    <Pressable
                        style={styles.modalCard}
                        onPress={(e) => e.stopPropagation()}
                    >
                        <Text style={styles.modalTitle}>{t('settings.appearance.label')}</Text>
                        {THEME_MODES.map((mode) => {
                            const selected = mode === themeMode;
                            return (
                                <TouchableOpacity
                                    key={mode}
                                    style={styles.langOption}
                                    onPress={async () => {
                                        await setThemeMode(mode);
                                        setThemePickerOpen(false);
                                    }}
                                >
                                    <Text style={[styles.langLabel, selected && styles.langLabelSelected]}>
                                        {t(`settings.appearance.${mode}`)}
                                    </Text>
                                    {selected ? (
                                        <Ionicons name="checkmark" size={20} color={colors.primary} />
                                    ) : null}
                                </TouchableOpacity>
                            );
                        })}
                    </Pressable>
                </Pressable>
            </Modal>

            {/* ── Delete stage 1: what gets deleted vs kept ─────────────── */}
            <Modal
                visible={deleteStage === 1}
                transparent
                animationType="fade"
                onRequestClose={() => setDeleteStage(0)}
            >
                <Pressable
                    style={styles.modalBackdrop}
                    onPress={() => setDeleteStage(0)}
                >
                    <Pressable
                        style={styles.modalCard}
                        onPress={(e) => e.stopPropagation()}
                    >
                        <Text style={styles.modalTitle}>{t('delete.stage1.title')}</Text>

                        <Text style={styles.bulletHeader}>{t('delete.stage1.willDelete')}</Text>
                        {(t('delete.stage1.willDeleteItems', { returnObjects: true }) as string[]).map((it, i) => (
                            <BulletRow key={i} text={it} color={colors.error} styles={styles} />
                        ))}

                        <Text style={[styles.bulletHeader, { marginTop: 12 }]}>
                            {t('delete.stage1.willKeep')}
                        </Text>
                        {(t('delete.stage1.willKeepItems', { returnObjects: true }) as string[]).map((it, i) => (
                            <BulletRow key={i} text={it} color={colors.success} styles={styles} />
                        ))}

                        <View style={styles.modalBtnRow}>
                            <GlassButton
                                title={t('delete.stage1.cancel')}
                                variant="secondary"
                                onPress={() => setDeleteStage(0)}
                                flex
                            />
                            <GlassButton
                                title={t('delete.stage1.continue')}
                                variant="danger"
                                onPress={() => setDeleteStage(2)}
                                flex
                            />
                        </View>
                    </Pressable>
                </Pressable>
            </Modal>

            {/* ── Delete stage 2: type-to-confirm ───────────────────────── */}
            <Modal
                visible={deleteStage === 2}
                transparent
                animationType="fade"
                onRequestClose={() => deleting ? null : setDeleteStage(0)}
            >
                <Pressable
                    style={styles.modalBackdrop}
                    onPress={() => (!deleting ? setDeleteStage(0) : null)}
                >
                    <Pressable
                        style={styles.modalCard}
                        onPress={(e) => e.stopPropagation()}
                    >
                        <Text style={styles.modalTitle}>{t('delete.stage2.title')}</Text>
                        <Text style={styles.modalBody}>{t('delete.stage2.body')}</Text>
                        <TextInput
                            style={styles.textInput}
                            value={deleteInput}
                            onChangeText={setDeleteInput}
                            placeholder={t('delete.stage2.placeholder')}
                            placeholderTextColor={colors.textMuted}
                            autoCapitalize="characters"
                            autoCorrect={false}
                            editable={!deleting}
                        />
                        <View style={styles.modalBtnRow}>
                            <GlassButton
                                title={t('delete.stage2.cancel')}
                                variant="secondary"
                                onPress={() => {
                                    if (deleting) return;
                                    setDeleteStage(0);
                                    setDeleteInput('');
                                }}
                                disabled={deleting}
                                flex
                            />
                            <GlassButton
                                title={deleting ? '…' : t('delete.stage2.confirm')}
                                variant="danger"
                                disabled={deleteInput !== t('delete.stage2.magic') || deleting}
                                onPress={handleDelete}
                                flex
                            />
                        </View>
                    </Pressable>
                </Pressable>
            </Modal>

            {/* ── Goodbye screen ────────────────────────────────────────── */}
            <Modal
                visible={deleteStage === 'goodbye'}
                transparent={false}
                animationType="fade"
            >
                <View style={[styles.page, styles.goodbye]}>
                    <Ionicons name="heart-outline" size={64} color={colors.primary} />
                    <Text style={styles.goodbyeTitle}>{t('delete.goodbye.title')}</Text>
                    <Text style={styles.goodbyeBody}>{t('delete.goodbye.body')}</Text>
                    <GlassButton
                        title={t('delete.goodbye.cta')}
                        variant="primary"
                        onPress={handleOpenNewAccount}
                        style={{ marginTop: 24, minWidth: 220 }}
                    />
                </View>
            </Modal>
        </Animated.ScrollView>
        </>
    );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function Section({
    title, children, styles,
}: {
    title: string;
    children: React.ReactNode;
    styles: ReturnType<typeof makeStyles>;
}) {
    return (
        <View style={styles.section}>
            <Text style={styles.sectionTitle}>{title}</Text>
            <View style={styles.card}>{children}</View>
        </View>
    );
}

function ToggleRow({
    label, hint, value, onChange, styles, colors,
}: {
    label: string;
    hint?: string;
    value: boolean;
    onChange: (v: boolean) => Promise<void> | void;
    styles: ReturnType<typeof makeStyles>;
    colors: AppTheme;
}) {
    return (
        <View style={styles.row}>
            <View style={styles.rowMain}>
                <Text style={styles.rowLabel}>{label}</Text>
                {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
            </View>
            <Switch
                value={value}
                onValueChange={onChange}
                trackColor={{ false: colors.surfaceMuted, true: colors.primaryMuted }}
                thumbColor={value ? colors.primary : colors.textMuted}
            />
        </View>
    );
}

function Divider({ styles }: { styles: ReturnType<typeof makeStyles> }) {
    return <View style={styles.divider} />;
}

function BulletRow({
    text, color, styles,
}: {
    text: string;
    color: string;
    styles: ReturnType<typeof makeStyles>;
}) {
    return (
        <View style={styles.bulletRow}>
            <View style={[styles.bulletDot, { backgroundColor: color }]} />
            <Text style={styles.bulletText}>{text}</Text>
        </View>
    );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const makeStyles = (c: AppTheme) => StyleSheet.create({
    page: {
        flex: 1,
        backgroundColor: c.pageBackground,
    },
    pageContent: {
        paddingVertical: 16,
        paddingBottom: 48,
    },

    section: {
        marginBottom: 24,
    },
    sectionTitle: {
        fontSize: 12,
        fontWeight: '700',
        color: c.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        marginHorizontal: 20,
        marginBottom: 8,
    },
    card: {
        backgroundColor: c.cardBackground,
        marginHorizontal: 16,
        borderRadius: 12,
        overflow: 'hidden',
    },

    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
    rowMain: {
        flex: 1,
        gap: 2,
    },
    rowLabel: {
        fontSize: 15,
        color: c.textPrimary,
    },
    rowLabelDanger: {
        color: c.error,
        fontWeight: '600',
    },
    rowValue: {
        fontSize: 13,
        color: c.textSecondary,
    },
    rowHint: {
        fontSize: 12,
        color: c.textMuted,
        lineHeight: 17,
    },
    divider: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: c.borderSubtle,
        marginLeft: 16,
    },

    // ── Modal common ─────────────────────────────────────
    modalBackdrop: {
        flex: 1,
        backgroundColor: c.overlayBackdrop,
        justifyContent: 'center',
        paddingHorizontal: 24,
    },
    modalCard: {
        backgroundColor: c.cardBackground,
        borderRadius: 16,
        padding: 20,
        gap: 8,
    },
    modalTitle: {
        fontSize: 17,
        fontWeight: '700',
        color: c.textPrimary,
        marginBottom: 4,
    },
    modalBody: {
        fontSize: 13,
        lineHeight: 19,
        color: c.textSecondary,
    },
    modalBtnRow: {
        flexDirection: 'row',
        gap: 10,
        marginTop: 12,
    },
    modalBtn: {
        flex: 1,
        paddingVertical: 12,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    modalBtnSecondary: {
        backgroundColor: c.surfaceMuted,
    },
    modalBtnPrimary: {
        backgroundColor: c.primary,
    },
    modalBtnDanger: {
        backgroundColor: c.error,
    },
    modalBtnDisabled: {
        opacity: 0.4,
    },
    modalBtnTextSecondary: {
        fontSize: 14,
        fontWeight: '600',
        color: c.textPrimary,
    },
    modalBtnTextPrimary: {
        fontSize: 14,
        fontWeight: '700',
        color: c.onPrimary,
    },

    // ── Language picker ─────────────────────────────────
    langOption: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 12,
    },
    langLabel: {
        fontSize: 15,
        color: c.textPrimary,
    },
    langLabelSelected: {
        fontWeight: '700',
        color: c.primary,
    },

    // ── Delete bullets ──────────────────────────────────
    bulletHeader: {
        fontSize: 13,
        fontWeight: '600',
        color: c.textSecondary,
        marginTop: 4,
        marginBottom: 6,
    },
    bulletRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        paddingVertical: 2,
    },
    bulletDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        marginTop: 7,
    },
    bulletText: {
        flex: 1,
        fontSize: 13,
        lineHeight: 19,
        color: c.textPrimary,
    },

    // ── Stage 2 input ───────────────────────────────────
    textInput: {
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 15,
        color: c.textPrimary,
        marginTop: 4,
        backgroundColor: c.pageBackground,
    },

    // ── Goodbye screen ──────────────────────────────────
    goodbye: {
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
    },
    goodbyeTitle: {
        fontSize: 22,
        fontWeight: '700',
        color: c.textPrimary,
        marginTop: 16,
        textAlign: 'center',
    },
    goodbyeBody: {
        fontSize: 14,
        color: c.textSecondary,
        marginTop: 8,
        textAlign: 'center',
    },
});
