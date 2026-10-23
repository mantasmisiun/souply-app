import {
    View, Text, TouchableOpacity, ScrollView, StyleSheet, Alert,
} from 'react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { type AppTheme } from '../../constants/theme';
import { ShareInvitePanel } from '../ShareInvitePanel';
import { DockSection } from '../dock/DockSection';
import { UserAvatar } from '../UserAvatar';
import { getUserId } from '../../config/user';
import { type TripMemberInfo } from '../../utils/tripsApi';

/**
 * In-sheet invite pane (dock content swap, not a separate modal). The share/
 * invite SURFACE itself — flat QR (tap → fullscreen) · "Dalintis nuoroda"
 * button (native share — the raw link is never shown) · email/@handle chips —
 * is the app-wide ShareInvitePanel (also the recipe share pane), and THIS
 * look is the panel's canonical one. This pane adds what is invite-scope
 * only: the member roster (owner removes, member leaves) as the panel's
 * footer slot.
 *
 * Scope-agnostic: the caller injects `onSendInvite` / `onRemoveMember` so the
 * SAME pane powers trip sharing AND family-shopping (household) sharing.
 */
export function InvitePane({
    inviteUrl, members, onInvitesSent, onSendInvite, onRemoveMember, onLeave, colors,
}: {
    inviteUrl: string | null;
    members: TripMemberInfo[];
    onInvitesSent?: () => void;
    onSendInvite: (target: { email?: string; handle?: string }) => Promise<void>;
    onRemoveMember: (userId: string) => Promise<void>;
    /** When provided, a non-owner sees a leave control on their OWN card. */
    onLeave?: () => Promise<void>;
    colors: AppTheme;
}) {
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
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
                        try { await onRemoveMember(m.userId); onInvitesSent?.(); } catch { /* roster refresh shows truth */ }
                    },
                },
            ],
        );
    }, [onRemoveMember, onInvitesSent, t]);

    const confirmLeave = useCallback(() => {
        Alert.alert(
            t('invite.leaveTitle'),
            t('invite.leaveBody'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('invite.leaveConfirm'),
                    style: 'destructive',
                    onPress: async () => {
                        try { await onLeave?.(); onInvitesSent?.(); } catch { /* refresh shows truth */ }
                    },
                },
            ],
        );
    }, [onLeave, onInvitesSent, t]);

    return (
        <ShareInvitePanel
            url={inviteUrl}
            colors={colors}
            onSendInvite={onSendInvite}
            onInvitesSent={onInvitesSent}
            footer={
                /* member roster — same section chrome as the other sheets */
                <DockSection colors={colors} icon="people-outline" title={t('invite.membersTitle')}>
                    {members.length === 0 ? (
                        <Text style={styles.noMembers}>{t('invite.noMembers')}</Text>
                    ) : (
                        <ScrollView style={styles.membersScroll} nestedScrollEnabled>
                            {members.map(m => (
                                <View key={m.userId} style={styles.memberRow}>
                                    <UserAvatar name={m.label} color={m.avatarColor} size={30} />
                                    <Text style={styles.memberLabel} numberOfLines={1}>{m.label}</Text>
                                    {m.role === 'owner' && (
                                        <Text style={styles.ownerTag}>{t('invite.owner')}</Text>
                                    )}
                                    {iAmOwner && m.userId !== myId && m.role !== 'owner' && (
                                        <TouchableOpacity onPress={() => confirmRemove(m)} hitSlop={8}
                                            accessibilityLabel={t('invite.removeConfirm')}>
                                            <Ionicons name="person-remove-outline" size={20} color={colors.textMuted} />
                                        </TouchableOpacity>
                                    )}
                                    {onLeave && !iAmOwner && m.userId === myId && m.role !== 'owner' && (
                                        <TouchableOpacity onPress={confirmLeave} hitSlop={8}
                                            accessibilityLabel={t('invite.leaveConfirm')}>
                                            <Ionicons name="exit-outline" size={20} color="#E53E3E" />
                                        </TouchableOpacity>
                                    )}
                                </View>
                            ))}
                        </ScrollView>
                    )}
                </DockSection>
            }
        />
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    membersScroll: { maxHeight: 180 },
    memberRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 },
    memberLabel: { flex: 1, fontSize: 13.5, color: c.textPrimary },
    noMembers: { fontSize: 13.5, color: c.textSecondary, paddingVertical: 12 },
    ownerTag: { fontSize: 10.5, fontWeight: '700', color: c.textSecondary },
});
