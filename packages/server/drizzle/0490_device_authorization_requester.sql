-- Device-code login: where a login was started from (the visitor's IP and
-- location), shown on the approval page so a person can tell a login they
-- started from one someone sent them. Security use only; cleared 30 days after
-- created_at by the hourly maintenance sweep. NULL when the visitor's address
-- can't be trusted.
ALTER TABLE "device_authorizations" ADD COLUMN "requested_ip" text;--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD COLUMN "requested_location" text;