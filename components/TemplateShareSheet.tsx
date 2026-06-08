import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    View, Text, Modal, TouchableOpacity, StyleSheet, ActivityIndicator,
    Share, Image, PanResponder, Animated, Platform, ToastAndroid, Alert, type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import { BrandedQR } from './BrandedQR';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../constants/theme';
import {
    generateShareLink,
    type ShareLinkResult,
} from '../utils/basketTemplatesApi';

interface Props {
    visible: boolean;
    templateId: number | null;
    templateName: string;
    itemCount: number;
    /** Current server-side visibility of this template. */
    visibility: 'private' | 'unlisted' | 'public';
    /** True when the owner is a signed-in creator (has a username). Drives
     *  whether the Privatus/Viešas switch is shown. Non-creators just get a
     *  quick unlisted link with no controls. */
    isCreator: boolean;
    /** Flip visibility (creator only). The parent owns the PATCH + publish
     *  wall and updates the `visibility` prop on success. Returns a status so
     *  the sheet can surface a themed inline notice (e.g. the DEV account
     *  can't publish) instead of a native alert. */
    onSetVisibility?: (next: 'private' | 'public') => Promise<'ok' | 'wall' | 'dev' | 'error'>;
    onClose: () => void;
}

/**
 * Bottom-sheet share modal.
 *
 *  - Non-creator: opening mints/reuses an unlisted link and shows the full
 *    sheet (QR · savings · link · share). No switch — it just works.
 *  - Creator: a Privatus/Viešas switch gates the sheet. Privatus shows only
 *    the switch + a short explainer; Viešas (public, listed under the
 *    @handle) reveals QR · savings · link · share. Flipping to Privatus is
 *    the off-control — there's no separate revoke. The slug is kept
 *    server-side, so any link already shared resolves to a "made private"
 *    page rather than 404, and flipping back reuses the same link.
 */
