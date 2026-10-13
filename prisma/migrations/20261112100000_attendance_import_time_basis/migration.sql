-- Which timezone the bare times in an attendance import sheet are written in ("UTC" keeps the old behaviour).
ALTER TABLE "attendance_import_batches" ADD COLUMN "timeBasis" TEXT NOT NULL DEFAULT 'UTC';
