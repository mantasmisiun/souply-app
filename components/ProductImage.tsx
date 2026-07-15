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
    const token = ++verifyTokenRef.current;
    const uri = list[idx];
    (async () => {
      try {
        const res = await fetch(uri, { method: "HEAD" });
        if (token !== verifyTokenRef.current) return;
        if (!res.ok) {
          setIdx((i) => i + 1);
          return;
        }
        if (res.headers.get("x-cld-error")) {
          // Cloudinary explicitly signals the resource wasn't found.
          setIdx((i) => i + 1);
          return;
        }
        const len = Number(res.headers.get("content-length") || 0);
        if (len > 0 && len < 1024) {
          // Too small to be a real product image — almost certainly a placeholder.
          setIdx((i) => i + 1);
        }
      } catch {
        if (token === verifyTokenRef.current) {
          setIdx((i) => i + 1);
        }
      }
    })();
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
      onError={() => setIdx((i) => i + 1)}
      onLoad={(event) => {
        const w = event?.source?.width ?? 0;
        const h = event?.source?.height ?? 0;
        // Decoded but suspiciously tiny → treat as a placeholder/broken image.
        if (w > 0 && h > 0 && (w < 16 || h < 16)) {
          setIdx((i) => i + 1);
          return;
        }
        settle(true);
      }}
    />
  );
}
