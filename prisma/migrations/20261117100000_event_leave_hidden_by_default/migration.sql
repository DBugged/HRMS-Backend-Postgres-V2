-- Event-based leave (maternity, paternity, bereavement...) is one-off and granted by HR, so it should not appear in the
-- Leave Tracker / Leave Balances views unless HR opts in. The checkbox ("Show in Leave Tracker or Leave Balances") used
-- to default to ticked for every type; untick it on the existing event-based ones (HR can tick any back on).
UPDATE "leave_types" SET "showInLeaveTracker" = false WHERE "allocationType" = 'EVENT_BASED';
