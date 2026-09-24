-- Migrate task status values: open/claimed/completed → todo/in_progress/done
UPDATE tasks SET status = 'todo' WHERE status = 'open';
--> statement-breakpoint
UPDATE tasks SET status = 'in_progress' WHERE status = 'claimed';
--> statement-breakpoint
UPDATE tasks SET status = 'done' WHERE status = 'completed';
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "status" SET DEFAULT 'todo';
