-- New configurable list: Offboarding exit interview's "Reason for Leaving".
-- Its own migration because Postgres can't use a newly added enum value in
-- the same transaction that adds it (same split as ASSET_CATEGORY).
ALTER TYPE "OrgListType" ADD VALUE IF NOT EXISTS 'REASON_FOR_LEAVING';
