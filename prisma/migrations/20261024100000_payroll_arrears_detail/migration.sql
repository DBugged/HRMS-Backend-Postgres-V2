-- Which locked/paid months a supplementary arrears run makes good (prevents paying the same difference twice). Additive.
ALTER TABLE "payroll_runs" ADD COLUMN "arrearsDetail" JSONB;
