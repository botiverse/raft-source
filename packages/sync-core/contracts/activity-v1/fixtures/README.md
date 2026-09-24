# Fixture status

`activity-sync.contract-vectors.jsonl` is a contract/codegen canary. Each line
contains untyped candidate bytes plus explicit expectations for three
consumers:

- `validator`: the TypeSpec-derived JSON Schema runtime validator;
- `typescriptStatic`: a generated-TypeScript **compile-time** `satisfies`
  canary; this is never described as runtime decoding;
- `kotlinRuntime`: the direct Kotlin binding's `kotlinx.serialization` decoder.

The partition is intentional:

- positive vectors must be accepted by all consumers;
- structural negatives must be rejected by all consumers;
- value-domain negatives are `validator=reject`,
  `typescriptStatic=exempt`, and `kotlinRuntime=reject`.

TypeScript cannot express a regex pattern, so an `exempt` is a named,
load-bearing constraint allocation. It must never be weakened to “any leg may
reject.”

`activity-sync.behavior.seed.jsonl` only freezes the fixture envelope and
exercises all seven ingress branches. It is **not** a canonical behavior vector
and deliberately has no expected reducer result or result digest. The real Web
and KMP reducers/selectors do not yet consume this seven-branch protocol; a
digest manufactured here would be false evidence.
