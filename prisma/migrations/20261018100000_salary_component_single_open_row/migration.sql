-- A component has at most one CURRENT (effectiveTo IS NULL) revision per employee. applyRevision closes the old
-- row and inserts the new one in a transaction; this partial unique index makes a double submit or race fail
-- instead of leaving two open rows that resolveCurrentRows would pick between arbitrarily.
CREATE UNIQUE INDEX "employee_salary_components_one_open_row"
  ON "employee_salary_components" ("organizationId", "employeeId", "componentCode")
  WHERE "effectiveTo" IS NULL;
