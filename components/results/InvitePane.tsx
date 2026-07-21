import {
    View, Text, TextInput, TouchableOpacity, Share, Modal, ScrollView, StyleSheet, Platform, Alert,
} from 'react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { type AppTheme, radius, spacing } from '../../constants/theme';
import { BrandedQR } from '../BrandedQR';
import { DockSection } from '../dock/DockSection';
import { MaterialProgress } from '../MaterialProgress';
import { getUserId } from '../../config/user';
import {
    sendAddressedTripInvite, removeTripMember, type TripMemberInfo,
} from '../../utils/tripsApi';

/**
 * In-sheet invite pane (dock content swap, not a separate modal):
 *   ‹ back · person-add · "Pakviesti"
 *   QR card (tap → fullscreen) + "Dalintis nuoroda" (native share — the raw
 *   link is never shown), then the SMART chip field (email or @handle; space/
 *   comma/enter commits a chip, × removes) + send, then the member roster.
 */
export function InvitePane({
    tripId, inviteUrl, members, onInvitesSent, colors,
}: {
    tripId: number;
    inviteUrl: string | null;
    members: TripMemberInfo[];
    onInvitesSent?: () => void;
    colors: AppTheme;
}) {
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [chips, setChips] = useState<string[]>([]);
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [sentCount, setSentCount] = useState<number | null>(null);
    const [qrFull, setQrFull] = useState(false);
    const [paneW, setPaneW] = useState(0);
    const [myId, setMyId] = useState<string | null>(null);
    useEffect(() => { getUserId().then(setMyId).catch(() => {}); }, []);
    // Everyone SEES the roster and can invite; only the OWNER removes.
    const iAmOwner = myId != null && members.some(m => m.userId === myId && m.role === 'owner');

    const confirmRemove = useCallback((m: TripMemberInfo) => {
        Alert.alert(
            t('invite.removeTitle'),
            t('invite.removeBody', { name: m.label }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('invite.removeConfirm'),
                    style: 'destructive',
                    onPress: async () => {
                        try { await removeTripMember(tripId, m.userId); onInvitesSent?.(); } catch { /* roster refresh shows truth */ }
                    },
                },
            ],
        );
    }, [tripId, onInvitesSent, t]);

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
        if (!chips.length || sending) return;
        setSending(true);
        try {
            for (const c of chips) {
                await sendAddressedTripInvite(tripId, c.startsWith('@') ? { handle: c } : { email: c });
            }
            setSentCount(chips.length);
            setChips([]);
            onInvitesSent?.();
        } catch {
            setSentCount(null);
        } finally {
            setSending(false);
        }
    }, [chips, sending, tripId, onInvitesSent]);

    const shareLink = useCallback(async () => {
        if (!inviteUrl) return;
        try { await Share.share({ message: inviteUrl, url: inviteUrl }); } catch { /* user closed */ }
    }, [inviteUrl]);

    return (
        <View
            style={styles.root}
            /* Capture the width ONCE at open (sheet is at the full detent) and
               keep the QR static — live width-tracking re-rasterized the SVG
               every drag frame and lagged badly. Mid-drag the glass may clip a
               few px at the sides; it settles perfectly. */
            onLayout={e => { const w = Math.round(e.nativeEvent.layout.width); if (paneW === 0 && w > 0) setPaneW(w); }}
        >
            {/* QR — full sheet width (no card), share button matching beneath */}
            <TouchableOpacity
                style={styles.qrWrap}
                onPress={() => inviteUrl && setQrFull(true)}
                activeOpacity={0.85}
            >
                {inviteUrl && paneW > 0
                    /* Card total = qr·1.08 (QRCodeStyled's 4%-per-side padding)
                       + 2×12 flat frame — solve for qr so the CARD's outer edge
                       exactly matches the button width. */
                    ? <BrandedQR flat value={inviteUrl} size={Math.max(120, Math.floor((paneW - 24) / 1.08))} />
                    : <MaterialProgress size="large" color={colors.primary} />}
            </TouchableOpacity>
            <TouchableOpacity
                style={[styles.shareBtn, !inviteUrl && { opacity: 0.5 }]}
                onPress={shareLink}
                disabled={!inviteUrl}
            >
                <Ionicons
                    name={Platform.OS === 'ios' ? 'share-outline' : 'share-social'}
                    size={17}
                    color={colors.onPrimary}
                />
                <Text style={styles.shareBtnText}>{t('invite.shareLink')}</Text>
            </TouchableOpacity>

            <View style={styles.orRow}>
                <View style={styles.orLine} /><Text style={styles.orText}>{t('invite.orDirect')}</Text><View style={styles.orLine} />
            </View>

            {/* smart chip field */}
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
                style={[styles.sendBtn, chips.length > 0 && styles.sendBtnActive]}
                onPress={send}
                disabled={!chips.length || sending}
            >
                {sending
                    ? <MaterialProgress size="small" color={colors.onPrimary} />
                    : <Text style={[styles.sendText, chips.length > 0 && styles.sendTextActive]}>
                        {sentCount != null
                            ? t('invite.sent', { count: sentCount })
                            : t('invite.send', { count: chips.length })}
                      </Text>}
            </TouchableOpacity>

            {/* member roster — same section chrome as the other sheets */}
            <DockSection colors={colors} icon="people-outline" title={t('invite.membersTitle')}>
                {members.length === 0 ? (
                    <Text style={styles.noMembers}>{t('invite.noMembers')}</Text>
                ) : (
                    <ScrollView style={styles.membersScroll} nestedScrollEnabled>
                        {members.map(m => (
                            <View key={m.userId} style={styles.memberRow}>
                                <View style={styles.avatar}>
                                    <Text style={styles.avatarText}>{m.label.replace(/^@/, '').charAt(0).toUpperCase()}</Text>
                                </View>
                                <Text style={styles.memberLabel} numberOfLines={1}>{m.label}</Text>
                                {m.role === 'owner' && (
                                    <Text style={styles.ownerTag}>{t('invite.owner')}</Text>
                                )}
                                {iAmOwner && m.userId !== myId && m.role !== 'owner' && (
                                    <TouchableOpacity onPress={() => confirmRemove(m)} hitSlop={8}
                                        accessibilityLabel={t('invite.removeConfirm')}>
                                        <Ionicons name="close-circle-outline" size={20} color={colors.textMuted} />
                                    </TouchableOpacity>
                                )}
                            </View>
                        ))}
                    </ScrollView>
                )}
            </DockSection>

            {/* fullscreen QR (brighter scanning) */}
            <Modal visible={qrFull} transparent animationType="fade" onRequestClose={() => setQrFull(false)}>
                <TouchableOpacity style={styles.qrBackdrop} activeOpacity={1} onPress={() => setQrFull(false)}>
                    <View style={styles.qrFullCard} onStartShouldSetResponder={() => true}>
                        {inviteUrl && <BrandedQR value={inviteUrl} size={260} />}
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

    membersScroll: { maxHeight: 180 },
    memberRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 },
    avatar: {
        width: 30, height: 30, borderRadius: 15, backgroundColor: c.primaryMuted,
        alignItems: 'center', justifyContent: 'center',
    },
    avatarText: { fontSize: 13, fontWeight: '800', color: c.primary },
    memberLabel: { flex: 1, fontSize: 13.5, color: c.textPrimary },
    noMembers: { fontSize: 13.5, color: c.textSecondary, paddingVertical: 12 },
    ownerTag: { fontSize: 10.5, fontWeight: '700', color: c.textSecondary },

    qrBackdrop: {
        flex: 1, backgroundColor: 'rgba(0,0,0,0.72)',
        alignItems: 'center', justifyContent: 'center', padding: spacing.lg,
    },
    qrFullCard: { backgroundColor: '#fff', borderRadius: radius.lg, padding: 20 },
});
