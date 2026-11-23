# Activity row contract cases

The rules an Activity row is kept by between inbox answers, written once
as cases that web, the app (Kotlin Multiplatform) and the server run. Task:
#triage:#244 (the inbox redesign: snapshot + ordered events). Same format
family as [`../unread/`](../unread/README.md); this directory has its own
schema.

- **`position`**: the per-row position rule. A served row says what it has
  counted up to (its `latestActivitySeq`, P). The client applies live
  messages above P, ignores one it already applied, and re-reads **that one
  row** (`GET /api/channels/inbox?ids=<row>`, never the list) when a message
  at or below P was not applied by it, when an answer arrives after a commit
  order inversion, or when the row has no position.
- **`predicate`**: does a live message count as unread on its row for this
  viewer, and does it light the @.
- **`sync_inbox_row`**: how a GET /api/sync/changes `inbox_row` change
  (`SyncInboxRowChange`, inbox_row capability) applies to the held row. An
  upsert is an `answer` step (the same merge; its row may carry `readSeq`),
  a delete a `syncDelete` step. Shared: `applySyncInboxRowChange`. What the
  server sends when (the message arm holding a row, the cursor's message
  position) is server-only and pinned by
  `packages/server/src/routes/syncChanges.inboxRows.api.test.ts`
  (`sync_own_message_m_advances`, `sync_held_row_not_sent_m_stops` there).

Shared implementation: [`reduceActivityRow`](../../src/activityRowPosition.ts)
and [`activityLiveUnread`](../../src/activityUnreadPredicate.ts) in
`@botiverse/raft-shared`. Web applies them with the server flag
`inbox_row_position_v1` on (step 2, `packages/web/src/store/inboxRowPosition.ts`);
off, web keeps its earlier live patch.

Plain JSON, no dependencies: `case.schema.json` (JSON Schema 2020-12) and one
case per file in `cases/`.

## A case

```json
{
  "formatVersion": 1,
  "id": "reverse_commit_live_after_answer",
  "rule": "position",
  "title": "101 commits before 100; the answer at 101 misses 100, and live 100 arrives after it: re-read the row once",
  "status": "agreed",
  "given": { "row": { "unreadCount": 0, "hasMention": false, "position": "99", "mentionOnly": false } },
  "steps": [
    { "act": "answer", "row": { "unreadCount": 1, "hasMention": false, "position": "101", "mentionOnly": false } },
    { "act": "liveMessage", "seq": "100", "counts": true, "mentionsViewer": false },
    { "act": "answer", "row": { "unreadCount": 2, "hasMention": false, "position": "101", "mentionOnly": false } }
  ],
  "expect": { "row": { "unreadCount": 2, "position": "101" }, "reread": true }
}
```

