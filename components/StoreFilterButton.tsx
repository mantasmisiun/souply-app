import { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../constants/theme';
import { FilterPill } from './FilterPill';
import { FilterDropdownModal, type FilterOption } from './FilterDropdownModal';
import { ChainLogoStrip } from './ChainLogoStrip';

/**
 * Reusable multi-select store picker (shared by the discounts + Analyze screens).
 * A pill trigger — the plain label while "All stores" is active, or the selected
 * chains' logo strip once narrowed — that drops the shared FilterDropdownModal
 * (multi mode) just below itself. Selection state is owned by the caller:
 *   selectedIds === null  → "All stores" (checkboxes render unchecked = narrowing)
 *   Set                   → the explicit checked subset
 * onToggle / onAll implement the one-tap-narrows + collapse-to-All rules.
 */
export function StoreFilterButton({
    storeOptions,
    selectedIds,
    onToggle,
    onAll,
    logoUrlById,
    label,
    allLabel,
    title,
}: {
    storeOptions: FilterOption[];
    /** null = all stores; otherwise the explicit checked subset. */
    selectedIds: Set<number> | null;
    onToggle: (id: number) => void;
    onAll: () => void;
    /** chainId → first-seen logo URL, for the selected-logos trigger. */
    logoUrlById: Map<number, string | null>;
    /** Pill label while "All stores" is active (e.g. "Stores"). */
    label: string;
    /** Dropdown "all" row label (e.g. "All stores"). */
    allLabel: string;
    /** Dropdown panel title. */
    title: string;
}) {
    const colors = useTheme();
    const [open, setOpen] = useState(false);

    const allSelected = !selectedIds || selectedIds.size >= storeOptions.length;
    const selectedLogos = allSelected
        ? []
        : [...selectedIds!].sort((a, b) => a - b).map((id) => ({ chainId: id, logoUrl: logoUrlById.get(id) ?? null }));

    return (
        <>
            {allSelected || selectedLogos.length === 0 ? (
                <FilterPill active={!allSelected} label={label} onPress={() => setOpen(true)} />
            ) : (
                <FilterPill
                    onPress={() => setOpen(true)}
                    style={{ borderColor: colors.primary }}
                    leading={<ChainLogoStrip chainLogos={selectedLogos} />}
                    trailing={<Ionicons name="chevron-down" size={14} color={colors.primary} />}
                />
            )}
            <FilterDropdownModal
                visible={open}
                title={title}
                options={storeOptions}
                onClose={() => setOpen(false)}
                config={{
                    mode: 'multi',
                    isChecked: (id) => !!selectedIds?.has(id),
                    allChecked: allSelected,
                    allLabel,
                    onToggle,
                    onAll,
                }}
            />
        </>
    );
}
