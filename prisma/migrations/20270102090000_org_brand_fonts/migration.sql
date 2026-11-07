-- Company-chosen fonts: one for headings, one for body text (defaults match the app's own fonts).
ALTER TABLE "organizations" ADD COLUMN "headingFont" TEXT NOT NULL DEFAULT 'Plus Jakarta Sans';
ALTER TABLE "organizations" ADD COLUMN "bodyFont" TEXT NOT NULL DEFAULT 'Inter';
