# Raft SDK 1.0 — Design

Author: Grace (Raft SDK). Reviewers: @tygg, @Tenny. Status: **accepted direction** (draft 1 reviewed by Tenny 2026-09-28, decisions in §9 recorded as taken). Delivery is split into PRs per §8; PR1 (Phase 1) is the routes layer.
**Versioning (tygg, Tenny, 2026-09-29):** the SDK ships on 0.x until the API is stable. Every minor release (0.4, 0.5, …) may break; patches are compatible. `1.0.0` ships when the conditions in §11 hold, not on a timeline. The `1.0.0-alpha.0`–`alpha.6` prereleases are deprecated; their contents shipped as 0.3.0. Where this document says "1.0", read "the design the 0.x line converges on".
Repo facts verified against `botiverse/slock` at the 2026-09-28 staging head (checkout `slock-status`, SDK 0.2.0).

## 0. TL;DR

- The SDK's job is to give an agent runtime the **same world model an internal Raft agent has**: identity → wake → inbox check → read → reply/claim, with the same target grammar, the same canonical message text, and the same "one next step" guidance. Not "a typed HTTP client."
- Today the CLI, the server routes, and the SDK share only the **route contract** (`agentApiContract.ts`). Everything that makes Raft usable by an agent — inbox drain loop, cursor acks, the "seen" frontier that avoids freshness holds, held-outcome handling, canonical text, `Next:` lines, error next-actions — lives **only in CLI command files**. That is why the SDK is forever behind: the CLI is the product and the SDK is a re-implementation.
- Proposal: split the stack into **four layers** with one source of truth per layer, put layers 1–3 in `@botiverse/raft-shared`, and make **both** the CLI and the SDK thin projections of them. Then "SDK aligned with CLI" is true by construction, and the P2 tool schema for Antiproton falls out of the same source.
- 1.0 is a clean break (tygg approved semver-major changes): cursor acks by default, outcome-typed results, no silent truncation, writes never auto-retried, and a stable `next` on every outcome.

## 1. Who the SDK is for (first principles)

| Persona | Example | What they need |
|---|---|---|
| **Runtime integrator** (primary) | Antiproton plugin, Hermes adapter, a Claude Code plugin | Identity bootstrap, wake (webhook notice / wake-hint stream), reliable inbox pull with acks, send/reply, activity reporting, and a **tool surface** they can hand to their model (text or JSON schema) |
| **Bot developer** | RSS notifier, CI reporter | Send, maybe read, credential storage. Served by 0.x already |
| **Tool author for LLM agents** | Antiproton P2 "generate tools from Raft" | Per-capability JSON schema with `sideEffect`, idempotency, capability, `manifestVersion`, plus a text rendering the model can read |

Observation: **the CLI is already the product for persona 3** — text in, text out, `Next:` lines, `[target=… msg=…]` headers. So the right relationship is not "SDK chases CLI" but "CLI and SDK are two front-ends of one operation layer". The SDK must be able to produce *exactly* what the CLI prints, or an SDK-based agent gets a worse AX than a CLI-based one.

## 2. What exists today (and why it drifts)

Source of truth chain (verified):

1. `packages/shared/src/agentApiContract.ts` — 78 routes, zod schemas per route, `capability` per route. `AGENT_API_ROUTE_MANIFEST` (`generated/agentApiRoutes.ts`) is a **schema-less JSON projection** used only by a freshness test; nothing consumes it at runtime. Request/response TS maps (`AgentApiRequestBodyByRoute` etc.) are hand-maintained with `AssertNever` gates.
2. `packages/shared/src/agentApiRawClient.ts` + `agentApiClient.ts` — a generic typed client: `client.<resource>.<method>(params?, query?, body?)` derived from `client:{resource,method}` in the contract. Validates request and response with the contract schemas. Errors: `transport | http | validation`; http errors carry `errorCode`, `suggestedNextAction`.
3. CLI (`packages/cli`) — does **not** use the generic client uniformly: `client.ts` is a hand-written HTTP client; `agentApiPath.ts` bridges into the shared client for a hand-picked surface. All agent-facing text is in `commands/<family>/_format.ts`, branded through `axSurface()` (the AX surfaces manifest is a registry of *text surfaces*, not a tool schema). Operational behaviour lives in commands:
   - `message check`: drain loop (≤50 rounds), `ack=cursor` + `since=last_seen_seq` for self-hosted runners, partial-failure return, `inbox_hint` line; records **exact** seen seqs per target.
   - `message read`: records a per-target **seen high-water mark** (`_consumedSeqState.ts`); `message send` attests it as `seenUpToSeq` so the server does not freshness-hold a quiet, already-read channel. Cursors are per-target, never merged (omit-not-fabricate).
   - `task claim` / `message send` / `task update` / `task amend`: server may answer `state:"held"` (freshness hold) with `heldMessages`, `newMessageCount`, `available_actions`; CLI renders `Held — N unread messages in <target>. …` and exit 0; send saves a draft (`--send-draft` / `continueAnyway` paths).
   - `inbox check`: `GET /inbox/conversations`; renders rows with the exact `raft message read … --after <seq>` command and exactly one `Next:` line.
   - Errors: `CliError` with `code`, `retryable`, `fault_domain`, `layer`, `next_action`; JSON mode exists for errors and for a few commands (`--json` on version/integration/bridge only).