| Field | Meaning |
| --- | --- |
| `formatVersion` | `1`. See [Versioning](#versioning). |
| `id` | The file name without `.json`, `snake_case`. Predicate cases start with `predicate_`. |
| `rule` | `position`, `predicate` or `sync_inbox_row`. |
| `title`, `why` | What the case says, and why the rule is so. |
| `status` | `agreed`, or `pending-product-decision` (see below). |
| `sources` | Where web / app / server implement it today. Documentation only. |
| `knownGaps` | An agreed rule a side does not follow yet: `{client, reason, followUp}` (`client`: `web`, `app`, `server`). That side skips the case and reports the reason. |
| `given` | `position`, `sync_inbox_row`: `row`, the row as its last answer delivered it (nothing applied yet). `predicate`: `viewer {type, id}`, `scope`, `message`. |
| `steps` | `position`, `sync_inbox_row`: acts in order. `predicate`: always `[]`. |
| `checkpoints` | `position`, `sync_inbox_row`: `{afterStep (1-based), row?, reread?}`; `sync_inbox_row` also `removed?`. |
| `expect` | `position`: `{row?, reread}`. `sync_inbox_row`: `{row?, reread, removed?}`. `predicate`: `{verdict}`. |
| `decision` | Pending cases only: `{question, owner, candidates[]}`. |

### The row (`given.row`, an `answer`'s `row`)

`{unreadCount, hasMention, position, mentionOnly, readSeq?}`: the served row's unread
inputs. `position` is its `latestActivitySeq`, or `null` when the server could
not pair it with the row's latest message: such a row takes no live patch.
`readSeq` (optional, an answer's row): the read position served with it (the
row's `maxReadSeq`); merged as a read is, so the row keeps the higher read seq
and a Mark as Unread ceiling still holds.

### Seqs are decimal strings

Every seq in a case (a row's `position`, a `liveMessage`'s or a `read`'s
`seq`, an expected `position`) is a canonical decimal string
(`^(0|[1-9][0-9]*)$`), as the server sends `latestActivitySeq`.
`messages.seq` is a 64-bit bigserial, and a floating-point number loses
precision past 2^53. Loaders keep seqs as strings or exact 64-bit integers
(BigInt, Kotlin `Long`) and compare them exactly, never as `Number`/`Double`.
`seq_above_2_53` (9007199254740993 vs 9007199254740992) fails a float
compare. The shared reducer takes and returns decimal strings and compares
them with `compareActivityRowSeq`. A
`mentionOnly` row (a mention with nothing else unread) has the highest
mention seq as its position.

### Acts (`position`)

`act` is the discriminator (kotlinx.serialization: `classDiscriminator = "act"`).

| Act | Fields | Meaning |
| --- | --- | --- |
| `liveMessage` | `seq`, `counts` (`true`/`false`/`null`), `mentionsViewer` | A live message of the row's conversation arrives, with the predicate's verdict for it. `counts: null` = it cannot be judged (re-read the row). |
| `answer` | `row` | An inbox answer with this row arrives (a list read or a single-row re-read). |
| `read` | `seq` | The viewer's read up to `seq` is applied (a persisted read, a read change's `refSeq`). |
| `markUnread` | none | The viewer marks the conversation unread (the read cursor moves back). |
| `syncDelete` | `position` (seq or `null`), `reason` (`done`/`left`) | `sync_inbox_row` only: an `inbox_row` delete arrives. |

The rule, in full (design doc "Fact 1"):

1. Live `seq > P` and not applied: apply it (count it if `counts`; a mention
   lights the @). An applied `seq` lower than one already applied since the
   last answer is an **inversion**.
2. Live `seq > P` already applied: ignore it (the same message again).
3. Live `seq <= P`: re-read the row (it may have committed after a higher seq).
   Since the applied set resets on every answer, a copy of a seq an answer
   already covered also re-reads (`duplicate_covered_by_answer_rereads`).
4. A row with `position: null`: every live message re-reads it.
5. An answer at `Pa < P`: keep the row. Otherwise take the answer and apply
   again the seqs applied above `Pa`; those at or below `Pa` are trusted as
   counted in it, unless an inversion was seen: then re-read the row. An
   older answer is kept out whether or not a live message came first
   (`older_answer_kept`, `older_answer_kept_no_live`).
6. A mention-only row: a counted message above it, a counted mention
   included, makes it a normal unread row; a mention that does not count (a
   muted conversation) lights the @ and keeps it mention-only.
7. A read at or past the shown position clears the unread and @. A read below
   it, on a mention-only row, or on a row without a position, re-reads the row.
   Either way the applied seqs at or below the read no longer count, so an
   answer below them does not count them again (`read_then_answer_below_applied`).
   A read covers only what is at or below it: an answer with a message past
   the read keeps its unread (`read_covers_only_its_activity`, #15049).
   The row keeps the highest seq read (its **read seq**, raised by every read
   or read ack, never lowered by an older one, and kept across answers). An
   answer at a position at or below the read seq counted only read messages
   (the server computed it before the read reached it): its unread and @ are
   dropped (`answer_before_read_lands`, `answer_before_read_lands_no_live`).
   A mention-only answer is taken as it is: its @ does not follow the read
   cursor on every server path (`answer_mention_only_after_read_keeps_at`).
   A Mark as Unread clears the read seq and keeps it as a ceiling: a read at
   or below the ceiling (a late ack of a read from before the mark) does not
   raise the read seq; a read above it lifts the ceiling and records as usual
   (`mark_unread_then_late_read_ack`).

8. A live message with `moves: false` (past a channel or DM mute) does not
   move the row: RisingWave keeps it at its last message before the mute.
   Without a mention of the viewer it changes nothing and re-reads nothing
   (`muted_message_leaves_row`). A mention lights the @ and is applied
   without becoming the shown position, so an answer behind it keeps the @
   and a read past it clears it (`muted_mention_lights_without_moving`); on a
   mention-only row it moves the row as rule 6 says. `moves` is absent (true)
   on every other step.

### The sync rule (`sync_inbox_row`)

1. An upsert is an answer (rule 5): ignored only when its position is below
   the row's delivered position; an equal one replaces
   (`sync_upsert_equal_position_replaces`, `sync_upsert_below_ignored`). The
   read seq is the higher of the row's and the upsert's `readSeq`, so what the
   upsert counts at or below it stays read.
2. A delete applies when its `position` is `null` (`left`:
   `sync_delete_left_unconditional`) or at or past the position the row shows
   (a live message applied above its answer included); below it, a newer
   message brought the row back and it is kept
   (`sync_delete_done_below_activity_kept`).
3. The server sends at most one change per row id per response, so a client
   never has to order an upsert against a delete of the same row.

The rule has no clock: a row is kept by its positions alone, never by how long
ago something happened. A client that holds a row read for a while (a local
read hold) must not depend on that hold to keep a late, older answer out
(`older_answer_kept_without_hold`).

### Predicate inputs

`scope`: `rowKind` (`channel`, `dm`, `thread`, `task`), `threadFollowed`
(thread/task rows; absent = true), `activityMuted` (channel/DM rows; a live
message is past the mute boundary), `readOnArrival` (the client reads it as it
arrives: open at the bottom with the read saved, a queued read, a read hold).

`message`: `senderType`, `senderId`, `messageType` (`chat`/`system`),
`causalActorType`, `causalActorId`, `systemSubtype` (`null` = none; **absent**
= the event did not carry the system provenance), `mentions [{type, id}]`.

### Expectations

- `row`: what the row shows; only the listed keys are asserted. `position` is
  the shown `latestActivitySeq`: the delivered one, or the highest seq applied
  above it.
- `removed` (`sync_inbox_row`): the row is no longer held.
- `reread`: some step since the case started asked to re-read this one row.
  It does not say which request (agreed with the app): a client asserts that
  it asked for a single-row re-read of the case's row, not the list.
- `verdict`: `{counts, mention, moves}`. `counts: null` = cannot be judged
  from the event; the row is re-read. `moves: false` = the message does not
  become the row's latest activity (past a channel or DM mute, a mention
  included): the client passes it to the position rule as the step's `moves`
  (rule 8).

## Pending product decisions

Where the sides differ and nobody has chosen yet, the case is
`"status": "pending-product-decision"` with no `expect`;
`decision.candidates` records each candidate's full expectation and who
behaves like it today (`currentBehaviourOf`: `web`, `app`, `server`). Loaders
skip it for the rule and report the question; web and the server each check
that their own candidate is still what they do. Once decided, move the chosen
expectation to the top level, set `"status": "agreed"`, record it below, and
add a `knownGaps` entry for a side that still differs. None is open today.

A web `knownGaps` entry here is about web with `inbox_row_position_v1` on
(`inboxRowPosition.ts`), the path that follows these cases; there is none
today. Where web's flag-off live patch (`inboxInPlaceUnread.ts`, kept as it was
while the flag is off) differs, web's loader lists the case in its own
`FLAG_OFF_DIFFERS`, not here.

