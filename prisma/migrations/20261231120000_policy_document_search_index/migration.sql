-- Word index over a policy's text so Ask HR only reads the policies that contain the question's words.
ALTER TABLE "policy_documents" ADD COLUMN "contentSearch" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("contentText", ''))) STORED;
CREATE INDEX "policy_documents_contentSearch_idx" ON "policy_documents" USING GIN ("contentSearch");
