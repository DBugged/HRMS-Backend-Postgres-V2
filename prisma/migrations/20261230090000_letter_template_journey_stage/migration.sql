-- Which stage of an employee's journey a letter template belongs to (HIRING, PROBATION, EMPLOYMENT, DISCIPLINARY, EXIT), set by the admin
-- on a custom template. NULL = not part of the flow (listed under "Other letters"). Built-in templates ignore it: their stage is fixed.
ALTER TABLE "letter_templates" ADD COLUMN "journeyStage" TEXT;
