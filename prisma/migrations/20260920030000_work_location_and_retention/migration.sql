-- Per-employee work location override + EmployeeMovement location history (additive).
ALTER TABLE "users" ADD COLUMN "workLocationId" TEXT;
ALTER TABLE "employee_movements" ADD COLUMN "previousWorkLocationId" TEXT;
ALTER TABLE "employee_movements" ADD COLUMN "newWorkLocationId" TEXT;

CREATE INDEX "users_organizationId_workLocationId_idx" ON "users"("organizationId", "workLocationId");

ALTER TABLE "users" ADD CONSTRAINT "users_workLocationId_fkey" FOREIGN KEY ("workLocationId") REFERENCES "work_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Data-only: suggested retention periods for existing orgs. Fills periodMonths ONLY where currently null/absent;
-- never overwrites an admin-set value. Actions are left untouched (never auto-delete). Also appends the
-- privacy_audit_logs rule when missing.
UPDATE "privacy_settings" ps
SET "retentionRules" = (
  SELECT COALESCE(jsonb_agg(
    CASE
      WHEN (r.rule->>'periodMonths') IS NULL AND s.months IS NOT NULL THEN
        r.rule || jsonb_build_object(
          'periodMonths', s.months,
          'basis', CASE WHEN COALESCE(r.rule->>'basis', '') = '' THEN 'Suggested default — confirm with legal counsel' ELSE r.rule->>'basis' END
        )
      ELSE r.rule
    END ORDER BY r.ord), '[]'::jsonb)
  FROM jsonb_array_elements(ps."retentionRules") WITH ORDINALITY AS r(rule, ord)
  LEFT JOIN (VALUES
    ('employee_profile', 96), ('payroll_records', 96), ('loan_records', 96), ('attendance_records', 96),
    ('leave_records', 96), ('documents', 96), ('notifications', 12), ('sessions_tokens', 12),
    ('audit_logs', 36), ('privacy_audit_logs', 36)
  ) AS s(data_type, months) ON s.data_type = r.rule->>'dataType'
)
WHERE jsonb_typeof(ps."retentionRules") = 'array' AND jsonb_array_length(ps."retentionRules") > 0;

UPDATE "privacy_settings"
SET "retentionRules" = "retentionRules" || jsonb_build_array(jsonb_build_object(
  'dataType', 'privacy_audit_logs', 'label', 'Privacy audit log entries', 'periodMonths', 36,
  'basis', 'Suggested default — confirm with legal counsel', 'action', 'ARCHIVE', 'legalReviewRequired', true))
WHERE jsonb_typeof("retentionRules") = 'array' AND jsonb_array_length("retentionRules") > 0
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements("retentionRules") e WHERE e->>'dataType' = 'privacy_audit_logs');
