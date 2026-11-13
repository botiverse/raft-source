-- Device-login sessions issued before session families had a scope (0494)
-- became `full` by default: a 30-day refresh window and every route, the
-- phishing risk the device-login fix closes. No grant recorded its session
-- then (consumed_session_family_id came with 0493), so this matches them the
-- way the token phase made them: a family of the approving person created
-- within [consumed_at - 2s, consumed_at + 10s] (consumed_at is the app's
-- clock in the consume UPDATE, created_at the database's now() in
-- createSession's own transaction just after).
--
-- Only an unambiguous match is changed: exactly one family of that person in
-- the window, revoked or not, and that family still unrevoked. It becomes
-- `device` (no one is signed out: its next refresh starts a 7-day window and
-- only Raft Computer / raft CLI routes admit it) and the grant records it, so
-- the session's later credential mints and attaches send the usual notices.
-- Counting revoked families keeps a person's own web login, made a few
-- seconds after a device login they later signed out, from being taken for
-- the device session.
--
-- Ambiguous grants are left alone and expire on their own (at most 30 days):
-- revoking them would also sign those people out of the web sessions they
-- opened at the same moment, and there is no sign of abuse (decision: Tenny,
-- 2026-10-29). Production read-only replica, 2026-10-29 08:09Z: 13,163
-- exchanged device logins; 12,332 matching exactly one unrevoked family, 122
-- ambiguous, 709 with none; still live: 2,517 unique families, 34 ambiguous
-- logins (45 families). Counts at deploy time will be a little higher; the
-- rule is the same. Grants that already record their family (issued after
-- 0493) are not guessed at.
WITH grants AS (
  SELECT d."id", d."approved_by_user_id" AS user_id, d."consumed_at"
  FROM "device_authorizations" d
  WHERE d."consumed_at" IS NOT NULL
    AND d."approved_by_user_id" IS NOT NULL
    AND d."consumed_session_family_id" IS NULL
), candidates AS (
  SELECT g."id" AS grant_id, f."id" AS family_id, f."revoked_at"
  FROM grants g
  JOIN "session_families" f
    ON f."user_id" = g.user_id
   AND f."created_at" BETWEEN g."consumed_at" - interval '2 seconds' AND g."consumed_at" + interval '10 seconds'
), unique_matches AS (
  SELECT grant_id, (array_agg(family_id))[1] AS family_id
  FROM candidates
  GROUP BY grant_id
  HAVING count(*) = 1 AND count(*) FILTER (WHERE "revoked_at" IS NULL) = 1
), marked AS (
  UPDATE "session_families" f
  SET "scope" = 'device'
  FROM unique_matches u
  WHERE f."id" = u.family_id
  RETURNING f."id"
)
UPDATE "device_authorizations" d
SET "consumed_session_family_id" = u.family_id
FROM unique_matches u
WHERE d."id" = u.grant_id;
