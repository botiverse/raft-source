# Unread contract cases

Unread and thread rules that stay on the client, written once as cases that
web and the app (Kotlin Multiplatform) both run: a starting state, a sequence
of acts, then which requests the client sends and what it shows. Rules the
server can decide (for example the Mark as Unread `outcome`) belong on the
server; their cases here pin how a client reads the answer, including the
fallback for older servers. Task: #proj-mobile:#70 (inventory of rules
R1–R12 and display gaps S1–S2).

Plain JSON, no dependencies: `case.schema.json` (JSON Schema 2020-12) and one
case per file in `cases/`.

## A case

```json
{
  "formatVersion": 1,
  "id": "R9-muted-with-threads",
  "rule": "R9",
  "title": "A muted channel with unread and unread threads shows a grey number, not the badge",
  "status": "agreed",
  "given": {
    "conversation": { "id": "channel-1", "kind": "channel" },
    "row": { "joined": true, "muted": true, "unread": 5, "threads": 1 }
  },
  "steps": [],
  "expect": { "state": { "rowDisplay": { "kind": "quiet", "unreadTone": false } } }
}
```

| Field | Meaning |
| --- | --- |
| `formatVersion` | `1`. See [Versioning](#versioning). |
| `id` | The file name without `.json`. Convention: `<rule>-<what>`. |
| `rule` | The inventory rule (`R1`..`R12`) or display gap (`S1`..). |
| `title`, `why` | What the case says, and why the rule is so. |
| `status` | `agreed`, or `pending-product-decision` (see below). |
| `sources` | Where web / app / server implement it today. Documentation only. |
| `knownGaps` | An agreed rule a client does not follow yet: `{client, reason, followUp}`. That client skips the case and reports the reason. |
| `given` | The starting state: `conversation {id, kind}`, optionally `openThread`, `row` (the row's unread inputs), `jumpTarget`. |
| `steps` | Acts, in order (may be empty: the case is about how `given` is shown). |
| `checkpoints` | Expectations part-way: `{afterStep (1-based), requests?, state?}`. |
| `expect` | The expectation after the last step: `{requests?, state?}`. |
| `decision` | Pending cases only: `{question, owner, candidates[]}`. |

### Acts

Abstract, not tied to either client's stores or components. `act` is the
discriminator (kotlinx.serialization: `classDiscriminator = "act"`).

| Act | Fields | Meaning |
| --- | --- | --- |
| `markUnread` | `surface`: `threadMenu`, `activityRow`, `conversationRow`, `channelMessage` | The person picks Mark as Unread there. |
| `serverResponds` | `status`, `body`, `from?: "olderServer"` | The server answers the earliest unanswered request. `olderServer` bodies are not checked against the current contract. |
| `realtimeEvent` | `type`, `payload` | A socket event arrives (`read_state:updated`, ...). |
| `replyArrives` | `visible` | A reply from someone else arrives in the open thread; `visible` means an auto-read would fire. |
| `leaveThread` | | The person closes the thread or opens another one. |
| `jumpToUnreadThread` | | The person taps the jump pill for `given.jumpTarget`. |
| `jumpLands` | `historyLimited` | The jump finishes, on the parent or on the history paywall. |

### Expectations

- `requests`: every **mutating** request (POST/PUT/PATCH/DELETE) sent since
  the case started, in order, as `{method, path}` with the `/api` prefix and
  the given ids. GETs (refreshes, summaries) are never asserted: the clients
  refresh differently. Absent = not asserted; `[]` = none sent.
- `state`: only the keys listed are asserted.

| State key | Values |
| --- | --- |
| `outcome` | What the Mark as Unread answer means: `counted`, `marked`, `nothing`, `pending` (202). |
| `unreadState` | `{kind: "none"}`, `{kind: "count", count}`, `{kind: "dot"}` (marked unread). |
| `toast` | Abstract toast id (`markUnreadNothing`, `markUnreadFailed`) or `null` for none. |
| `holdActive` | Auto-read is held: the conversation stays unread while it is open. |
| `threadUnreadCleared` | The thread's unread was read away. |
| `rowDisplay` | `{kind, segments?, unreadTone?}`: `kind` is `loud` (pink badge), `quiet` (grey number), `newDot` (not joined, new messages), `markedDot`, `none`; `segments {unread?, threads?}` are the numbers shown (absent = not shown); `unreadTone` is the bold unread name. |

`unreadState` and `rowDisplay` are different layers. `unreadState` is the
unread state an act leaves on the conversation: a number, the marked-unread
dot, or none. `rowDisplay` is how a sidebar/Home row draws that state given
the row's other inputs (joined, muted, `hasNew`, unread threads): the same
`unreadState` count is a loud badge in a joined channel and a grey number in
a muted one. Act cases assert `unreadState`; row cases assert `rowDisplay`.

`unreadCount` in a Mark as Unread answer is a seq distance, not a count of
rows; cases never assert it as a row count.

## Pending product decisions

Where web and the app differ and nobody has chosen yet, the case is
`"status": "pending-product-decision"` with no `expect`; `decision.candidates`
records each candidate's full expectation and which client behaves like it
today (`currentBehaviourOf`). Loaders skip it and report the question. Once
decided, move the chosen candidate's `checkpoints`/`expect` to the top level,
set `"status": "agreed"`, and add a `knownGaps` entry for the client that
still differs until it is fixed.

Agreed rules use web's current behaviour as the reference unless a decision
says otherwise (Tenny, #proj-mobile:#70: a 202 is `pending`; a read-state
event that follows saying nothing was marked shows the nothing toast only
while the hold is still active, and no toast once the person has left).

## Decisions

A decided case keeps only the chosen expectation; the decision is recorded
here (the schema has no field for it) and in the case's `why`. A client that
does not follow it yet has a `knownGaps` entry whose reason starts with
`adopt decision (<who> <date>)`.

| Date | Who | Where | Cases | Decision | Differs today |
| --- | --- | --- | --- | --- | --- |
| 2026-10-29 | artin | #proj-mobile:966d7abd | `R2-optimistic-badge` | Home/sidebar row Mark as Unread shows the unread state at once, then the server's answer corrects it (the app's behaviour). | web |
| 2026-10-29 | artin | #proj-mobile:966d7abd | `R3-only-my-replies-in-thread` | Mark as Unread in an open thread with only the person's own replies is marked (server v1.21.38+ sets `markedUnread`, outcome `marked`); the hold stays while the person is there; no toast. | (none known) |
| 2026-10-29 | artin | #proj-mobile:966d7abd | `R7-jump-lands-on-paywall` | A jump to an unread thread is decided from the row's `parentInHistory`/`repliesInHistory` (the app's behaviour): parent past the window with replies visible opens the thread; both past jumps and reads it; no paywall bounce. | web |
| 2026-10-29 | artin | #proj-mobile:966d7abd | `S1-muted-grey-segments`, `R11-dm-muted-mention` | Sidebar display follows web: a muted row with thread unread shows both grey segments (5 · threads 1); a not-joined public channel with `hasNew` shows the quiet new dot (`R10-not-joined-has-new`); a muted DM stays quiet whatever pierces it (a mention or following does not make it loud). | app |

## Adding a case

1. Copy the closest case in `cases/`, name the file `<rule>-<what>.json`,
   and set `id` to the same name.
2. Fill `sources` for both clients; set `status`, and `knownGaps` for a client
   that does not follow an agreed rule yet.
3. Run the shared check (schema, ids, and that every `serverResponds` body not
   marked `olderServer` is one the current read-state contract allows):
   `pnpm --filter @botiverse/raft-shared exec vitest run src/unreadContractCases.test.ts`.
4. Run the web loader:
   `pnpm --filter @botiverse/raft-web exec vitest run tests/contractCases.unread.test.ts`.
   An agreed case web cannot drive fails until it is driven or listed in
   `WEB_CANNOT_DRIVE_YET` with a reason.
5. The app picks the case up when its vendored copy is next synced.

A new act or state key: add it to the schema and this README in the same
PR, keeping `formatVersion` (see below).

## Versioning

`formatVersion` is the format's version, `1` today. Additive changes (a new
act, state key, `given` key or surface) keep the version; a loader that meets
an act or key it cannot drive skips the case and reports it, never passes it.

Decoders must be lenient per case. A client reading a copy newer than its
own code (the app's vendored copy) can meet an `act` it does not know: it
skips and reports that one case, and the rest of the suite still runs. It
must not fail the whole suite or drop the case silently. Unknown fields in
a known act or in `given` are handled the same way. Within this repo the schema
is checked at the same commit as the cases, so an unknown act there is a
schema error.
A change in meaning or shape (renaming, removing, a field changing type)
bumps `formatVersion`, and a loader skips-and-reports files with a version it
does not know until it is updated. The schema `const` is the one version
this directory's files use.

## Loaders

A loader validates every file, runs the agreed cases it can drive, and
reports every other case as skipped with its reason: pending decision, known
gap for that client, unknown `formatVersion`, or nothing to drive it with yet.
A case is never counted as passed without its expectations being checked.

- **Web**: [`packages/web/tests/contractCases.unread.test.ts`](../../../web/tests/contractCases.unread.test.ts)
  (vitest). It reads the directory through the `@botiverse/raft-shared`
  package path, validates with Ajv, and today drives the R1 answer cases
  through `resolveMarkUnreadOutcome` (what the inbox and message stores use),
  the channel row cases through `getChannelUnreadIndicatorState` and
  `getChannelUnreadSegments`, and the DM row cases through
  `getDmUnreadIndicatorState` (what the Sidebar rows draw from). Each other
  case is a skipped test named with its reason.
- **Shared**: [`packages/shared/src/unreadContractCases.test.ts`](../../src/unreadContractCases.test.ts)
  checks the schema (Ajv strict), every file against it, `id` = file name,
  checkpoints in range, and replayed answers against
  `markConversationUnreadResponseSchema` / `readMutationPendingResponseSchema`.
- **App** (botiverse/mobile, later PR): a pinned copy under
  `compose/shared/src/commonTest/resources/contract-cases/unread/` with a
  `SOURCE_SHA` file, synced from `$SLOCK_SOURCE_REPO`; commonTest decodes the
  cases with kotlinx.serialization and drives a fake `RaftNetworkClient`
  through the shared stores. A drift job in a workflow that checks out slock
  fails when the copy is stale.
