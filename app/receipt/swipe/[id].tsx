import { Ionicons } from "@expo/vector-icons";
import { Stack, useLocalSearchParams, useRouter, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { GestureHandlerRootView, Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { API_BASE_URL } from "../../../config/api";
import { getUserId } from "../../../config/user";
import { useTheme, type AppTheme } from "../../../constants/theme";
import { useLevelStore } from "../../../state/levelStore";

type Vote = "identical" | "similar" | "different";

interface Candidate {
  rankPos: number;
  storeProductId: number;
  name: string;
  brandName: string | null;
  amount: string | number | null;
  unit: string | null;
  imageUrl: string | null;
  chainName: string;
  chainLogoUrl: string | null;
  matchScore: number;
  autoMatched: boolean;
}

interface QueueItem {
  receiptLineIdx: number;
  ocrName: string | null;
  ocrAmount: string | number | null;
  ocrUnit: string | null;
  ocrPrice: number | null;
  ocrPromoPrice: number | null;
  lineStoreProductId: number | null;
  candidates: Candidate[];
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");
const SWIPE_THRESHOLD_X = SCREEN_W * 0.28;
const SWIPE_THRESHOLD_Y = SCREEN_H * 0.18;

function formatAmount(amount: string | number | null, unit: string | null) {
  if (amount == null) return unit ?? "";
  const n = typeof amount === "number" ? amount : parseFloat(amount);
  if (!Number.isFinite(n)) return String(amount);
  return `${Number.isInteger(n) ? n : n.toFixed(n < 10 ? 2 : 0)} ${unit ?? ""}`.trim();
}

export default function SwipeScreen() {
  const { id, mandatory, mandatoryCount } = useLocalSearchParams<{ id: string; mandatory?: string; mandatoryCount?: string }>();
  const receiptId = Number(id);
  const isMandatory = mandatory === "1";
  const mandatorySwipesRequired = isMandatory ? (Number(mandatoryCount) || 3) : 0;
  const router = useRouter();
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { stashLevel, triggerIfNewLevel } = useLevelStore();
  const didSwipeRef = useRef(false);

  // Fetch the profile when leaving the swipe screen so the modal fires on
  // whichever screen the user lands on. Fire-and-forget: the cleanup itself
  // must return synchronously, so the async work runs in the background.
  // Using the profile endpoint (not levelSeenRef) avoids the race where the
  // last vote response arrives after the cleanup fires.
  useFocusEffect(useCallback(() => {
    return () => {
      if (!didSwipeRef.current) return;
      (async () => {
        try {
          const userId = await getUserId();
          const res = await fetch(`${API_BASE_URL}/api/users/${userId}/profile`);
          if (res.ok) {
            const { level } = await res.json();
            if (level) triggerIfNewLevel(level);
          }
        } catch {}
      })();
    };
  }, [triggerIfNewLevel]));

  const [loading, setLoading] = useState(true);
  const [refetching, setRefetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [itemIdx, setItemIdx] = useState(0);
  const [rankIdx, setRankIdx] = useState(0);
  // exhausted flips true only after a refetch confirms nothing more is
  // available for this user — not just when the in-memory queue ends. Keeps
  // the "Ačiū" screen from flashing prematurely when the server still has
  // rank-2+ candidates waiting.
  const [exhausted, setExhausted] = useState(false);
  const [undoVisible, setUndoVisible] = useState(false);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mandatorySwipesDoneRef = useRef(0);
  const lastSnapshotRef = useRef<{
    itemIdx: number;
    rankIdx: number;
    receiptLineIdx: number;
    candidateStoreProductId: number;
  } | null>(null);
  const cardShownAtRef = useRef<number>(Date.now());
  const userIdRef = useRef<string | null>(null);

  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);

  useEffect(() => {
    (async () => {
      userIdRef.current = await getUserId();
    })();
  }, []);

  const FETCH_TIMEOUT_MS = 8_000;

  const fetchWithTimeout = (url: string, options?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    return fetch(url, { ...options, signal: controller.signal }).finally(() =>
      clearTimeout(timer)
    );
  };

  const friendlyError = (e: any): string => {
    if (e?.name === 'AbortError' || e?.name === 'FetchTimeoutError') {
      return 'Ryšys nutrauktas. Bandykite dar kartą.';
    }
    return e?.message || 'Nepavyko gauti eilės';
  };

  // Fetch the receipt's swipe queue (filtered server-side by already-voted
  // pairs + self-pair verified prices). Returns the filtered item list.
  const loadQueue = async (): Promise<QueueItem[]> => {
    const userId = userIdRef.current ?? (await getUserId());
    userIdRef.current = userId;
    const res = await fetchWithTimeout(
      `${API_BASE_URL}/api/receipts/${receiptId}/swipe-queue?userId=${encodeURIComponent(userId)}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data?.items ?? []).filter(
      (it: QueueItem) => Array.isArray(it.candidates) && it.candidates.length > 0
    );
  };

  useEffect(() => {
    if (!Number.isFinite(receiptId)) {
      router.back();
      setLoading(false);
      return;
    }
    (async () => {
      try {
        setLoading(true);
        const validItems = await loadQueue();
        setItems(validItems);
        setItemIdx(0);
        setRankIdx(0);
        setExhausted(validItems.length === 0);
        cardShownAtRef.current = Date.now();
      } catch {
        // Drop straight to receipt analysis results on initial load failure —
        // don't leave the user stranded on an error screen.
        if (isMandatory) {
          router.replace({
            pathname: "/receipt-process",
            params: { receiptId: String(receiptId), swipeDone: "1" },
          } as any);
        } else {
          router.back();
        }
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiptId]);

  // Once we've swiped past the last in-memory card, try one refetch to see
  // whether the server has more (rank-2+ candidates surface here after the
  // rank-1 vote is recorded). If new items come in, continue the session.
  // If not, mark exhausted — only then does the Ačiū screen appear.
  useEffect(() => {
    if (loading || error || refetching || exhausted) return;
    if (items.length === 0) return; // initial empty already handled
    if (itemIdx < items.length) return; // still have cards in memory
    (async () => {
      try {
        setRefetching(true);
        const more = await loadQueue();
        if (more.length > 0) {
          setItems(more);
          setItemIdx(0);
          setRankIdx(0);
          cardShownAtRef.current = Date.now();
        } else {
          setExhausted(true);
        }
      } catch {
        // Fail closed: don't block the Ačiū screen on a transient error.
        setExhausted(true);
      } finally {
        setRefetching(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemIdx, items.length, loading, error, refetching, exhausted]);

  const currentItem = items[itemIdx];
  const currentCandidate = currentItem?.candidates[rankIdx];
  const done = !loading && !error && !refetching && exhausted;

  const sendVote = async (vote: Vote, item: QueueItem, cand: Candidate, dwellMs: number) => {
    didSwipeRef.current = true;
    const userId = userIdRef.current ?? (await getUserId());
    userIdRef.current = userId;
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/swipe-votes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          receiptId,
          receiptLineIdx: item.receiptLineIdx,
          candidateStoreProductId: cand.storeProductId,
          vote,
          dwellMs,
          isMandatory: isMandatory ? 1 : 0,
        }),
      });
      const data = await res.json();
      if (data?.level) stashLevel(data.level); // persists for app-close recovery
    } catch (e) {
      console.warn("Swipe vote POST failed:", e);
    }
  };

  const advance = (vote: Vote) => {
    const item = currentItem;
    const cand = currentCandidate;
    if (!item || !cand) return;

    lastSnapshotRef.current = {
      itemIdx,
      rankIdx,
      receiptLineIdx: item.receiptLineIdx,
      candidateStoreProductId: cand.storeProductId,
    };
    setUndoVisible(true);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => setUndoVisible(false), 3000);

    const dwell = Date.now() - cardShownAtRef.current;
    sendVote(vote, item, cand, dwell);

    if (vote === "different") {
      // Try the next-ranked candidate for this line; if none, advance to next line.
      if (rankIdx + 1 < item.candidates.length) {
        setRankIdx(rankIdx + 1);
      } else {
        setItemIdx(itemIdx + 1);
        setRankIdx(0);
      }
    } else {
      // identical or similar: we're done with this line, move on.
      setItemIdx(itemIdx + 1);
      setRankIdx(0);
    }

    translateX.value = 0;
    translateY.value = 0;
    cardShownAtRef.current = Date.now();

    // Mandatory cap: end session after mandatorySwipesRequired votes regardless
    // of how many more candidates remain in the queue.
    if (isMandatory && mandatorySwipesRequired > 0) {
      mandatorySwipesDoneRef.current += 1;
      if (mandatorySwipesDoneRef.current >= mandatorySwipesRequired) {
        setExhausted(true);
      }
    }
  };

  /**
   * Skip the current card without recording a vote. Same advancement
   * rule as "different" (try the next candidate, fall through to the
   * next line) but nothing is sent to the backend — the pair stays
   * un-voted and may resurface in a future queue fetch. Useful when
   * the user can't decide and wants to move on.
   *
   * No undo surfaced (nothing to undo server-side), and no snapshot
   * stored so the undo toast doesn't misfire on a subsequent real vote.
   */
  const skip = () => {
    const item = currentItem;
    if (!item) return;
    if (rankIdx + 1 < item.candidates.length) {
      setRankIdx(rankIdx + 1);
    } else {
      setItemIdx(itemIdx + 1);
      setRankIdx(0);
    }
    translateX.value = 0;
    translateY.value = 0;
    cardShownAtRef.current = Date.now();
  };

  const handleUndo = async () => {
    const snap = lastSnapshotRef.current;
    if (!snap) return;
    setItemIdx(snap.itemIdx);
    setRankIdx(snap.rankIdx);
    setUndoVisible(false);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    lastSnapshotRef.current = null;
    cardShownAtRef.current = Date.now();

    // Fire-and-forget: reverse the vote on the backend so the vote ledger
    // + Product merges + Price.isVerified all roll back to pre-swipe state.
    const userId = userIdRef.current ?? (await getUserId());
    userIdRef.current = userId;
    try {
      await fetchWithTimeout(`${API_BASE_URL}/api/swipe-votes/undo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          receiptId,
          receiptLineIdx: snap.receiptLineIdx,
          candidateStoreProductId: snap.candidateStoreProductId,
        }),
      });
    } catch (e) {
      console.warn("Undo POST failed:", e);
    }
  };

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      translateX.value = e.translationX;
      translateY.value = e.translationY; // allow both up (similar) and down (skip)
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
      } else if (down) {
        // Swipe-down = skip. No vote sent; card slides off-screen and
        // the next candidate surfaces.
        translateY.value = withTiming(SCREEN_H, { duration: 220 }, () =>
          runOnJS(skip)()
        );
      } else if (right) {
        translateX.value = withTiming(SCREEN_W, { duration: 220 }, () =>
          runOnJS(advance)("identical")
        );
      } else if (left) {
        translateX.value = withTiming(-SCREEN_W, { duration: 220 }, () =>
          runOnJS(advance)("different")
        );
      } else {
        translateX.value = withSpring(0);
        translateY.value = withSpring(0);
      }
    });

  const cardStyle = useAnimatedStyle(() => {
    const rotate = interpolate(translateX.value, [-SCREEN_W, 0, SCREEN_W], [-10, 0, 10]);
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
    const dyUp = translateY.value < 0 ? Math.min(1, -translateY.value / SWIPE_THRESHOLD_Y) : 0;
    const dyDown = translateY.value > 0 ? Math.min(1, translateY.value / SWIPE_THRESHOLD_Y) : 0;
    let bg = "transparent";
    let opacity = 0;
    // Whichever axis has the stronger drag wins the tint.
    const maxY = Math.max(dyUp, dyDown);
    if (maxY > dxAbs) {
      if (dyUp > dyDown) {
        bg = colors.info;        // similar
        opacity = dyUp * 0.35;
      } else {
        bg = colors.textMuted;   // skip — muted, not a positive vote
        opacity = dyDown * 0.35;
      }
    } else if (translateX.value > 0) {
      bg = colors.primary;       // identical
      opacity = dxAbs * 0.35;
    } else if (translateX.value < 0) {
      bg = colors.error;         // different
      opacity = dxAbs * 0.35;
    }
    return { backgroundColor: bg, opacity };
  });

  useEffect(() => () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  }, []);

  // Auto-navigate to receipt results when mandatory swipes are done.
  // No "Žiūrėti rezultatus" button — just drop straight into the screen.
  useEffect(() => {
    if (done && isMandatory) {
      router.replace({
        pathname: "/receipt-process",
        params: { receiptId: String(receiptId), swipeDone: "1" },
      } as any);
    }
  }, [done, isMandatory]);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.pageBackground }}>
      <Stack.Screen options={{ title: "Padėk atpažinti" }} />

      {(loading || refetching) && (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      )}

      {!loading && !refetching && error && (
        <View style={styles.centered}>
          <Ionicons name="cloud-offline-outline" size={48} color={colors.textMuted} style={{ marginBottom: 12 }} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity
            style={[styles.closeBtn, { marginTop: 16 }]}
            onPress={async () => {
              setError(null);
              setLoading(true);
              try {
                const validItems = await loadQueue();
                setItems(validItems);
                setItemIdx(0);
                setRankIdx(0);
                setExhausted(validItems.length === 0);
              } catch (e: any) {
                setError(friendlyError(e));
              } finally {
                setLoading(false);
              }
            }}
          >
            <Text style={styles.closeBtnText}>Bandyti dar kartą</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.closeBtn, styles.secondaryBtn, { marginTop: 8 }]}
            onPress={() =>
              isMandatory
                ? router.replace({
                    pathname: "/receipt-process",
                    params: { receiptId: String(receiptId), swipeDone: "1" },
                  } as any)
                : router.back()
            }
          >
            <Text style={styles.secondaryBtnText}>
              {isMandatory ? "Praleisti ir žiūrėti kvitą" : "Grįžti"}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {!loading && !refetching && !error && done && !isMandatory && (
        <View style={styles.centered}>
          <Ionicons name="checkmark-circle" size={72} color={colors.primary} />
          <Text style={styles.doneTitle}>Ačiū!</Text>
          <Text style={styles.doneSubtitle}>
            {items.length === 0
              ? "Šiame kvite nėra prekių atpažinimui."
              : "Peržiūrėjai visus kvito produktus."}
          </Text>
          <View style={styles.buttonRow}>
            <TouchableOpacity style={styles.closeBtn} onPress={() => router.back()}>
              <Text style={styles.closeBtnText}>Grįžti į kvitą</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.closeBtn, styles.secondaryBtn]}
              onPress={() => router.replace("/swipe/extra")}
            >
              <Text style={styles.secondaryBtnText}>Gal dar?</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {!loading && !refetching && !error && !done && currentItem && currentCandidate && (
        <View style={styles.stage}>
          {undoVisible && (
            <TouchableOpacity style={styles.toast} onPress={handleUndo} activeOpacity={0.8}>
              <Ionicons name="arrow-undo" size={16} color={colors.onPrimary} />
              <Text style={styles.toastText}>Atšaukti</Text>
            </TouchableOpacity>
          )}

          <GestureDetector gesture={pan}>
            <Animated.View style={[styles.card, cardStyle]}>
              <Animated.View style={[StyleSheet.absoluteFill, styles.cardTint, tintStyle]} />

              <View style={styles.half}>
                <Text style={styles.sideLabel}>KVITE</Text>
                <Text style={styles.ocrName} numberOfLines={3}>
                  {currentItem.ocrName ?? "—"}
                </Text>
                <Text style={styles.subtle}>
                  {formatAmount(currentItem.ocrAmount, currentItem.ocrUnit)}
                </Text>
                {currentItem.ocrPrice != null && (
                  <Text style={styles.price}>{currentItem.ocrPrice.toFixed(2)} €</Text>
                )}
              </View>

              <View style={styles.divider} />

              <View style={styles.half}>
                <Text style={styles.sideLabel}>PASIŪLYMAS</Text>
                {currentCandidate.imageUrl && (
                  <Image
                    source={{ uri: currentCandidate.imageUrl }}
                    style={styles.image}
                    resizeMode="contain"
                  />
                )}
                <Text style={styles.candName} numberOfLines={3}>
                  {currentCandidate.name}
                </Text>
                <Text style={styles.subtle}>
                  {formatAmount(currentCandidate.amount, currentCandidate.unit)}
                </Text>
                <View style={styles.chainRow}>
                  {currentCandidate.chainLogoUrl && (
                    <Image
                      source={{ uri: currentCandidate.chainLogoUrl }}
                      style={styles.chainLogo}
                      resizeMode="contain"
                    />
                  )}
                  <Text style={styles.chainName}>{currentCandidate.chainName}</Text>
                  <Text style={styles.score}>
                    {Math.round(currentCandidate.matchScore * 100)}%
                  </Text>
                </View>
              </View>
            </Animated.View>
          </GestureDetector>

          <View style={styles.legend}>
            <View style={styles.legendItem}>
              <Ionicons name="arrow-back" size={18} color={colors.error} />
              <Text style={styles.legendText}>Skirtingi</Text>
            </View>
            <View style={styles.legendItem}>
              <Ionicons name="arrow-up" size={18} color={colors.info} />
              <Text style={styles.legendText}>Panašūs</Text>
            </View>
            <View style={styles.legendItem}>
              <Ionicons name="arrow-forward" size={18} color={colors.primary} />
              <Text style={styles.legendText}>Identiški</Text>
            </View>
            <View style={styles.legendItem}>
              <Ionicons name="arrow-down" size={18} color={colors.textMuted} />
              <Text style={styles.legendText}>Praleisti</Text>
            </View>
          </View>

          <Text style={styles.progress}>
            {isMandatory && mandatorySwipesRequired > 0
              ? `${mandatorySwipesDoneRef.current + 1} / ${mandatorySwipesRequired}`
              : `${Math.min(itemIdx + 1, items.length)} / ${items.length}`}
          </Text>
        </View>
      )}
    </GestureHandlerRootView>
  );
}

