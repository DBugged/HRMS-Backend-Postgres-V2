-- Per-member EPS (pension) exclusion for the PF ECR: members outside EPS get no EPS share, and a member who becomes an
-- EPS member part-way through a month (the 17-Sep-2026 wage-ceiling change) is split by days. Additive; every existing
-- employee stays an EPS member as before.
ALTER TABLE "users" ADD COLUMN "epsExcluded" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "epsExcludedUntil" TEXT;
