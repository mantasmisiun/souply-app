import { Redirect, usePathname } from 'expo-router';

// Catch-all for unmatched routes. Share-intent URLs arrive as
// `souply:///dataUrl=<key>` — the iOS Linking event can race with
// expo-router's initial render so +native-intent.tsx doesn't always
// intercept them in time. Redirect silently to home; expo-share-intent's
// independent native module surfaces the actual shared data through
// useShareIntentContext regardless of which route we're on.
export default function NotFound() {
    const path = usePathname();
    if (path.includes('dataUrl=')) {
        return <Redirect href="/" />;
    }
    // Fall through to nothing — or add a real 404 UI here later.
    return null;
}
