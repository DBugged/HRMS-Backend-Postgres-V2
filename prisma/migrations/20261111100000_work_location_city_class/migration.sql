-- Where an employee is hired (metro city / other city / village) decides how HRA is set up.
CREATE TYPE "CityClass" AS ENUM ('METRO', 'NON_METRO', 'RURAL');
ALTER TABLE "work_locations" ADD COLUMN "city" TEXT NOT NULL DEFAULT '', ADD COLUMN "cityClass" "CityClass" NOT NULL DEFAULT 'NON_METRO';

-- Existing locations: a name or address that mentions one of the eight HRA cities is a metro location.
UPDATE "work_locations" SET "cityClass" = 'METRO'
WHERE "name" || ' ' || "address" ~* '(mumbai|bombay|delhi|kolkata|calcutta|chennai|madras|bengaluru|bangalore|hyderabad|pune|ahmedabad)';
