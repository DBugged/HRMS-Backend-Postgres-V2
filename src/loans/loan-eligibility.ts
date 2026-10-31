// Purpose: Who may take a loan or salary advance.
// Important: only a confirmed, permanent employee. Interns, trainees, contract staff and anyone still on probation
//   (or on extended probation) are not eligible. Confirming someone on probation also turns their type into
//   Permanent (see EmployeeProfileService), so both conditions hold for a normal confirmation.

export const LOAN_ELIGIBILITY_MESSAGE =
  'Loans and advances are only for confirmed, permanent employees. Employees on probation, interns and other non-permanent staff are not eligible.';

// Admin, HR and Managers may still ask for a loan or advance when they are not (yet) confirmed and permanent: the request goes
// to an approver, who decides. Everyone else is held to the rule when they apply.
export const LOAN_ELIGIBILITY_OVERRIDE_ROLES = ['ADMIN', 'HR', 'MANAGER'] as const;

export function canRequestDespiteEligibility(role: string): boolean {
  return (LOAN_ELIGIBILITY_OVERRIDE_ROLES as readonly string[]).includes(role);
}

export function isLoanEligible(employee: {
  employmentStatus?: string | null;
  employeeType?: string | null;
}): boolean {
  return (
    employee.employmentStatus === 'CONFIRMED' &&
    (employee.employeeType ?? 'permanent') === 'permanent'
  );
}
