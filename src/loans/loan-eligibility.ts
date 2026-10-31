// Purpose: Who may take a loan or salary advance.
// Important: only a confirmed, permanent employee. Interns, trainees, contract staff and anyone still on probation
//   (or on extended probation) are not eligible. Confirming someone on probation also turns their type into
//   Permanent (see EmployeeProfileService), so both conditions hold for a normal confirmation.

// Told to the approver when someone who is not confirmed and permanent applies: they are not blocked, the approver decides.
export const LOAN_ELIGIBILITY_NOTE = 'Note: this employee is not a confirmed permanent employee.';

export const LOAN_ELIGIBILITY_MESSAGE =
  'Loans and advances are only for confirmed, permanent employees. Employees on probation, interns and other non-permanent staff are not eligible.';

export function isLoanEligible(employee: {
  employmentStatus?: string | null;
  employeeType?: string | null;
}): boolean {
  return (
    employee.employmentStatus === 'CONFIRMED' &&
    (employee.employeeType ?? 'permanent') === 'permanent'
  );
}
