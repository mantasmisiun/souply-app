import React from 'react';
import { render, act } from '@testing-library/react-native';
import { useReceiptQueueStore } from '../state/receiptQueueStore';
import { useReceiptQueueRunner } from '../hooks/useReceiptQueueRunner';
import { useNetworkStatus } from '../state/networkStatus';

/**
 * Perf audit finding 2: `useReceiptQueueRunner` runs inside RootLayout — above
 * the Stack and every provider — and used to subscribe to the WHOLE queue
 * items array. `updateProgress` replaced that array's identity on every
 * matched product line, so a 50-line receipt re-rendered the entire app root
 * 50+ times while the user browsed elsewhere.
 *
 * Pinned here:
 *   1. updateProgress BAILS (no set, same array identity) when
 *      progress/done/total are unchanged — the templateAddState.setLeaveInstant
 *      guard pattern;
 *   2. real progress ticks do NOT re-render a host of the runner hook (it
 *      subscribes to derived hasPending/hasProcessing booleans now);
 *   3. the runner still starts processing when a pending item appears and
 *      nothing is running — the semantics the array subscription provided.
 */

jest.mock('../services/receiptProcessingService', () => {
    class ProcessingError extends Error {
        reason: string;
        constructor(message: string, reason = 'unknown') { super(message); this.reason = reason; }
    }
    class NetworkError extends Error {}
    return {
        ProcessingError,
        NetworkError,
        // Never settles: items under test stay in "processing" deterministically.
        processOneReceipt: jest.fn(() => new Promise(() => {})),
    };
});


const { processOneReceipt } = require('../services/receiptProcessingService');

const store = () => useReceiptQueueStore.getState();

let runnerRenders = 0;
function RunnerProbe() {
    runnerRenders++;
    useReceiptQueueRunner();
    return null;
}

beforeEach(() => {
    runnerRenders = 0;
    (processOneReceipt as jest.Mock).mockClear();
    useNetworkStatus.setState({ isOnline: true });
    // initialized: true → the mount-time initialize() is a no-op (no
    // AsyncStorage restore churn mid-test).
    useReceiptQueueStore.setState({
        items: [], recentIds: [], lastCompleted: null, lastCompletedAt: null, initialized: true,
    });
});

describe('updateProgress no-op bail (store level)', () => {
    const seedProcessing = () => {
        store().addItems([{ uris: ['file:///a.jpg'] }]);
        const id = store().items[0].id;
        store().markProcessing(id, 'Nuskaitoma...');
        return id;
    };

    test('identical progress/done/total → no set, SAME items identity', () => {
        const id = seedProcessing();
        store().updateProgress(id, '3/8 prekės', 3, 8);
        const after = store().items;
        store().updateProgress(id, '3/8 prekės', 3, 8);
        expect(store().items).toBe(after);
    });

    test('a changed field still commits (new identity, values land)', () => {
        const id = seedProcessing();
        store().updateProgress(id, '3/8 prekės', 3, 8);
        const before = store().items;
        store().updateProgress(id, '4/8 prekės', 4, 8);
        expect(store().items).not.toBe(before);
        expect(store().items[0]).toMatchObject({ progress: '4/8 prekės', progressDone: 4, progressTotal: 8 });
    });

    test('unknown id → no set, SAME items identity', () => {
        seedProcessing();
        const before = store().items;
        store().updateProgress('no-such-id', '1/2 prekės', 1, 2);
        expect(store().items).toBe(before);
    });
});

describe('runner derived-boolean subscription', () => {
    test('progress ticks do not re-render the runner host', async () => {
        store().addItems([{ uris: ['file:///a.jpg'] }]);
        const id = store().items[0].id;

        render(<RunnerProbe />);
        // Let the mount effects run: pending → processing via processNext.
        await act(async () => {});
        expect(store().items[0].status).toBe('processing');
        const rendersAfterStart = runnerRenders;

        // A 50-line receipt's worth of matcher ticks — every one changes the
        // progress text, so each commits a NEW items array. The runner host
        // must not re-render once: hasPending/hasProcessing never flip.
        act(() => {
            for (let i = 1; i <= 50; i++) {
                store().updateProgress(id, `${i}/50 prekės`, i, 50);
            }
        });
        expect(store().items[0].progressDone).toBe(50);
        expect(runnerRenders).toBe(rendersAfterStart);
    });

    test('a pending item appearing while nothing runs still starts processing', async () => {
        render(<RunnerProbe />);
        await act(async () => {});
        expect(processOneReceipt).not.toHaveBeenCalled();

        act(() => { store().addItems([{ uris: ['file:///b.jpg'] }]); });
        await act(async () => {});

        expect(store().items[0].status).toBe('processing');
        expect(processOneReceipt).toHaveBeenCalledTimes(1);
    });
});
