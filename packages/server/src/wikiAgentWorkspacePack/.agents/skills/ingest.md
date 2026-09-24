---
name: wiki-ingest
description: Read eligible Raft activity, compile durable Wiki knowledge, and atomically publish immutable revisions through the authenticated Wiki manifest bridge. Use on first setup, recurring Wiki reminders, and explicit human refresh requests.
---

# Wiki Ingest

Read `AGENTS.md` before using this skill.

## Preconditions

- Raft source access is available.
- `raft wiki manifest`, `raft wiki read`, and `raft wiki publish` are available.
- This Agent is the configured Wiki Agent.

If any precondition is missing, report the exact blocker. Do not advance the
manifest or claim success.

## Procedure

1. Run `raft wiki manifest` and retain the complete response. Its `etag` is the
   only valid `expectedEtag` for this attempt. If `manifest` is null, coverage
   is empty and this run publishes manifest revision 1.
2. If the manifest exists, run `raft wiki read <artifactId>` for the current
   Index and Log plus every Page that may be affected, including archived
   redirect Pages whose former topic overlaps the new evidence. Treat these
   bodies as canonical. Never infer current Markdown from manifest metadata or
   a stale workspace copy.
3. Use `raft server info` to enumerate source channels. Include only active
   public server channels and their threads. Exclude `#all`, the Wiki channel,
   DMs, private/joint channels, and archived/deleted channels.
4. Freeze a source upper boundary for this run. Before semantic reading,
   inventory the eligible channel, thread, task, and attachment boundaries and
   rank likely durable topics. This structural pass defines the complete
   reading plan; it does not publish knowledge.
   The thread inventory is part of this reading plan and must be built from
   each eligible channel's full history, never from the messages of one batch interval. A
   thread's parent can sit far below the range being read while its replies keep
   arriving, so a list derived from one batch's messages misses exactly the
   long-lived discussions. A run must hold a complete inventory for the channels
   it is about to process, including a run resuming partway and a run started by
   the daily schedule, because coverage records which sequences were read, not
   which threads exist. The inventory may be persisted in the workspace and
   extended incrementally across wakes; what it may never be is derived from a
   single batch's read. Guard the source of the list, not the cost of building
   it.
5. Read eligible source inside that plan, above what `coverage` already records
   for each channel and no greater than the frozen boundary.
   `raft message read` returns at most 100 messages per call, and only 50 when
   `--limit` is omitted, so one call is never proof that a target is fully
   read. Page each target with
   `raft message read --target <target> --after <seq> --before <end>`, where
   `<end>` is the end of the range this batch covers for a parent channel, and
   the run's frozen boundary for a thread, so one read of that thread serves
   every chunk. Start from the covered high-water of the channel that coverage
   is keyed on — for a thread that is its parent channel's high-water, not
   zero, because a channel's coverage stands for its threads — or, when this
   run already cached that thread, from where the cache left off, but only
   while the local copy is verified continuous and complete from that lower
   bound up to the mark; otherwise discard the mark and re-read from the parent
   channel's canonical coverage high-water, because a position mark can outlive
   the dump it describes and trusting it silently skips messages that were
   never cached. Repeat from the highest `seq` returned until the window
   reports no newer messages.
   A chunk `(x, y]` must account for every thread whose parent sits at or below
   `y`, not only the threads whose parent falls inside this chunk: replies keep
   arriving long after their parent, so a thread opened in an earlier chunk can
   carry replies into this one. Omitting them is a silent under-count until the
   server counts the range and rejects the publication. Re-reading each of those
   threads' `(x, y]` slice in every chunk is also correct, but it costs one call
   per thread per chunk, nearly all empty on a channel with hundreds of threads.
   Prefer reading each thread once through to the frozen boundary, keeping it in
   the run's local cache, and compiling and counting each chunk from that copy
   by `seq`, taking only the replies inside `(x, y]`. A chunk may publish as
   soon as every thread whose parent is at or below `y` is cached through the
   boundary: a thread whose parent sits above `y` cannot have replies below its
   own parent, so no chunk waits for the whole channel.
   Passing `--before` makes the bound structural instead of leaving it to
   discipline; without it a target is read to the newest message and the batch
   interval means nothing. Sequences are comparable across
   channels, but coverage is recorded per channel: what one channel has been
   read to says nothing about any other.
   Thread replies are not returned by their parent channel's read. A parent
   message that carries replies exposes its thread in the channel read through
   `threadId` and `replyTarget`; read every thread in the run's inventory
   separately by its own target `#channel:parentShortId`, applying the same
   paging loop. Take that list from the structural pass rather than from the
   current interval's channel read, which cannot surface a thread whose parent
   sits below the interval. Omitting a thread drops a whole discussion while
   the channel read still looks complete. Preserve thread context.
   A thread target can exist while containing no replies. `No messages in this
   channel` is a successful zero-message result, not a read failure: it adds
   zero to `observedCount` and does not block completing the parent range.
   Each stored source ref includes `channelId`, `messageId`, `seq`, and a
   linkifiable `slockRef`. Use `#channel:messageShortId` for a top-level source
   or the parent thread target `#channel:parentShortId` for a thread reply.
   A ref's `channelId` is the channel the message actually lives in, so a
   thread reply carries the thread's own channel id — not its parent's. Only
   `slockRef` names the parent. The server matches each ref against the real
   message row, so a parent id here is rejected. This is the opposite of the
   rule for coverage below, and the two are easy to confuse: a ref says where
   a message *is*, coverage says which channel *stands for* it.
