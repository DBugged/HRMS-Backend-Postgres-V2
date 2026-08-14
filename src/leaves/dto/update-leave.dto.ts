import { ApplyLeaveDto } from './apply-leave.dto';

// PUT /leaves/:id — self-only, pending-only (enforced in LeavesService).
// Old system's updatePendingLeave re-runs the FULL apply flow (cancels the
// old row, creates a new one via editedFromLeaveId) rather than patching
// fields, so this takes the same full shape as ApplyLeaveDto, not a
// partial.
export class UpdateLeaveDto extends ApplyLeaveDto {}