## Decisions

| Date | Who | Where | Cases | Decision | Differs today |
| --- | --- | --- | --- | --- | --- |
| 2026-11-14 | Tenny | #14988 review | `predicate_channel_own_caused_system`, `predicate_dm_own_caused_system` | A system message the viewer caused does not count, on any row kind (RisingWave). | web flag-off live patch (thread rows only) |
| 2026-11-14 | Tenny | #14988 review | `predicate_channel_uncounted_subtype`, `predicate_channel_self_unfollow_subtype` | `channel.self_unfollow_thread` and `task.deleted_summary` do not count, on any row kind (RisingWave). | web flag-off live patch (thread rows only) |
| 2026-11-14 | Tenny | #14988 review | `predicate_muted_channel_message` | A new message in a muted conversation does not count (RisingWave muted prefix). | web flag-off live patch (no mute input) |
| 2026-11-14 | Tenny | #14993 review | `read_then_answer_below_applied` | A read covers the live seqs applied at or below it: an answer below them does not count them again (shared `applyRead`). | none (shared reducer since #14993) |
| 2026-11-14 | Tenny | #14988 review | `predicate_muted_channel_mention` | A mention in a muted conversation lights the @ and does not count (RisingWave). | web flag-off live patch |
| 2026-11-16 | Tenny | #triage:#244 | `predicate_muted_channel_message`, `predicate_muted_channel_mention`, `muted_message_leaves_row`, `muted_mention_lights_without_moving` | Follow RisingWave: past a mute no message moves a row with a pre-mute message (`moves: false`); a mention lights its @; a mention-only row still moves. Judged in place, no list re-read. | web flag-off live patch (re-reads the list on a mention) |
| 2026-11-17 | Scout, Lagoon | #triage:#244, #15301 review | `answer_before_read_lands`, `answer_before_read_lands_no_live`, `answer_mention_only_after_read_keeps_at`, `mark_unread_then_late_read_ack` | The row keeps its read seq; an answer at or below it has nothing unread, so an answer computed before a read and arriving after it does not bring the unread back (shared `mergeAnswer`). A mention-only answer is not cleared by it. Mark as Unread clears it and keeps a ceiling a late read ack cannot raise it past. | web meets it with its store's read projection (`inboxReadProjection.ts`, `projectionCoversActivity`), not yet through the shared read seq |
| 2026-11-17 | Tenny | #triage:#244 (sync inbox rows, PR1) | `sync_upsert_equal_position_replaces`, `sync_upsert_below_ignored`, `sync_delete_done_below_activity_kept`, `sync_delete_left_unconditional` | An `inbox_row` upsert goes through the answer merge (read seq and ceiling: the higher of old and new; other fields from the new row). A delete applies at a null position or at or past the shown position. One change per row id per response. | no client applies `inbox_row` yet (web and app: capability not sent) |

