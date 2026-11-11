-- The product name is written "D'Rect HR" (with a space). Plan feature lines were seeded as "D'RectHR".
UPDATE "cc_plans"
SET "features" = replace("features"::text, 'D''RectHR', 'D''Rect HR')::jsonb
WHERE "features"::text LIKE '%D''RectHR%';