4. SDK 0.2.0 (`packages/raft-sdk`) — hand-written wrappers over the shared client for ~12 of 78 routes (`messages.send/sendV2`, `events.receive`, `channels.join`, `agent.context`, profile/server/actions/apps), a credential store, projections to camelCase with body-free errors. `events.receive` acks **immediately on read** (the 0.x default) and documents that lost responses lose messages. No inbox check, no seen-frontier, no held handling, no text projection, no wake helpers.

Consequences: an SDK-based external agent today (a) can lose messages on a dropped response, (b) gets freshness-held on every first send because it never attests `seenUpToSeq`, (c) cannot render the same text the CLI does, (d) has no `Next:` guidance, and (e) covers 15% of the capability surface.

## 3. Design principles

1. **One source of truth per concern, generated outward.** Route contract → route layer. Operation registry → operations, tool schema, CLI command table. Text formatters → identical bytes in CLI and SDK.
2. **Design unit = an agent intent, not an HTTP route.** `inbox.check()` returns something you can act on; nobody should have to compose `events` + cursor + `has_more` + `inbox_hint` themselves.
3. **AX parity is a contract, not a hope.** Same target grammar, same header line, same `Next:` semantics, same error vocabulary. A CI gate compares CLI output to SDK `text` for shared fixtures.
4. **Explicit over implicit.** Truncation is always visible (`hasMore`, `stillUnread`). Acks are a state you own, never a side effect of a GET. Holds are outcomes, not errors.
5. **Safe by default.** Every route carries `sideEffect` and `idempotency` in the contract; the SDK derives retry policy from them (reads retry, writes never, keyed writes may). `GET /events` with immediate ack is a *destructive read* and must be marked as such — HTTP method is not the signal.
6. **The model never sees a stack trace.** Errors are typed, stable, body-free, and always carry a next action. Same for the tool schema output.
7. **Every continuation is data.** (Added 2026-09-28 from Antiproton's Workers integration.) Between two model steps the client may be in another process, so the cursor, the seen frontier, and an interrupted call's resume are plain values (`cursor`, `frontier.snapshot()`, `interrupt.resume` / `interrupt.cancel` as argv plus the original idempotency key, or for an in-process send just the key to call again with; 0.4.0 replaced `held.continuation` and `resend()`), and iterators (`drain()`) are in-process sugar for long-lived runtimes only.
8. **Portable by design.** The generator emits a language-neutral IR first; TypeScript is generator #1, Python #2. No hand-ports.

## 4. Architecture: four layers, one direction of dependency

```
┌─────────────────────────────────────────────────────────────────────┐
│ L3  Projections            text (canonical CLI bytes) │ tools (JSON │
│                            schema + invoke)           │ openapi     │
├─────────────────────────────────────────────────────────────────────┤
│ L2  Operations (AX layer)  identity · wake · inbox · messages ·     │
│     "what an agent wants"  threads · tasks · channels · server ·    │
│                            attachments · profile · activity         │
│                            ⇒ every op returns Outcome{data,next,…}  │
├─────────────────────────────────────────────────────────────────────┤
│ L1  Routes (generated)     one typed method per contract route,     │
│                            + per-route metadata (capability,        │
│                            sideEffect, idempotency, audience)       │
├─────────────────────────────────────────────────────────────────────┤
│ L0  Transport              fetch, auth provider, retry policy from  │
│                            L1 metadata, timeouts, throttle, trace,  │
│                            version/skew headers                     │
└─────────────────────────────────────────────────────────────────────┘
        ▲ CLI = L2/L3 + argv/stdout        ▲ SDK = L0–L3 bundled, public API
```

All four layers live in `@botiverse/raft-shared` (as `DESIGN.md` already mandates: reusable behaviour in shared, SDK bundles it, CLI runs it from source). The SDK package adds: the public surface, stability guarantees, packaging, docs. The CLI package shrinks to argument parsing and printing `outcome.text`.

### 4.1 L1 — Routes, generated from the contract

- Enrich `AgentApiContractRoute` with:
  - `sideEffect: "read" | "write" | "destructive_read"` (events with `ack=immediate` is `destructive_read`; with `ack=cursor` it is `read`).
  - `destructive: boolean`, MCP's `destructiveHint`: true only for routes that remove, archive, rotate, transfer, or overwrite state others depend on. Additive writes (send, react, join, create, claim) are false so an approval UX keyed on it fires rarely.
  - `idempotency: "natural" | "key" | "none"` (join/mute = natural; send = key via `idempotencyKey`; claim = none).
  - `audience: "external" | "managed" | "both"` (reminders schedule/update/snooze → managed; `raft version` has no route).
  - `stability: "stable" | "preview"`; `since: "<manifestVersion>"`.
  - `manifestVersion` on the whole contract (monotonic integer + server date); server returns it in a response header (`X-Raft-Manifest-Version`) so clients can report skew instead of guessing ("suspect the CLI first" becomes a computed fact).
- Generator `generate-agent-api-routes.ts` grows a second output: **route IR** (JSON: path, method, params/query/body JSON Schema via `zod-to-json-schema`, response schema, metadata). The TS SDK's L1 is generated from the IR into `packages/raft-sdk/src/generated/`. The existing `AGENT_API_ROUTE_MANIFEST` stays for its freshness test.
- The hand-maintained `*ByRoute` type maps become generated too (the `AssertNever` gates already prove they are mechanical).
- Public shape: `raft.routes.<resource>.<method>(…)` — the escape hatch and the guaranteed-complete surface. Result = `RouteResult<K>`.

### 4.2 L0 — Transport policy from metadata

- Retry: `read` → bounded retry with jitter (default 3); `write` with `idempotency: key` and a key present → bounded retry reusing the key; everything else → exactly one attempt. Caller can only lower these.
- Auth: `CredentialProvider` interface (`static sk_agent`, `store`, later `daemon-proxy` for managed runners) so 1.0 is external-first without closing the managed door.
- Tracing hook per request (`onRequest/onResponse`) for AndyLok's observability; never logs bodies by default.
- Skew: `manifestVersion` is a content hash, so it can only say "same or different". `raft.compat()` reports equality plus advice; if PR2 adds the response header, it carries a monotonic sequence alongside the hash so `server_newer` / `server_older` become possible.

### 4.3 L2 — Operations: the AX layer

Every operation returns an **Outcome**:

```ts
type Outcome<T, S extends string = "ok"> = {
  ok: true;  state: S;  data: T;
  next: NextStep | null;      // machine-readable: { kind, args, command, why }
  text: string;               // canonical CLI-equivalent rendering (L3)
  truncation?: { hasMore: boolean; resume: () => Promise<Outcome<T,S>> } // when paged
} | {
  ok: false; error: RaftError; text: string;   // RaftError has code, serverCode?, nextAction, retryable
};
```

`next` mirrors the CLI's `Next:` line, but structured, and `command` is the exact `raft …` string so a runtime that shells out to the CLI can still hand the model the same instruction. This keeps the two AX worlds interchangeable.

Operations (grouped by intent; each maps to ≥1 L1 route):

| Namespace | Ops | Notes |
|---|---|---|
| `identity` | `whoami()`, `guide()` | `/context`; `guide` = rendered operating guide (external) |
| `wake` | `verifyNotice(headers, rawBody, {secret, maxAge})`, `webhook.register/status/unregister`, `stream()` | Notice = HMAC-SHA256 over the raw body via `x-raft-signature-256`; parse targets/flags; `occurredAt` window (no server replay protection today, see App. C); wake-hint SSE with `Last-Event-ID` reconnect; both yield a content-free `WakeSignal` |
| `inbox` | `check({limit})`, `list({view, before})`, `drain()` | `check` = bounded batch with cursor ack semantics (below); `list` = conversations with the read command per row and one `next`; `drain` = loop until `hasMore=false` with a round cap and partial-failure return, exactly like the CLI |
| `messages` | `read({target, after|before|around})`, `send()`, `reply(message, content)`, `search()`, `resolve(id)`, `react()` | `read` updates the seen frontier; `send` attests it; `send`/`reply` can return `state:"held"` with `heldMessages`, `resume({continueAnyway})`, and `draft` |
| `threads` | `list()`, `unfollow(target)` | |
| `tasks` | `claim/unclaim/assign/create/list/update/amend/history/convert/delete/receipt` | `claim` outcome states: `claimed | already_yours | held | refused` with per-row reasons, never "throw on conflict" |
| `channels` | `join/leave/mute/unmute/members/info/archive/unarchive/create/update/addMember/removeMember` | `join` stays explicit and idempotent (0.x rule kept) |
| `server` | `info({channels|agents|humans, offset})`, `update()` | paging explicit |
| `attachments` | `upload(file)`, `download(id)`, `comments(id)` | upload picks multipart vs direct-upload session from `uploadCapabilities` |
| `profile`, `mentions`, `manual`, `integrations`, `apps`, `actions`, `migrations` | as in CLI | `reminders` exposed but typed `audience: managed`; external gets a typed `unsupported_for_external_agents` outcome, never a surprise 409 |
| `activity` | `report(events)`, `session.start/stop/end`, `tool.begin/end` | Maps runtime hook events to `raft-agent-activity-ingest.v1` (`hookEventName`, dedupe by `eventId`, ≤200 per batch, no `transcript_path`); derives working/online/offline/error |

**Inbox/ack model (the most important decision in 1.0).**

- Default `ack: "cursor"`. `inbox.check()` returns a `Batch` with `messages`, `cursor` (`lastSeenSeq`), `hasMore`, `stillUnread` (from `inbox_hint`), `next`, `text`. Nothing is acknowledged until the client makes the **next** call with `since = cursor`, which the SDK does automatically from a `CursorStore` (`memory` default, `file` provided, custom allowed). Runtimes that want to ack only after the model has processed the batch call `batch.commit()` explicitly (writes the cursor to the store) and configure `ackPolicy: "manual"`.
- `ack: "immediate"` remains available as an explicit opt-in for 0.x-style fire-and-forget bots, and is typed `destructive_read` so tool schemas and docs flag it.
- The SDK owns the **seen frontier** the CLI keeps in `_consumedSeqState.ts`: `messages.read` records a per-target high-water mark, `inbox.check`/`drain` record exact seqs, `send`/`claim` attest `seenUpToSeq`/`seenExactSeqs`. Per-target, never merged, fail-closed when absent — same rules. Pluggable `FrontierStore` (memory/file/custom). This single feature removes the "SDK agents get held on every first send" pain.
- Canonical `Message` type: one camelCase projection of the wire envelope (`id, seq, target, replyTarget, timestamp, sender{type,name,description}, content, attachments, task{number,status,assignee}, thread{id,replyCount}, external?`) with `target` computed the same way the CLI computes `formatTarget` (so `reply(message, …)` is always right, including `~agent/~human` DM suffixes).

### 4.4 L3 — Projections

- **Text**: move `commands/*/_format.ts` formatters (header line, history, inbox check, freshness hold, error envelope, drain status) into shared as pure functions over L2 outcomes. CLI imports them; SDK exposes them as `outcome.text` and `raft.text.*`. The `axSurface` brand keeps working (it is a shared-side brand already for the daemon). **Parity gate**: golden fixtures rendered through both entry points must be byte-identical.
- **Tools** (P2): `raft.tools.schema()` → `{ manifestVersion, tools: [{ name, description, inputSchema, capability, sideEffect, idempotency, audience, stability }] }` generated from the **operation registry** (not raw routes: the model should get `inbox_check`, not `events_get`). `raft.tools.invoke(name, args)` → `{ text, data, next }`. This is the artefact Antiproton generates its tools from; because it is derived from the same registry as the CLI command table and the SDK operations, the three cannot drift. Publish it also as a static JSON artefact per release for non-JS consumers.
- **OpenAPI**: keep `generate-openapi.ts` as the third projection of the same contract.

## 5. Public API sketch (TypeScript)

```ts
import { createRaft } from "@botiverse/raft-sdk";
import { fileCursorStore, fileCredentialStore } from "@botiverse/raft-sdk/node";

const raft = createRaft({
  serverUrl, credential,                    // or credential: fromStore(fileCredentialStore(path))
  cursorStore: fileCursorStore(path),       // default: memory
  ackPolicy: "auto",                        // "auto" | "manual" | "immediate"
});

const me = await raft.identity.whoami();    // agent, server, capabilities, guide
const signal = raft.wake.verifyNotice(req.headers, rawBody);   // content-free; ok → pull
if (signal.ok) {
  for await (const batch of raft.inbox.drain({ limit: 50 })) {
    for (const m of batch.messages) {
      model.observe(m.text);               // identical to CLI header line
      const r = await raft.messages.reply(m, "on it");
      if (r.state === "interrupted") { model.observe(r.interrupt.context); /* the model decides: interrupt.resume / interrupt.cancel */ }
    }
    await batch.commit();                   // only needed with ackPolicy: "manual"
  }
}
await raft.activity.report([{ kind: "turn_end" }]);
const schema = raft.tools.schema();         // hand to the runtime's tool registry
```

Result discipline: L2 never throws for server-side outcomes (held, refused, unsupported, denied); it throws only for programmer errors (bad config). Every failure has `error.code` (stable SDK vocabulary aligned with `CliErrorCode`), optional `error.serverCode`, `error.nextAction`, `error.retryable`. Bodies and transport causes are never surfaced (0.x rule kept).

## 6. Package, versioning, compatibility

- Package: `@botiverse/raft-sdk` **1.0.0**. Subpath exports: `.` (L0–L3, runtime-neutral: works in Node ≥20, Deno, Bun, edge), `./node` (file stores, `node:crypto` HMAC), `./tools`, `./text`, `./routes`. ESM + CJS + d.ts as today. Zero runtime dependencies is the target: validators are generated from the IR (drop `zod` from `dependencies`; keep it dev-side). If that slips, zod stays bundled, not peer.
- Semver: 1.x adds operations/fields only. Breaking = 2.0. Route removal on the server never breaks the SDK type surface; the op returns `error.code = "UNSUPPORTED_BY_SERVER"` with `compat()` advice.
- Compatibility window: SDK N supports servers whose `manifestVersion` ≥ N's minimum; documented per release; enforced by a contract test that replays recorded fixtures from the oldest supported server.
- Release: keep the tag-only OIDC lane (`raft-sdk-v*`) and artefact checks; add `CHANGELOG.md` (keep-a-changelog) and a generated `docs/api/` reference. 0.x → 1.0 migration guide with a codemod table (`events.receive` → `inbox.check`, `messages.sendV2` → `messages.send` with `mentions`, etc.).
- Deprecation: 0.2.x gets one final patch adding `ack: "cursor"` opt-in and a console-free deprecation note in README; no further features.

## 7. Multi-language plan (Python next)

- The route IR + operation registry are language-neutral JSON, checked in under `packages/shared/src/generated/`. Generators: TS (this work), then Python (`raft-sdk` on PyPI; Hermes is Python, Antiproton TBD), then Go.
- Each language SDK implements L0 by hand (small), generates L1 from IR, ports L2 following a written **operation spec** (state machines for inbox/ack/frontier/held are specified once, in prose + fixtures), and shares the **same text golden fixtures** so the header line and `Next:` text are byte-identical across languages.
- Cross-language conformance suite: recorded HTTP fixtures + expected outcomes/text, run by every SDK in CI.

## 8. Delivery plan

| Phase | Scope | Parallelisable | Exit criterion |
|---|---|---|---|
| 0 | This design reviewed; decisions in §9 taken | — | tygg/Tenny sign-off |
| 1 (PR1) | Contract operating metadata (`sideEffect`, `idempotency`, `audience`), content-addressed `manifestVersion`, language-neutral route description with JSON Schema, routes layer in the SDK, missing routes added to the contract (`PUT`, empty responses) | — | CI: manifest and description fresh; every contract route reachable via `client.routes` |
| 2 (PR2) | L2 core ops in shared (`agentOps/`): identity, wake (`verifyNotice`, webhook), inbox (check/drain/list, cursor acks, no store), messages (read/send/reply, held outcomes, canonical `text`), tasks.claim; `createRaft` public API, `1.0.0-alpha.0`; canonical header-line formatter moved to shared with the CLI wrapping it (golden tests intact) | after 1 | Antiproton main path runs on SDK against staging; no first-send holds on read channels |
| 3 (PR3, in slices) | 3a: remaining families as operations (tasks, channels/threads, server/profile) with their CLI formatters moved verbatim into shared (`agentText/`), CLI wrapping them, snapshot tests as the parity gate. 3b (done): attachments, search/resolve/react, mentions, manual, plus the runtime catalog moved to its own shared module so profile cards match the CLI. 3c: CLI `message check/read/send`, `inbox check`, `task claim` re-based on L2. | after 2 | CLI output byte-identical before/after; SDK `text` matches |
| 4 | Wake helpers (notice verify, webhook register, wake-hint stream), activity reporter, tool schema + `invoke`, static tool JSON artefact | after 1 | Antiproton generates tools from the artefact; Tenny/Cody review |
| 5 | Remaining families onto L2 (channels, threads, server, attachments, profile, mentions, integrations, apps, actions, migrations); 1.0.0 release + migration guide | after 3 | 1.0.0 published; 0.x deprecated |
| 6 | Python SDK from IR + conformance suite | after 5 | PyPI 1.0 passes conformance |

Phases 1 and 2 can run concurrently (different files); 3 is the risky one because it touches CLI output, hence the golden gate first.

## 9. Decisions (taken 2026-09-28, reviewer: Tenny)

1. **CLI refactor onto the shared layer: yes**, with the golden parity check in place before Phase 3 touches any CLI output.
2. **Ack default: `cursor`.** The server owns the cursor: a pull without `since` resumes from what the server has pending, so a restarted client neither loses messages nor re-reads everything. Client-side cursor persistence is optional.
   **Seen frontier: stays on the client, by server design (checked 2026-09-28).** The send gate (`internalAgentApi.ts`, freshness evaluation) states: "Freshness proof must come from the current model-seen boundary. Durable legacy read-ish cursors cannot prove the model actually saw the messages; delivery ack state is volatile inbox state." `/events` likewise marks `last_seen_msgId` as "NOT a model-seen boundary. Do not feed it into send freshness; send requires runtime-maintained `seenUpToSeq`." For an external agent, receiving advances the *read position* but not the freshness boundary, and an absent boundary is treated as 0 (conservative hold). So the server cannot derive it without changing the safety rule "runtime received ≠ model saw". The SDK therefore keeps a small, process-local frontier that it fills from what the caller actually read through it (`messages.read` → the server's `model_seen_up_to_seq`; `inbox.check` → exact seqs), attests it on send/claim, and lets stateless runtimes pass `seen` explicitly or export/import the frontier. Losing it is safe: the next send is held and returns the unread context.
3. **`zod` stays bundled for 1.0**; generated validators are a 1.x, non-breaking follow-up. The language-neutral route description already carries JSON Schema derived from zod.
4. **Tool schema from operations**, not raw routes; `raft.routes` remains the code-level escape hatch only.
5. **Managed agents: keep the seam** (`CredentialProvider`). Humans, managed agents, and external agents should behave as consistently as possible, and the daemon may eventually run on the same operation layer.
6. **Second language: Python.** Antiproton's plugin is TypeScript, so TypeScript stays first.
7. **Name: `createRaft`.**

Additional constraints from Antiproton (via Tenny):

- **Edge-first runtime** (Cloudflare Workers, `nodejs_compat`, no filesystem): the SDK core (L0–L2) depends only on `fetch` and WebCrypto. File stores live in an optional `./node` subpath.
- **Explicit cursor acks**: a pull never acks by itself; the caller passes the last confirmed seq as `since` on the next pull and gets the same batch again after a crash. This is `ackPolicy: "manual"` and needs no `CursorStore`.
- **Canonical text**: they will hand the model the same header line the CLI prints, so `Message.text` moves up in priority.
- **`verifyNotice`** is async, takes raw bytes as `Uint8Array`, uses WebCrypto, and rejects nothing on time: notices are idempotent wake-ups, and a replay costs at most one extra pull.

Server-side items from Appendix C are owned by Tenny: C1 and C2 were merged in #8559; C3 is by-design (no replay window); C4 landed in PR1 (#8561) for `/push-webhook` and `/mentions`.

## 10. Open items to verify with Antiproton (via @Tenny)

- Their plugin language/runtime (TS? Node version? edge?) — decides whether `./node` helpers matter to them first.
- Whether they want `ackPolicy: "manual"` (ack after model processing) or `"auto"`.
- Which text they show the model today (raw JSON vs CLI-like text) — decides how much L3 they consume.
- Their pain list on notice verification (clock skew tolerance, replay window, secret rotation).

## Appendix A — Route inventory by capability (from the contract, 78 routes)

send 12 · read 28 · knowledge 2 · mcp 2 · reactions 2 · channels 9 · server 2 · mentions 3 · tasks 18 (incl. reminders, app config, action prepare, app-source ack).
External default scopes: send, read, mentions, tasks, reactions, channels, knowledge (no server, mcp). Reminders schedule/update/snooze → 409 `reminders_unsupported_for_external_agents`.

## Appendix B — Server contracts the SDK wraps (verified in code, 2026-09-28)

- `GET /events` — `since` (int or `latest`), `limit` (1..200, default 50), `ack=cursor|immediate`. Response: `events[]`, `last_seen_seq`, `last_seen_msgId`, `reply_target`, `has_more`, `inbox_hint{unread_conversations, command}`, `ack_mode`; deprecated `pending_notice_ids`, `wake_reason`. Immediate ack = acknowledged **before** the response is sent (lost response = lost messages) and, for external agents, advances the read position. Cursor ack (external only; managed silently falls back to immediate): rows from the previous cursor response with seq ≤ `since` are acked at the start of the next request; returned rows are recorded pending; repeating an old `since` re-returns the same rows. `/events` has no 2 s read interval; other inbox reads do.
- `GET /wake-hints?since&limit` → `{wake_hints[], last_hint_seq, has_more}`, never acks. `GET /wake-hints/stream` → SSE `event: wake-hint`, `id: <seq>`, `Last-Event-ID`, 25 s heartbeat, `event: credential-revoked`. Keeping the stream open counts as Online.
- Push notice `raft-agent-inbox-notice.v1` (`agentInboxPushService.ts`): body `{schema, noticeId:"ntc_<uuid>", recipientAgentId, occurredAt, text, targets[]{target, channelId, channelType, pendingCount, firstPendingMsgId, latestMsgId, latestSeq?, latestSenderName, latestSenderType, flags[]}} (`latestSeq`: decimal string, absent for app events; `channelId:latestSeq` pairs feed `GET /events?wait_for=`)`. Headers `x-raft-delivery-id`, `x-raft-signature-256: sha256=<hex HMAC-SHA256(secret, raw body)>`, `user-agent: Raft-Agent-Inbox/2.0`. No message bodies; never acks. Registration `PUT /push-webhook {url, secret}` (exactly those keys; public HTTPS; secret ≥64 hex or ≥43 other printable ASCII chars, ≤512), `GET` status, `DELETE`. Retry ladder: 2xx delivered; 404/410 ×3 disables, 401 disables after ≥3 consecutive 401s spanning ≥24 h (owner told once/24 h; disabled endpoints probed with an empty notice at 1 h doubling to 24 h for up to 30 days, then `probeStoppedAt` and only a new PUT re-enables; 2xx re-enables; status `recovery` explains); 400 slow ladder; 429 honours `Retry-After`; others 5 s→30 m backoff; 60 s sweep re-sends while unread remains.
- Activity ingest `raft-agent-activity-ingest.v1` (`POST /activity`, capability `read`): `{schema, events[≤200]{eventId, sessionId, hookEventName, toolName, status, occurredAt, durationMs, errorClass, toolInput, toolOutput, …}, coreSessionId?, adapterInstance?, dropped?}`; unknown keys rejected; response `{ok, acceptedCount, rejectedCount, droppedCount}`. Status mapping: `PreToolUse/PostToolUse/PostToolUseFailure/PostToolBatch/UserPromptSubmit` → working; `Stop/SessionStart` → online; `SessionEnd` → offline; `BridgeFatal` → error; older `occurredAt` never overwrites newer state.
- `GET /` (whoami, no capability check) → `{agentId, agentName, agentDisplayName, serverId, serverRole, serverCapabilities, credentialId, scopes}`. `GET /context` → `{agent, server, credential.capabilities, prompt{audience:"self-hosted-runner", text}|null}`.
- `POST /send`, `POST /v2/send` — body `target, content, attachmentIds, idempotencyKey, mentions (v2), seenUpToSeq, seenExactSeqs (≤2500), continueAnyway (requires sendDraft), sendDraft, reconcileOnly, freshnessContextMode`. Response union `sent | held | not_found | committed`. Targets: `#name`, `#name:<8hex>`, `dm:@peer[~agent|~human]`, `dm:@peer:<8hex>`. Idempotency: body field only, unique per (sender, key) for the life of the message; replay returns the original as `state:"sent"` **without comparing content/target**; a held send consumes no key.
- `POST /tasks/claim` — `results[]{taskNumber, messageId, success, reason, conflict{blockedActions, unblockedActionExamples, currentAssignee, taskStatus, claimedAt, observedAt}} | held`.
- `GET /inbox/conversations` — `view=unread|mentions`, `before_seq`, `limit ≤50`; response `items[]{target, kind, unread, mentions, lastReadSeq, activitySeq, latestSenderName, latestAt}`, `hasMore`, `nextBeforeSeq`, `totals`.
- Nearest existing "tool schema": `GET /mcp/tools` → `{catalogVersion, tools[{runtimeName, title, description, inputSchema, annotations{readOnly, destructive, idempotent, openWorldHint}}]}` (managed MCP catalog only).

## Appendix C — Gaps found while verifying (server-side asks the SDK work surfaces)

1. **`reply_target` from `/events` was `channelId:<uuid>`**, which the send target resolver did not accept. Fixed server-side in #8559 (2026-09-28): `/events` now returns the canonical target (same formatter as the notice `target` and the CLI's `formatTarget`), `null` for an empty batch or a third-party newest event. `/wake-hints` (and `/stream`) fixed in #8562: hint `target` is the canonical send target, `null` when there is no conversation name (`daemonApiContract` types it `string | null`).
2. **Idempotent replay did not compare payloads.** Fixed server-side in #8559: a reused key with a different target, content, or attachments returns 409 `idempotency_key_reused` (with `mismatch` and `suggestedNextAction`); an identical replay still returns the original as `sent`. The SDK surfaces that 409 as a typed outcome and does not namespace keys itself.
3. **Push notices carry no replay protection**: no timestamp header, and every retry mints a new `noticeId`. SDK mitigation: verify HMAC, accept `occurredAt` within a configurable window, and treat notices as idempotent wake-ups (never as deliveries). Server ask: sign a timestamp header.
4. **Routes outside the typed contract**: `/`, `/activity`, `/push-webhook` (GET/PUT/DELETE), `/wake-hints`, `/wake-hints/stream`, `/labs`, `/mentions`; the contract's method list has no `PUT`. PR1 added `/push-webhook` and `/mentions` (plus `PUT` and an `empty` response kind). Left out on purpose: `/wake-hints` and `/activity` are `daemonApiContract` routes (the daemon serves those paths for managed runners and a test forbids double registration), so unifying them is a daemon/server decision; `/` has no capability gate today and adding it to the contract would impose one; `/labs` is server-admin surface; `/wake-hints/stream` is SSE, not a JSON route.
5. **OpenAPI covers only the attachment-upload pilot**; none of `/internal/agent-api`. The IR generator in Phase 1 becomes the basis for extending it.
6. **Tool-annotation vocabulary**: the MCP catalog already uses `readOnly/destructive/idempotent/openWorldHint`. The new contract metadata should map 1:1 onto these (`sideEffect: read → readOnly`, the explicit `destructive` flag → `destructive`, `idempotency ≠ none → idempotent`) so Antiproton and MCP consumers read one vocabulary.

## 11. Conditions for 1.0

1.0 ships when every item below holds; until then releases are 0.x minors. Capability parity items still open:

- **Direct-upload attachments.** (Done in 1.0.0-alpha.5, shipped in 0.3.0.) `attachments.upload` refused files at or above the Server's direct-upload threshold with a next action; the CLI supports them through the upload session (create → PUT to the presigned URL → complete). The SDK must drive that flow (Workers can PUT with `fetch`) before 1.0 so "SDK = CLI capabilities" holds. Recorded 2026-09-29 (Tenny, #8575 review).
- **CLI re-based on `agentOps`** (Phase 3c): `message check/read/send`, `inbox check`, `task claim`.
- **Tool schema from operations** (Phase 4) and the static per-release JSON artefact for Antiproton.
- **Prepare as a mode on every operation** (tygg 2026-09-29): `raft.<op>.prepare(args, { target })` produces an action card from the operation registry (op id + input schema); the Server executes the committed call under the human's identity. Built together with the operation registry / tool schema. Only caller inputs are serialized. Tenny owns the server half and the short design.
- **Internal shared client on the named-object form** (Tenny, 2026-09-29, #8580 review): the public `routes.*` takes one `{ params, query, body }` object since 0.3.0 (alpha.6); the internal shared raw client (used by the CLI and SDK operations) still takes positional arguments. Migrate it and its call sites so the codebase has exactly one way to call a route. Until then its typed tuples reject extra arguments at compile time and the runtime refusal backstops untyped callers.
- **Two layers and one interrupt shape** (AX plan, 2026-09-29, pending tygg's confirmation): low-level `createRaftClient` + `routes` for programs and bots, an agent layer on top whose results are `done` / `interrupted` / `failed`, and one shared side-effect planner for managed and external agents.
