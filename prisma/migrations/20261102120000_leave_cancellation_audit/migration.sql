-- Who cancelled a leave and when. Additive; existing cancelled leaves have none.
ALTER TABLE "leaves" ADD COLUMN "cancelledById" TEXT;
ALTER TABLE "leaves" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "leaves" ADD CONSTRAINT "leaves_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
