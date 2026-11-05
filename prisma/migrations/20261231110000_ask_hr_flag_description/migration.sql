-- The module switch that covered the AI policy assistant now covers Ask HR (search over policies and the person's own records).
UPDATE "cc_feature_flags" SET "description" = 'Ask HR - answers from policies, leave, holidays, letters and payslips', "updatedAt" = now() WHERE "key" = 'module.policy_assistant';
