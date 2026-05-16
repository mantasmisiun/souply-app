import { devLog } from './devLog';

/**
 * Global JS-side crash reporter for the DEV variant.
 *
 * iOS native crashes need Xcode (or `idevicesyslog`) to capture; this
 * misses those. But MOST React Native crashes on iOS surface as a JS
 * error first — either a thrown Error inside React's render path, or
 * an uncaught promise rejection from a native bridge call. Both go
 * through ErrorUtils.setGlobalHandler. We intercept them, POST to
 * `/api/dev-log`, and re-throw so the original handler still runs
 * (which usually shows the redbox in dev or hard-crashes in
 * release).
 *
 * Idempotent — safe to call multiple times. Production-build no-op.
 */
export function installCrashReporter(): void {
    if (!__DEV__ && typeof process !== 'undefined' && process.env.NODE_ENV !== 'development') {
        // Only ship from the DEV variant; the dev-log endpoint is
        // dev-only and prod builds shouldn't hit it.
    }
    const g = globalThis as unknown as {
        ErrorUtils?: {
            getGlobalHandler: () => (error: unknown, isFatal?: boolean) => void;
            setGlobalHandler: (handler: (error: unknown, isFatal?: boolean) => void) => void;
        };
        __souplyCrashReporterInstalled?: boolean;
    };
    if (g.__souplyCrashReporterInstalled) return;
    g.__souplyCrashReporterInstalled = true;

    if (g.ErrorUtils) {
        const previous = g.ErrorUtils.getGlobalHandler();
        g.ErrorUtils.setGlobalHandler((error, isFatal) => {
            try {
                const err = error as Error | undefined;
                devLog('crash.js', {
                    isFatal: !!isFatal,
                    name: err?.name,
                    message: err?.message,
                    stack: err?.stack?.split('\n').slice(0, 30).join('\n'),
                });
            } catch {
                // Never let logging itself crash the handler.
            }
            previous?.(error, isFatal);
        });
    }

    // Unhandled promise rejections — RN doesn't always route these
    // through ErrorUtils. Subscribe to the global hook if present.
    const tracking = (globalThis as any).HermesInternal?.enablePromiseRejectionTracker;
    if (typeof tracking === 'function') {
        try {
            tracking({
                allRejections: true,
                onUnhandled: (id: number, rejection: unknown) => {
                    const err = rejection as Error | undefined;
                    devLog('crash.promise', {
                        id,
                        name: err?.name,
                        message: err?.message ?? String(rejection),
                        stack: err?.stack?.split('\n').slice(0, 30).join('\n'),
                    });
                },
            });
        } catch {
            // ignore
        }
    }
}
