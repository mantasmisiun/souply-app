import React, { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import {
    View, Text, TextInput, TouchableOpacity, Share, Modal, StyleSheet, Platform,
    ToastAndroid, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import { captureRef } from 'react-native-view-shot';
import { useTranslation } from 'react-i18next';
import { BrandedQR } from './BrandedQR';
import { MaterialProgress } from './MaterialProgress';
import { useTheme, radius, spacing, type AppTheme } from '../constants/theme';

export interface InviteTarget { email?: string; handle?: string }

interface Props {
    /** The share/invite URL — encoded in the QR. null while the caller is
     *  still minting it → QR spinner, buttons disabled. The raw link is
     *  NEVER shown: sharing goes through the Dalintis button only. */
    url: string | null;
    /** Override the primary Dalintis action. Default shares the raw link via
     *  the native sheet; the recipe pane passes its QR-image share instead. */
    onShare?: () => void | Promise<void>;
    /** Source a QR PNG for the download action — providing this ADDS the
     *  "Download QR" button (the recipe pane's ONE allowed extra over the
     *  map dock's invite look; the trip/family panes omit it and stay
     *  button-free). When it comes back empty the panel captures its own
     *  rendered QR, so the button always works once it exists. */
    getQrFile?: () => Promise<string | null>;
    /** Addressed invite (email or @handle). Three states:
     *    function  — the row is live (trip + household endpoints exist).
     *    null      — the row RENDERS identically but Send stays disabled:
     *                the surface must LOOK the same while its backend
     *                endpoint doesn't exist yet (recipes — see
     *                TemplateSharePane). Never fakes a send.
     *    undefined — no row at all. */
    onSendInvite?: ((target: InviteTarget) => Promise<void>) | null;
    /** Fired after a batch of addressed invites lands (roster refresh). */
    onInvitesSent?: () => void;
    /** Slot between the QR and the share button — the recipe pane's savings line. */
    belowQr?: ReactNode;
    /** Slot after everything — the trip/family member roster. */
    footer?: ReactNode;
    /** Theme override (the map surface passes its own resolved colors). */
    colors?: AppTheme;
}

/**
 * ShareInvitePanel — THE share/invite surface, one layout for all three uses
 * (trip Pakviesti, family shopping, recipe share). The CANONICAL look is the
 * map dock's invite pane, verbatim:
 *
 *   · flat full-width branded QR — no card, no border, no shadow
 *     (tap → fullscreen for brighter scanning)
 *   · "Dalintis nuoroda" — a BUTTON through the native sheet; the raw link
 *     is never exposed on screen
 *   · invite by email / @handle (smart chip field + send)
 *
 * The ONLY sanctioned visual addition is the recipe pane's "Download QR"
 * button (rides the `getQrFile` prop). Everything else that differs stays
 * with the caller via props/slots: what the link is, what Dalintis actually
 * shares, extra rows above/below (visibility slider, savings, member
 * roster). The panel owns the shared look and its transient state (chips,
 * flashes, download progress), so unmounting resets it free.
 */
export function ShareInvitePanel({
    url, onShare, getQrFile, onSendInvite, onInvitesSent, belowQr, footer, colors: colorsProp,
}: Props) {
    const themed = useTheme();
    const colors = colorsProp ?? themed;
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const [savedFlash, setSavedFlash] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [qrFull, setQrFull] = useState(false);
    /* Capture the width ONCE at open (sheet is at the full detent) and keep
       the QR static — live width-tracking re-rasterized the SVG every drag
       frame and lagged badly. Mid-drag the glass may clip a few px at the
       sides; it settles perfectly. */
    const [paneW, setPaneW] = useState(0);

    // Capture target for the download fallback — wraps exactly the QR.
    // collapsable={false} keeps the view a real native node on Android, or
    // captureRef has nothing to rasterise.
    const qrShotRef = useRef<View>(null);

    const handleShare = useCallback(async () => {
        if (!url) return;
        if (onShare) { await onShare(); return; }
        try { await Share.share({ message: url, url }); } catch { /* user closed */ }
    }, [url, onShare]);

    // One-tap download: save a QR PNG straight to the device gallery
    // (write-only Photos permission on iOS). Caller-provided file first
    // (server-branded PNG), else a capture of the QR on screen.
    const handleDownload = useCallback(async () => {
        if (downloading || !url || !getQrFile) return;
        setDownloading(true);
        try {
            const perm = await MediaLibrary.requestPermissionsAsync(true);
            if (!perm.granted) {
                Alert.alert(t('invite.qrPermTitle'), t('invite.qrPermBody'));
                return;
            }
            let file: string | null = null;
            try { file = await getQrFile(); } catch { file = null; }
            if (!file && qrShotRef.current) {
                try {
                    file = await captureRef(qrShotRef.current, { format: 'png', result: 'tmpfile', quality: 1 });
                } catch { file = null; }
            }
            if (!file) {
                Alert.alert(t('invite.qrSaveError'));
                return;
            }
            await MediaLibrary.saveToLibraryAsync(file);
            if (Platform.OS === 'android') {
                ToastAndroid.show(t('invite.qrSaved'), ToastAndroid.SHORT);
            } else {
                setSavedFlash(true);
                setTimeout(() => setSavedFlash(false), 1600);
            }
        } catch {
            Alert.alert(t('invite.qrSaveError'));
        } finally {
            setDownloading(false);
        }
    }, [downloading, url, getQrFile, t]);

    // ── Addressed-invite chip field (email or @handle) ────────────────────
    // Rendered whenever onSendInvite is DECLARED (function or null); only a
    // real function makes Send actionable — see the Props doc.
    const canSend = typeof onSendInvite === 'function';
    const [chips, setChips] = useState<string[]>([]);
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [sentCount, setSentCount] = useState<number | null>(null);

    const isValidTarget = (v: string) =>
        /^@?[a-z0-9_.]{3,}$/i.test(v) && v.startsWith('@')
            ? true
            : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

    const commitDraft = useCallback((raw?: string) => {
        const v = (raw ?? draft).trim().replace(/[,\s]+$/, '');
        if (!v) return;
        if (!isValidTarget(v)) return; // keep in field until it parses
        setChips(prev => (prev.includes(v.toLowerCase()) ? prev : [...prev, v.toLowerCase()]));
        setDraft('');
        setSentCount(null);
    }, [draft]);

    const onChangeDraft = (v: string) => {
        // gmail behavior: space/comma commits the pending chip
        if (/[ ,]$/.test(v)) commitDraft(v);
        else { setDraft(v); setSentCount(null); }
    };

    const removeChip = (c: string) => setChips(prev => prev.filter(x => x !== c));

    const send = useCallback(async () => {
        if (!canSend || !onSendInvite || !chips.length || sending) return;
        setSending(true);
        try {
            for (const c of chips) {
                await onSendInvite(c.startsWith('@') ? { handle: c } : { email: c });
            }
            setSentCount(chips.length);
            setChips([]);
            onInvitesSent?.();
        } catch {
            setSentCount(null);
        } finally {
            setSending(false);
        }
    }, [canSend, chips, sending, onSendInvite, onInvitesSent]);

    return (
        <View
            style={styles.root}
            onLayout={e => { const w = Math.round(e.nativeEvent.layout.width); if (paneW === 0 && w > 0) setPaneW(w); }}
        >
            {/* QR — full sheet width, FLAT (no card/border/shadow — the map
                dock's presentation); tap → fullscreen for brighter scanning. */}
            <TouchableOpacity
                style={styles.qrWrap}
                onPress={() => url && setQrFull(true)}
                activeOpacity={0.85}
            >
                {url && paneW > 0
                    ? (
                        <View ref={qrShotRef} collapsable={false}>
                            {/* Card total = qr·1.08 (QRCodeStyled's 4%-per-side
                                padding) + 2×12 flat frame. Capped so it doesn't
                                dominate a wide sheet — a scan-sized code, centred. */}
                            <BrandedQR flat value={url} size={Math.min(210, Math.max(120, Math.floor((paneW - 24) / 1.08)))} />
                        </View>
                    )
                    : <MaterialProgress size="large" color={colors.primary} />}
            </TouchableOpacity>

            {belowQr}

            {/* Dalintis — the ONLY way the link leaves the pane (native sheet);
                the raw URL is never printed on screen. */}
            <TouchableOpacity
                style={[styles.shareBtn, !url && styles.disabled]}
                onPress={handleShare}
                disabled={!url}
            >
                <Ionicons
                    name={Platform.OS === 'ios' ? 'share-outline' : 'share-social'}
                    size={17}
                    color={colors.onPrimary}
                />
                <Text style={styles.shareBtnText}>{t('invite.shareLink')}</Text>
            </TouchableOpacity>

            {/* Download QR — recipe-only extra (see getQrFile). */}
            {getQrFile && (
                <TouchableOpacity
                    style={[styles.downloadBtn, !url && styles.disabled]}
                    onPress={handleDownload}
                    disabled={!url || downloading}
                    activeOpacity={0.8}
                >
                    {downloading ? (
                        <MaterialProgress color={colors.primary} />
                    ) : (
                        <>
                            <Ionicons name="download-outline" size={17} color={colors.primary} />
                            <Text style={styles.downloadBtnText}>{t('invite.downloadQr')}</Text>
                        </>
                    )}
                </TouchableOpacity>
            )}
            {Platform.OS !== 'android' && savedFlash && (
                <Text style={styles.flashToast}>{t('invite.qrSaved')}</Text>
            )}

            {/* Invite by email / @handle. */}
            {onSendInvite !== undefined && (
                <>
                    <View style={styles.orRow}>
                        <View style={styles.orLine} />
                        <Text style={styles.orText}>{t('invite.orDirect')}</Text>
                        <View style={styles.orLine} />
                    </View>

                    {/* smart chip field: space/comma/enter commits, × removes */}
                    <View style={styles.field}>
                        {chips.map(c => (
                            <View key={c} style={[styles.chip, c.startsWith('@') && styles.chipUser]}>
                                <Text style={[styles.chipText, c.startsWith('@') && styles.chipTextUser]} numberOfLines={1}>{c}</Text>
                                <TouchableOpacity onPress={() => removeChip(c)} hitSlop={6}>
                                    <Ionicons name="close" size={13} color={colors.textSecondary} />
                                </TouchableOpacity>
                            </View>
                        ))}
                        <TextInput
                            style={styles.input}
                            value={draft}
                            onChangeText={onChangeDraft}
                            onSubmitEditing={() => commitDraft()}
                            onBlur={() => commitDraft()}
                            placeholder={chips.length ? '' : t('invite.fieldPlaceholder')}
                            placeholderTextColor={colors.textMuted}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="email-address"
                            returnKeyType="done"
                        />
                    </View>
                    <TouchableOpacity
                        style={[styles.sendBtn, canSend && chips.length > 0 && styles.sendBtnActive]}
                        onPress={send}
                        disabled={!canSend || !chips.length || sending}
                    >
                        {sending
                            ? <MaterialProgress size="small" color={colors.onPrimary} />
                            : <Text style={[styles.sendText, canSend && chips.length > 0 && styles.sendTextActive]}>
                                {sentCount != null
                                    ? t('invite.sent', { count: sentCount })
                                    : t('invite.send', { count: chips.length })}
                              </Text>}
                    </TouchableOpacity>
                </>
            )}

            {footer}

            {/* fullscreen QR (brighter scanning) */}
            <Modal visible={qrFull} transparent animationType="fade" onRequestClose={() => setQrFull(false)}>
                <TouchableOpacity style={styles.qrBackdrop} activeOpacity={1} onPress={() => setQrFull(false)}>
                    <View style={styles.qrFullCard} onStartShouldSetResponder={() => true}>
                        {url && <BrandedQR value={url} size={260} />}
                    </View>
                </TouchableOpacity>
            </Modal>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    root: { gap: 12 },
    qrWrap: { alignItems: 'center', justifyContent: 'center', minHeight: 120 },
    shareBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        alignSelf: 'stretch', backgroundColor: c.primary, borderRadius: radius.md,
        paddingVertical: 11,
    },
    shareBtnText: { color: c.onPrimary, fontSize: 14, fontWeight: '700' },
    // Download = the share button's outline twin (same radius/height family).
    downloadBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        alignSelf: 'stretch', borderRadius: radius.md, paddingVertical: 10,
        borderWidth: 1, borderColor: c.primary,
    },
    downloadBtnText: { color: c.primary, fontSize: 14, fontWeight: '700' },
    flashToast: {
        alignSelf: 'center', backgroundColor: c.textPrimary,
        color: c.cardBackground, fontSize: 12, fontWeight: '600',
        paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, overflow: 'hidden',
    },
    disabled: { opacity: 0.5 },

    orRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    orLine: { flex: 1, height: 1, backgroundColor: c.border },
    orText: { fontSize: 11, color: c.textSecondary },

    field: {
        flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center',
        backgroundColor: c.cardBackground, borderWidth: 1, borderColor: c.border,
        borderRadius: radius.md, padding: 8, minHeight: 44,
    },
    chip: {
        flexDirection: 'row', alignItems: 'center', gap: 5,
        backgroundColor: c.surfaceMuted ?? c.pageBackground,
        borderRadius: 999, paddingVertical: 4, paddingLeft: 10, paddingRight: 6,
        maxWidth: 220,
    },
    chipUser: { backgroundColor: c.primaryMuted },
    chipText: { fontSize: 12.5, fontWeight: '600', color: c.textPrimary, flexShrink: 1 },
    chipTextUser: { color: c.primary },
    input: { flexGrow: 1, minWidth: 120, fontSize: 13.5, color: c.textPrimary, padding: 2 },

    sendBtn: {
        alignItems: 'center', justifyContent: 'center', borderRadius: radius.md,
        paddingVertical: 11, backgroundColor: c.surfaceMuted ?? c.pageBackground,
    },
    sendBtnActive: { backgroundColor: c.primary },
    sendText: { fontSize: 14, fontWeight: '700', color: c.textSecondary },
    sendTextActive: { color: c.onPrimary },

    qrBackdrop: {
        flex: 1, backgroundColor: 'rgba(0,0,0,0.72)',
        alignItems: 'center', justifyContent: 'center', padding: spacing.lg,
    },
    qrFullCard: { backgroundColor: '#fff', borderRadius: radius.lg, padding: 20 },
});
