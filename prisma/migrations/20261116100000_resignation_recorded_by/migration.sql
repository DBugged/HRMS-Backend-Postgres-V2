-- A resignation HR or an Admin recorded on the employee's behalf (given by email or in person): the id of whoever
-- entered it. NULL = the employee submitted it themselves.
ALTER TABLE "resignations" ADD COLUMN "recordedById" TEXT;
