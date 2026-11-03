// Purpose: the page a notification opens, worked out from what it says, for every notification that was stored without one.
// Responsibilities: pure rules over the title (and the category as a last resort); no database. Used when the inbox is read, so
//   notifications already in the table open the right page too, and a new kind only needs a line here.
// Important: titles are directional - "... Requested" goes to the approver, "... Approved / Rejected" to the person who asked - so
//   the rule alone picks "the approvals page" or "my own page" and the recipient's role is not needed. A link a sender set
//   explicitly always wins (see withLink).

// [pattern on the title, page]. First match wins, so the specific ones come first.
const RULES: Array<[RegExp, string]> = [
  // Attendance, work from home and regularization
  [/^Work From Home (Requested|Withdrawn)/, '/attendance-approvals'],
  [/^Attendance Regularization Requested/, '/attendance-approvals'],
  [/^Work From Home Request/, '/attendance?view=mine'],
  [/^Regularization Request/, '/attendance?view=mine'],
  [/^Attendance Import Batch Uploaded/, '/attendance'],
  [/^Overtime (Requested|requests from an attendance import)/, '/overtime-approvals'],
  [/^Overtime Request/, '/attendance?view=mine'],
  [/^(Punch-Out Missing|Punch-Out Reminder|Marked Absent|Marked Late|You did not punch out|Mark your attendance|Remember to check out|Still checked in)/, '/attendance?view=mine'],
  // Leave, comp-off, encashment, event leave
  [/^(Leave Application Pending Final Approval|New Leave Application|Leave Cancellation Request$|Approved Leave Cancelled|Leave Encashment Requested|Event Leave (Requested|Awaiting Final Approval))/, '/leaves'],
  [/^(Leave |Event Leave)/, '/leaves?view=mine'],
  [/^Comp-Off (Requested|Withdrawn)/, '/comp-offs'],
  [/^Comp-Off/, '/comp-offs?view=mine'],
  // Pay
  [/^(Revised payslip|Payslip for)/, '/payroll?view=mine'],
  [/^Salary structure revised/, '/my-salary-structure'],
  [/^Full & Final Settlement/, '/settlements'],
  [/^Reimbursement Claims? Submitted/, '/reimbursements'],
  [/^Reimbursement Claim/, '/reimbursements?view=mine'],
  [/^Loan\/Advance Request Pending Review/, '/loans'],
  [/^(Loan |Your .* EMI)/, '/loans?view=mine'],
  [/^(Submit your tax declaration|Tax Declaration)/, '/tax-declaration'],
  [/^Payroll processing on/, '/payroll'],
  [/ due on /, '/statutory-compliance'],
  [/^Performance Rating Published/, '/my-performance'],
  // Joining, exit and resignations
  [/^Resignation (Submitted|Recorded|Withdrawn|Withdrawal Requested|waiting)/, '/resignations'],
  [/^(Resignation |Withdrawal )/, '/my-resignation'],
  [/^(Exit task assigned|Exit clearance open)/, '/offboarding'],
  [/^(Offboarding Process Initiated|Last Working Day Updated|Your last working day|Return your company assets)/, '/my-resignation'],
  [/^(Joining task assigned|\d+ joining tasks? needs?)/, '/onboarding-checklist'],
  [/^Please complete your onboarding/, '/profile'],
  // Documents and profile
  [/^Please acknowledge:/, '/documents'],
  [/^\d+ required documents?\(?s?\)? still missing/, '/profile'],
  [/employee\(s\) have required documents missing/, '/pending-onboarding'],
  [/^Document (Approved|Rejected)/, '/profile'],
  [/^Address Updated/, '/profile'],
  [/^Complete your profile/, '/profile'],
  // Company housekeeping
  [/^Warranty ends|^Warranty ending/, '/asset-inventory'],
  [/^Add \d{4}'s holidays/, '/holidays'],
  [/^Retention review due|breach/i, '/data-privacy'],
  [/organization setup issue/, '/organization-settings'],
  [/automatic letter\/email template/, '/letter-templates'],
  [/probation/i, '/probation'],
];

// The page a notification with this title opens, or null for one with nowhere to go (a greeting, a general announcement).
export function resolveNotificationLink(title: string | null | undefined): string | null {
  const t = (title ?? '').trim();
  if (!t) return null;
  for (const [pattern, path] of RULES) if (pattern.test(t)) return path;
  return null;
}

// The notification as the inbox returns it: its own link when it has one, otherwise the page worked out from its title.
export function withLink<T extends { title: string; link?: string | null }>(n: T): T & { link: string | null } {
  return { ...n, link: n.link || resolveNotificationLink(n.title) };
}
