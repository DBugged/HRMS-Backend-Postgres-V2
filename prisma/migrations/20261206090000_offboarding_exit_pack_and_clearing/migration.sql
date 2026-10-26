-- Markers for two automatic exit steps: pending requests closed after the last working day, and the final-documents pack emailed.
ALTER TABLE "offboarding_cases"
  ADD COLUMN "pendingClearedAt" TIMESTAMP(3),
  ADD COLUMN "exitPackSentAt" TIMESTAMP(3);
