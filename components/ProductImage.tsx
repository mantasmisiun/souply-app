import { Image, type ImageContentFit } from "expo-image";
import { useEffect, useMemo, useRef, useState } from "react";
import {
    ImageStyle,
    StyleProp,
    Text,
    TextStyle,
    View,
    ViewStyle,
} from "react-native";

type UriInput =
  | (string | null | undefined)[]
  | string
  | null
  | undefined;

// Legacy RN resizeMode strings that callers still pass; mapped to contentFit.
type LegacyResizeMode = "cover" | "contain" | "stretch" | "repeat" | "center";

type Props = {
  // Accepts either a parsed array of URLs or the raw JSON string that MySQL's
  // JSON_ARRAYAGG sometimes returns — saves every call-site from parsing.
  uris?: UriInput;
  imageStyle?: StyleProp<ImageStyle>;
  placeholderStyle?: StyleProp<ViewStyle>;
  emojiStyle?: StyleProp<TextStyle>;
  resizeMode?: LegacyResizeMode;
  emoji?: string;
  /** Fired ONCE when this image has settled — either it loaded a real image
   *  (ok=true) or every URL failed and the placeholder is shown (ok=false).
   *  Lets a parent gate a loading state on the image actually being ready. */
  onSettled?: (ok: boolean) => void;
};

const resizeModeToContentFit = (mode?: LegacyResizeMode): ImageContentFit => {
  switch (mode) {
    case "cover":
      return "cover";
    case "stretch":
      return "fill";
    case "center":
      return "scale-down";
    case "repeat":
      return "cover";
    case "contain":
    default:
      return "contain";
  }
};

function normalizeUris(input: UriInput): string[] {
  if (!input) return [];
  let arr: unknown = input;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((u): u is string => typeof u === "string" && u.length > 0);
}

/**
 * URL → "is this a real image?" verdict, remembered for the session.
 *
 * The HEAD pre-check below is what catches CDN placeholders (a 200 with
 * `x-cld-error`, or a 300-byte "not found" PNG) that no decoder can spot. It ran
 * on EVERY mount, so scrolling a product grid fired a HEAD request per card per
 * pass — dozens of round trips and as many state updates on the JS thread, which
 * is exactly what made the list stutter. A URL's verdict can't change mid
 * session, so it's cached here and each one is checked at most once.
 */
const verdicts = new Map<string, boolean>();
/** In-flight checks, so two cards showing the same URL share one request. */
const pending = new Map<string, Promise<boolean>>();

function verifyUri(uri: string): Promise<boolean> {
    const known = verdicts.get(uri);
    if (known !== undefined) return Promise.resolve(known);
    const existing = pending.get(uri);
    if (existing) return existing;
    const p = (async () => {
        let ok = true;
        try {
            const res = await fetch(uri, { method: 'HEAD' });
            const len = Number(res.headers.get('content-length') || 0);
            // Not found, an explicit Cloudinary error, or too small to be a real
            // product image (a placeholder served with a 200).
            ok = res.ok && !res.headers.get('x-cld-error') && !(len > 0 && len < 1024);
        } catch {
            ok = false;
        }
        verdicts.set(uri, ok);
        pending.delete(uri);
        return ok;
    })();
    pending.set(uri, p);
    return p;
}

/**
 * Product-level image with fallback chain: tries each URL in `uris` in order
 * and swaps in a 🫜 placeholder once all have failed or there are no URIs.
 * For single-URL views, pass `uris={[single]}`.
 */
export function ProductImage({
  uris,
  imageStyle,
  placeholderStyle,
  emojiStyle,
  resizeMode = "contain",
  emoji = "🫜",
  onSettled,
}: Props) {
  const list = useMemo(() => normalizeUris(uris), [uris]);
  const [idx, setIdx] = useState(0);

  // Fire onSettled exactly once per `list`: on a real load or once the
  // placeholder is shown (all URLs exhausted / no URLs).
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const settledRef = useRef(false);
  const settle = (ok: boolean) => {
    if (!settledRef.current) {
      settledRef.current = true;
      onSettledRef.current?.(ok);
    }
  };

  // Reset to the first URL whenever the input changes.
  useEffect(() => {
    setIdx(0);
    settledRef.current = false;
  }, [list]);

  // Placeholder reached (no URLs or all failed) → settle(false).
  useEffect(() => {
    if (idx >= list.length) settle(false);
  }, [idx, list]);

  // Pre-verify the current URL with a HEAD request so we can spot CDN fallback
  // responses (e.g. Cloudinary's `x-cld-error` header on a valid 250x212 PNG
  // that's actually a "not found" placeholder). Pure image-decode libraries
  // can't catch these; the server returns a legit image.
  const verifyTokenRef = useRef(0);
  useEffect(() => {
    if (idx >= list.length) return;
    const uri = list[idx];
    // Already judged (this session) → decide synchronously, no request, no
    // re-render churn as the grid recycles this card.
    const known = verdicts.get(uri);
    if (known === false) { setIdx(i => i + 1); return; }
    if (known === true) return;
    const token = ++verifyTokenRef.current;
    void verifyUri(uri).then(ok => {
      if (token !== verifyTokenRef.current) return;
      if (!ok) setIdx(i => i + 1);
    });
  }, [idx, list]);

  if (idx >= list.length) {
    return (
      <View style={placeholderStyle}>
        <Text style={emojiStyle}>{emoji}</Text>
      </View>
    );
  }

  return (
    <Image
      key={list[idx]}
      source={{ uri: list[idx] }}
      style={imageStyle}
      contentFit={resizeModeToContentFit(resizeMode)}
      transition={0}
      onError={() => { verdicts.set(list[idx], false); setIdx((i) => i + 1); }}
      onLoad={(event) => {
        const w = event?.source?.width ?? 0;
        const h = event?.source?.height ?? 0;
        // Decoded but suspiciously tiny → treat as a placeholder/broken image.
        if (w > 0 && h > 0 && (w < 16 || h < 16)) {
          verdicts.set(list[idx], false);
          setIdx((i) => i + 1);
          return;
        }
        settle(true);
      }}
    />
  );
}
