-- Dashboards and reports filter leaves by status and a start/end window, and count attendance rows whose
-- regularization request is still pending (a JSON field, so a plain index cannot help). Both ran as scans over an
-- organization's whole history on every dashboard load.

-- Leave requests by organization + status + start date (approved leave overlapping a month, pending requests).
CREATE INDEX "leaves_organizationId_status_startDate_idx" ON "leaves"("organizationId", "status", "startDate");

-- Partial index holding only the attendance rows with a pending regularization. Matches the predicate Prisma
-- generates for { regularization: { path: ['status'], equals: 'pending' } }; it stays tiny because few rows are
-- ever pending. (Prisma cannot express a partial index in schema.prisma, so it lives only in this migration.)
CREATE INDEX "attendances_pending_regularization_idx"
  ON "attendances"("organizationId")
  WHERE (("regularization" #> ARRAY['status']::text[])::jsonb = '"pending"'::jsonb);
