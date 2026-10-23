-- The mobile app cannot be told apart from the web app on the server, so a per-company switch for it would do nothing. Remove it rather than promise it.
DELETE FROM "cc_feature_flags" WHERE "key" = 'module.mobile_app';
