import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { Easing, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import {
    Atlas, Canvas, Circle, Group, Image as SkiaImage, Text as SkiaText,
    matchFont, useImage, useRSXformBuffer, useRectBuffer, useTexture,
} from '@shopify/react-native-skia';
import type { OverlaySingleSpec, ProjectionFrame } from './MapPillOverlay';

/**
 * iOS directory SINGLES rendered as ONE Skia Atlas draw call.
 *
 * The view-based singles layer (a mounted <Image> per store) was the map's
 * remaining perf ceiling: a pan/zoom commit into a dense area mounted dozens
 * of views in one synchronous JS render (the "wait a couple of seconds before
 * things glue" stall — queued region events starved the overlay's projection
 * feed), and every mounted dot ran its own animated-style worklet per frame.
 *
 * Here NOTHING mounts, ever: a fixed pool of sprite slots lives in one shared
 * value; a commit is a plain array write (microseconds of JS), and per frame
 * exactly TWO worklets run (the transform buffer + the sprite-rect buffer)
 * regardless of how many dots are on screen. The GPU draws the whole layer as
 * a single textured-quad batch.
 *
 * The sprite sheet holds the five chain pin logos plus a lazily-grown set of
 * letter-chip fallbacks for chains without a bundled asset; it re-bakes only
 * when a never-seen-before fallback chain appears (typically never).
 *
 * This module imports Skia at top level — it must only be require()'d behind
 * the guarded probe in MapPillOverlay so a binary without the native module
 * falls back to the view-based singles instead of crashing.
 */

const MAX_SLOTS = 128;           // MAX_SINGLES (80) + retention headroom
const SPRITE = 108;              // 3x of the 36dp on-screen dot → retina-crisp
const DOT = 36;                  // on-screen size (matches styles.singleLogo)

// Flat slot layout inside ONE shared value (plain numbers only — cheap to
// serialize to the UI runtime and pure arithmetic to read in the worklet).
const STRIDE = 6;
const F_ALIVE = 0;
const F_SPRITE = 1;
const F_FLNG = 2;   // flight-from longitude
const F_FMY = 3;    // flight-from mercator-y
const F_TLNG = 4;   // target longitude
const F_TMY = 5;    // target mercator-y

const RAD = Math.PI / 180;
const mercY = (lat: number): number => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

// Static logo sprites: sheet slots 0..4 = chain pins 1..5 (same assets the
// view path used via chainPinImage). Loaded as SkImages with fixed hooks.
const PIN_ASSETS: number[] = [
    require('../../assets/chain-logos/pin_1.png'),
    require('../../assets/chain-logos/pin_2.png'),
    require('../../assets/chain-logos/pin_3.png'),
    require('../../assets/chain-logos/pin_4.png'),
    require('../../assets/chain-logos/pin_5.png'),
];
const spriteIndexByAsset = new Map<number, number>(PIN_ASSETS.map((a, i) => [a, i]));

/** Fallback letter-chip identity → its (stable, append-only) sheet slot. */
const fallbackKey = (s: OverlaySingleSpec) => `${s.fallbackColor}|${s.fallbackLetter}`;

export const SkiaSinglesLayer = React.memo(function SkiaSinglesLayer({
    singles,
    frame,
}: {
    singles: OverlaySingleSpec[];
    frame: SharedValue<ProjectionFrame>;
}) {
    // ── Sprite sheet ─────────────────────────────────────────────────────────
    const img0 = useImage(PIN_ASSETS[0]);
    const img1 = useImage(PIN_ASSETS[1]);
    const img2 = useImage(PIN_ASSETS[2]);
    const img3 = useImage(PIN_ASSETS[3]);
    const img4 = useImage(PIN_ASSETS[4]);
    const logoImages = [img0, img1, img2, img3, img4];

    // Append-only list of fallback chips (keeps every previously issued sprite
    // index valid). Grows via state so the texture re-bakes when a new chain
    // without a logo shows up.
    const [fallbacks, setFallbacks] = useState<{ key: string; color: string; letter: string }[]>([]);
    const fallbackIdxRef = useRef(new Map<string, number>());
    useEffect(() => {
        const fresh = singles.filter(s => s.logo == null && !fallbackIdxRef.current.has(fallbackKey(s)));
        if (fresh.length === 0) return;
        const add: { key: string; color: string; letter: string }[] = [];
        for (const s of fresh) {
            const key = fallbackKey(s);
            if (fallbackIdxRef.current.has(key)) continue;
            fallbackIdxRef.current.set(key, PIN_ASSETS.length + fallbackIdxRef.current.size);
            add.push({ key, color: s.fallbackColor, letter: s.fallbackLetter });
        }
        if (add.length) setFallbacks(prev => [...prev, ...add]);
    }, [singles]);

    const font = useMemo(
        () => matchFont({ fontFamily: 'Helvetica', fontSize: 44, fontWeight: 'bold' }),
        [],
    );
    const sheetSlots = PIN_ASSETS.length + fallbacks.length;
    const sheet = useMemo(() => (
        <Group>
            {logoImages.map((img, i) => (img ? (
                <SkiaImage key={`l${i}`} image={img} x={i * SPRITE} y={0} width={SPRITE} height={SPRITE} fit="contain" />
            ) : null))}
            {fallbacks.map((f, i) => {
                const cx = (PIN_ASSETS.length + i) * SPRITE + SPRITE / 2;
                const tw = font ? font.measureText(f.letter).width : 0;
                return (
                    <Group key={f.key}>
                        {/* white ring + brand disc + letter (the fallbackChip look) */}
                        <Circle cx={cx} cy={SPRITE / 2} r={45} color="#FFFFFF" />
                        <Circle cx={cx} cy={SPRITE / 2} r={39} color={f.color} />
                        {font ? (
                            <SkiaText x={cx - tw / 2} y={SPRITE / 2 + 16} text={f.letter} font={font} color="#FFFFFF" />
                        ) : null}
                    </Group>
                );
            })}
        </Group>
        // eslint-disable-next-line react-hooks/exhaustive-deps
    ), [img0, img1, img2, img3, img4, fallbacks, font]);
    const texture = useTexture(
        sheet,
        { width: Math.max(sheetSlots, 1) * SPRITE, height: SPRITE },
        [img0, img1, img2, img3, img4, fallbacks],
    );

    // ── Slot pool (shared values; commits are plain array writes) ───────────
    const slots = useSharedValue<number[]>(new Array(MAX_SLOTS * STRIDE).fill(0));
    const flight = useSharedValue(1);
    const slotByIdRef = useRef(new Map<number, number>());
    const freeRef = useRef<number[]>([]);
    const nextFreeRef = useRef(0);

    useEffect(() => {
        const slotById = slotByIdRef.current;
        const arr = slots.value.slice();
        const nextIds = new Set(singles.map(s => s.id));
        // Free departed stores' slots.
        for (const [id, slot] of slotById) {
            if (!nextIds.has(id)) {
                slotById.delete(id);
                freeRef.current.push(slot);
                arr[slot * STRIDE + F_ALIVE] = 0;
            }
        }
        let anyFlight = false;
        for (const s of singles) {
            let slot = slotById.get(s.id);
            const isNew = slot == null;
            if (slot == null) {
                slot = freeRef.current.pop() ?? (nextFreeRef.current < MAX_SLOTS ? nextFreeRef.current++ : undefined as unknown as number);
                if (slot == null) continue; // pool exhausted → drop (never happens under MAX_SINGLES)
                slotById.set(s.id, slot);
            } else if (!isNew) {
                // A persisting dot never moves (stores are static) — but make
                // sure any old flight is finalized so a restarted `flight`
                // progress can't replay it.
                const o = slot * STRIDE;
                arr[o + F_FLNG] = arr[o + F_TLNG];
                arr[o + F_FMY] = arr[o + F_TMY];
                continue;
            }
            const o = slot * STRIDE;
            const tMy = mercY(s.latitude);
            const sprite = s.logo != null
                ? (spriteIndexByAsset.get(s.logo) ?? 0)
                : (fallbackIdxRef.current.get(fallbackKey(s)) ?? 0);
            arr[o + F_ALIVE] = 1;
            arr[o + F_SPRITE] = sprite;
            arr[o + F_TLNG] = s.longitude;
            arr[o + F_TMY] = tMy;
            if (s.fromLat != null && s.fromLng != null) {
                // Unjoin: fly out of the cluster bubble this store split from.
                arr[o + F_FLNG] = s.fromLng;
                arr[o + F_FMY] = mercY(s.fromLat);
                anyFlight = true;
            } else {
                arr[o + F_FLNG] = s.longitude;
                arr[o + F_FMY] = tMy;
            }
        }
        slots.value = arr;
        if (anyFlight) {
            flight.value = 0;
            flight.value = withTiming(1, { duration: 320, easing: Easing.out(Easing.cubic) });
        } else {
            flight.value = 1;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [singles]);

    // ── Per-frame buffers: the ONLY recurring work of the whole layer ────────
    const transforms = useRSXformBuffer(MAX_SLOTS, (val, i) => {
        'worklet';
        const f = frame.value;
        const a = slots.value;
        const o = i * STRIDE;
        if (!a[o + F_ALIVE] || f.mercPerPx <= 0 || f.W <= 0) {
            val.set(0, 0, 0, -9999); // scale 0 → invisible, parked off-screen
            return;
        }
        const t = flight.value;
        const lng = a[o + F_FLNG] + (a[o + F_TLNG] - a[o + F_FLNG]) * t;
        const my = a[o + F_FMY] + (a[o + F_TMY] - a[o + F_FMY]) * t;
        const x = f.W / 2 + ((lng - f.cLng) * RAD) / f.mercPerPx;
        const y = f.H / 2 + (f.mercC - my) / f.mercPerPx;
        const s = DOT / SPRITE;
        val.set(s, 0, x - DOT / 2, y - DOT / 2);
    });
    const sprites = useRectBuffer(MAX_SLOTS, (val, i) => {
        'worklet';
        const idx = slots.value[i * STRIDE + F_SPRITE];
        val.setXYWH(idx * SPRITE, 0, SPRITE, SPRITE);
    });

    return (
        <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
            <Atlas image={texture} sprites={sprites} transforms={transforms} />
        </Canvas>
    );
});
