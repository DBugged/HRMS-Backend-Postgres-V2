-- Per-employee exemption from the Labour Welfare Fund (managerial / supervisory above the wage limit).
ALTER TABLE "users" ADD COLUMN "lwfExempt" BOOLEAN NOT NULL DEFAULT false;
