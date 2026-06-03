import { useAuthState } from '../state/authState';
import { CreateUsernameModal } from './CreateUsernameModal';

/**
 * Root-level gate: a signed-in creator who never picked a @username gets
 * re-prompted on every app open until they set one — parity with the web,
 * which re-shows its (non-dismissible) modal on each session restore.
 *
 * Only fires for verified/OAuth users (`authState.user`): anonymous users
 * aren't creators and are never asked. The modal calls
 * `updateUser({ username })` on success, flipping the condition, so this
 * gate hides itself with no extra wiring.
 */
export function UsernameGate() {
    const user = useAuthState((s) => s.user);
    const needsUsername = !!user && !user.username;
    return <CreateUsernameModal visible={needsUsername} onDone={() => {}} />;
}
