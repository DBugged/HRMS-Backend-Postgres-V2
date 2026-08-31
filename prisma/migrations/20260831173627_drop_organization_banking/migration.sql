-- Drop the unused Organization.banking column — Banking Details was
-- captured (bank name/account/IFSC/branch) but never read anywhere in the
-- app; the "salary certificate / FnF settlement" documents it claimed to
-- feed don't exist as generators. Confirmed empty on every org before
-- dropping.
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "banking";
