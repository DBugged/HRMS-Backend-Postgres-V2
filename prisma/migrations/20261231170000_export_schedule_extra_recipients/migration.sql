-- Outside email addresses a scheduled export may be sent to, each confirmed by a link sent to that address.
ALTER TABLE "cc_export_schedules" ADD COLUMN "extraRecipients" JSONB NOT NULL DEFAULT '[]';
