import { StyleSheet, View } from 'react-native';
import { SHEET_PEEK, SHEET_CARD_SHADOW_RADIUS } from './sheetTokens';

/**
 * THE sheet-content inset — rendered by the sheet components themselves
 * (DockedGlassSheet, GlassSheet, GlassStageSheet), never by call sites, so no
 * sheet can forget it. It applies:
 *
 *   · horizontal: SHEET_PEEK — the same inset the bar row is laid out at, so
 *     content edges always line up with the sheet's title row;
 *   · top/bottom: SHEET_CARD_SHADOW_RADIUS — the sheet's scroll viewport is
 *     `overflow: 'hidden'`, and an unreserved edge slices the boxShadow halo
 *     off any SheetCard sitting flush against it.
 *
 * Sheet content must NOT re-declare any of this (no `paddingHorizontal:
 * spacing.lg` in sheet bodies). Every hand-rolled copy of these numbers is the
 * drift that put one sheet's content at 30px while another sat at 14px — a
 * call site owns only its own internal spacing (`gap`, per-row padding).
 */
export function SheetContent({ children, grow }: {
    children: React.ReactNode;
    /** Stretch to fill the scroll viewport (pane hosts — a short pane must
     *  still own the whole open sheet). Purely behavioural; never spacing. */
    grow?: boolean;
}) {
    return (
        <View style={[styles.content, grow && styles.grow]} testID="sheet-content">
            {children}
        </View>
    );
}

const styles = StyleSheet.create({
    content: {
        paddingHorizontal: SHEET_PEEK,
        paddingTop: SHEET_CARD_SHADOW_RADIUS,
        paddingBottom: SHEET_CARD_SHADOW_RADIUS,
    },
    grow: { flexGrow: 1 },
});
