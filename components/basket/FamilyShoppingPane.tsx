import { View, Text, Switch, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { useEffect, useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, type AppTheme } from '../../constants/theme';
import { SheetCard } from '../SheetCard';
import { MaterialProgress } from '../MaterialProgress';
import { InvitePane } from '../results/InvitePane';
import { getUserId } from '../../config/user';
import { useShoppingSheet } from '../../state/shoppingSheet';
import {
    createOwnHousehold, fetchOwnHousehold, createHouseholdInviteUrl,
    leaveHousehold, removeHouseholdMember, sendAddressedHouseholdInvite,
    type TripMemberInfo,
} from '../../utils/tripsApi';

/**
 * Family-shopping PANE — an in-sheet content swap (NOT a separate sheet/screen):
 * the Shopping sheet renders this in place of its main body when the "Family
 * shopping" button is tapped. Header row (back + title) + the enable toggle +
 * the SAME invite surface as trip sharing (reused InvitePane). Toggling off (or
 * a non-owner's leave control) leaves/dissolves the household.
 */
export function FamilyShoppingPane({ onBack }: { onBack: () => void }) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { t } = useTranslation();

    const household = useShoppingSheet(s => s.household);
    const refreshTrips = useShoppingSheet(s => s.refreshTrips);
    const enabled = household != null;

    const [myId, setMyId] = useState<string | null>(null);
    useEffect(() => { void getUserId().then(setMyId); }, []);

    const [busy, setBusy] = useState(false);
    const [inviteUrl, setInviteUrl] = useState<string | null>(null);

    const refreshHousehold = async () => {
        const hh = await fetchOwnHousehold().catch(() => null);
        useShoppingSheet.getState().setHousehold(hh);
    };

    useEffect(() => {
        if (enabled && inviteUrl == null) { createHouseholdInviteUrl().then(setInviteUrl).catch(() => {}); }
        if (!enabled && inviteUrl != null) setInviteUrl(null);
    }, [enabled, inviteUrl]);

    const onToggle = async (on: boolean) => {
        if (busy) return;
        if (on && !household) {
            setBusy(true);
            try { await createOwnHousehold(); await refreshHousehold(); refreshTrips?.(); }
            catch { /* toggle snaps back on next render */ }
            finally { setBusy(false); }
        } else if (!on && household) {
            Alert.alert(t('family.disableTitle'), t('family.disableBody'), [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('family.disableConfirm'), style: 'destructive',
                    onPress: async () => {
                        setBusy(true);
                        try { await leaveHousehold(); await refreshHousehold(); refreshTrips?.(); }
                        catch { /* refresh shows truth */ }
                        finally { setBusy(false); }
                    },
                },
            ]);
        }
    };

    const members: TripMemberInfo[] = (household?.members ?? []).map(m => ({
        userId: m.userId,
        role: m.role === 'owner' ? 'owner' : 'member',
        label: m.label ?? (m.userId === myId ? t('family.you') : t('family.member')),
        avatarColor: m.avatarColor ?? null,
    }));

    return (
        <>
            <View style={styles.headerRow}>
                <TouchableOpacity onPress={onBack} hitSlop={10} accessibilityLabel={t('common.back')}>
                    <Ionicons name="chevron-back" size={26} color={colors.primary} />
                </TouchableOpacity>
                <Text style={styles.title}>{t('family.sheetTitle')}</Text>
            </View>

            <SheetCard>
                <View style={styles.row}>
                    <View style={styles.rowIcon}>
                        <Ionicons name="home" size={20} color={colors.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.rowTitle}>{t('smartBasket.familyTitle')}</Text>
                        <Text style={styles.rowSub}>
                            {enabled
                                ? t('trips.householdMembers', { count: household!.members.length })
                                : t('family.disabledHelp')}
                        </Text>
                    </View>
                    {busy
                        ? <MaterialProgress size="small" color={colors.primary} />
                        : (
                            <Switch
                                value={enabled}
                                onValueChange={(v) => { void onToggle(v); }}
                                trackColor={{ false: colors.border, true: colors.primary }}
                                thumbColor={colors.onPrimary}
                            />
                        )}
                </View>
            </SheetCard>

            {enabled && (
                <InvitePane
                    inviteUrl={inviteUrl}
                    members={members}
                    colors={colors}
                    onSendInvite={(target) => sendAddressedHouseholdInvite(target)}
                    onRemoveMember={(userId) => removeHouseholdMember(userId)}
                    onLeave={async () => { await leaveHousehold(); await refreshHousehold(); refreshTrips?.(); }}
                    onInvitesSent={() => { void refreshHousehold(); refreshTrips?.(); }}
                />
            )}
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingTop: spacing.xs, paddingBottom: spacing.xs },
    title: { fontSize: 22, fontWeight: '700', color: c.textPrimary },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 10 },
    rowIcon: {
        width: 40, height: 40, borderRadius: 20,
        backgroundColor: c.primaryMuted ?? c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center',
    },
    rowTitle: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
    rowSub: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
});
