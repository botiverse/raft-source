# RisingWave SQL

These definitions and validation queries support the Inbox materialized views.
They are executable infrastructure inputs, not PostgreSQL/Drizzle migrations.
The numeric prefixes retain links to the design history in `rfcs/`.

The local bootstrap in `packages/server/scripts/bootstrap-risingwave-local.ts`
(`./raftdev start`, which runs it by default, and the `risingwave-real` CI job) selects, statement by
statement, exactly the relations the server reads and their dependencies from
024 (CDC-table indexes only), 061, 063-unified-inbox-chain, 063-chain-v5,
066 (`rw_inbox_muted_full_v1` only), 075, 078, 071 (indexes only), and 074, in
that order (078's conversation unread reads 066's `rw_inbox_muted_full_v1`
instead of 075's `rw_inbox_muted_full_v2`, which is therefore not built; 066's
`rw_conversation_unread_v1` and 068's consumers are superseded by 068/076; 076's
serving and totals and
063-chain-v5's watermark by 077, which builds on 076's items; 067's mention
arm, 076's items, agent inbox and conversation unread and all of 077 by 078,
which treats task conversations as sub-conversations; 069's
`rw_followed_thread_stats_v2`, 070's `rw_followed_thread_stats_v3` and 072's
`rw_followed_threads_v4` are superseded by 074's `rw_followed_threads_v5`, which
also covers joint threads, and are not applied; 074 also reads the `rw_tasks`
CDC table). The selection lives in `RISINGWAVE_BOOTSTRAP_ARTIFACTS`
(`scripts/dev/raftdev-risingwave-bootstrap.ts`), which is also the list of
applied relations. When a new generation replaces a
view the server reads, add it there, or the `risingwave-real` job fails. That
script is the consumer to check when
changing file locations.

Do not run every file alphabetically: some are superseded generations kept
because tests still read them. For local setup use `./raftdev start`,
which applies exactly the `RISINGWAVE_BOOTSTRAP_ARTIFACTS` list above, in
order.

