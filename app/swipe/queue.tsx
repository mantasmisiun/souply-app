import { Ionicons } from "@expo/vector-icons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  GestureHandlerRootView,
  Gesture,
  GestureDetector,
} from "react-native-gesture-handler";
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Image } from "expo-image";
import { useTranslation } from "react-i18next";
import { ProductImage } from "../../components/ProductImage";
import { API_BASE_URL } from "../../config/api";
import { getUserId } from "../../config/user";
import { useTheme, type AppTheme } from "../../constants/theme";
import { useLevelStore } from "../../state/levelStore";
import { capMandatoryQueue, capVoluntaryQueue } from "../../utils/swipeQueueCap";

// ── Types ──────────────────────────────────────────────────────────────────

type Vote = "identical" | "similar" | "different";

interface SwipeCardSide {
  spId: number;
  productId: number;
  name: string;
  brandName: string | null;
  imageUrl: string | null;
  chainId: number;
  chainName: string;
  chainLogoUrl: string | null;
  categoryId: number;
  categoryName: string;
}

interface SwipeQueueCard {
  cardId: string;
  slot: 1 | 2 | 3;
  score: number;
  left: SwipeCardSide;
  right: SwipeCardSide;
  slot2Meta?: {
    sameChain: boolean;
    conflictDetected: boolean;
  };
  /** Tagged by `capVoluntaryQueue` for cards sourced from the global pool
   *  (after the receipt's own cards fill their per-slot share). The card
   *  renderer shows a small subline acknowledging the user is helping
   *  the community queue, not resolving this receipt. */
  fromGlobalFill?: boolean;
}

interface SlotCounts {
  slot1: number;
  slot2: number;
  slot3: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");
const STAGE_H_PAD = 16;
const CARD_W = SCREEN_W - STAGE_H_PAD * 2;
const IMG_SIZE = Math.min(140, Math.floor((CARD_W - 24) / 2) - 8);

const SWIPE_THRESHOLD_X = SCREEN_W * 0.26;
const SWIPE_THRESHOLD_Y = SCREEN_H * 0.16;
const UNDO_DELAY_MS = 3000;
const MIN_DWELL_MS = 700;

/**
 * Hard cap on how many receipts we'll let the user power through in a
 * single session. 5 × 3 cards = 15 mandatory swipes — past that the user
 * is doing too much in one go. The banner re-appears on return so they
 * can finish the rest at their pace.
 */
const MAX_RECEIPTS_PER_SESSION = 5;

// ── Sub-components ─────────────────────────────────────────────────────────

function ProgressDots({
  total,
  current,
  colors,
}: {
  total: number;
  current: number;
  colors: AppTheme;
}) {
  if (total === 0) return null;
  return (
    <View style={{ flexDirection: "row", gap: 4, flexWrap: "wrap", justifyContent: "center" }}>
      {Array.from({ length: total }, (_, i) => (
        <View
          key={i}
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor:
              i < current
                ? colors.success
                : i === current
                ? colors.warning
                : colors.textMuted,
          }}
        />
      ))}
    </View>
  );
}

function CardSide({
  side,
  styles,
}: {
  side: SwipeCardSide;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.half}>
      <View style={styles.chainRow}>
        {side.chainLogoUrl ? (
          <Image
            source={{ uri: side.chainLogoUrl }}
            style={styles.chainLogo}
            contentFit="contain"
          />
        ) : null}
        <Text style={styles.chainName} numberOfLines={1}>
          {side.chainName}
        </Text>
      </View>

      <ProductImage
        uris={side.imageUrl ? [side.imageUrl] : []}
        imageStyle={styles.productImg}
        placeholderStyle={styles.productImgPlaceholder}
        emojiStyle={styles.productImgEmoji}
        resizeMode="contain"
      />

      <Text style={styles.productName} numberOfLines={5}>
        {side.name}
      </Text>
    </View>
  );
}

// ── Main screen ────────────────────────────────────────────────────────────