6. Group related evidence into durable topics and apply the capture policy in
   `AGENTS.md`. The stable artifact id plus slug is the topic identity. Match
   evidence against the full current Page inventory before creating a Page.
   Match new evidence against existing claims as well as topic identity. When
   it supersedes a decision, closes an open question, changes ownership, or
   otherwise makes a current Page claim stale, update every affected Page in
   this publication instead of leaving the repair for weekly lint.
   Partial coverage cannot prove that something is currently absent. Do not
   turn "not found in the source read so far" into a present-tense claim such
   as "still open", "no decision", or "no owner". Until every eligible source
   channel is covered through the run's frozen boundary, either omit that claim
   or state the verified historical limit and that current status is unverified.
7. Create or improve coherent Page markdown. Avoid duplicate or one-message
   pages. Reuse each unchanged Page's current artifact and revision fields.
   If a prior lint merged a topic into a surviving Page and left an archived
   redirect, extend the survivor. Do not recreate, reactivate, or split the
   absorbed topic merely because new source uses the older narrower wording.
   Reopen it only when new source establishes a genuinely independent durable
   question, and explain that source-backed divergence in Log.
8. Reconcile Index so every current Page is discoverable.
9. Reconcile Log with only meaningful document changes.
10. Construct one publication JSON object:
   - `expectedEtag`: the ETag read in step 1, or null for first publication
   - `manifest`: prior manifest revision + 1, `coverage` extended with exactly
     the ranges this publication actually read, the current Index/Log/Page
     inventory, one new `lastIngest` receipt, and the previous `lastLint`
     receipt unchanged
   - every range added to `coverage` must appear in `lastIngest.added` as
     `{channelId, from, to, observedCount}`, where `observedCount` is how many
     messages you saw in that range. The server counts the same range itself
     and rejects a mismatch, so this is the one claim in the publication that
     cannot be made by assertion alone
   - count the channel and its threads together. Sequences are server-wide and
     a thread reply carries its own, so a parent channel's range spans the
     replies interleaved with it; the server counts them under the parent too.
     Counting only the parent's own messages under-reports and is rejected
   - the `coverage` key and `lastIngest.added[].channelId` are always the
     parent channel. Never key either on a thread. This applies to coverage
     only — `sourceRefs[].channelId` is the message's own channel, as above
   - `revisionBodies`: markdown only for newly referenced immutable revisions
   Use one strictly newer ISO timestamp for both `manifest.publishedAt` and
   `manifest.lastIngest.publishedAt`.
11. For every changed document, generate a new UUID revision id and set its key
   to `servers/{serverId}/wiki/revisions/{artifactId}/{revisionId}.md`. Set
   `sha256` to lowercase SHA-256 of the exact UTF-8 bytes and `bytes` to the
   exact UTF-8 byte count. Preserve the stable artifact id and slug when
   updating an existing document.
12. Run `raft wiki publish --input <publication.json>`. Treat success only as
    the returned manifest plus new ETag. The server writes immutable revisions,
    verifies receipts and source refs, and advances the manifest with CAS.
13. An input-validation failure is a safe rejected attempt. The server checks
    source refs, `observedCount`, manifest invariants, and every revision body
    before the first storage write, so the manifest, coverage, and revision
    storage are unchanged. It reports all independently detectable source-ref
    and `observedCount` problems together. Correct the reported fields in one
    pass and retry the existing payload; do not reread source, regenerate UUIDs,
    or rebuild unaffected documents. CAS still protects the retry if another
    publication committed in the meantime.
14. On HTTP 409 / `WIKI_MANIFEST_PUBLISH_FAILED`, reread the manifest and
    recompute the publication against the new state. Never substitute the new
    ETag into an old payload and replay it blindly.

Coverage may only record ranges that were actually read and verified, and only
for the channel they were read from. A truncated, partial, or failed read must
not be recorded. Coverage never shrinks, so a range claimed once is never
revisited: claiming more than was read hides that source permanently while the
run still looks successful. When a range cannot be confirmed complete, record
only the part that was, publish nothing beyond what was genuinely compiled, and
report the blocker.

Recording a range you checked and found empty is correct and required. "I read
this range and there was nothing here" is a result; leaving it unrecorded turns
a quiet channel into a permanent gap.

Ingest must preserve the topic structure produced by a prior clean lint.
Without genuinely new source that changes the durable-question boundary,
`lint → ingest` cannot split a merged topic back into its former fragments.

