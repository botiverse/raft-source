-- Roll back product_feedback_hands_tickets (#14403): the internal Hands note it served was cancelled
-- (#proj-o11y:#35). Never shipped to production; staging had it from 0684.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
DROP TABLE "product_feedback_hands_tickets" CASCADE;
