# Inbox autoanalyze guard

Migration `0180_inbox_autoanalyze_guard.sql` lowers PostgreSQL's per-table
autoanalyze trigger for the hot relations used by the primary Inbox serving
query. It changes storage parameters only. It does not run `ANALYZE`, change
vacuum settings, alter `work_mem`, or mutate application rows.

PostgreSQL schedules autoanalyze after approximately:

```text
autovacuum_analyze_threshold +
autovacuum_analyze_scale_factor * n_live_tup
```

The database DRI validated these values on a copy-on-write branch and froze
them from the 2026-07-18 PRIMARY snapshot:

| Table                       | Live rows | Previous trigger | New trigger |
| --------------------------- | --------: | ---------------: | ----------: |
| `inbox_serving_rows`        |   363,488 |          ~36,399 |      ~9,270 |
| `channels`                  |   573,359 |          ~57,386 |     ~30,668 |
| `thread_follows`            | 1,208,389 |         ~120,889 |     ~65,419 |
| `user_channel_read_cursors` |   434,334 |          ~43,483 |     ~23,717 |
| `channel_humans`            |   139,349 |          ~13,985 |      ~8,967 |
| `messages`                  | 9,716,158 |         ~971,666 |    ~495,808 |
| `message_mentions`          | 6,458,300 |         ~645,880 |    ~332,915 |

`joint_channel_servers`, `joint_channels`, and
`user_channel_inbox_states` remain on the database defaults because their
small cardinalities keep the default trigger below approximately 760
modifications. Lowering their scale factor provides no useful prevention gain.

## Verification

Before and after an authorized apply, record the exact settings:

```sql
SELECT c.relname, c.reloptions
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = ANY(ARRAY[
    'inbox_serving_rows',
    'channels',
    'thread_follows',
    'user_channel_read_cursors',
    'channel_humans',
    'messages',
    'message_mentions',
    'joint_channel_servers',
    'joint_channels',
    'user_channel_inbox_states'
  ])
ORDER BY c.relname;
```

Then monitor `pg_stat_user_tables.last_autoanalyze` and
`n_mod_since_analyze` against the trigger formula above. The migration does not
force an immediate analyze; the autovacuum launcher applies the new thresholds
on its normal cadence.

## Production boundary

Production application requires Tenny's owner approval and Manjusaka's database
DRI approval on the exact migration head, followed by one explicit per-operation
write authorization for the operator. Do not apply the migration as part of an
incident response without all three approvals. Record the before/after catalog
query in the task thread.

## Rollback

Reset only the two storage parameters on each tuned table:

```sql
ALTER TABLE public.inbox_serving_rows RESET (
  autovacuum_analyze_scale_factor,
  autovacuum_analyze_threshold
);
ALTER TABLE public.channels RESET (
  autovacuum_analyze_scale_factor,
  autovacuum_analyze_threshold
);
ALTER TABLE public.thread_follows RESET (
  autovacuum_analyze_scale_factor,
  autovacuum_analyze_threshold
);
ALTER TABLE public.user_channel_read_cursors RESET (
  autovacuum_analyze_scale_factor,
  autovacuum_analyze_threshold
);
ALTER TABLE public.channel_humans RESET (
  autovacuum_analyze_scale_factor,
  autovacuum_analyze_threshold
);
ALTER TABLE public.messages RESET (
  autovacuum_analyze_scale_factor,
  autovacuum_analyze_threshold
);
ALTER TABLE public.message_mentions RESET (
  autovacuum_analyze_scale_factor,
  autovacuum_analyze_threshold
);
```

Rollback restores the database-level defaults and does not rewrite table data.
