import { disablePasswordRotationGuard } from './password-rotation-guard.testing';

// Runs before every e2e spec — see password-rotation-guard.testing.ts for why
// the guard is off by default and which spec turns it back on.
disablePasswordRotationGuard();
