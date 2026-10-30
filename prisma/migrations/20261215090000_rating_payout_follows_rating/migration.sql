-- The variable-pay payout now follows the 1-5 rating: 1 -> 0%, 2 -> 25%, 3 -> 50%, 4 -> 75%, 5 -> 100%
-- (see src/performance-ratings/rating-payout.ts). Existing ratings are brought in line; a 1/5 had been saved at 100%.
UPDATE "performance_ratings"
SET "payoutPercentage" = CASE "rating"
  WHEN 1 THEN 0
  WHEN 2 THEN 25
  WHEN 3 THEN 50
  WHEN 4 THEN 75
  WHEN 5 THEN 100
  ELSE "payoutPercentage"
END;