Web's gaps closed in step 2 for the flag-on path (`inbox_row_position_v1`);
the server's pure inbox model (`inboxPolicyModel.ts`) follows all four rows
since step 2 too. The server runner checks every server-decided predicate
case against both SQL rules: the RisingWave `unread_count` FILTER and the
canonical Postgres read's fragments in `getInboxItems` (search, guest access,
forced reads): `inboxRowMessageCountsUnreadSql` and `inboxPersonalMentionSql`.

## Adding a case

1. Copy the closest case in `cases/`, name the file `<id>.json`.
2. Fill `sources`; set `status`, and `knownGaps` for a side that does not
   follow an agreed rule yet.
3. Run the shared check (schema, ids, and every agreed case against the
   shared rule):
   `pnpm --filter @botiverse/raft-shared exec vitest run src/activityRowContractCases.test.ts`.
4. Run the web loader:
   `pnpm --filter @botiverse/raft-web exec vitest run tests/contractCases.activityRow.test.ts`.
5. A predicate case: run the server check:
   `pnpm --filter @botiverse/raft-server exec vitest run src/services/activityUnreadPredicate.contractCases.test.ts`.
6. The app picks the case up when its vendored copy is next synced.

A new act, `given` key or expectation key: add it to the schema and this
README in the same PR, keeping `formatVersion`.

## Versioning

As [`../unread/`](../unread/README.md#versioning): additive changes keep
`formatVersion` (1); a loader that meets an act or key it cannot drive skips
that case and reports it, never passes it and never fails the whole suite. A
change in meaning or shape bumps `formatVersion`.

## Loaders

A loader validates every file, runs the agreed cases it can drive, and
reports every other case as skipped with its reason. A case is never counted
as passed without its expectations being checked.

- **Shared**: [`packages/shared/src/activityRowContractCases.test.ts`](../../src/activityRowContractCases.test.ts):
  the schema (Ajv strict), every file, `id` = file name, checkpoints in range,
  the named cases present, and every agreed case through `reduceActivityRow` /
  `activityLiveUnread`.
- **Web**: [`packages/web/tests/contractCases.activityRow.test.ts`](../../../web/tests/contractCases.activityRow.test.ts):
  every agreed case against the shared rule through the package path; each
  agreed predicate case through web's flag-on adapter (`rowPositionVerdict`),
  which must give the case's verdict exactly; and each predicate case through
  web's flag-off live patch (`liveActivityUnread` + `liveUnreadFields`), which
  must match, except the cases in its `FLAG_OFF_DIFFERS`, which must still
  differ.
- **Server**: [`packages/server/src/services/activityUnreadPredicate.contractCases.test.ts`](../../../server/src/services/activityUnreadPredicate.contractCases.test.ts):
  each predicate case the server decides, against the RisingWave
  `unread_count` FILTER read from `infra/risingwave/sql/075-…` (and the muted
  boundary, and `078-…` for task rows) executed in PGlite, and against
  `isMessageUnreadEligibleForReceiver`.
- **App** (botiverse/mobile): a pinned copy under
  `compose/shared/src/commonTest/resources/contract-cases/activity-row/` with
  a `SOURCE_SHA` file, as for `unread/`; commonTest decodes the cases and
  drives the app's row reducer and predicate.
