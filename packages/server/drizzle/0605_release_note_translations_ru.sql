-- Allow ru in release_note_translations ahead of the Russian display locale.
-- Re-adding the check takes the table's exclusive lock; the table is small, so
-- fail fast rather than queue behind a long reader.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "release_note_translations" DROP CONSTRAINT "release_note_translations_locale";--> statement-breakpoint
ALTER TABLE "release_note_translations" ADD CONSTRAINT "release_note_translations_locale" CHECK ("release_note_translations"."locale" in ('es', 'pt-br', 'ru', 'ko', 'ja', 'zh-cn', 'zh-tw'));--> statement-breakpoint
-- Russian joins the release-note translation locales: the table check above and
-- the write function's list say the same. The function body is 0496's, with ru
-- added; CREATE OR REPLACE keeps its owner and the EXECUTE grants made per role.
CREATE OR REPLACE FUNCTION public.release_note_translations_write(
  p_actor_type text,
  p_actor_id text,
  p_client_id text,
  p_body jsonb
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $release_note_translations_write$
DECLARE
  -- Every display locale but English; the table's locale check says the same.
  c_locales CONSTANT text[] := ARRAY['es', 'pt-br', 'ru', 'ko', 'ja', 'zh-cn', 'zh-tw'];
  c_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  c_sha256 CONSTANT text := '^[0-9a-f]{64}$';
  v_release_id uuid;
  v_revision integer;
  v_locale text;
  v_reason text;
  v_entries jsonb;
  v_entry jsonb;
  v_count integer;
  v_release record;
  v_snapshot text;
  v_bad uuid[];
BEGIN
  IF p_actor_type IS NULL OR p_actor_type NOT IN ('human', 'agent') THEN
    RAISE EXCEPTION USING ERRCODE = 'RNT01', MESSAGE = 'actorType must be human or agent';
  END IF;
  IF coalesce(pg_catalog.btrim(p_actor_id), '') = '' OR coalesce(pg_catalog.btrim(p_client_id), '') = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'RNT01', MESSAGE = 'actorId and clientId are required';
  END IF;
  IF p_body IS NULL OR pg_catalog.jsonb_typeof(p_body) <> 'object'
    OR NOT (p_body ?& ARRAY['releaseId', 'revision', 'snapshotHash', 'locale', 'reason', 'entries'])
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_body)) <> 6 THEN
    RAISE EXCEPTION USING ERRCODE = 'RNT01',
      MESSAGE = 'body must be {releaseId, revision, snapshotHash, locale, reason, entries} and nothing else';
  END IF;
  IF pg_catalog.jsonb_typeof(p_body->'releaseId') <> 'string' OR (p_body->>'releaseId') !~ c_uuid THEN
    RAISE EXCEPTION USING ERRCODE = 'RNT01', MESSAGE = 'releaseId must be a uuid';
  END IF;
  v_release_id := pg_catalog.lower(p_body->>'releaseId')::uuid;
  IF pg_catalog.jsonb_typeof(p_body->'revision') <> 'number' OR (p_body->>'revision') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'RNT01', MESSAGE = 'revision must be a positive integer';
  END IF;
  v_revision := (p_body->>'revision')::integer;
  IF pg_catalog.jsonb_typeof(p_body->'snapshotHash') <> 'string' OR (p_body->>'snapshotHash') !~ c_sha256 THEN
    RAISE EXCEPTION USING ERRCODE = 'RNT01', MESSAGE = 'snapshotHash must be 64 lowercase hex digits';
  END IF;
  v_locale := p_body->>'locale';
  IF pg_catalog.jsonb_typeof(p_body->'locale') <> 'string' OR NOT (v_locale = ANY (c_locales)) THEN
    RAISE EXCEPTION USING ERRCODE = 'RNT01', MESSAGE = 'locale must be one of ' || pg_catalog.array_to_string(c_locales, ', ');
  END IF;
  v_reason := pg_catalog.replace(pg_catalog.replace(p_body->>'reason', E'\r\n', E'\n'), E'\r', E'\n');
  IF pg_catalog.jsonb_typeof(p_body->'reason') <> 'string' OR pg_catalog.char_length(v_reason) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION USING ERRCODE = 'RNT01', MESSAGE = 'reason must be 1 to 2000 characters';
  END IF;
  v_entries := p_body->'entries';
  IF pg_catalog.jsonb_typeof(v_entries) <> 'array' OR pg_catalog.jsonb_array_length(v_entries) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION USING ERRCODE = 'RNT01', MESSAGE = 'entries must be an array of 1 to 200 entries';
  END IF;
  v_count := pg_catalog.jsonb_array_length(v_entries);
  FOR i IN 0 .. v_count - 1 LOOP
    v_entry := v_entries->i;
    IF pg_catalog.jsonb_typeof(v_entry) <> 'object' OR NOT (v_entry ?& ARRAY['entryId', 'sourceHash', 'text'])
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_entry)) <> 3 THEN
      RAISE EXCEPTION USING ERRCODE = 'RNT01', MESSAGE = pg_catalog.format('entries[%s] must be {entryId, sourceHash, text} and nothing else', i);
    END IF;
    IF pg_catalog.jsonb_typeof(v_entry->'entryId') <> 'string' OR (v_entry->>'entryId') !~ c_uuid THEN
      RAISE EXCEPTION USING ERRCODE = 'RNT01', MESSAGE = pg_catalog.format('entries[%s].entryId must be a uuid', i);
    END IF;
    IF pg_catalog.jsonb_typeof(v_entry->'sourceHash') <> 'string' OR (v_entry->>'sourceHash') !~ c_sha256 THEN
      RAISE EXCEPTION USING ERRCODE = 'RNT01', MESSAGE = pg_catalog.format('entries[%s].sourceHash must be 64 lowercase hex digits', i);
    END IF;
    IF pg_catalog.jsonb_typeof(v_entry->'text') <> 'string'
      OR pg_catalog.char_length(pg_catalog.replace(pg_catalog.replace(v_entry->>'text', E'\r\n', E'\n'), E'\r', E'\n')) NOT BETWEEN 1 AND 20000 THEN
      RAISE EXCEPTION USING ERRCODE = 'RNT01', MESSAGE = pg_catalog.format('entries[%s].text must be 1 to 20000 characters', i);
    END IF;
  END LOOP;
  IF (SELECT pg_catalog.count(DISTINCT pg_catalog.lower(e->>'entryId')) FROM pg_catalog.jsonb_array_elements(v_entries) e) <> v_count THEN
    RAISE EXCEPTION USING ERRCODE = 'RNT01', MESSAGE = 'entries must not repeat an entryId';
  END IF;

  -- FOR SHARE: publishing a new revision updates this row, so it waits until
  -- the translation commits (and vice versa) instead of racing the checks.
  SELECT r.current_revision, r.retracted_at INTO v_release
    FROM public.release_notes r WHERE r.id = v_release_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'release_not_found');
  END IF;
  IF v_release.current_revision IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'release_not_published');
  END IF;
  IF v_release.retracted_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'release_retracted');
  END IF;
  IF v_release.current_revision <> v_revision THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'revision_not_current', 'currentRevision', v_release.current_revision);
  END IF;
  SELECT rv.snapshot_hash INTO v_snapshot
    FROM public.release_note_revisions rv WHERE rv.release_id = v_release_id AND rv.revision = v_revision;
  IF v_snapshot IS DISTINCT FROM (p_body->>'snapshotHash') THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'snapshot_mismatch');
  END IF;

  SELECT pg_catalog.array_agg(e.entry_id ORDER BY e.ord) INTO v_bad
    FROM (SELECT pg_catalog.lower(x->>'entryId')::uuid AS entry_id, ord
            FROM pg_catalog.jsonb_array_elements(v_entries) WITH ORDINALITY AS t(x, ord)) e
    WHERE NOT EXISTS (SELECT 1 FROM public.release_note_revision_items it
      WHERE it.release_id = v_release_id AND it.revision = v_revision AND it.entry_id = e.entry_id);
  IF v_bad IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'unknown_entry', 'entryIds', pg_catalog.to_jsonb(v_bad));
  END IF;
  SELECT pg_catalog.array_agg(e.entry_id ORDER BY e.ord) INTO v_bad
    FROM (SELECT pg_catalog.lower(x->>'entryId')::uuid AS entry_id, x->>'sourceHash' AS source_hash, ord
            FROM pg_catalog.jsonb_array_elements(v_entries) WITH ORDINALITY AS t(x, ord)) e
    JOIN public.release_note_revision_items it
      ON it.release_id = v_release_id AND it.revision = v_revision AND it.entry_id = e.entry_id
    WHERE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(it.text, 'UTF8')), 'hex') <> e.source_hash;
  IF v_bad IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'source_changed', 'entryIds', pg_catalog.to_jsonb(v_bad));
  END IF;

  -- In entryId order, so two overlapping submissions lock rows in the same order.
  INSERT INTO public.release_note_translations (release_id, entry_id, locale, revision, source_hash, text, actor_type, actor_id)
  SELECT v_release_id, e.entry_id, v_locale, v_revision, e.source_hash, e.text, p_actor_type, p_actor_id
    FROM (SELECT pg_catalog.lower(x->>'entryId')::uuid AS entry_id, x->>'sourceHash' AS source_hash,
                 pg_catalog.replace(pg_catalog.replace(x->>'text', E'\r\n', E'\n'), E'\r', E'\n') AS text
            FROM pg_catalog.jsonb_array_elements(v_entries) x) e
    ORDER BY e.entry_id
  ON CONFLICT (release_id, entry_id, locale) DO UPDATE SET
    revision = EXCLUDED.revision, source_hash = EXCLUDED.source_hash, text = EXCLUDED.text,
    actor_type = EXCLUDED.actor_type, actor_id = EXCLUDED.actor_id, updated_at = pg_catalog.now();
  -- entry_deltas describe changes to the English entries; a translation changes none.
  INSERT INTO public.release_note_audit (id, release_id, actor_type, actor_id, client_id, action, revision, reason, entry_deltas)
  VALUES (pg_catalog.gen_random_uuid(), v_release_id, p_actor_type, p_actor_id, p_client_id,
          'translate:' || v_locale, v_revision, v_reason, '[]'::jsonb);
  RETURN pg_catalog.jsonb_build_object('ok', true, 'releaseId', v_release_id, 'revision', v_revision,
    'locale', v_locale, 'written', v_count);
EXCEPTION
  WHEN SQLSTATE 'RNT01' THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'invalid_request', 'message', SQLERRM);
END
$release_note_translations_write$;