export default function SwipeQueueScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  // Param surface:
  //   receiptIds=a,b,c        Banner batch flow — multi-receipt mandatory
  //                           session, 3 cards per receipt.
  //   receiptId=a             Single-receipt flow. Combined with
  //                           voluntary=1 → "Pagerinti atpažinimą" mode
  //                           (10 cards, 3-per-slot + ≥1 global).
  //                           Without voluntary → legacy mandatory shape.
  //   voluntary=1             Voluntary deep-rescue mode (pink button on
  //                           Nepriskirta modal). No mandatory completion
  //                           tracking, returns to /receipt-process when
  //                           done. Requires receiptId.
  //   returnTo=/(tabs)/...    Where to land after the session ends.
  const {
    receiptId: receiptIdParam,
    receiptIds: receiptIdsParam,
    voluntary,
    returnTo,
  } = useLocalSearchParams<{
    receiptId?: string;
    receiptIds?: string;
    voluntary?: string;
    returnTo?: string;
  }>();

  const isVoluntary = voluntary === "1";

  const receiptIdList = useMemo<string[]>(() => {
    if (receiptIdsParam) {
      const split = receiptIdsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // Dedupe defensively; cap to per-session limit.
      const seen = new Set<string>();
      const out: string[] = [];
      for (const id of split) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
        if (out.length >= MAX_RECEIPTS_PER_SESSION) break;
      }
      return out;
    }
    if (receiptIdParam) return [receiptIdParam];
    return [];
     
  }, [receiptIdParam, receiptIdsParam]);

  const isMulti = receiptIdList.length > 1;

  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const stashLevel = useLevelStore((s) => s.stashLevel);
  const triggerIfNewLevel = useLevelStore((s) => s.triggerIfNewLevel);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<SwipeQueueCard[]>([]);
  /**
   * receiptId the currently-loaded `items` belong to (or null for standalone).
   * Drives the staleness gate in `doneWithCurrentReceipt` — without it,
   * advancing `receiptIdx` flips `done` to true *before* `loadQueue` runs,
   * which would falsely mark the next receipt complete on entry.
   */
  const [itemsReceiptId, setItemsReceiptId] = useState<string | null>(null);
  const [slotCounts, setSlotCounts] = useState<SlotCounts>({
    slot1: 0,
    slot2: 0,
    slot3: 0,
  });
  const [idx, setIdx] = useState(0);
  const [sessionNum, setSessionNum] = useState(0);
  const [receiptIdx, setReceiptIdx] = useState(0);
  const [undoLabel, setUndoLabel] = useState<string | null>(null);
  /**
   * Guard against the final-receipt "done" effect navigating twice
   * (state flips can cause the dep array to re-trigger before unmount).
   */
  const finishedRef = useRef(false);

  const userIdRef = useRef<string | null>(null);
  const cardShownAtRef = useRef(Date.now());
  const pendingVoteRef = useRef<{
    item: SwipeQueueCard;
    vote: Vote;
    dwell: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  const currentReceiptId = receiptIdList[receiptIdx] ?? null;

  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);

  // ── Load queue ─────────────────────────────────────────────────────────

  const loadQueue = async () => {
    try {
      setLoading(true);
      setError(null);
      const userId = userIdRef.current ?? (await getUserId());
      userIdRef.current = userId;

      // Fetch the receipt-anchored queue. In voluntary mode also fetch
      // the global queue in parallel so `capVoluntaryQueue` can enforce
      // the 3+3+3+1 spec (3 cards per slot in priority 2→1→3, plus 1
      // global card flagged with `fromGlobalFill`). We still pass
      // `voluntary=1` to the server so it knows to trigger the
      // background OSC refill for the user's missing orphans (the
      // refill is fire-and-forget; it benefits the user's NEXT visit).
      const receiptParts: string[] = [];
      if (currentReceiptId) receiptParts.push(`receiptId=${encodeURIComponent(currentReceiptId)}`);
      if (isVoluntary) receiptParts.push("voluntary=1");
      const receiptQs = receiptParts.length > 0 ? `?${receiptParts.join("&")}` : "";
      const [receiptRes, globalRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/swipe-queue${receiptQs}`),
        isVoluntary
          ? fetch(`${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/swipe-queue`)
          : Promise.resolve(null as Response | null),
      ]);
      if (!receiptRes.ok) throw new Error(`HTTP ${receiptRes.status}`);
      const receiptData = await receiptRes.json();
      const receiptItems: SwipeQueueCard[] = Array.isArray(receiptData?.items) ? receiptData.items : [];
      const counts: SlotCounts = receiptData?.slotCounts ?? { slot1: 0, slot2: 0, slot3: 0 };

      let globalItems: SwipeQueueCard[] = [];
      if (globalRes && globalRes.ok) {
        const globalData = await globalRes.json();
        globalItems = Array.isArray(globalData?.items) ? globalData.items : [];
      }

      let capped: SwipeQueueCard[];
      if (isVoluntary) {
        // Voluntary spec: 3 slot 2 (orphans) → 3 slot 1 (cross-chain
        // identity) → 3 slot 3 (same-chain dedup) → 1 global card.
        // capVoluntaryQueue redistributes within the 9-card receipt
        // budget when a slot has < 3 cards, and stamps fromGlobalFill
        // on the community-contribution card.
        capped = capVoluntaryQueue({ receiptItems, globalItems }).items;
      } else if (currentReceiptId) {
        // Mandatory: 3 cards in slot 2 → 1 → 3 priority. EC7 top-up:
        // if the receipt-anchored pool has < 3 cards, blend in global
        // cards before capping so the user still does meaningful work.
        let augmented = receiptItems;
        if (augmented.length < 3) {
          try {
            const res2 = await fetch(
              `${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/swipe-queue`,
            );
            if (res2.ok) {
              const data2 = await res2.json();
              const extras: SwipeQueueCard[] = Array.isArray(data2?.items) ? data2.items : [];
              const seen = new Set(augmented.map((c) => c.cardId));
              const merged = [...augmented];
              for (const c of extras) {
                if (merged.length >= 3) break;
                if (seen.has(c.cardId)) continue;
                seen.add(c.cardId);
                merged.push(c);
              }
              augmented = merged;
            }
          } catch (e) {
            console.warn("[SwipeQueue] mandatory top-up failed:", e);
          }
        }
        capped = capMandatoryQueue({ receiptItems: augmented }).items;
      } else {
        // Defensive: voluntary + standalone are the documented modes.
        // Anything else (no receiptId, no voluntary) is treated as an
        // empty session rather than crashing the renderer.
        capped = [];
      }

      setItems(capped);
      setSlotCounts(counts);
      setIdx(0);
      setItemsReceiptId(currentReceiptId);
      cardShownAtRef.current = Date.now();
    } catch (e: any) {
      setError(e?.message ?? t('swipe.errorQueue'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    (async () => {
      userIdRef.current = await getUserId();
    })();
  }, []);

  useEffect(() => {
    loadQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionNum, receiptIdx]);

  // ── Vote dispatch ──────────────────────────────────────────────────────

  const sendVote = async (vote: Vote, item: SwipeQueueCard, dwell: number) => {
    const userId = userIdRef.current!;
    try {
      let res: Response;
      if (item.slot === 2) {
        res = await fetch(
          `${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/swipe-vote/slot2`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orphanSpId: item.left.spId,
              candidateSpId: item.right.spId,
              vote,
              dwellMs: dwell,
              conflictDetected: item.slot2Meta?.conflictDetected ?? false,
              sameChain: item.slot2Meta?.sameChain ?? false,
            }),
          }
        );
      } else {
        res = await fetch(
          `${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/swipe-vote`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              spIdA: item.left.spId,
              spIdB: item.right.spId,
              vote,
              dwellMs: dwell,
            }),
          }
        );
      }
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data?.level) stashLevel(data.level).catch(() => {});
      }
    } catch (e) {
      console.warn("[SwipeQueue] vote POST failed:", e);
    }
  };

  // ── Advance / undo ─────────────────────────────────────────────────────

  const advance = (vote: Vote | null) => {
    const item = cappedItems[idx];
    if (!item) return;

    const dwell = Date.now() - cardShownAtRef.current;

    if (pendingVoteRef.current) {
      const prev = pendingVoteRef.current;
      clearTimeout(prev.timer);
      pendingVoteRef.current = null;
      sendVote(prev.vote, prev.item, prev.dwell).catch(() => {});
    }

    translateX.value = 0;
    translateY.value = 0;
    setIdx((i) => i + 1);
    cardShownAtRef.current = Date.now();

    if (vote === null) {
      setUndoLabel(null);
      return;
    }

    if (dwell < MIN_DWELL_MS) {
      setUndoLabel(null);
      sendVote(vote, item, dwell).catch(() => {});
      return;
    }

    const label =
      vote === "identical" ? t('swipe.directionIdentical') : vote === "similar" ? t('swipe.directionSimilar') : t('swipe.directionDifferent');
    setUndoLabel(label);

    const timer = setTimeout(() => {
      pendingVoteRef.current = null;
      setUndoLabel(null);
      sendVote(vote, item, dwell).catch(() => {});
    }, UNDO_DELAY_MS);

    pendingVoteRef.current = { item, vote, dwell, timer };
  };

  const handleUndo = () => {
    if (!pendingVoteRef.current) return;
    clearTimeout(pendingVoteRef.current.timer);
    pendingVoteRef.current = null;
    setUndoLabel(null);
    setIdx((i) => Math.max(0, i - 1));
    cardShownAtRef.current = Date.now();
  };

  // Animate card off in the given direction then call advance.
  const advanceTap = (vote: Vote | null) => {
    if (vote === "different") {
      translateX.value = withTiming(-SCREEN_W, { duration: 200 }, () =>
        runOnJS(advance)(vote)
      );
    } else if (vote === "identical") {
      translateX.value = withTiming(SCREEN_W, { duration: 200 }, () =>
        runOnJS(advance)(vote)
      );
    } else if (vote === "similar") {
      translateY.value = withTiming(-SCREEN_H, { duration: 200 }, () =>
        runOnJS(advance)(vote)
      );
    } else {
      translateY.value = withTiming(SCREEN_H, { duration: 200 }, () =>
        runOnJS(advance)(null)
      );
    }
  };

  // ── Gesture ────────────────────────────────────────────────────────────

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      translateX.value = e.translationX;
      translateY.value = e.translationY;
    })
    .onEnd((e) => {
      const up = e.translationY < -SWIPE_THRESHOLD_Y;
      const down = e.translationY > SWIPE_THRESHOLD_Y;
      const right = e.translationX > SWIPE_THRESHOLD_X;
      const left = e.translationX < -SWIPE_THRESHOLD_X;

      if (up) {
        translateY.value = withTiming(-SCREEN_H, { duration: 220 }, () =>
          runOnJS(advance)("similar")
        );
      } else if (right) {
        translateX.value = withTiming(SCREEN_W, { duration: 220 }, () =>
          runOnJS(advance)("identical")
        );
      } else if (left) {
        translateX.value = withTiming(-SCREEN_W, { duration: 220 }, () =>
          runOnJS(advance)("different")
        );
      } else if (down) {
        translateY.value = withTiming(SCREEN_H, { duration: 220 }, () =>
          runOnJS(advance)(null)
        );
      } else {
        translateX.value = withSpring(0);
        translateY.value = withSpring(0);
      }
    });

  const cardStyle = useAnimatedStyle(() => {
    const rotate = interpolate(
      translateX.value,
      [-SCREEN_W, 0, SCREEN_W],
      [-10, 0, 10]
    );
    return {
      transform: [
        { translateX: translateX.value },
        { translateY: translateY.value },
        { rotate: `${rotate}deg` },
      ],
    };
  });

  const tintStyle = useAnimatedStyle(() => {
    const dxAbs = Math.min(1, Math.abs(translateX.value) / SWIPE_THRESHOLD_X);
    const upAbs =
      translateY.value < 0 ? Math.min(1, -translateY.value / SWIPE_THRESHOLD_Y) : 0;
    const downAbs =
      translateY.value > 0 ? Math.min(1, translateY.value / SWIPE_THRESHOLD_Y) : 0;
    const dominantY = Math.max(upAbs, downAbs);
    let bg = "transparent";
    let opacity = 0;
    if (dominantY > dxAbs) {
      if (upAbs >= downAbs) { bg = colors.info; opacity = upAbs * 0.35; }
      else { bg = colors.surfaceMuted; opacity = downAbs * 0.3; }
    } else if (translateX.value > 0) {
      bg = colors.primary; opacity = dxAbs * 0.35;
    } else if (translateX.value < 0) {
      bg = colors.error; opacity = dxAbs * 0.35;
    }
    return { backgroundColor: bg, opacity };
  });

  // ── Derived ────────────────────────────────────────────────────────────

  // `items` is now pre-capped by loadQueue (via capMandatoryQueue or
  // capVoluntaryQueue) so the renderer just iterates. Keeping the alias
  // local to avoid churn through the existing references below.
  const cappedItems = items;
  const currentItem = cappedItems[idx];
  // `itemsReceiptId === currentReceiptId` is the staleness gate. Until
  // loadQueue refreshes after a receiptIdx bump, `items` still holds the
  // previous receipt's cards — without this check, `done` would flip true
  // for the new receipt instantly and POST complete-swipes for cards the
  // user never saw.
  const itemsMatchReceipt = itemsReceiptId === currentReceiptId;
  const doneWithCurrentReceipt =
    !loading &&
    !error &&
    itemsMatchReceipt &&
    (cappedItems.length === 0 || idx >= cappedItems.length);

  // ── Flow control: per-receipt completion ─────────────────────────────
  //
  // When the current receipt's session ends, behaviour splits by mode:
  //   • Mandatory: POST /complete-swipes (clears banner count); advance
  //     receiptIdx if more receipts remain; else navigate to returnTo
  //     or the legacy /receipt-process flow.
  //   • Voluntary: never POST /complete-swipes (mandatory tracking is
  //     orthogonal). Single-receipt session only — navigate straight
  //     back to /receipt-process so the breakdown re-renders with any
  //     newly-resolved Nepriskirta lines.
  useEffect(() => {
    if (!doneWithCurrentReceipt) return;
    if (!currentReceiptId) return;
    if (finishedRef.current) return;
    // Voluntary mode with 0 cards returned: don't auto-navigate. Show
    // the empty state below so the user understands there's nothing to
    // rescue right now instead of being silently bounced back to the
    // receipt screen. Mandatory mode still auto-navigates because it
    // needs to mark the receipt complete server-side.
    if (isVoluntary && cappedItems.length === 0) return;

    let cancelled = false;
    (async () => {
      if (!isVoluntary) {
        // Mandatory: always mark the current receipt complete — even
        // if cappedItems was 0 (no candidates available), the server
        // counter must be cleared so the banner count drops on return.
        try {
          await fetch(`${API_BASE_URL}/api/receipts/${currentReceiptId}/complete-swipes`, {
            method: "POST",
          });
        } catch {}
      }
      if (cancelled) return;

      const hasNext = !isVoluntary && receiptIdx + 1 < receiptIdList.length;
      if (hasNext) {
        // Move to next receipt; loadQueue fires via the receiptIdx effect.
        setReceiptIdx((i) => i + 1);
        return;
      }

      // Wrap the session.
      finishedRef.current = true;
      // Give the latest pending vote a chance to commit before fetching
      // profile (used to decide level-up modal).
      await new Promise((r) => setTimeout(r, 400));
      const userId = userIdRef.current;
      if (userId) {
        try {
          const r = await fetch(
            `${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/profile`
          );
          const d = await r.json();
          if (d?.level) await stashLevel(d.level);
        } catch {}
      }
      if (cancelled) return;
      if (isVoluntary) {
        // Pop just the queue screen so the existing /receipt-process
        // underneath re-focuses. router.replace into a fresh
        // /receipt-process stacked a duplicate on top of the original,
        // forcing the user to back-tap TWICE to reach the Analize tab.
        // The receipt screen's focus effect refreshes the swipe count
        // on its own; the breakdown picks up any rescued lines on the
        // next manual revisit (read-through category resolver).
        router.back();
      } else if (returnTo) {
        router.replace(returnTo as any);
      } else {
        // Legacy single-receipt-from-receipt-process flow.
        router.replace({
          pathname: "/receipt-process",
          params: { receiptId: currentReceiptId, swipeDone: "1" },
        } as any);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneWithCurrentReceipt, currentReceiptId, receiptIdx]);

  // Standalone: trigger modal directly on the done screen.
  useEffect(() => {
    if (doneWithCurrentReceipt && !currentReceiptId && !loading) {
      (async () => {
        const userId = userIdRef.current;
        if (!userId) return;
        try {
          const r = await fetch(
            `${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/profile`
          );
          const d = await r.json();
          if (d?.level) await triggerIfNewLevel(d.level);
        } catch {}
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneWithCurrentReceipt, currentReceiptId, loading]);

  // ── Render ─────────────────────────────────────────────────────────────

  const headerTitle = isMulti
    ? t('swipe.headerProgress', { current: receiptIdx + 1, total: receiptIdList.length })
    : t('swipe.header');

  return (
    <GestureHandlerRootView
      style={{ flex: 1, backgroundColor: colors.pageBackground }}
    >
      <Stack.Screen options={{ title: headerTitle }} />

      {/* ── Loading ── */}
      {loading && (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      )}

      {/* ── Error ── */}
      {!loading && error && (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.btn} onPress={() => router.back()}>
            <Text style={styles.btnText}>{t('swipe.back')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Done / empty ──
          Standalone (no receiptId) always renders here. Voluntary mode
          with 0 cards stays here too — the auto-navigate effect skips
          it so the user sees an honest "nothing to rescue right now"
          message instead of being silently bounced back to the receipt. */}
      {!loading && !error && doneWithCurrentReceipt && (!currentReceiptId || (isVoluntary && cappedItems.length === 0)) && (
        <View style={styles.centered}>
          <Ionicons
            name={cappedItems.length === 0 && isVoluntary ? "leaf-outline" : "checkmark-circle"}
            size={72}
            color={cappedItems.length === 0 && isVoluntary ? colors.textMuted : colors.primary}
          />
          <Text style={styles.doneTitle}>
            {cappedItems.length === 0 && isVoluntary ? t('swipe.doneEmpty') : t('swipe.doneAck')}
          </Text>
          <Text style={styles.doneSubtitle}>
            {cappedItems.length === 0 && isVoluntary
              ? t('swipe.emptyVoluntaryReceipt')
              : cappedItems.length === 0
              ? t('swipe.emptyNothing')
              : t('swipe.doneAllSeen')}
          </Text>
          <View style={styles.btnRow}>
            {cappedItems.length > 0 && !isVoluntary && (
              <TouchableOpacity
                style={styles.btnOutline}
                onPress={() => setSessionNum((n) => n + 1)}
              >
                <Text style={styles.btnOutlineText}>{t('swipe.moreCta')}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.btn} onPress={() => router.back()}>
              <Text style={styles.btnText}>{t('swipe.back')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── Progress dots — just below nav bar ── */}
      {!loading && !error && !doneWithCurrentReceipt && currentItem && (
        <View style={styles.dotsBar}>
          <ProgressDots
            total={cappedItems.length}
            current={idx}
            colors={colors}
          />
        </View>
      )}

      {/* ── Active card ── */}
      {!loading && !error && !doneWithCurrentReceipt && currentItem && (
        <View style={styles.stage}>
          {/* Voluntary-mode community-contribution subline. Shows above
              the card stack when the current card is sourced from the
              global pool (this receipt's own cards exhausted). */}
          {currentItem.fromGlobalFill && (
            <Text style={styles.fromGlobalSubline} numberOfLines={2}>
              {t('swipe.fromGlobalFill')}
            </Text>
          )}
          <GestureDetector gesture={pan}>
            <Animated.View style={[styles.card, cardStyle]}>
              <Animated.View
                style={[StyleSheet.absoluteFill, styles.cardTint, tintStyle]}
              />
              <View style={styles.cardInner}>
                <CardSide side={currentItem.left} styles={styles} />
                <View style={styles.verticalDivider} />
                <CardSide side={currentItem.right} styles={styles} />
              </View>
            </Animated.View>
          </GestureDetector>

          {/* Tap buttons */}
          <View style={styles.tapRow}>
            <TouchableOpacity
              style={styles.tapBtn}
              onPress={() => advanceTap("different")}
            >
              <Text style={styles.tapBtnArrow}>←</Text>
              <Text style={styles.tapBtnLabel}>{t('swipe.directionDifferent')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.tapBtn}
              onPress={() => advanceTap("similar")}
            >
              <Text style={styles.tapBtnArrow}>↑</Text>
              <Text style={styles.tapBtnLabel}>{t('swipe.directionSimilar')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.tapBtn}
              onPress={() => advanceTap(null)}
            >
              <Text style={styles.tapBtnArrow}>↓</Text>
              <Text style={styles.tapBtnLabel}>{t('swipe.directionSkip')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.tapBtn}
              onPress={() => advanceTap("identical")}
            >
              <Text style={styles.tapBtnArrow}>→</Text>
              <Text style={styles.tapBtnLabel}>{t('swipe.directionIdentical')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── Undo toast ── */}
      {undoLabel !== null && (
        <View style={styles.undoToast}>
          <Text style={styles.undoText}>{undoLabel}</Text>
          <TouchableOpacity onPress={handleUndo} style={styles.undoBtn}>
            <Text style={styles.undoBtnText}>{t('swipe.undoCancel')}</Text>
          </TouchableOpacity>
        </View>
      )}
    </GestureHandlerRootView>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const makeStyles = (c: AppTheme) =>
  StyleSheet.create({
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },

    // ── Done state ──
    doneTitle: {
      fontSize: 24,
      fontWeight: "700",
      color: c.textPrimary,
      marginTop: 12,
    },
    doneSubtitle: {
      color: c.textSecondary,
      textAlign: "center",
      marginTop: 8,
      marginBottom: 20,
      fontSize: 14,
    },
    btnRow: { flexDirection: "row", gap: 12 },
    btn: {
      backgroundColor: c.primary,
      paddingVertical: 12,
      paddingHorizontal: 24,
      borderRadius: 12,
    },
    btnText: { color: c.onPrimary, fontWeight: "600", fontSize: 15 },
    btnOutline: {
      backgroundColor: c.cardBackground,
      borderWidth: 1,
      borderColor: c.primary,
      paddingVertical: 12,
      paddingHorizontal: 24,
      borderRadius: 12,
    },
    btnOutlineText: { color: c.primary, fontWeight: "600", fontSize: 15 },
    errorText: {
      color: c.error,
      textAlign: "center",
      marginBottom: 16,
      fontSize: 16,
    },

    // ── Dots bar ──
    dotsBar: {
      alignItems: "center",
      paddingTop: 10,
      paddingBottom: 4,
    },

    // ── Stage ──
    stage: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: STAGE_H_PAD,
      paddingBottom: 8,
    },

    // ── Card ──
    card: {
      width: CARD_W,
      backgroundColor: c.cardBackground,
      borderRadius: 20,
      overflow: "hidden",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.12,
      shadowRadius: 10,
      elevation: 6,
    },
    cardTint: { borderRadius: 20 },
    cardInner: {
      flexDirection: "row",
      paddingHorizontal: 10,
      paddingVertical: 14,
    },
    // Voluntary-mode subline above the card. Italic, muted colour,
    // small font — communicates "you're now helping the community"
    // without competing with the active card content.
    fromGlobalSubline: {
      fontSize: 12,
      fontStyle: "italic",
      color: c.textMuted,
      textAlign: "center",
      paddingHorizontal: 16,
      marginBottom: 8,
    },
    verticalDivider: {
      width: 1,
      backgroundColor: c.border,
      marginHorizontal: 6,
      alignSelf: "stretch",
    },

    // ── Card half ──
    half: {
      flex: 1,
      alignItems: "center",
      paddingHorizontal: 2,
    },
    chainRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginBottom: 6,
      width: "100%",
      justifyContent: "center",
    },
    chainLogo: {
      width: 16,
      height: 16,
    },
    chainName: {
      fontSize: 10,
      fontWeight: "700",
      color: c.textMuted,
      letterSpacing: 0.8,
      textTransform: "uppercase",
      flexShrink: 1,
    },
    productImg: {
      width: IMG_SIZE,
      height: IMG_SIZE,
    },
    productImgPlaceholder: {
      width: IMG_SIZE,
      height: IMG_SIZE,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surfaceMuted,
      borderRadius: 8,
    },
    productImgEmoji: {
      fontSize: IMG_SIZE * 0.55,
      opacity: 0.4,
    },
    productName: {
      fontSize: 12,
      fontWeight: "600",
      color: c.textPrimary,
      textAlign: "center",
      marginTop: 8,
      lineHeight: 17,
    },

    // ── Tap buttons ──
    tapRow: {
      flexDirection: "row",
      marginTop: 14,
      gap: 8,
      width: "100%",
      justifyContent: "space-between",
    },
    tapBtn: {
      flex: 1,
      alignItems: "center",
      paddingVertical: 10,
      borderRadius: 12,
      backgroundColor: c.cardBackground,
      borderWidth: 1,
      borderColor: c.border,
      gap: 2,
    },
    tapBtnArrow: {
      fontSize: 16,
      color: c.textSecondary,
    },
    tapBtnLabel: {
      fontSize: 9,
      fontWeight: "600",
      color: c.textMuted,
      textAlign: "center",
    },

    // ── Undo toast ──
    undoToast: {
      position: "absolute",
      bottom: 100,
      left: 20,
      right: 20,
      backgroundColor: c.cardBackground,
      borderRadius: 14,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: 12,
      paddingHorizontal: 16,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.12,
      shadowRadius: 8,
      elevation: 5,
    },
    undoText: {
      fontSize: 14,
      color: c.textSecondary,
    },
    undoBtn: {
      backgroundColor: c.primaryMuted,
      paddingVertical: 6,
      paddingHorizontal: 14,
      borderRadius: 8,
    },
    undoBtnText: {
      fontSize: 13,
      fontWeight: "700",
      color: c.primary,
    },
  });