The views read Postgres through CDC source tables (`rw_messages`, `rw_channels`
and the others named in each file's prerequisites). The local bootstrap creates
them for a loopback Postgres and RisingWave. For any other cluster, create the
CDC source and its tables first, then apply the same files in the same order.
Then apply 024's CDC-table indexes, 061's mute-state index and
`079-prod-only-indexes.sql`: a cluster without those indexes answers the same
queries with full scans. Recreating the CDC tables does not bring them back. An
index added by hand on a running cluster is recorded in 079 in the same change.

`075-inbox-cursor-decouple.sql` and `076-cursor-decouple-consumers.sql` are the
inbox arms with the read cursor as a join condition (a cursor move no longer
rewrites every message of the conversation), plus the 068 consumers re-pointed
at them. `076-parity-checks.sql` compares each new view with the one it
replaces; every pair must report 0. The server reads the
076 views; until an environment has built them, a read that finds one missing
reads its 068 counterpart (`withUnifiedChainTransition` in
`packages/server/src/db/risingwave.ts`). Drop the 068 generation (and
`rw_inbox_normal_v4`, `rw_inbox_muted_prefix_v1`) only after 076 is built
everywhere and traces show no `inbox.rw.unified_chain_view_fallback` events.
Keep `rw_inbox_muted_full_v1`: 078's `rw_conversation_unread_v4` reads it.

The fallback covers a view that is missing or still backfilling (RW 3.0.3
answers `42704 table or source not found` for both), but not a view whose index
is still being built: in that gap reads would go to the new view unindexed and
scan it. So the four server-read views are built under a `_build` name and
renamed only once everything, indexes included, has finished (see Building
the views below).
Until the last rename, at least one read view is missing, so every read stays on
068; after it, all four switch together. A server that reads 076 can therefore
be deployed before, during or after the build. An environment built under the
final names directly (such as the dev bootstrap) must not run that server until
its indexes exist.

`077-deleted-parent-threads.sql` drops threads whose parent is
deleted (an agent's DM after the agent is deleted), archived, or no longer
visible to the receiver (removed from a private, DM or joint parent) from the
human Activity, matching the canonical Postgres read and the sidebar
(`rw_conversation_unread_v3`). `rw_inbox_items_v12`
filters 076's `rw_inbox_items_v11` (which therefore stays, as its base); 077
replaces 076's `rw_inbox_serving_v7`, `rw_activity_totals_v5` and 063-chain-v5's
`rw_activity_watermark_v5` with `rw_inbox_serving_v8`, `rw_activity_totals_v6`
and `rw_activity_watermark_v6`; the columns are unchanged. The server reads serving v8 / totals v6 and, while they are missing, falls
back to v7 / v5, or to 068's v6 / v4 where 076 is not built either (same
mechanism as above, one step further). Unlike 076,
077 is not meant to be identical to what it replaces: `077-parity-checks.sql`
expects the only differences to be threads below a deleted, archived or
invisible parent.

`078-task-conversations.sql` makes a task conversation (`channels.type =
'task'`, task v2: a task's own discussion, with a parent channel but no parent
message) a sub-conversation like a thread everywhere the chain special-cased
threads. `rw_conversation_parent_v1` is `rw_thread_parent_v3` plus one row per
task conversation, whose parent is `channels.parent_channel_id` (the local
parent on every face, joint projections included). On it, with the previous
definitions and the upstream names advanced: `rw_inbox_mention_v7` (a task
conversation is kind 'thread', visible through its parent or a follow),
`rw_task_conversation_replies_v1` (a task conversation's reply count: its chat
messages, not its lifecycle lines), `rw_task_conversation_unread_v1` (a followed
task conversation's unread on the same basis: chat messages after the cursor,
not the reader's own),
`rw_activity_watermark_v7`, `rw_inbox_items_v13` (076's items and 077's parent
filter in one view), `rw_inbox_serving_v9` (+ index), `rw_activity_totals_v7`,
`rw_agent_inbox_v7` (+ index) and `rw_conversation_unread_v4` (+ index). Inside
the chain a task conversation keeps the internal kind 'thread' (the arms and
the Done/suppression target kinds key on it); serving, agent inbox and
conversation unread output kind 'task'; a task row's `reply_count` is its chat
messages (a thread's stays every message), and its `unread_count` /
`first_unread_message_id` (serving) and `unread_count` (conversation unread)
count chat messages only too, so "N new" never counts lifecycle lines; mentions
(the assignment notice) are unchanged. Serving takes a row's task columns
from `rw_tasks` (a task conversation's own task; a thread's by its parent
message). Columns are unchanged, so the server switch is a rename: the server
reads serving v9, totals v7, agent inbox v7 and conversation unread v4 and,
while one is missing, the previous generation (same mechanism as above), where
task conversations are absent. 075's arms, 063's latest/eligibility views and
074's `rw_followed_threads_v5` are unchanged (the followed-threads list reads
task conversations from Postgres). `rw_conversation_unread_v4` reads 066's
`rw_inbox_muted_full_v1` as its muted arm, not 075's `rw_inbox_muted_full_v2`
(075 gives both the same columns and semantics), so it can be built where v2 is
not kept. 078 needs `rw_channels.parent_channel_id`
and `rw_channels.task_id` (`ALTER TABLE rw_channels ADD COLUMN ...` on a
cluster whose CDC table predates them). Adding the columns does not re-snapshot
existing rows: where they were added after Postgres had already filled
`parent_channel_id`, only rows inserted or updated since then carry it in
RisingWave, and older thread rows have it NULL.
078 reads the two columns only for `type = 'task'` rows, all created after the
columns existed, so it is unaffected. A new view must not take a thread's
parent channel from `rw_channels.parent_channel_id`; use `rw_thread_parent_v3`
(or `rw_conversation_parent_v1`), or re-touch the old rows first (a separately
scheduled bulk write). `078-parity-checks.sql` expects
differences only on task conversations and on serving's task columns.

Retirement (RFC 062): once 078 is built everywhere and traces show no
`inbox.rw.unified_chain_view_fallback` naming a 078 view, drop leaf-first, never
CASCADE, with `SHOW CREATE` receipts first: `rw_activity_totals_v6`,
`rw_inbox_serving_v8` and its index, `rw_inbox_items_v12`, `rw_inbox_items_v11`,
`rw_activity_watermark_v6`, `rw_agent_inbox_v6` and its index,
`rw_conversation_unread_v3` and its index, `rw_inbox_mention_v6`; remove them
from `UNIFIED_CHAIN_TRANSITION_VIEWS` in the same change. A cluster that went
from the 068 generation to 078 directly (077 never built, and of 076 only
`rw_agent_inbox_v6` and `rw_inbox_items_v11`) served `rw_inbox_serving_v6`,
`rw_activity_totals_v4`, `rw_agent_inbox_v6` and `rw_conversation_unread_v2`
until the 078 rename, and retires instead: `rw_activity_totals_v4`,
`rw_inbox_serving_v6` and its index, `rw_inbox_items_v10`, `rw_inbox_items_v11`
(not read by any view), `rw_activity_watermark_v5`, `rw_agent_inbox_v6` and its
index, `rw_conversation_unread_v2` and its index, `rw_inbox_mention_v6`,
`rw_inbox_normal_v4`, `rw_inbox_muted_prefix_v1` (10 views, 3 indexes), checked
against `rw_depend` before dropping. While a replaced generation is still the
rename's rollback path, keep it in the transition list until the drop has
run. The older 068 and 076
generations named above go first if they are still present, so no more than
two generations coexist. Keep 075's `rw_inbox_normal_v5` and
`rw_inbox_muted_prefix_v2` and 066's `rw_inbox_muted_full_v1`: 078 reads them
(`rw_inbox_muted_full_v1` is not one of the 068 leftovers to drop).

### Building the views

Every view in 075-078 backfills from the whole message table (078's
`rw_conversation_parent_v1` only from the channel table, and
`rw_task_conversation_replies_v1` and `rw_task_conversation_unread_v1` only from
task conversations' messages; `rw_inbox_preview_need_v1` only from the
views before it). Serving and conversation unread read previews from
`rw_inbox_preview_seq_v1` / `rw_inbox_preview_parent_v1`, which each scan the
message preview view once, so they no longer backfill the message table per
preview join. On a cluster with
real data, build them throttled and one object per step: in the session, before
each `CREATE`, set `BACKGROUND_DDL = true`, cap `STREAMING_PARALLELISM`, and set
`backfill_rate_limit`. Keep the parallelism cap even with a rate limit: a rate
limit alone still occupies every core (see the build note in 063). Before each
step, `rw_ddl_progress` must be empty and the previous object visible in the
catalog.

Order: 075 (`rw_inbox_normal_v5`, `rw_inbox_muted_full_v2`,
`rw_inbox_muted_prefix_v2`); 076 (`rw_inbox_items_v11`, `rw_inbox_serving_v7`,
its index, `rw_activity_totals_v5`, `rw_agent_inbox_v6`, its index,
`rw_conversation_unread_v3`, its index; environments without
`rw_inbox_muted_full_v2` skip `rw_conversation_unread_v3`); 077 (`rw_activity_watermark_v6`,
`rw_inbox_items_v12`, `rw_inbox_serving_v8`, its index, `rw_activity_totals_v6`);
078 (needs 066's `rw_inbox_muted_full_v1`; `rw_conversation_parent_v1`,
`rw_task_conversation_replies_v1`,
`rw_task_conversation_unread_v1`, `rw_inbox_mention_v7`,
`rw_activity_watermark_v7`, `rw_inbox_items_v13`, `rw_inbox_preview_need_v1`,
`rw_inbox_preview_seq_v1`, `rw_inbox_preview_parent_v1`, `rw_inbox_serving_v9`, its
index, `rw_activity_totals_v7`, `rw_agent_inbox_v7`, its index,
`rw_conversation_unread_v4`, its index).


The views the server reads (serving, totals, agent inbox, conversation unread)
and their indexes are created under a `_build` name (a totals `_build` view
reads the serving `_build` view) and renamed to their final names in one session
once the last index has finished and `rw_ddl_progress` is empty, for example:

```sql
ALTER MATERIALIZED VIEW rw_inbox_serving_v8_build RENAME TO rw_inbox_serving_v8;
ALTER MATERIALIZED VIEW rw_activity_totals_v6_build RENAME TO rw_activity_totals_v6;
ALTER INDEX idx_rw_inbox_serving_v8_receiver_build RENAME TO idx_rw_inbox_serving_v8_receiver;
```

The other views are not read by the server and keep their final names. A rename
is catalog-only and does not wait on a barrier. Indexes and downstream views
refer to their upstream by id, so they keep working and the planner keeps using
the renamed index. RW rewrites a dependent view's stored definition to
`FROM <new name> AS <old name>` and does not rewrite the stored text of an index
(it still says `ON ..._build`); both are cosmetic.

Then run the parity checks. Drop a replaced view only after its successor is
built everywhere and traces show no `inbox.rw.unified_chain_view_fallback`
events. Keep `rw_inbox_items_v11`: it is `rw_inbox_items_v12`'s base.
