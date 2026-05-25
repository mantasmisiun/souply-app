/**
 * Intercept URLs from the iOS share extension / Android intent before
 * expo-router tries to match them against registered routes.
 *
 * On iOS the `expo-share-intent` Share Extension dispatches files to
 * the host app by opening a URL of the shape:
 *
 *   souply://dataUrl=<key>#<media|file|text>
 *
 * (see node_modules/expo-share-intent/plugin/build/ios/
 *      ShareExtensionViewController.swift, `redirectToHostApp`)
 *
 * expo-router sees that URL and tries to route to the path part
 * (`/dataUrl=<key>`). Since no route by that name exists, the user
 * lands on the unmatched-route screen ("no route" in dev, the
 * generated +not-found in prod). The actual share data is handled
 * separately by expo-share-intent's native module via `useLinkingURL`,
 * which pulls the file content out of the App Group container and
 * populates `useShareIntentContext`. ShareHandler in app/_layout.tsx
 * then navigates to `/receipt-process` with the file URIs.
 *
 * So: for share-intent URLs we redirect expo-router to `/` (the tab
 * navigator root), letting expo-share-intent's independent handler do
 * its work. For every other URL we pass through unchanged.
 *
 * This is the official expo-router hook for this exact problem —
 * https://docs.expo.dev/router/advanced/native-intent/.
 */
export function redirectSystemPath({
    path,
    initial: _initial,
}: {
    path: string | null;
    initial: boolean;
}): string | null | undefined {
    try {
        if (path && path.includes('dataUrl=')) {
            return '/';
        }
    } catch (e) {
        console.warn('[+native-intent] redirect failed', e);
    }
    return path;
}
