CREATE INDEX IF NOT EXISTS "idx_messages_task_assignee" ON "messages" USING btree ("task_assignee_type","task_assignee_id") WHERE task_assignee_type is not null and task_assignee_id is not null;
