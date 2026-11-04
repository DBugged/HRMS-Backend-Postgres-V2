-- Company-level live-tracking settings (how often the phone shares its location, the distance that triggers an early point, and how
-- many days points are kept). NULL = the built-in defaults (5 minutes, 200 m, 60 days), so existing companies behave as before.
ALTER TABLE "organizations" ADD COLUMN "fieldTrackingSettings" JSONB;
