-- RFC 084 §4: an id is reserved if the App ever used it. The rows that show use
-- can go (tokens expire and are purged, a link-preview registration can be
-- deleted), so the fact is kept on the App once and never cleared (Tenny,
-- #proj-apps:#57). A trigger, so no path that writes those rows can miss it.
-- Invoker rights on purpose: App Admin's role check refuses a definer function
-- it could execute, and everything inserting these rows already owns them.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "first_used_at" timestamp with time zone;--> statement-breakpoint
CREATE FUNCTION public.oauth_client_mark_first_used() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE public.oauth_clients SET first_used_at = now()
   WHERE id = NEW.client_id AND first_used_at IS NULL;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER oauth_client_first_used_token AFTER INSERT ON public.oauth_access_tokens
  FOR EACH ROW EXECUTE FUNCTION public.oauth_client_mark_first_used();--> statement-breakpoint
CREATE TRIGGER oauth_client_first_used_grant AFTER INSERT ON public.oauth_grants
  FOR EACH ROW EXECUTE FUNCTION public.oauth_client_mark_first_used();--> statement-breakpoint
CREATE TRIGGER oauth_client_first_used_request AFTER INSERT ON public.oauth_access_requests
  FOR EACH ROW EXECUTE FUNCTION public.oauth_client_mark_first_used();--> statement-breakpoint
CREATE TRIGGER oauth_client_first_used_link_preview AFTER INSERT ON public.oauth_app_link_previews
  FOR EACH ROW EXECUTE FUNCTION public.oauth_client_mark_first_used();--> statement-breakpoint
-- Existing Apps: what the rows still show, and the append-only audit for what
-- they no longer do. Only ever marks an App used, the safe direction.
UPDATE public.oauth_clients c SET first_used_at = c.created_at
 WHERE c.first_used_at IS NULL AND (
   EXISTS (SELECT 1 FROM public.oauth_access_tokens t WHERE t.client_id = c.id)
   OR EXISTS (SELECT 1 FROM public.oauth_grants g WHERE g.client_id = c.id)
   OR EXISTS (SELECT 1 FROM public.oauth_access_requests r WHERE r.client_id = c.id)
   OR EXISTS (SELECT 1 FROM public.oauth_app_link_previews p WHERE p.client_id = c.id)
   OR EXISTS (SELECT 1 FROM public.integration_audit_events e WHERE e.client_id = c.id AND e.event_type LIKE 'oauth.%'));
