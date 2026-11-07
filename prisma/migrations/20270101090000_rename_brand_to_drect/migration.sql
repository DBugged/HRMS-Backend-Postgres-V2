-- Product rename: D'Core HR -> D'Rect HR in text already saved in the database (email and letter templates, plan feature lists).
-- Covers the straight apostrophe, the curly one and the HTML-entity forms, with or without the space (D'CoreHR). Idempotent: a second run finds nothing.
UPDATE "email_templates"
SET "name" = regexp_replace("name", 'D(''|’|&rsquo;|&apos;|&#39;|&#x27;)Core( ?)HR', 'D\1Rect\2HR', 'g'),
    "subject" = regexp_replace("subject", 'D(''|’|&rsquo;|&apos;|&#39;|&#x27;)Core( ?)HR', 'D\1Rect\2HR', 'g'),
    "bodyHtml" = regexp_replace("bodyHtml", 'D(''|’|&rsquo;|&apos;|&#39;|&#x27;)Core( ?)HR', 'D\1Rect\2HR', 'g')
WHERE "name" ~ 'D(''|’|&rsquo;|&apos;|&#39;|&#x27;)Core ?HR'
   OR "subject" ~ 'D(''|’|&rsquo;|&apos;|&#39;|&#x27;)Core ?HR'
   OR "bodyHtml" ~ 'D(''|’|&rsquo;|&apos;|&#39;|&#x27;)Core ?HR';

UPDATE "letter_templates"
SET "name" = regexp_replace("name", 'D(''|’|&rsquo;|&apos;|&#39;|&#x27;)Core( ?)HR', 'D\1Rect\2HR', 'g'),
    "title" = regexp_replace("title", 'D(''|’|&rsquo;|&apos;|&#39;|&#x27;)Core( ?)HR', 'D\1Rect\2HR', 'g'),
    "bodyText" = regexp_replace("bodyText", 'D(''|’|&rsquo;|&apos;|&#39;|&#x27;)Core( ?)HR', 'D\1Rect\2HR', 'g')
WHERE "name" ~ 'D(''|’|&rsquo;|&apos;|&#39;|&#x27;)Core ?HR'
   OR "title" ~ 'D(''|’|&rsquo;|&apos;|&#39;|&#x27;)Core ?HR'
   OR "bodyText" ~ 'D(''|’|&rsquo;|&apos;|&#39;|&#x27;)Core ?HR';

UPDATE "cc_plans"
SET "name" = regexp_replace("name", 'D(''|’)Core( ?)HR', 'D\1Rect\2HR', 'g'),
    "features" = regexp_replace("features"::text, 'D(''|’)Core( ?)HR', 'D\1Rect\2HR', 'g')::jsonb
WHERE "name" ~ 'D(''|’)Core ?HR' OR "features"::text ~ 'D(''|’)Core ?HR';
