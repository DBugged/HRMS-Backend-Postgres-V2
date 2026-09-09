import { PasswordRotationGuard } from '../src/common/guards/password-rotation.guard';

// ---------------------------------------------------------------------------
// PasswordRotationGuard blocks every non-allowlisted route while
// User.mustChangePassword is true, so an emailed temporary password can't
// drive the whole API without ever being rotated.
//
// Almost every e2e spec builds its fixtures through POST /employees and then
// logs in with the temporary password that endpoint returns — a flow the
// product now forbids. Rather than bolt a change-password call onto ~140
// fixture sites (which would also invalidate the temporary password several
// specs reuse), test/setup-e2e.ts disables the guard for those suites.
//
// The guard's real behaviour is not lost: password-rotation.e2e-spec.ts calls
// restore() and exercises it end to end against the running app.
//
// An earlier version of this harness cleared mustChangePassword in the
// database after every login instead. It worked, but it needed a second
// PrismaClient per spec file on top of the app's own two, and the extra
// connection pools intermittently starved later suites at boot. Swapping a
// method on the guard needs no connection at all and cannot race.
// ---------------------------------------------------------------------------

// Kept as a plain reference purely to put it straight back on the prototype.
// eslint-disable-next-line @typescript-eslint/unbound-method
const original = PasswordRotationGuard.prototype.canActivate;

export function disablePasswordRotationGuard(): void {
  PasswordRotationGuard.prototype.canActivate = () => true;
}

export function restorePasswordRotationGuard(): void {
  PasswordRotationGuard.prototype.canActivate = original;
}
