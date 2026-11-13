-- #proj-apps:#58 (xxchan 123f7688): an App with no When to use stays out of the
-- agent prompt, and agents read its confirmed name and description in their
-- integration list. An edit that leaves When to use empty and the description
-- as confirmed shows agents nothing new, yet the App's page asked an admin to
-- confirm it. From now on such an edit moves the confirmation along
-- (appPromptTextService). This does the same for rows already waiting: When to
-- use is empty on both sides and the description is the one confirmed (with
-- nothing confirmed, the current description is empty). Anything else is left
-- for the admin.
--
-- Locks: both tables are small (hundreds of Apps, thousands of installs).
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
UPDATE public.oauth_client_installs i
   SET confirmed_text_revision_id = c.text_current_revision_id,
       text_confirmed_by_user_id = NULL,
       text_confirmed_at = now(),
       updated_at = now()
  FROM public.oauth_clients c
  JOIN public.oauth_app_text_revisions cur ON cur.id = c.text_current_revision_id
 WHERE i.client_id = c.id
   AND coalesce(btrim(cur.when_to_use), '') = ''
   AND i.confirmed_text_revision_id IS DISTINCT FROM c.text_current_revision_id
   AND (
     (i.confirmed_text_revision_id IS NULL AND coalesce(btrim(cur.description), '') = '')
     OR EXISTS (
       SELECT 1 FROM public.oauth_app_text_revisions confirmed
        WHERE confirmed.id = i.confirmed_text_revision_id
          AND coalesce(btrim(confirmed.when_to_use), '') = ''
          AND coalesce(btrim(confirmed.description), '') = coalesce(btrim(cur.description), '')
     )
   );--> statement-breakpoint
UPDATE public.oauth_clients c
   SET local_confirmed_text_revision_id = c.text_current_revision_id
  FROM public.oauth_app_text_revisions cur
 WHERE cur.id = c.text_current_revision_id
   AND coalesce(btrim(cur.when_to_use), '') = ''
   AND c.local_confirmed_text_revision_id IS DISTINCT FROM c.text_current_revision_id
   AND (
     (c.local_confirmed_text_revision_id IS NULL AND coalesce(btrim(cur.description), '') = '')
     OR EXISTS (
       SELECT 1 FROM public.oauth_app_text_revisions confirmed
        WHERE confirmed.id = c.local_confirmed_text_revision_id
          AND coalesce(btrim(confirmed.when_to_use), '') = ''
          AND coalesce(btrim(confirmed.description), '') = coalesce(btrim(cur.description), '')
     )
   );
