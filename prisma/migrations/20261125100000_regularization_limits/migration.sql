-- Optional caps on regularization requests; NULL means no limit (the existing behaviour).
ALTER TABLE "organizations"
  ADD COLUMN "regularizationMonthlyLimit" INTEGER,
  ADD COLUMN "regularizationResubmitLimit" INTEGER;
