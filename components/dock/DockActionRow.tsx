import React, { type ComponentProps } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { DockActionCard } from './DockActionCard';
import { spacing, type AppTheme } from '../../constants/theme';

/**
 * A row of dock action cards — the pair of big buttons every sheet opens with.
 *
 * The row itself used to be re-declared in each sheet (`actionRow:
 * { flexDirection: 'row', gap: spacing.md }` in four files, plus a `bigBtnRow`
 * that means the same thing), so the shared look depended on everyone remembering
 * to write the same style. Now the row is part of the component: a sheet passes
 * what the buttons DO and nothing about how they sit.
 *
 * `DockActionCard` already carries its own `SheetCard` background, so a sheet must
 * NOT wrap these in another card — that nests a card inside a card and doubles
 * the surface.
 */

/** Everything a card takes except the theme, which the row supplies. */
export type DockAction = Omit<ComponentProps<typeof DockActionCard>, 'colors'> & {
    /** Optional stable key; the title is used when omitted. */
    key?: string;
};

export function DockActionRow({ colors, actions, gap = spacing.md, style }: {
    colors: AppTheme;
    /**
     * The buttons, left to right. Falsy entries are skipped so a conditional
     * action can be written inline — `isUploader && { … }` — instead of forcing
     * the caller back into JSX branching.
     */
    actions: (DockAction | null | false | undefined)[];
    /** Override the gap only when a surface genuinely differs (the map docks sit
     *  on a wider grid). Defaults to the standard sheet gap. */
    gap?: number;
    style?: StyleProp<ViewStyle>;
}) {
    const live = actions.filter((a): a is DockAction => Boolean(a));
    if (live.length === 0) return null;
    return (
        <View style={[{ flexDirection: 'row', gap }, style]}>
            {live.map(({ key, ...card }) => (
                <DockActionCard key={key ?? card.title} colors={colors} {...card} />
            ))}
        </View>
    );
}
