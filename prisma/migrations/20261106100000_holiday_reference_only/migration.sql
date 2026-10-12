-- A calendar upload may now include dates that already passed. They are saved inactive (so no calculation reads them)
-- and flagged as reference records so the calendar can still list them as past holidays. Additive; every existing
-- holiday stays an ordinary one.
ALTER TABLE "holidays" ADD COLUMN "isReference" BOOLEAN NOT NULL DEFAULT false;
