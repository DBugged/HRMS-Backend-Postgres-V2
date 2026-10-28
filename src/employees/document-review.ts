// Purpose: how many of each employee's uploaded documents are waiting for review or were rejected, so the Employee Directory can show a
//   profile as "In review" until HR/Admin has looked at what was uploaded.
// Responsibilities: pure counting over (employeeId, status) rows; no database.
export interface DocumentReview {
  pending: number;
  rejected: number;
}

export function summarizeDocumentReview(docs: { employeeId: string; status: string }[]): Map<string, DocumentReview> {
  const out = new Map<string, DocumentReview>();
  for (const d of docs) {
    if (d.status !== 'PENDING' && d.status !== 'REJECTED') continue;
    const cur = out.get(d.employeeId) ?? { pending: 0, rejected: 0 };
    if (d.status === 'PENDING') cur.pending += 1;
    else cur.rejected += 1;
    out.set(d.employeeId, cur);
  }
  return out;
}
