import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '../../constants/theme';
import { SwipeQueue, type SwipeQueueProps } from './SwipeQueue';

/**
 * Full-screen overlay host for <SwipeQueue> — the SINGLE presentation shared by
 * BOTH swipe flows on the trip receipts screen: the mandatory post-scan review
 * (`voluntary={false}`) and the voluntary identify-queue (`voluntary`).
 *
 * It covers the host screen's own chrome (absolute fill) and lets the queue draw
 * its own top bar via `renderHeader`, so the two flows show the IDENTICAL
 * ScreenNavBar ("Prekių atpažinimas") instead of one inheriting the trip chrome.
 * Change the queue's title bar in one place and both flows follow.
 */
export function SwipeQueueOverlay(
    props: Pick<SwipeQueueProps, 'receiptIds' | 'voluntary' | 'onAllDone' | 'onExit'>,
) {
    const colors = useTheme();
    const overlay = useMemo(
        () => [StyleSheet.absoluteFill, { backgroundColor: colors.pageBackground, zIndex: 20 }],
        [colors.pageBackground],
    );
    return (
        <View style={overlay}>
            <SwipeQueue {...props} renderHeader />
        </View>
    );
}
