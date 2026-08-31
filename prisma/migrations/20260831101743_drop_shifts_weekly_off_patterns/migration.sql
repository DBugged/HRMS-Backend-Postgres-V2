-- Drop standalone reference-catalog tables (Shifts, Weekly Off Patterns).
-- Superseded by Work Schedules, which already captures the same
-- shift/hours and off-pattern info in one place.
DROP TABLE IF EXISTS "shifts";
DROP TABLE IF EXISTS "weekly_off_patterns";
