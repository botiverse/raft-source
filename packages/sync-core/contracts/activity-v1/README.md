# Activity Sync contract v1 — direct binding packet

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

## What is executable here

- TypeSpec 1.14.0 emits sealed JSON Schema and OpenAPI 3.1.
- `tools/generate-typescript.mjs` is a minimal reference direct generator. It
  consumes the TypeSpec compiler semantic graph, not JSON Schema.
- The direct TypeScript output parses cleanly and retains seven ingress
  branches, seven intent branches, required/null/optional distinctions, and
  discriminator literals.
- `tools/verify-contract.mjs` validates the JSON Schema leg for all 13 contract
  vectors and validates the seven-branch fixture envelope.
- `tools/verify-typescript-leg.mjs` invokes the real TypeScript compiler for
  every candidate: positives compile 3/3, structural negatives type-error 7/7,
  and value-domain exemptions compile 3/3.
- `tools/verify-typescript-leg-mutations.mjs` degrades the generated binding in
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

On Web, generated TypeScript is erased at runtime. The JSON Schema validator is
therefore load-bearing and must run before the typed reducer adapter.

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
