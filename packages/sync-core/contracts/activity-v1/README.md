# Activity Sync contract v1 — direct binding packet

The experimental Web Activity cutover and its snapshot/difference HTTP endpoints
were retired in task #212. This packet still describes the existing inbox,
read-all and Done HTTP operations, plus reusable sync-core model fixtures. The
Kotlin canary verifies these model bindings; it is not a live sync client.


This packet supersedes the earlier proposal that used generated JSON Schema as
the binding input. The only editable contract source is:

```text
activity-sync.tsp
```

The four outputs are independent, parallel derivations:

```text
activity-sync.tsp -> direct TypeScript binding generator
activity-sync.tsp -> direct Kotlin binding generator
activity-sync.tsp -> JSON Schema runtime-validator schemas
activity-sync.tsp -> OpenAPI HTTP operation description
```

JSON Schema is never an input to either binding generator. OpenAPI is never an
input to either binding generator.

## Contract revision

`revisions.json` maps every `activity-sync.tsp` digest to a contract revision.
Any change to what goes over the wire (a field added, renamed or removed; a type,
semantics or ordering change) takes the previous revision + 1. Even an added
optional response field counts, because the Kotlin binding decodes strictly. A
change that leaves the wire identical (comments, docs) keeps the revision and
must state why in `compatible`; reviewers check that claim, since no tool can.
`tools/contract-revision.ts` (run by `contract.test.ts`) fails when the current
source digest is not the ledger's last entry, and `contract.test.ts` also checks
the ledger is append-only against the staging branch when git history for it is
available. Reviewers of tsp PRs should still confirm the ledger only grew.

`revision` is distinct from the older `version` / `contractVersion: 1` fields,
which name the contract family and fixture format and are not bumped.

Both bindings carry `ACTIVITY_SYNC_CONTRACT` and `ACTIVITY_SYNC_CONTRACT_REVISION`
from the ledger; `manifest.json` pins `revision` and `revisionsSha256`. Revision 3
removes the retired HTTP operations. The snapshot/difference response models
remain library fixtures, not promises of available server endpoints. There is
no Activity engine enablement or revision-handshake header in the serving API.

## What is executable here

- TypeSpec 1.14.0 emits sealed JSON Schema and OpenAPI 3.1.
- `tools/generate-typescript.ts` is a minimal reference direct generator. It
  consumes the TypeSpec compiler semantic graph, not JSON Schema.
- The direct TypeScript output parses cleanly and retains seven ingress
  branches, seven intent branches, required/null/optional distinctions, and
  discriminator literals.
- `tools/verify-contract.ts` validates the JSON Schema leg for all 13 contract
  vectors and validates the seven-branch fixture envelope.
- `tools/verify-typescript-leg.ts` invokes the real TypeScript compiler for
  every candidate: positives compile 3/3, structural negatives type-error 7/7,
  and value-domain exemptions compile 3/3.
- `tools/verify-typescript-leg-mutations.ts` degrades the generated binding in
  six plausible emitter directions; every mutation flips exactly the named
  vector(s) from type-error to compiles.
- The Kotlin direct generator is intentionally absent. Its owner must prove
  real `kotlinx.serialization` compile/decode behavior before its digest can be
  added to `manifest.json`.

Run:

```bash
npm ci
npm run canary
```

Expected terminal line:

```text
Activity direct-binding contract canary: PASS
```

## Constraint allocation

The vector file avoids a false “any output may reject” gate:

- positive: validator, TypeScript static canary, and Kotlin runtime must accept;
- structural negative: all three must reject;
- value-domain negative: JSON Schema validator rejects, TypeScript static
  canary is explicitly exempt because TypeScript cannot express regex
  patterns, and Kotlin runtime must reject.

The TypeScript column is executable evidence, not expectation-label
self-consistency. `exempt` is asserted positively by proving those candidates
compile.

Generated TypeScript is erased at runtime. The retained library contract checks
validate model fixtures; the retired Web runtime no longer compiles these schemas.

## Status

`manifest.json` remains `experimental`:

- the fixture seed has no canonical reducer result;
- Kotlin binding digest is null;
- Web/KMP result digests and the compatibility receipt are null;
- the OpenAPI describes the successor receipt contract. It does not claim that
  the two current `done` routes, which still return `{ok:true}`, already
  conform.

No Activity UI/store authority, server route implementation, feature flag, or
activation is changed by this packet.
