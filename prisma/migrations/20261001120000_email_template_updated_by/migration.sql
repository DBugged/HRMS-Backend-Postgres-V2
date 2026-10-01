-- Who last saved an email template row — optimistic concurrency's companion field,
-- surfaced on the Email Templates table so editors see who touched it before them.
ALTER TABLE "email_templates" ADD COLUMN "updatedById" TEXT;

ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
