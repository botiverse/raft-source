#!/usr/bin/env bash
# Behavioural coverage for the task backfill, run against a real throwaway
# Postgres. The properties worth testing here are all about what the script does
# to a database, so an in-process stub would test nothing.
#
# The first test exists because of a real regression: rewriting the row-at-a-time
# insert as INSERT...SELECT silently dropped the dry-run guard, and --dry-run
# started writing — on the command users are told to run first, and which was
# documented as touching nothing. The implementation changed and the check that
# would have caught it was never re-run.
#
#   bash packages/server/scripts/backfill-tasks-from-messages.test.sh
#
# Requires docker.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
server_root="$(cd "$here/.." && pwd)"
repo_root="$(cd "$server_root/../.." && pwd)"
container="backfill-test-$$"
port="$(( 16000 + RANDOM % 900 ))"
DB="postgresql://postgres:x@127.0.0.1:${port}/x"

cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
psql_q() { docker exec -i "$container" psql -U postgres -d x -t -A -c "$1"; }
run_script() { DATABASE_URL="$DB" NO_PROXY="127.0.0.1,localhost,::1" \
  pnpm --filter @botiverse/raft-server exec tsx scripts/backfill-tasks-from-messages.ts "$@"; }

echo "starting throwaway postgres on :${port}"
docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=x -e POSTGRES_DB=x \
  -p "${port}:5432" postgres:16 >/dev/null
until docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done

DATABASE_URL="$DB" NO_PROXY="127.0.0.1,localhost,::1" \
  pnpm --filter @botiverse/raft-server exec drizzle-kit migrate >/dev/null 2>&1

seed() {
  docker exec -i "$container" psql -U postgres -d x -q >/dev/null 2>&1 <<'SQL'
TRUNCATE tasks, messages, channels, servers, users CASCADE;
INSERT INTO users (id,email,name,display_name,password_hash,email_verified)
  VALUES ('11111111-1111-1111-1111-111111111111','o@t.t','o','o','x',true);
INSERT INTO servers (id,name,slug,owner_id)
  VALUES ('22222222-2222-2222-2222-222222222222','S','s','11111111-1111-1111-1111-111111111111');
INSERT INTO channels (id,server_id,name)
  VALUES ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222','general');
-- three legacy message-tasks, one with microsecond precision on claimed_at
INSERT INTO messages (id,channel_id,sender_type,sender_id,content,task_status,task_number,task_assignee_type,task_assignee_id,task_claimed_at)
VALUES
 ('aaaaaaa1-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','user','11111111-1111-1111-1111-111111111111','one','todo',1,NULL,NULL,NULL),
 ('aaaaaaa1-0000-0000-0000-000000000002','33333333-3333-3333-3333-333333333333','user','11111111-1111-1111-1111-111111111111','two','in_progress',2,'user','11111111-1111-1111-1111-111111111111','2026-07-27 07:31:05.320025+00'),
 ('aaaaaaa1-0000-0000-0000-000000000003','33333333-3333-3333-3333-333333333333','user','11111111-1111-1111-1111-111111111111','three','done',3,NULL,NULL,NULL);
-- a v0 orphan: canonical row with no host message, must never be touched
INSERT INTO tasks (id,channel_id,task_number,title,status,created_by_type,created_by_id,message_id)
VALUES ('44444444-4444-4444-4444-444444444444','33333333-3333-3333-3333-333333333333',9,'v0 orphan','todo','user','11111111-1111-1111-1111-111111111111',NULL);
SQL
}

# --- 1. dry-run writes NOTHING ----------------------------------------------
# The regression. A dry run that writes is worse than no dry run, because it is
# the step people are told is safe.
seed
before="$(psql_q 'SELECT count(*) FROM tasks;')"
run_script --dry-run >/dev/null 2>&1
after="$(psql_q 'SELECT count(*) FROM tasks;')"
[[ "$before" == "$after" ]] || fail "--dry-run wrote to the database ($before -> $after rows)"

# Running it twice must report the same pending set — if the first run wrote,
# the second would see fewer. This catches the regression even if the row count
# were somehow restored.
first="$(run_script --dry-run 2>&1 | grep -oE 'would migrate [0-9]+' | grep -oE '[0-9]+')"
second="$(run_script --dry-run 2>&1 | grep -oE 'would migrate [0-9]+' | grep -oE '[0-9]+')"
[[ "$first" == "$second" && "$first" == "3" ]] \
  || fail "--dry-run is not idempotent: reported $first then $second (expected 3 both times)"

# --- 2. apply migrates exactly the pending set -------------------------------
run_script --apply >/dev/null 2>&1
migrated="$(psql_q "SELECT count(*) FROM tasks WHERE message_id IS NOT NULL;")"
[[ "$migrated" == "3" ]] || fail "expected 3 canonical rows after apply, got $migrated"

# --- 3. microsecond fidelity -------------------------------------------------
# Round-tripping timestamps through JS truncates to milliseconds, silently.
mismatch="$(psql_q "SELECT count(*) FROM tasks t JOIN messages m ON m.id=t.message_id WHERE t.claimed_at IS DISTINCT FROM m.task_claimed_at;")"
[[ "$mismatch" == "0" ]] || fail "timestamp fidelity lost on $mismatch row(s)"

# --- 4. re-running apply is a no-op ------------------------------------------
run_script --apply >/dev/null 2>&1
again="$(psql_q "SELECT count(*) FROM tasks WHERE message_id IS NOT NULL;")"
[[ "$again" == "3" ]] || fail "re-apply duplicated rows: $again (expected 3)"

# --- 5. v0 orphans are untouched ---------------------------------------------
orphans="$(psql_q "SELECT count(*) FROM tasks WHERE message_id IS NULL;")"
[[ "$orphans" == "1" ]] || fail "v0 orphan was modified (expected 1, got $orphans)"

# --- 6. the message side is left intact (the rollback path) ------------------
shadows="$(psql_q "SELECT count(*) FROM messages WHERE task_status IS NOT NULL;")"
[[ "$shadows" == "3" ]] || fail "backfill cleared messages.task_* (expected 3 intact, got $shadows)"

# --- 7. verify oracle passes and exits 0 -------------------------------------
run_script --verify >/dev/null 2>&1 || fail "--verify should exit 0 when the data is consistent"

echo "backfill-tasks-from-messages: PASS"
