ALTER TABLE "messages" ADD COLUMN "search_text" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', COALESCE(search_text, ''))) STORED;--> statement-breakpoint
CREATE INDEX "idx_messages_search_vector_gin" ON "messages" USING gin ("search_vector");