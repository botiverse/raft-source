# @botiverse/raft-trace-client

Internal-only node-side trace primitives shared by daemon, Computer CLI,
and menu-bar app. Houses sink implementations that depend on `node:fs` /
`node:crypto` / `node:zlib` (kept out of `@botiverse/raft-shared` so the web
bundle stays clean) plus a thin `createTraceClient` factory that combines
the canonical `BasicTracer` with a multi-sink fan-out and a force-injected
`source` attribute.

Canonical types (`Tracer`, `TraceSink`, `TraceEvent`, `CompletedTraceSpan`,
`StartSpanOptions`, etc.) continue to live in `@botiverse/raft-shared/tracing`.

## Service scope (closed by design)

This package is **closed to three known node consumers** — daemon, Computer
CLI, menu-bar app. The `TraceClientSource` enum, the sink set, and the
review surface are all sized for that consumer count. Adding a fourth
caller is **not a "just import it" change** — re-evaluate scope first:

- Does the new caller need its own `source` enum value? (a new label is
  not equivalent to reusing an existing one — provenance debug breaks)
- Does it need a different sink configuration? (e.g. a different upload
  pipeline, custom rotation policy)
- Does it widen the trust boundary? (e.g. a package not in this repo's
  review chain — that's a different scope tier and may need lint /
  runtime validation that this package deliberately does NOT carry)

Server-side tracing has its own path (`packages/server/src/tracing/serverTracer.ts`)
and does NOT route through this client. Web also does not import this node
package: its browser producer uploads trace batches directly to the
trace-upload Worker. Current browser trace IDs are minted independently from
server HTTP request trace IDs, so local readers must not infer web-to-server
continuity. If you find yourself wanting to import this from a new package,
open an RFC / discussion before adding the import.

The package is `private: true` and consumed as TS source via
`workspace:*`. Do not depend on it from external packages.

## Two-axis trace identity — don't conflate

Two independent axes label every span this package emits. Keep them
separate when designing new attributes or query patterns:

| axis      | values                                                 | use                                                                  |
|-----------|--------------------------------------------------------|----------------------------------------------------------------------|
| `surface` | `server` \| `daemon` \| `web` \| `computer`            | subsystem family — query/aggregation bucketing                       |
| `source`  | `daemon` \| `computer.cli` \| `computer.menu-bar`      | emitting process — misattribution / uniqueness debug                 |

CLI and menu-bar both ship under `surface: "computer"` (coarse) but
distinct `source` (fine). Do NOT introduce a `surface: "computer.cli"`
shortcut — query-by-subsystem and debug-by-process are separately useful.

## Usage

```ts
import { createTraceClient, LocalRotatingTraceSink } from "@botiverse/raft-trace-client";

const sink = new LocalRotatingTraceSink({ machineDir: "/path/to/machine" });
const tracer = createTraceClient({
  source: "computer.cli",
  sinks: [sink],
});

const span = tracer.startSpan("computer.runner.restart", {
  surface: "computer",  // not "computer.cli" — surface is coarse
  kind: "internal",
  attrs: { decision: "via-service" },
});
span.addEvent("ipc.dispatched");
span.end("ok", { attrs: { durationBucket: "fast" } });
```

The factory force-injects `source` at both `startSpan` and `end` —
caller-supplied `attrs.source` is overridden, not merged. This is the
silent-misattribution invariant: when three node consumers share an
upload pipeline, the emitting process must always be unambiguous.

## Multi-sink fan-out

`createTraceClient({ sinks: TraceSink[] })` wraps the canonical
`BasicTracer` with a `MultiSink` that fans out to every sink with
**per-sink failure isolation** — a sink whose `record()` throws does
not block sibling sinks from receiving the same span. Daemon today
runs `sinks: [localSink]`; the upload path is a band-out file watcher
reading what the local sink wrote, not an in-process subscriber.

## Why this package exists separately from `@botiverse/raft-shared`

Both `LocalRotatingTraceSink` and the daemon's upload path depend on
node-only modules (`node:fs`, `node:path`, `node:crypto`, `node:zlib`).
`@botiverse/raft-shared` is consumed by the web bundle as workspace source —
node modules in shared would break the web build. This package is
internal (`private: true`), node-only, and consumed the same way (as TS
source via `workspace:*`).

## Tripwire: when to add closed-union literal-only lint

This package deliberately does NOT carry a custom lint rule that forces
`surface: TraceSurface` or `kind: TraceSpanKind` to literal values. Under
the current "closed to 3 known consumers" scope, `tsc` already rejects
non-literal `string` at `surface` callsites, and explicit `as TraceSurface`
casts are caught by review across that small consumer set.

Add the lint if either tripwire fires:

1. **Scope slides** to "open internal" or wider (more callers than the
   3-consumer review surface can plausibly cover) — `tsc` alone leaks via
   `as` cast escape hatches, and review doesn't scale linearly with caller
   count.
2. **Real decay incident** — an `as TraceSurface` cast or `string`-typed
   variable lands in `surface` and bypasses the closed-union invariant.
   This is the empirical-not-theoretical version: don't add the lint
   pre-emptively, do add it the moment you see a real bypass.

Locked decision per #proj-o11y:19c78ab3 (tygg + skyzh + Noel):
*"enforcement layer is a function of consumer-trust-scope — under closed
scope, type+review is sufficient; lint becomes load-bearing only if scope
widens"*. Re-open this section if you're considering scope change.
