-- Optional header / footer images for generated letters (Organization Settings > Branding).
ALTER TABLE "organizations" ADD COLUMN "letterHeaderUrl" TEXT;
ALTER TABLE "organizations" ADD COLUMN "letterFooterUrl" TEXT;
