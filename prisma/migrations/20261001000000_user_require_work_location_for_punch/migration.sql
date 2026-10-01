-- Per-employee (not org-wide) toggle: office-based employees need a work
-- location assigned for the geo-fence to apply; remote/field employees
-- genuinely have none, and that's fine for them. Off by default.
ALTER TABLE "users" ADD COLUMN "requireWorkLocationForPunch" BOOLEAN NOT NULL DEFAULT false;
