ALTER TABLE "organizations"
  ALTER COLUMN "policies" SET DEFAULT '{"financialYearStartMonth":4,"timezone":"Asia/Kolkata","currency":"INR","currencySymbol":"₹","dateFormat":"DD-MM-YYYY","timeFormat":"24","defaultNoticeDays":30,"language":"English"}'::jsonb;
