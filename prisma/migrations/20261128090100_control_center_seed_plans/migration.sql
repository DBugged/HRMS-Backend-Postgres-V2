-- The four D'Core HR plans from the price sheet. Idempotent: re-running leaves existing plans (and any edits) alone.
-- Rates are per employee per month in INR, GST extra. limits.* drives the panel's billing: employee band, which terms are
-- offered, and the discounted annual rate. perExtraEmployeeRate applies to each employee above includedEmployees.
INSERT INTO "cc_plans" ("id","name","code","billingModel","currency","trialDays","perEmployeeRate","termMonths","includedEmployees","perExtraEmployeeRate","gstApplicable","features","limits","isPublic","status","updatedAt") VALUES
('plan-starter','Starter Pack','STARTER','PER_EMPLOYEE','INR',60,120,NULL,50,130,true,
 '["Complete D''CoreHR Platform","Web & Mobile Access","Secure Cloud Hosting","Standard Support","Regular Updates"]',
 '{"minEmployees":1,"maxEmployees":50,"allowedTerms":["MONTHLY","YEARLY"],"annualRate":110,"annualSavePct":8,"tagline":"For Smaller Teams"}',true,'ACTIVE',now()),
('plan-professional','Professional Pack','PROFESSIONAL','PER_EMPLOYEE','INR',60,100,12,100,110,true,
 '["Complete D''CoreHR Platform","Web & Mobile Access","Secure Cloud Hosting","Priority Support","Implementation Assistance","Regular Updates"]',
 '{"minEmployees":51,"maxEmployees":100,"allowedTerms":["YEARLY"],"mostPopular":true,"tagline":"For Growing Businesses"}',true,'ACTIVE',now()),
('plan-business','Business Pack','BUSINESS','PER_EMPLOYEE','INR',60,80,60,200,100,true,
 '["Complete D''CoreHR Platform","Web & Mobile Access","Secure Cloud Hosting (5 Years)","Priority Support","Implementation & Migration Assistance","Basic Customization Support","Regular Updates"]',
 '{"minEmployees":101,"maxEmployees":200,"allowedTerms":["FIVE_YEAR"],"upfront":true,"tagline":"For Established Businesses"}',true,'ACTIVE',now()),
('plan-enterprise','Enterprise','ENTERPRISE','FIXED_TERM','INR',60,NULL,NULL,NULL,NULL,true,
 '["Complete D''CoreHR Platform","Multi-location Support","Advanced Integrations (Biometric, APIs, 3rd Party Systems)","Custom Workflows & Reports","Dedicated Implementation","Dedicated / Priority Support","SLA Options","Flexible Deployment Options (Cloud or On-Premise)","Regular Updates"]',
 '{"custom":true,"tagline":"Built Around Your Organization"}',true,'ACTIVE',now())
ON CONFLICT ("code") DO NOTHING;
