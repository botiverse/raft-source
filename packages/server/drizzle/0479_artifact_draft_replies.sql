-- Review drafts that reply (S8, docs/development/workspace-artifacts.md,
-- xxchan #proj-workspace:f07141a9): `app_artifacts.comment_drafts`
-- `reply_to`, the comment a draft replies to, posted as a reply to that
-- thread when the review is submitted. A reply has no place of its own (it
-- takes its thread's): `path` (and so `anchor`) null. Only app_artifacts
-- tables, behind workspace_artifacts_v0; every existing draft is null here.
--
-- No foreign key to app_artifacts.comments: a comment without replies is
-- deleted outright, and neither cascading (the draft gone unseen) nor SET
-- NULL (the draft silently a new thread) is right. A draft whose comment is
-- gone is refused at submit (COMMENT_NOT_FOUND, naming the draft).
--
-- Bounded lock wait: the column and check lock comment_drafts briefly; give
-- up after 5s (the deploy retries) rather than queue its writes behind a long
-- transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "app_artifacts"."comment_drafts" ADD COLUMN "reply_to" text;--> statement-breakpoint
ALTER TABLE "app_artifacts"."comment_drafts" ADD CONSTRAINT "comment_drafts_reply_has_no_place" CHECK ("app_artifacts"."comment_drafts"."reply_to" IS NULL OR "app_artifacts"."comment_drafts"."path" IS NULL);

