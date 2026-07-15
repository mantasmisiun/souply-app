import DocumentScanner, {
    ResponseType,
    ScanDocumentResponseStatus,
} from 'react-native-document-scanner-plugin';

/**
 * Launch the OS document scanner — ML Kit Document Scanner on Android,
 * VisionKit on iOS. Both are free, on-device and give the premium guided
 * capture UX (live edge detection, auto-capture, perspective de-skew,
 * multi-page) with no CV code of ours to maintain.
 *
 * The corrected page image(s) are handed to /receipt-process exactly like the
 * PDF multi-page flow — plain comma-separated `uris` — so the existing OCR →
 * parse → mask-burn-in → upload pipeline is unchanged and masking/privacy are
 * preserved. This is the ONLY scan entry point (the guided multi-segment "long
 * receipt" scanner was removed).
 */

export interface ScanRouteParams {
    /** true → results screen is preview-only (no upload). */
    preview?: boolean;
    shoppingListId?: string;
    expectedChainId?: string;
    /** chainId→listId map (post-completion shopping-list receipt flow). */
    listMap?: string;
    /** true → replace the current route instead of pushing (used by the
     *  "retake" flow from receipt-process, so the failed attempt is swapped
     *  out rather than stacked). */
    replace?: boolean;
}

// Minimal structural type so we don't depend on expo-router's exported Router
// type (which churns between versions). `href` is `any` because typedRoutes
// narrows the real signature to a static union that our runtime query string
// can't satisfy — the same reason the call sites use `as any`.
interface PushRouter {
    push: (href: any) => void;
    replace: (href: any) => void;
}

/** File paths from the scanner may come back without a scheme; OCR/ImageManipulator
 *  need a `file://` URI. */
function toFileUri(path: string): string {
    return /^[a-z]+:\/\//i.test(path) ? path : `file://${path}`;
}

/**
 * Open the scanner; on success route to /receipt-process with the captured
 * page(s). Returns the captured URIs (or null on cancel/failure) in case the
 * caller wants to react.
 */
export async function launchDocumentScanner(
    router: PushRouter,
    params: ScanRouteParams = {},
): Promise<string[] | null> {
    // iOS: every caller invokes this right after closing a JS Modal/overlay (the
    // upload menu, the fail-gate "try again", the shopping-list target picker).
    // Presenting the native VisionKit scanner while that modal is still dismissing
    // wedges the view hierarchy — a frozen, unresponsive screen, worst on the
    // first run where the camera-permission prompt stacks on top. Give the modal
    // a beat to fully dismiss first (the file-picker path already does this).
    await new Promise((resolve) => setTimeout(resolve, 300));

    let scannedImages: string[] | undefined;
    let status: ScanDocumentResponseStatus | undefined;
    try {
        const res = await DocumentScanner.scanDocument({
            // A normal receipt is one page; allow a few so a 2-frame receipt
            // still works. The scanner returns them as ordered pages.
            maxNumDocuments: 5,
            croppedImageQuality: 100,
            responseType: ResponseType.ImageFilePath,
        });
        scannedImages = res.scannedImages;
        status = res.status;
    } catch (e) {
        // Native scanner failed to launch (e.g. the Play Services module is
        // still downloading on first use) — fail soft; the caller's UI stays put.
        console.warn('[docScanner] launch failed', e);
        return null;
    }

    if (status === ScanDocumentResponseStatus.Cancel) return null;
    if (!scannedImages || scannedImages.length === 0) return null;

    const uris = scannedImages.map(toFileUri);
    const qp = new URLSearchParams();
    if (uris.length === 1) {
        qp.set('uri', uris[0]);
    } else {
        qp.set('uris', uris.join(','));
    }
    if (params.preview) qp.set('preview', 'true');
    if (params.shoppingListId) qp.set('shoppingListId', params.shoppingListId);
    if (params.expectedChainId) qp.set('expectedChainId', params.expectedChainId);
    if (params.listMap) qp.set('listMap', params.listMap);

    const href = `/receipt-process?${qp.toString()}`;
    if (params.replace) router.replace(href);
    else router.push(href);
    return uris;
}
