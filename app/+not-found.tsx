import { Redirect } from 'expo-router';

// Catch-all for unmatched routes (share-intent deep links, stale bookmarks, etc.)
// Any path that reaches here sends the user home silently.
export default function NotFound() {
    return <Redirect href="/" />;
}
