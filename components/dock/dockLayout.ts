import { spacing } from '../../constants/theme';

/**
 * Shared geometry for every map DockedGlassSheet (the main dock and the
 * store-options dock). Keeping these in ONE place is what stops the two docks
 * from drifting apart: the bar row and the sheet content use the SAME horizontal
 * pad, so the title, the action cards and the section cards all keep an equal
 * gap to the sheet edge at every stage.
 */
export const DOCK_SIDE_PAD = 16;

/** Bar row base — horizontal pad matches the content so bar and cards align. */
export const dockBarBase = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing.md,
    paddingHorizontal: DOCK_SIDE_PAD,
};

/** Sheet content base — one column of action rows / section cards. */
export const dockContentBase = {
    paddingHorizontal: DOCK_SIDE_PAD,
    paddingTop: 22,
    gap: 14,
};
