# task #235 Phase 1 — Server contract freeze draft (v2.3.1 — reachability predicates corrected)

**Scope**: additive per-server Activity unread count in `GET /servers/unread-summary`.
**Author**: Argus (Phase 1 server contract owner). **Status**: DRAFT for 3-way ack
(@KMP-专家 Mobile, @CC-Cata Web, @Cindy acceptance). Source basis: slock
`staging@6e5ccaf4e` read-only census (routes/servers.ts:621-692,
routes/channels.ts:842-874, services/activitySyncService.ts:862+).

## 1. Wire shape (additive)

```jsonc
// GET /servers/unread-summary  (auth: session user; entries = user's memberships)
[
  {
    "serverId": "…",
    "unreadCount": 3,          // LEGACY broader sidebar unread — semantics untouched
    "serverPushMuted": false,  // LEGACY — semantics untouched
    "activityUnreadCount": 5   // NEW, OPTIONAL — see semantics
  }
]
```

- `activityUnreadCount` is a **non-negative safe integer** when present.
- **Present ⟺ known**: the server successfully computed this membership's count.
  `0` = known zero ("no unread Activity").
- **Absent ⟺ unknown**: compute failure, feature gate off, or authorization
  cannot be established. Never `null`, never negative, never a substituted
  broader count. The legacy `unreadCounts[id] ?? 0` merge is **forbidden** for
  this field (it remains only for the legacy `unreadCount`).

## 2. Count authority

- Definition (v2, exact binding per Mobile+Web census): the wire field
  **`totalUnreadCount`** of **`GET /channels/inbox?filter=all`** — computed by
  `channelService.getInboxItems(serverId, userId, { filter: "all",
  historyCutoff, humanActivityMuteEnabled })` (routes/channels.ts:924-996;
  `totals` CTE `COALESCE(sum("unreadCount"),0)` at channelService.ts:7686-7691).
  This is exactly what Mobile's `ProcessActivityUnreadRepository` consumes
  today (`filter=all&limit=1&offset=0` → `totalUnreadCount` →
  `ProcessActivityUnreadStore`) and what Home displays. Explicitly **NOT**
  `activeUnreadCount` (a distinct aggregate whose difference from total is
  backend-specific — see the per-backend definitions below; on serving v2
  both zero mention-only and differ only by row set) and **NOT** any
  snapshot window row count. A SQL aggregate over the whole scope: invariant
  under `limit`/`offset`. Any future migration of this authority to another
  aggregate is a separate contract requiring proven equivalence — never a
  silent metric swap.
