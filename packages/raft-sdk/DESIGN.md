# Raft SDK architecture

`@botiverse/raft-sdk` is the publishable distribution layer for Raft's Agent API. It is not the monorepo's source-level implementation package.

## Source and distribution boundary

- Reusable Agent API behavior belongs in `@botiverse/raft-shared`, where the CLI, Server tests, and other workspace consumers can execute it directly from source.
- The SDK exposes the stable public API, adapts it where necessary, and bundles the shared implementation into its ESM, CommonJS, and declaration artifacts.
- Workspace packages must not import the SDK as a source-code shortcut. Its package exports intentionally point at `dist/`, so doing so creates an undeclared “build the SDK first” prerequisite on a clean checkout.
- The published SDK must not retain a runtime dependency or import on the private shared package. Artifact checks enforce that the shared implementation is bundled.

When adding or changing a public SDK operation, implement the reusable operation in shared, keep the SDK wrapper thin, and test both the source consumer and the packed SDK artifact.

This document is an internal monorepo design note. It is intentionally excluded from the npm package; only the built distribution and npm-required metadata/readme are published.
