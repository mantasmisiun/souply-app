import { View, StyleSheet } from 'react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DateFilterButton } from '../DateFilterButton';
import { FilterPill } from '../FilterPill';
import { FilterDropdownModal } from '../FilterDropdownModal';
import { useShoppingSheet } from '../../state/shoppingSheet';
import { spacing } from '../../constants/theme';

/**
 * Shopping filters — the date chip + the status multi-check chip, PINNED at
 * the top of the Shopping screen (moved out of the dock sheet). State lives
 * in the shoppingSheet store, so the sheet and the trips list read the same
 * filter regardless of who renders the chips.
 */
export const STATUS_OPTIONS: { id: number; i18nKey: string; stages: number[] }[] = [
    { id: 1, i18nKey: 'smartBasket.statusForming', stages: [1, 2] },
    { id: 2, i18nKey: 'smartBasket.statusShopping', stages: [3] },
    { id: 3, i18nKey: 'smartBasket.statusReceipt', stages: [4] },
    { id: 4, i18nKey: 'smartBasket.statusStats', stages: [5] },
];

export function ShoppingFilterChips() {
    const { t } = useTranslation();
    const selectedDate = useShoppingSheet(s => s.selectedDate);
    const setSelectedDate = useShoppingSheet(s => s.setSelectedDate);
    const setSelectedStages = useShoppingSheet(s => s.setSelectedStages);
    const dotMap = useShoppingSheet(s => s.dotMap);
    const statusIds = useShoppingSheet(s => s.statusIds);
    const setStatusIds = useShoppingSheet(s => s.setStatusIds);
    const [statusOpen, setStatusOpen] = useState(false);

    useEffect(() => {
        if (statusIds == null) { setSelectedStages(null); return; }
        const stages = new Set<number>();
        for (const o of STATUS_OPTIONS) if (statusIds.has(o.id)) o.stages.forEach(st => stages.add(st));
        setSelectedStages(stages);
    }, [statusIds, setSelectedStages]);

    const statusLabel = statusIds == null
        ? t('smartBasket.statusAll')
        : STATUS_OPTIONS.filter(o => statusIds.has(o.id)).map(o => t(o.i18nKey)).join(', ');

    return (
        <View style={styles.row}>
            <DateFilterButton
                value={selectedDate}
                onChange={setSelectedDate}
                label={t('receipts.filterDate')}
                markedDates={dotMap}
            />
            <FilterPill
                label={statusLabel}
                active={statusIds != null}
                onPress={() => setStatusOpen(true)}
            />
            <FilterDropdownModal
                visible={statusOpen}
                title={t('smartBasket.statusTitle')}
                options={STATUS_OPTIONS.map(o => ({ id: o.id, label: t(o.i18nKey) }))}
                onClose={() => setStatusOpen(false)}
                config={{
                    mode: 'multi',
                    isChecked: (id) => statusIds?.has(id) ?? false,
                    allChecked: statusIds == null,
                    allLabel: t('smartBasket.statusAll'),
                    onToggle: (id) => {
                        const prev = useShoppingSheet.getState().statusIds;
                        let next: Set<number> | null;
                        if (prev == null) next = new Set([id]);
                        else {
                            next = new Set(prev);
                            if (next.has(id)) next.delete(id);
                            else next.add(id);
                            if (next.size === 0 || next.size === STATUS_OPTIONS.length) next = null;
                        }
                        setStatusIds(next);
                    },
                    onAll: () => setStatusIds(null),
                }}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap',
        gap: spacing.sm, paddingHorizontal: 16, paddingVertical: 8,
    },
});
