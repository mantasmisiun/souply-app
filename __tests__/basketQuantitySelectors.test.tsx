import React from 'react';
import { render, act } from '@testing-library/react-native';
import {
    useBasketQuantities,
    useBasketItemCount,
    useBasketProductQuantity,
} from '../hooks/useBasketQuantities';
import { useBasketQuantitiesStore, __resetBasketQuantityTimers } from '../state/basketQuantities';
import { useBasketSession } from '../state/basketSession';

/**
 * Perf audit finding 8: `useBasketQuantities` used to subscribe to the WHOLE
 * quantities map (whose identity every ± tap replaces) and to basketRev, so
 * one tap re-rendered every consumer screen roughly twice — above the
 * per-card scalar subscriptions built precisely to avoid that.
 *
 * Pinned here:
 *   1. a quantity write does NOT re-render a screen using the hook;
 *   2. a basketRev bump triggers a refresh WITHOUT re-rendering it;
 *   3. the scalar selectors re-render only when their own value changes.
 */

const store = () => useBasketQuantitiesStore.getState();
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

let fetchMock: jest.Mock;

let screenRenders = 0;
let hookApi: ReturnType<typeof useBasketQuantities> | null = null;
function ScreenProbe() {
    screenRenders++;
    hookApi = useBasketQuantities();
    return null;
}

let countRenders = 0;
let lastCount = -1;
function CountProbe() {
    countRenders++;
    lastCount = useBasketItemCount();
    return null;
}

const cardRenders: Record<number, number> = {};
const cardValues: Record<number, number> = {};
function CardProbe({ pid }: { pid: number }) {
    cardRenders[pid] = (cardRenders[pid] ?? 0) + 1;
    cardValues[pid] = useBasketProductQuantity(pid);
    return null;
}

beforeEach(() => {
    jest.useFakeTimers();
    __resetBasketQuantityTimers();
    screenRenders = 0; countRenders = 0; lastCount = -1; hookApi = null;
    for (const k of Object.keys(cardRenders)) delete cardRenders[Number(k)];
    // Session targets basket 7; the store is already bound to it so the
    // hook's mount effect is a no-op (no clear/refetch churn mid-test).
    useBasketSession.setState({ target: { kind: 'basket', basketId: 7, isFamily: false } as any, basketRev: 0 });
    useBasketQuantitiesStore.setState({ basketId: 7, quantities: {}, server: {}, pending: {}, seq: 0 });
    // Refreshes resolve as failures → no state write, no act() noise; the
    // CALL is still observable for the bump-triggers-refresh assertion.
    fetchMock = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    (global as any).fetch = fetchMock;
});
afterEach(() => {
    __resetBasketQuantityTimers();
    jest.useRealTimers();
});

test('a ± tap re-renders ONLY its own product subscriber, never the screen', async () => {
    render(
        <>
            <ScreenProbe />
            <CardProbe pid={42} />
            <CardProbe pid={43} />
            <CountProbe />
        </>,
    );
    await act(tick);
    const screen0 = screenRenders;
    const card42 = cardRenders[42];
    const card43 = cardRenders[43];
    const count0 = countRenders;

    // First unit of product 42: its card and the item count change.
    act(() => { store().commit(42, 1); });
    expect(cardRenders[42]).toBe(card42 + 1);
    expect(cardValues[42]).toBe(1);
    expect(cardRenders[43]).toBe(card43);        // other card untouched
    expect(countRenders).toBe(count0 + 1);       // 0 → 1 products
    expect(lastCount).toBe(1);
    expect(screenRenders).toBe(screen0);         // THE regression: screen must not render

    // Second unit: same product count, so only the card renders.
    act(() => { store().commit(42, 2); });
    expect(cardRenders[42]).toBe(card42 + 2);
    expect(cardValues[42]).toBe(2);
    expect(countRenders).toBe(count0 + 1);       // count unchanged → no render
    expect(cardRenders[43]).toBe(card43);
    expect(screenRenders).toBe(screen0);
});

test('a basketRev bump refreshes quantities WITHOUT re-rendering the screen', async () => {
    render(<ScreenProbe />);
    await act(tick);
    const refreshCalls = () =>
        fetchMock.mock.calls.filter(c => String(c[0]).includes('/api/baskets/7/quantities')).length;
    const baselineRefreshes = refreshCalls();     // the mount refresh
    expect(baselineRefreshes).toBeGreaterThanOrEqual(1);
    const screen0 = screenRenders;

    await act(async () => {
        useBasketSession.getState().bumpBasketRev();
        await tick();
    });

    expect(refreshCalls()).toBe(baselineRefreshes + 1);  // transient subscription fired
    expect(screenRenders).toBe(screen0);                 // ...without a render
});

test('the hook exposes stable actions and the target basket id', async () => {
    render(<ScreenProbe />);
    await act(tick);
    expect(hookApi?.basketId).toBe(7);
    const before = hookApi;
    act(() => { store().commit(42, 1); });
    // No re-render happened, so the same object (and thus the same stable
    // callbacks) is still what the screen holds.
    expect(hookApi).toBe(before);
    expect(typeof hookApi?.commit).toBe('function');
    expect(typeof hookApi?.refresh).toBe('function');
});
