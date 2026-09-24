# Raft OpenAPI contract generation

This directory contains the committed OpenAPI 3.1 artifact generated from the
organization-wide contract registry in `src/openApiContract.ts`. Feature wire
schemas stay in feature modules; the first registered module is the additive,
unmounted direct-attachment-upload P1 contract in
`src/attachmentUploadContract.ts`.

`scripts/generate-openapi.ts` is the only generator entry point. It renders
both `openapi/openapi.json` and `src/generated/openapi.ts`. Adding another API
contract means registering another feature module in `openApiContractModules`;
it must not add another generator, artifact naming scheme, or drift gate.

The implementation follows the double-reviewed P0 design SHA-256
`6fd5f2e1aae87544171c19e7cf268421fe631213d71647ec145fe93e235b5148`
and evidence SHA-256
`f621fed34fb0a9082bce2e31aa76be7f303eb5a32b92dd45e99766c29756c991`.
Tooling is exact-pinned to `zod-openapi@6.0.0`,
`openapi-typescript@7.13.0`, and the independent `@redocly/cli@2.40.0`
validator; the repository package-manager contract is `pnpm@10.29.3`.

## P1 boundary

- Four operations are described: create, complete, cancel, and status.
- Every HTTP status has its own flat response schema; the pilot has no `default`
  response union.
- The two security requirements in one object mean bearer authentication **and**
  `X-Server-Id` scope are both required.
- Presigned URLs have no examples and are excluded from committed fixtures.
- These paths are not mounted. P1 creates no route, storage, R2, credential,
  environment, deployment, production, or generated-KMP behavior.

Run the complete local gate with:

```sh
pnpm --filter @botiverse/raft-shared check:openapi
```

The gate regenerates committed artifacts and rejects drift, runs a second
byte-identical generation, validates the document with the independent Redocly
validator, compiles generated Web consumer assertions with
`tsconfig.openapi.json`, and runs the registered feature contract tests. The
generated files are reviewable outputs, not manually maintained inputs; any
direct edit is overwritten by regeneration and rejected by CI freshness.

## Security middleware boundary

The operation-local response unions describe route parsing, dedicated
rate-limit, and service outcomes. Existing shared `requireAuth`,
`requireVerified`, and `requireServer` middleware remains the organization-wide
security boundary and may return its established 400/401/403 envelopes before
an operation handler runs. P2 does not duplicate or translate that middleware.
A later convergence task may model those shared responses as reusable OpenAPI
components.

Upload-session lifecycle routes use UUID-constrained route patterns. A
malformed `uploadId` therefore never enters the operation handler or service;
it stays on the framework routing/unknown-attachment boundary rather than
creating an undeclared operation-local 400 response.

## One toolchain, not two permanent stacks

The existing `agentApiContract` stays unchanged during this bounded pilot. The
generic registry/generator/artifact/CI shell in this directory is the proposed
entry point to one organization-wide Zod-to-OpenAPI flow, not permission to keep
two long-lived generators or to build one generator per feature.

The exit decision is explicit:

1. If P2 capability-off mounting and P3 storage/security review accept this
   flow, create a separate migration task that moves `agentApiContract` onto the
   same OpenAPI generator, version pins, artifact ownership, and CI semantics.
   Remove its old route-manifest generator only after equivalent consumer and
   drift gates are green.
2. If the pilot is rejected, remove this pilot's dependencies, registry,
   generated artifacts, fixtures, and CI step. Do not leave both stacks behind.

Flat status-local errors are also a reviewed compatibility surface, not a silent
forever decision. Domain errors may remain richer. Reconsider richer public wire
errors only after a KMP generator passes compile, nullable-reference, and error
matrix qualification, with an explicit compatibility/version review.
