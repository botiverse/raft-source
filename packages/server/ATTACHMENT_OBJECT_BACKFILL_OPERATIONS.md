# Before upgrading: attachment object backfill (migrations 0452-0454)

For anyone who deploys a Raft server database (staging, self-hosted). Do this
before deploying the first release that contains migrations
`0452_attachments_legacy_physical_nullable`, `0453_attachments_object_id_validate`
and `0454_attachments_object_id_not_null` (storage step 2c, after v1.21.35).

**The backfill ships only in v1.21.36 up to the release before
`0483_attachments_drop_legacy_physical`** (storage step 2c, part B). It builds
each object from the old physical columns on `attachments` (`storage_key`,
`mime_type`, `size_bytes`, ...); that migration drops those columns, and the
release that contains it no longer has the script or the
`attachments:backfill-objects` package script. A database that still has
`object_id IS NULL` rows therefore goes through such a release: run the
backfill from its checkout (v1.21.38 is the last), deploy it, then upgrade
further. Deploying a later release directly is safe but stops: 0453 fails
before 0483 can run, so nothing is dropped; run the backfill from a v1.21.38
checkout against that database (its state, 0452 applied, is the one the
script expects), then rerun the deploy.

## Why

Those migrations make `attachments.object_id` required: every attachment must
name its `attachment_objects` row. 0453 validates that and fails when any row
still has `object_id IS NULL`:

```text
check constraint "attachments_object_id_not_null" of relation "attachments" is violated by some row  (SQLSTATE 23514)
```

The deploy then stops before the new server starts. 0452 stays applied (each
migration is its own transaction): the previous release keeps running, but the
database now refuses any insert or update that leaves `object_id` NULL, so an
objectless attachment can no longer be changed (for example revoked) until the
backfill below has run.

Rows with a NULL `object_id` were written before the attachment-object dual
write; databases that started on a later release have none.

## 1. Check

```sql
SELECT count(*) FROM attachments WHERE object_id IS NULL;
```

`0`: nothing to do, deploy. Otherwise continue.

## 2. Backfill

Run from a checkout of v1.21.36 to v1.21.38 (they contain the script; the
release you upgrade from may not, and releases from
`0483_attachments_drop_legacy_physical` on do not), after `pnpm install`,
against the primary database. Dry run first; it only reads:

```sh
DATABASE_URL=postgres://... pnpm --filter @botiverse/raft-server attachments:backfill-objects
```

It prints one JSON line `{"phase":"before",...}` with `nullObjectIds` (the
backlog) and the anomaly counters. Then write:

```sh
DATABASE_URL=postgres://... ATTACHMENT_OBJECT_DUAL_WRITE_FLEET_READY=true \
  pnpm --filter @botiverse/raft-server attachments:backfill-objects --apply
```

| Setting | Meaning |
| --- | --- |
| `DATABASE_URL` | Required. The primary, read-write. |
| `ATTACHMENT_OBJECT_DUAL_WRITE_FLEET_READY=true` | Required with `--apply`: you assert every running server sets `object_id` on new attachments (v1.21.35 and the releases before it back to the dual write do). Anything else refuses to write. |
| `--batch-size N` | Rows per transaction, 1-1000, default 100. |
| `--max-rows N` | Stop after N rows. Always exits non-zero ("Segmented run"): it is not a completion. |
| `--server-id <uuid>` | Only that server's attachments. |

For each attachment with `object_id IS NULL` (oldest first, in batches,
skipping rows locked by live traffic) it creates one `attachment_objects` row
from the attachment's legacy columns (`storage_key`, `mime_type`, `size_bytes`,
`thumbnail_key`, `content_hash`, `width`, `height`) and sets `object_id`; an
unsent attachment also gets its upload reservation. It does not touch object
storage, deletes nothing and leaves the legacy columns as they are. A run that
stops halfway is resumed by running it again; a rerun on a finished database
writes nothing.

Exit 0 means the final check passed (`nullObjectIds=0` and no anomaly). A
non-zero exit before any batch says `No rows were written`:

- `Preflight failed: N attachment projection(s) have object_id IS NULL and no
  resolvable channel`: attachments whose channel is gone. The script cannot
  tell which server they belong to; inspect and delete or repair them by hand.
- `existing attachment foundation anomalies must be remediated before backfill`:
  existing objects disagree with their attachments. Investigate before going on.

## 3. Deploy

Check again that the count above is `0`, then deploy (or rerun the failed
deploy). 0453 and 0454 then apply.
