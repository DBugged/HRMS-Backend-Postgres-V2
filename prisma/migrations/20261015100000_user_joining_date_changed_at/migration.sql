-- Marks that an employee's joining date was already corrected once (HR/Admin may correct it only one time).
ALTER TABLE "users" ADD COLUMN "joiningDateChangedAt" TIMESTAMP(3);