export function TemplateShareSheet({
    visible, templateId, templateName, itemCount, visibility, isCreator, onSetVisibility, onClose,
}: Props) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { bottom: bottomInset } = useSafeAreaInsets();

    const [loading, setLoading] = useState(false);
    const [data, setData] = useState<ShareLinkResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [qrUrlFailed, setQrUrlFailed] = useState(false);
    const [copiedFlash, setCopiedFlash] = useState(false);
    const [switching, setSwitching] = useState(false);
    const [helpOpen, setHelpOpen] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [savedFlash, setSavedFlash] = useState(false);
    const [visNotice, setVisNotice] = useState<'dev' | 'error' | null>(null);

    // Non-creators always share (unlisted). For creators the sheet is "on"
    // only when the template isn't private.
    const isShared = !isCreator || visibility !== 'private';

    // ── Segmented Privatus/Viešas slider (mirrors the web VisibilitySlider) ──
    const [segW, setSegW] = useState(0);
    const slideX = useRef(new Animated.Value(isShared ? 1 : 0)).current;
    useEffect(() => {
        Animated.timing(slideX, {
            toValue: isShared ? 1 : 0, duration: 220, useNativeDriver: true,
        }).start();
    }, [isShared, slideX]);
    const onSegLayout = useCallback((e: LayoutChangeEvent) => setSegW(e.nativeEvent.layout.width), []);
    const capsuleW = segW > 0 ? (segW - 8) / 2 : 0; // container padding 4 each side
    // Memoised so the SAME interpolation node persists across renders. Passing
    // a freshly-created interpolation to a native-driven view every render
    // makes the native animated module lose track of it and glitch once the
    // value animates (after a toggle).
    const capsuleX = useMemo(
        () => slideX.interpolate({ inputRange: [0, 1], outputRange: [0, capsuleW] }),
        [slideX, capsuleW],
    );

    // ── Drag-to-dismiss via the top pill ──────────────────────────────────
    const translateY = useRef(new Animated.Value(0)).current;
    const panResponder = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4,
            onPanResponderMove: (_, g) => {
                if (g.dy > 0) translateY.setValue(g.dy);
            },
            onPanResponderRelease: (_, g) => {
                if (g.dy > 120 || g.vy > 1.2) {
                    Animated.timing(translateY, {
                        toValue: 600, duration: 180, useNativeDriver: true,
                    }).start(() => onClose());
                } else {
                    Animated.spring(translateY, {
                        toValue: 0, useNativeDriver: true, bounciness: 4,
                    }).start();
                }
            },
        }),
    ).current;

    // Fetch the slug + snapshot + QR only when the sheet should actually show
    // it (shared). For a creator's PRIVATE template we deliberately skip this
    // — calling /share would auto-upgrade it to unlisted, which is exactly
    // what the switch is meant to gate.
    useEffect(() => {
        if (!visible || templateId == null) return;
        if (itemCount === 0) {
            setError(t('basketTab.templates.shareNoItems'));
            return;
        }
        if (!isShared) {
            // Private (creator): no link surface, just the switch + explainer.
            setData(null);
            setError(null);
            return;
        }
        setLoading(true);
        setError(null);
        generateShareLink(templateId)
            .then(setData)
            .catch(() => setError(t('basketTab.templates.errorSave')))
            .finally(() => setLoading(false));
    }, [visible, templateId, itemCount, isShared, t]);

    // Reset transient UI when closed; snap drag back before the open slide-in.
    useEffect(() => {
        if (!visible) {
            setData(null);
            setError(null);
            setQrUrlFailed(false);
            setHelpOpen(false);
            setVisNotice(null);
        } else {
            translateY.setValue(0);
        }
    }, [visible, translateY]);

    // Materialise the branded QR PNG to a local cache file (from the inline
    // data URI, else the hosted URL). Returns null when no server QR exists
    // (pre-migration shares render the client-side SVG, which has no file).
    const ensureQrFile = useCallback(async (): Promise<string | null> => {
        if (!data) return null;
        const path = `${FileSystem.cacheDirectory}souply-qr-${templateId ?? 'x'}.png`;
        try {
            if (data.qrDataUrl) {
                const base64 = data.qrDataUrl.replace(/^data:image\/\w+;base64,/, '');
                await FileSystem.writeAsStringAsync(path, base64, { encoding: 'base64' });
                return path;
            }
            if (data.qrUrl) {
                const dl = await FileSystem.downloadAsync(data.qrUrl, path);
                return dl.uri;
            }
        } catch {}
        return null;
    }, [data, templateId]);

    // "Dalintis" → share the QR image through the native sheet, which surfaces
    // "Save Image / Save to Photos" alongside send-to-app targets. Falls back
    // to sharing the link text when no image file / sharing is unavailable.
    const handleNativeShare = useCallback(async () => {
        const file = await ensureQrFile();
        try {
            if (file && (await Sharing.isAvailableAsync())) {
                await Sharing.shareAsync(file, {
                    mimeType: 'image/png', dialogTitle: templateName, UTI: 'public.png',
                });
                return;
            }
        } catch {}
        if (data) {
            try {
                await Share.share({ message: `${templateName} — Souply\n${data.url}`, url: data.url, title: templateName });
            } catch {}
        }
    }, [ensureQrFile, data, templateName]);

    // Dedicated one-tap download: save the branded QR PNG straight to the
    // device gallery (write-only Photos permission on iOS).
    const handleDownload = useCallback(async () => {
        if (downloading) return;
        setDownloading(true);
        try {
            const perm = await MediaLibrary.requestPermissionsAsync(true);
            if (!perm.granted) {
                Alert.alert(t('basketTab.templates.qrPermTitle'), t('basketTab.templates.qrPermBody'));
                return;
            }
            const file = await ensureQrFile();
            if (!file) {
                Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorSave'));
                return;
            }
            await MediaLibrary.saveToLibraryAsync(file);
            if (Platform.OS === 'android') {
                ToastAndroid.show(t('basketTab.templates.qrSaved'), ToastAndroid.SHORT);
            } else {
                setSavedFlash(true);
                setTimeout(() => setSavedFlash(false), 1600);
            }
        } catch {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorSave'));
        } finally {
            setDownloading(false);
        }
    }, [downloading, ensureQrFile, t]);

    const handleToggle = useCallback(async (next: boolean) => {
        if (!onSetVisibility || switching) return;
        setSwitching(true);
        setVisNotice(null);
        try {
            const res = await onSetVisibility(next ? 'public' : 'private');
            if (res === 'dev' || res === 'error') setVisNotice(res);
        } finally {
            setSwitching(false);
        }
    }, [onSetVisibility, switching]);

    const handleCopy = useCallback(async () => {
        if (!data) return;
        await Clipboard.setStringAsync(data.url);
        if (Platform.OS === 'android') {
            ToastAndroid.show(t('basketTab.templates.linkCopiedToast'), ToastAndroid.SHORT);
        } else {
            setCopiedFlash(true);
            setTimeout(() => setCopiedFlash(false), 1400);
        }
    }, [data, t]);

    // "Tavo krepšelis pigiausioje parduotuvėje – iki €X pigiau" — the max
    // cross-chain gap (most expensive minus cheapest). Falls back to the
    // runner-up gap for older snapshots. Hidden entirely when there's no gap.
    const savings = (() => {
        const cheapest = data?.snapshot.cheapestTotalEur;
        const mostExpensive = data?.snapshot.mostExpensiveTotalEur;
        const runnerUp = data?.snapshot.runnerUpTotalEur;
        if (cheapest == null) return null;
        if (mostExpensive != null && mostExpensive > cheapest) return (mostExpensive - cheapest).toFixed(2);
        if (runnerUp != null && runnerUp > cheapest) return (runnerUp - cheapest).toFixed(2);
        return null;
    })();

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
                <Animated.View
                    style={[styles.sheet, { paddingBottom: Math.max(bottomInset + 12, 32), transform: [{ translateY }] }]}
                    onStartShouldSetResponder={() => true}
                >
                    <View {...panResponder.panHandlers} style={styles.handleArea}>
                        <View style={styles.handle} />
                    </View>
                    <Text style={styles.title} numberOfLines={1}>{templateName}</Text>

                    {/* Creator visibility — Privatus / Viešas segmented slider
                        (mirrors the web dashboard's VisibilitySlider). */}
                    {isCreator && (
                        <View style={styles.visBlock}>
                            <Text style={styles.visLabel}>{t('basketTab.templates.shareVisibilityLabel')}</Text>
                            <View style={[styles.segment, switching && { opacity: 0.6 }]} onLayout={onSegLayout}>
                                {capsuleW > 0 && (
                                    <Animated.View style={[styles.segCapsule, { width: capsuleW, transform: [{ translateX: capsuleX }] }]} />
                                )}
                                <TouchableOpacity style={styles.segBtn} disabled={switching} activeOpacity={0.8} onPress={() => handleToggle(false)}>
                                    <Ionicons name="lock-closed" size={13} color={!isShared ? colors.onPrimary : colors.textSecondary} />
                                    <Text style={[styles.segText, { color: !isShared ? colors.onPrimary : colors.textSecondary }]}>
                                        {t('basketTab.templates.shareVisPrivate')}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity style={styles.segBtn} disabled={switching} activeOpacity={0.8} onPress={() => handleToggle(true)}>
                                    <Ionicons name="globe" size={13} color={isShared ? colors.onPrimary : colors.textSecondary} />
                                    <Text style={[styles.segText, { color: isShared ? colors.onPrimary : colors.textSecondary }]}>
                                        {t('basketTab.templates.shareVisPublic')}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                            <Text style={styles.visSub}>
                                {isShared ? t('basketTab.templates.shareVisPublicSub') : t('basketTab.templates.shareVisPrivateSub')}
                            </Text>
                        </View>
                    )}

                    {visNotice && (
                        <View style={styles.noticeBox}>
                            <Ionicons name="information-circle-outline" size={18} color={colors.primary} />
                            <Text style={styles.noticeText}>
                                {visNotice === 'dev'
                                    ? t('basketTab.templates.shareDevAccount')
                                    : t('basketTab.templates.errorSave')}
                            </Text>
                        </View>
                    )}

                    {loading && (
                        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
                    )}

                    {error && (
                        <View style={styles.errorBox}>
                            <Ionicons name="alert-circle" size={18} color={colors.error} />
                            <Text style={styles.errorText}>{error}</Text>
                        </View>
                    )}

                    {/* Private (creator): explainer only, no link surface. */}
                    {isCreator && !isShared && !error && (
                        <View style={styles.explainerBox}>
                            <Text style={styles.explainerText}>{t('basketTab.templates.sharePrivateExplainer')}</Text>
                        </View>
                    )}

                    {isShared && data && (
                        <>
                            <View style={styles.qrWrap}>
                                <View style={styles.qrInner}>
                                    <BrandedQR value={data.url} size={180} />
                                </View>
                            </View>

                            {savings && (
                                <View style={styles.savingsRow}>
                                    <Ionicons name="trending-down" size={16} color={colors.success} />
                                    <Text style={styles.savingsText}>
                                        {t('basketTab.templates.shareSavingsViewer', { amount: savings })}
                                    </Text>
                                    <TouchableOpacity
                                        onPress={() => setHelpOpen(true)}
                                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                    >
                                        <Ionicons name="help-circle-outline" size={18} color={colors.textMuted} />
                                    </TouchableOpacity>
                                </View>
                            )}

                            <TouchableOpacity onPress={handleCopy} activeOpacity={0.7}>
                                <Text style={styles.url} numberOfLines={2}>{data.url}</Text>
                            </TouchableOpacity>
                            {Platform.OS !== 'android' && copiedFlash && (
                                <Text style={styles.copiedToast}>{t('basketTab.templates.linkCopiedToast')}</Text>
                            )}

                            <TouchableOpacity style={styles.primaryBtn} onPress={handleNativeShare}>
                                <Ionicons name="share-social-outline" size={18} color={colors.onPrimary} />
                                <Text style={styles.primaryBtnText}>{t('basketTab.templates.shareNative')}</Text>
                            </TouchableOpacity>

                            <TouchableOpacity style={styles.secondaryBtn} onPress={handleDownload} disabled={downloading} activeOpacity={0.8}>
                                {downloading ? (
                                    <ActivityIndicator color={colors.primary} />
                                ) : (
                                    <>
                                        <Ionicons name="download-outline" size={18} color={colors.primary} />
                                        <Text style={styles.secondaryBtnText}>{t('basketTab.templates.shareDownloadQr')}</Text>
                                    </>
                                )}
                            </TouchableOpacity>
                            {Platform.OS !== 'android' && savedFlash && (
                                <Text style={styles.copiedToast}>{t('basketTab.templates.qrSaved')}</Text>
                            )}
                        </>
                    )}
                </Animated.View>
            </TouchableOpacity>

            {/* Savings help popover */}
            <Modal visible={helpOpen} transparent animationType="fade" onRequestClose={() => setHelpOpen(false)}>
                <TouchableOpacity style={styles.helpBackdrop} activeOpacity={1} onPress={() => setHelpOpen(false)}>
                    <View style={styles.helpCard} onStartShouldSetResponder={() => true}>
                        <Text style={styles.helpTitle}>{t('basketTab.templates.shareSavingsHelpTitle')}</Text>
                        <Text style={styles.helpBody}>{t('basketTab.templates.shareSavingsHelpBody')}</Text>
                        <TouchableOpacity style={styles.helpClose} onPress={() => setHelpOpen(false)}>
                            <Text style={styles.helpCloseText}>{t('common.gotIt')}</Text>
                        </TouchableOpacity>
                    </View>
                </TouchableOpacity>
            </Modal>
        </Modal>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    sheet: {
        backgroundColor: c.cardBackground,
        borderTopLeftRadius: 24, borderTopRightRadius: 24,
        padding: 20, paddingBottom: 32, gap: 12,
    },
    handleArea: { alignSelf: 'stretch', alignItems: 'center', paddingVertical: 8, marginBottom: 4 },
    handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: c.border },
    copiedToast: {
        alignSelf: 'center', backgroundColor: c.textPrimary,
        color: c.cardBackground, fontSize: 12, fontWeight: '600',
        paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, overflow: 'hidden',
    },
    title: { fontSize: 18, fontWeight: '700', color: c.textPrimary, textAlign: 'center' },
    templateName: { fontSize: 14, color: c.textSecondary, textAlign: 'center' },
    visBlock: { marginTop: 4, gap: 6 },
    visLabel: { fontSize: 10, fontWeight: '700', color: c.textMuted, letterSpacing: 0.6, textTransform: 'uppercase' },
    segment: {
        position: 'relative', flexDirection: 'row',
        backgroundColor: c.surfaceMuted, borderRadius: 12, padding: 4,
        borderWidth: 1, borderColor: c.border,
    },
    segCapsule: {
        position: 'absolute', top: 4, bottom: 4, left: 4,
        borderRadius: 9, backgroundColor: c.primary,
    },
    segBtn: {
        flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: 6, paddingVertical: 8,
    },
    segText: { fontSize: 13, fontWeight: '700' },
    visSub: { fontSize: 12, color: c.textSecondary },
    noticeBox: {
        flexDirection: 'row', gap: 8, alignItems: 'flex-start',
        backgroundColor: c.primaryMuted, borderRadius: 10, padding: 12,
    },
    noticeText: { flex: 1, fontSize: 13, color: c.textPrimary, lineHeight: 18 },
    secondaryBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        borderRadius: 10, paddingVertical: 13, borderWidth: 1, borderColor: c.primary,
    },
    secondaryBtnText: { fontSize: 15, fontWeight: '700', color: c.primary },
    explainerBox: { backgroundColor: c.surfaceMuted, borderRadius: 10, padding: 14 },
    explainerText: { fontSize: 13, color: c.textSecondary, lineHeight: 19 },
    center: { alignItems: 'center', padding: 32 },
    errorBox: {
        flexDirection: 'row', gap: 8, alignItems: 'center',
        backgroundColor: c.surfaceMuted, borderRadius: 10, padding: 12,
    },
    errorText: { flex: 1, fontSize: 13, color: c.textPrimary },
    qrWrap: { alignItems: 'center', justifyContent: 'center', marginTop: 8 },
    qrInner: { alignItems: 'center', justifyContent: 'center' },
    savingsRow: { flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center' },
    savingsText: { fontSize: 13, fontWeight: '700', color: c.success },
    url: {
        fontSize: 13, color: c.textSecondary, textAlign: 'center',
        backgroundColor: c.surfaceMuted, padding: 10, borderRadius: 10,
    },
    primaryBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        backgroundColor: c.primary, borderRadius: 10, paddingVertical: 14,
    },
    primaryBtnText: { fontSize: 15, fontWeight: '700', color: c.onPrimary },
    helpBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 28 },
    helpCard: { backgroundColor: c.cardBackground, borderRadius: 18, padding: 20, gap: 10, maxWidth: 420, width: '100%' },
    helpTitle: { fontSize: 16, fontWeight: '700', color: c.textPrimary },
    helpBody: { fontSize: 14, color: c.textSecondary, lineHeight: 20 },
    helpClose: { alignSelf: 'flex-end', paddingVertical: 8, paddingHorizontal: 12, marginTop: 4 },
    helpCloseText: { fontSize: 14, fontWeight: '700', color: c.primary },
});
