import * as Sentry from '@sentry/react-native';
import { APP_ENV } from './env';

// Public, write-only ingest DSN — safe to ship in the binary (it can only
// POST events). Overridable per EAS profile via EXPO_PUBLIC_SENTRY_DSN.
const DEFAULT_DSN =
    'https://b7b1c1127468d82fd37504dd46b37d54@o4511502732361728.ingest.de.sentry.io/4511502774894672';

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN ?? DEFAULT_DSN;

// Initialise once at module load. `enabled:false` in local dev (Metro /
// __DEV__) so we don't ship our own debugging errors to Sentry; staging +
// prod builds report tagged by APP_ENV. Error Monitoring only — no
// performance tracing (free-tier quota).
Sentry.init({
    dsn,
    enabled: APP_ENV !== 'dev',
    environment: APP_ENV,
    tracesSampleRate: 0,
});

export { Sentry };