const makeStyles = (c: AppTheme) =>
  StyleSheet.create({
    centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
    errorText: { color: c.error, textAlign: "center", marginBottom: 16, fontSize: 16 },
    doneTitle: { fontSize: 24, fontWeight: "700", color: c.textPrimary, marginTop: 12 },
    doneSubtitle: { color: c.textSecondary, textAlign: "center", marginTop: 8, marginBottom: 20, fontSize: 14 },
    closeBtn: {
      backgroundColor: c.primary,
      paddingVertical: 12,
      paddingHorizontal: 24,
      borderRadius: 12,
    },
    closeBtnText: { color: c.onPrimary, fontWeight: "600", fontSize: 15 },
    buttonRow: { flexDirection: "row", gap: 12 },
    secondaryBtn: {
      backgroundColor: c.cardBackground,
      borderWidth: 1,
      borderColor: c.primary,
    },
    secondaryBtnText: { color: c.primary, fontWeight: "600", fontSize: 15 },

    stage: { flex: 1, padding: 16, alignItems: "center", justifyContent: "center" },

    toast: {
      position: "absolute",
      top: 16,
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.textPrimary,
      paddingVertical: 8,
      paddingHorizontal: 16,
      borderRadius: 20,
      gap: 6,
      zIndex: 10,
    },
    toastText: { color: c.onPrimary, fontWeight: "600", fontSize: 13 },

    card: {
      width: SCREEN_W - 32,
      maxHeight: SCREEN_H * 0.66,
      backgroundColor: c.cardBackground,
      borderRadius: 20,
      padding: 20,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.15,
      shadowRadius: 10,
      elevation: 6,
    },
    cardTint: { borderRadius: 20 },

    half: { paddingVertical: 12, alignItems: "center" },
    sideLabel: {
      fontSize: 11,
      fontWeight: "700",
      color: c.textMuted,
      letterSpacing: 1.5,
      marginBottom: 8,
    },
    ocrName: {
      fontSize: 17,
      fontWeight: "700",
      color: c.textPrimary,
      textAlign: "center",
    },
    candName: {
      fontSize: 16,
      fontWeight: "600",
      color: c.textPrimary,
      textAlign: "center",
      marginTop: 6,
    },
    subtle: { fontSize: 13, color: c.textSecondary, marginTop: 4 },
    price: { fontSize: 15, color: c.textPrimary, fontWeight: "600", marginTop: 4 },

    image: { width: 96, height: 96, marginVertical: 6 },

    chainRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginTop: 8,
    },
    chainLogo: { width: 18, height: 18 },
    chainName: { fontSize: 12, color: c.textSecondary },
    score: {
      marginLeft: 6,
      fontSize: 12,
      color: c.textMuted,
      fontWeight: "600",
    },

    divider: {
      height: 1,
      backgroundColor: c.border,
      marginVertical: 8,
    },

    legend: {
      flexDirection: "row",
      justifyContent: "space-around",
      width: "100%",
      marginTop: 18,
      paddingHorizontal: 24,
    },
    legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
    legendText: { fontSize: 12, color: c.textSecondary },

    progress: {
      marginTop: 14,
      fontSize: 13,
      color: c.textMuted,
      fontWeight: "600",
    },
  });
