-- A leave spanning New Year charges each year its own days. Additive; existing leaves keep charging their start year.
ALTER TABLE "leaves" ADD COLUMN "yearSplit" JSONB;
