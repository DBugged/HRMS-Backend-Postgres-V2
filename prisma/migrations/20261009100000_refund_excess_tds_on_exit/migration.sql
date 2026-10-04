-- Final settlement: refund TDS withheld in excess of the tax on income actually earned.
ALTER TABLE "payroll_settings" ADD COLUMN "refundExcessTdsOnExit" BOOLEAN NOT NULL DEFAULT true;