Published Wiki artifacts must not become a second raw-message archive. Raw
content remains authoritative in Raft, and Wiki documents store concise source
references. This does not forbid a run-scoped, disposable workspace cache of
eligible source when it avoids rereads across batches or wakes. Such a cache is
non-canonical: source refs still point to real Raft messages, raw cache content
is never published, and the cache is discarded rather than maintained as a
second long-lived archive.

## Cold Start

The first run has no coverage and faces the whole eligible history, which is far
larger than an ordinary delta. Do not carry all of it to a single final
publication: publish in batches so committed progress survives failure.

- Freeze a fresh source boundary at the start of every wake and keep it only
  across that wake's batches. The bound prevents one execution from chasing
  messages that arrive while it is reading; the next wake deliberately freezes
  the then-current live boundary so channels or messages created since the last
  wake enter the plan.
- The boundary is run-local planning state, not a canonical manifest fact.
  Never persist or reuse it across wakes. Each wake continues from canonical
  manifest coverage and derives its remaining work anew: every eligible channel
  must be covered contiguously from 0 through that wake's boundary. Do not add a
  persisted completion bit or reinterpret already verified ranges as unread.
- Batch by channel. Read a channel and all of its threads from that channel's
  start — through to the frozen boundary when it fits in one batch, otherwise in
  chunks as described below — compile what it yields, and publish, extending
  `coverage` for the channels this batch actually read. Coverage is recorded per
  channel, so a batch claims nothing about any channel it did not read.
- A channel is the right unit because it is also the unit knowledge arrives in.
  A topic's argument usually lives in one channel or one of its threads, so a
  channel read through is enough to compile a complete, citable Page; a batch
  cut across all channels at once yields fragments of every conversation and
  completes none of them.
- Each batch is an ordinary publication: revision + 1, the ranges you read in
  `lastIngest.added` with their observed counts, and a new receipt.
- The first publication of a cold start must be revision 1 and must already
  carry at least one Page, so a first channel that yields nothing publishable
  cannot be committed on its own. Continue to the next channel and fold it into
  the same batch; coverage stays as it was until something commits.
- A failed batch leaves every earlier committed batch intact. Later wakes
  resume from what coverage already records after freezing their own fresh
  boundary.
- Read a channel only from its start. If it fits in one batch, read it through
  and publish. If it does not fit, cut it into chronological chunks from the
  oldest upward and publish each one: `0..x`, then `x+1..y`, and so on.
  Coverage then grows contiguously from the beginning and is never holed, while
  every chunk commits, so a failure costs only the last chunk instead of the
  whole channel.
- Publishing a chunk uses both forms of the same range. `coverage` carries the
  merged cumulative interval (`0..y`), because coverage is accumulated state and
  the manifest rejects adjacent unmerged ranges. `lastIngest.added` carries only
  this publication's new segment (`x+1..y`), and `observedCount` counts only
  that segment, because the server counts exactly the range you declare.
- Never start a channel from its middle or its newest end. The format records
  such a hole visibly rather than hiding it, but recording a gap is not the same
  as closing one: a hole sits below the highest sequence you have covered, and
  nothing you can rely on will bring you back to it. Treat leaving one as
  permanent loss of that history.
- An uncovered channel is unfinished work, not an absence of news. Advancing
  those channels toward the frozen boundary is every run's first duty, carried
  across wakes until none remain — with one exception, which belongs to the
  same rule: a channel already covered contiguously from its start may also
  take its newer messages in the same run, because that extends a range with no
  hole behind it. A channel still missing earlier history may not, because
  reading its newest messages is the jump to the newest end forbidden above.
  So history never waits on recent traffic, and recent traffic never waits on
  history, and neither is read in a way that leaves a gap. Do not read a run as
  "nothing new to do" while any eligible channel is still uncovered.
- The cold start is complete when every eligible channel is covered to the
  frozen boundary.

## No-Change Runs

If you read ranges and what you read contains no durable knowledge:

- reuse all existing Index/Log/Page artifact and revision fields
- publish `revisionBodies: []`
- set `lastIngest.outcome` to `no_changes`
- extend coverage only over the ranges that were actually read successfully
- do not post a daily summary

This is the run that read something and found nothing worth writing, so it has
a result to record: the ranges are now verified empty rather than unknown. It
is not the run that had nothing left to read. With no uncovered source there is
nothing to record, so publish nothing at all — see Reminder in `AGENTS.md`.

## Reminder Output

For reminder-triggered runs, post a short Wiki-channel summary only when the
run found meaningful decisions, progress, risks, ownership changes, or Wiki
document changes. Cite the relevant Raft source. Otherwise remain silent.

## Report

Report:

- source boundary read
- pages created or updated
- whether index and log changed
- manifest revision and CAS commit result
- daily summary posted or skipped
- any permission, source, or Wiki bridge blocker

Never describe a partial write as a completed ingest.
