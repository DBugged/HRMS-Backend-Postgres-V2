-- Product rename follow-up: the white-label flag description still said "D'Core HR". Idempotent: a second run finds nothing.
UPDATE "cc_feature_flags"
SET "description" = regexp_replace("description", 'D(''|’)Core( ?)HR', 'D\1Rect\2HR', 'g')
WHERE "description" ~ 'D(''|’)Core ?HR';