- **Aggregate definitions (v2.3 — verified-to-the-line, THREE backends)**.
  v2.2's two-backend table misattributed the legacy row (its cited lines
  belong to the RW builder). The NORMATIVE BINDING (wire `totalUnreadCount`
  of `GET /channels/inbox?filter=all`, whatever the active backend computes)
  is unchanged. Verified semantics per reachable backend:
  - **PG legacy inline (pglite/dev fallback)** — channelService.ts:9586-9591
    and :9709: `totalUnreadCount` = `count(m.id)` joining `messages` on
    `seq > lastReadSeq` (excluding the caller's own messages) over
    `selected_activity`; `activeUnreadCount` is **aliased to the same
    value** (:9709). total == active **by aliasing**.
  - **RisingWave direct-query builder** (`buildRisingWaveInboxItems
    ServingQuery`, executed against RW views) — :7689: `totalUnreadCount` =
    plain `SUM(unreadCount)` over `selected`; :7677 `activeUnreadCount` =
    mention-zeroed sum over the pre-facet set. (These are the lines v2.2
    wrongly attributed to legacy.)
  - **PG serving-rows / Sink B (production read path)** —
    channelService.ts:8677: `totalUnreadCount` = `SUM(CASE WHEN mention_only
    THEN 0 ELSE unread_count END)` over `selected` (post-facet);
    `activeUnreadCount` = the same mention-zeroed sum over
    `all_visible_rows` (pre-facet); divergence arises from **row-set
    differences**, not mention-zeroing.
  - **Reachability (actual decision predicates, verified to the line)**:
    1. **RW direct-query** is attempted iff `!q && !opts.forcePostgres &&
       rfc056ServingMode !== "off"` (:9165-9176). In `shadow` mode a RW
       result is read for comparison but DISCARDED — Postgres stays
       authoritative (:9221-9227). A successful non-shadow RW result is
       served.
    2. **PG serving-rows (Sink B)** is entered iff
       `(humanActivityMuteEnabled || historyCutoff) && !risingWaveResult &&
       !opts.forceCanonicalPostgres` (:9262-9283).
    3. **Otherwise → PG legacy inline.**
    The functions `recordRfc056ServingGuardDecision` (:9014-9034) and
    `getLegacyInboxFallbackReason` (:7421) record trace/fallback-reason
    surfaces only — they are NOT the decision authority. This contract makes
    NO claim about which backend production currently serves; that is a
    runtime-configuration observation (mode/mute/cutoff dependent) requiring
    its own evidence if ever asserted.
  - The RW-builder vs serving-rows expression difference is reconciled (or
    not) upstream of these lines; this contract takes no position — the
    per-backend oracle equality obligation (9d) is what guarantees the batch
    matches whatever each backend actually serves.
  - Chosen authority remains `totalUnreadCount` (Home's number on every
    backend).
  - **DoD #11 scope, honestly stated**: the deterministic DI tooth proves the
    service SELECTS the `totalUnreadCount` field (provenance) — it does not
    prove backend divergence exists. The API-level divergence assertion is
    conditional (runs when the backend actually diverges) and its
    mention-only premise does NOT hold on v2; it may trigger via row-set
    divergence scenarios instead.
- **Web migration note (v2, per CC-Cata census)**: Web's current rail
  indicator reads `activeUnreadCount` (LeftRail.tsx:113, Sidebar.tsx:920) —
  today Mobile and Web literally consume different aggregates. That active
  口径 is **superseded semantics**: Phase 2 migrates Web's rail/switcher to
  the frozen `totalUnreadCount` authority. This is an intended semantic
  replacement, to be stated in the Phase 2 Web PR, not a regression.
- **Invariant (cross-surface consistency)**: at equal
  (account, server, historyCutoff, humanActivityMuteEnabled, watermark),
  batch `activityUnreadCount == /channels/inbox(filter=all).totalUnreadCount`. This is
  a server test, and the reason the switcher and Home can never disagree
  again (task #227's root complaint). A dedicated tooth proves equality holds
  with `limit=1` and with multi-page datasets (window size can never
  re-introduce the divergence).
- **Test determinism (v1.1, per Cindy)**: the invariant test compares both
  numbers server-internally against the same materialized state (single
  closed-book evaluation at one watermark), so the §4 freshness allowance can
  never flake it. The v1 wire carries no watermark parameter; the invariant is
  a server-side guarantee, not a client-side assertion.

## 3. Mute orthogonality (ruling)

- `serverPushMuted` (and channel-level activity mute already baked into the
  Activity feed itself) does **not** zero out or absent-out the count:
  the count is fact; mute is presentation/delivery state.
- Frozen display rule for both clients: muted servers still show the exact
  number (may be styled weakened); dot/hidden is **only** for absent/unknown.

## 4. Freshness

- The count may lag real time by **≤ 30 seconds** (server-side caching
  allowance). Consumers must not assert equality against a concurrently open
  Activity view; on entering a server, the Activity snapshot remains the
  authoritative reconciliation point.
- **Fail-closed (v1.2, per KMP-专家)**: if the server cannot prove a cached
  count's age is within the bound, it emits the field **absent** for that
  server rather than returning an unprovably fresh value. Part of the
  freshness tooth.
- No realtime push contract in Phase 1 (clients poll unread-summary as today);
  a push/event channel would be a separate additive contract.

## 5. Batch & partial failure

- **(v2.2, grouped-batch semantics)** The counts are computed by ONE
  set-based query. Honest failure semantics: a batch query failure makes the
  WHOLE batch unknown — every entry keeps legacy fields and omits
  `activityUnreadCount`; the response stays HTTP 200. A member server with an
  empty inbox is **present with 0** (the query anchors on the input server
  list via LEFT JOIN, so empty groups cannot be dropped into false absence).
  Per-server absent-only isolation exists ONLY if a deterministic test
  proves in-SQL isolation of a single server's error; otherwise it must not
  be claimed. (Supersedes the v1 per-server allSettled isolation wording.)
- A membership missing from the response entirely keeps today's meaning
  (not a member / not visible), not "zero".
- **State collapse at render (v1.1, per Cindy)**: `unauthorized` (membership
  or permission lost between listing and compute) and `not member` (entry
  absent) are the SAME client-observable state — unknown → the single
  dot/hidden fallback. Clients must not render a third distinguishable state;
  the `unauthorized` fixture exists to pin server emission behavior (entry or
  field absence), not to add a client state.

## 6. Compatibility

- Purely additive: old clients ignore the field; the legacy `unreadCount` and
  `serverPushMuted` bytes/semantics are regression-locked by tests.
- New clients: absent → dot/hide (the only fallback), per Cindy #5.

## 7. Golden fixtures (server-generated)

- Server contract tests emit versioned fixture JSON at the canonical path
  `packages/server/test-contracts/unread-summary-activity.v1.json` (slock
  repo) covering exactly five states: `zero`, `positive`,
  `batch-failure-all-unknown` (batch query failure → every entry keeps legacy
  fields, new field absent), `unauthorized` (membership lost between list and
  compute → entry absent), and `mixed-known-unknown` — the mixed state must
  arise only from provable per-server causes (permission loss / feature gate /
  unsupported), never from a pretended isolatable per-server SQL compute
  failure. Each state carries
  request/account context (environment, account, server identity) plus the
  expected client-observable outcome, so fence tests are expressible.
- **Cross-repo distribution (v2.1, per KMP-专家 — no self-reported
  authority)**: Web consumes the canonical file in-repo. Mobile
  (`botiverse/mobile`) carries a **vendored mirror plus a recorded upstream
  slock commit SHA**. Mobile's Hosted gate fetches the canonical path **at
  that exact upstream commit** (immutable git surface) and byte/hash-compares
  the mirror against it; upstream unreachable → **fail closed** (gate red,
  never skip). The checksum authority is therefore the server repo's
  immutable commit surface — never a checksum recorded alongside the mirror
  in the Mobile repo (mirror + self-recorded checksum changing together must
  not pass). Cross-repo provenance mutation teeth (DoD #8): mutate mirror
  bytes only → red; repoint the pin to a commit whose canonical fixture
  differs or is absent → red. A server-published immutable provenance
  manifest/artifact is an acceptable future hardening, additive to this.
  Hand-copied same-name JSON without provenance is forbidden. Additive
  evolution only (v2 for breaking).

## 8. Server test checklist (Phase 1 definition of done)

1. Wire shape + non-negative integer + present/absent semantics.
2. `0` vs absent distinguishable end-to-end (serializer never merges `?? 0`).
3. Legacy-field regression: byte-identical output for existing consumers when
   the new field is stripped.
4. Batch failure semantics: a batch query failure yields the whole batch
   with the new field absent, legacy fields intact, HTTP 200 (per §5).
   Single-server isolation may be added later only with deterministic
   in-SQL isolation evidence.
5. Mute orthogonality (muted membership still returns fact count).
6. History-cutoff/plan parity with the Activity snapshot.
7. Cross-surface consistency invariant (§2) at fixed watermark, closed-book.
8. Fixture emission = committed golden file at the canonical path (drift
   fails CI); fixture states carry request context + expected outcome.
   Cross-repo provenance teeth: mirror-only mutation red; pin repointed to a
   commit with differing/absent canonical fixture red; upstream unreachable
   fail-closed (v2.1).
9. Pagination independence: invariant equality holds at `limit=1` and with
   multi-page datasets.
9b. **Set-based plan proof (v2.2)**: the batch is one keyed-by-server query
   (all server IDs + per-server cutoff/mute as VALUES/typed input joined
   into ONE CTE chain, final `GROUP BY server_id`) — not N lateral/UNION
   subplans. Real-PG evidence includes `EXPLAIN (ANALYZE, BUFFERS)` at
   N=1/5/20/50 showing no per-server loop of full CTE chains, plus DB
   time/rows/buffers/connection occupancy — not endpoint wall-clock alone.
9c. **Empty-server zero tooth (v2.2)**: a member server with zero inbox rows
   returns present-0, never absent.
9d. **Oracle equality (v2.3)**: the retired per-server `getInboxItems` path
   remains as the test oracle. For EACH reachable backend, the SAME input
   fixture set is run through both the old per-server oracle and the new
   batch, compared per-server equal across all contract states. A backend
   with no test harness must be EXPLICITLY declared not-exercised in the
   evidence (named, with reason) — never silently skipped.
10. Freshness fail-closed: unprovable cache age → field absent.
11. Aggregate provenance (v2.2 scope): the deterministic DI tooth proves the
    implementation SELECTS `totalUnreadCount`. Backend divergence is
    verified conditionally where the backend can be made to diverge;
    non-divergence on a backend is NOT a failure.

## 9. Explicitly out of scope for Phase 1

- Client rendering/fencing (Phase 2 Mobile/Web).
- Realtime push of count changes.
- Any change to broader unread computation.
- Production deploy (requires its own authority after review).

## 10. PR #2070 (v2, per artin 2026-08-13 14:33Z)

artin ruled the conservative-fallback PR #2070 should be **closed outright**,
not kept open as HOLD. Its owner (@KMP-专家) executed the close (GitHub
`CLOSED`, unmerged). The closed PR and its head exact remain inspectable for
historical reference — the code was never merged, so nothing of it lives on
main. No contract text may describe it as a pending landing candidate or
fallback branch.
