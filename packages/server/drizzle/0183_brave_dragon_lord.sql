ALTER TABLE "server_members" ADD COLUMN "server_push_mode" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
UPDATE "server_members"
SET "server_push_mode" = CASE WHEN "server_push_muted" THEN 'none' ELSE 'all' END;--> statement-breakpoint
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_server_push_mode_valid" CHECK ("server_members"."server_push_mode" IN ('all', 'mentions', 'none'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sync_server_member_push_mode"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."server_push_mode" IS DISTINCT FROM 'all' THEN
      NEW."server_push_muted" := NEW."server_push_mode" = 'none';
    ELSIF NEW."server_push_muted" THEN
      NEW."server_push_mode" := 'none';
    END IF;
  ELSIF NEW."server_push_mode" IS DISTINCT FROM OLD."server_push_mode" THEN
    NEW."server_push_muted" := NEW."server_push_mode" = 'none';
  ELSIF NEW."server_push_muted" IS DISTINCT FROM OLD."server_push_muted" THEN
    NEW."server_push_mode" := CASE WHEN NEW."server_push_muted" THEN 'none' ELSE 'all' END;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "server_members_push_mode_sync"
BEFORE INSERT OR UPDATE OF "server_push_mode", "server_push_muted"
ON "server_members"
FOR EACH ROW
EXECUTE FUNCTION "sync_server_member_push_mode"();
