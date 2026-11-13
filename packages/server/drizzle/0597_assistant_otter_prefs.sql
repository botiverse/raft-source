-- #proj-assistant:#21: the personal assistant's otter over every page, per
-- account: shown unless the person turns it off, and the shortcut that hides
-- it for a while (null = the default, "off" = none). Two catalog-only ADD
-- COLUMNs (a constant default, a nullable column): no table rewrite. Give up
-- after 5 s rather than queue sign-ins behind a long transaction on users.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "assistant_otter_visible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "assistant_otter_shortcut" text;