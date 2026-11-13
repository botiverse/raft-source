# @botiverse/raft-perf

Web performance tools for agents. The guide, and how we work on page speed: [docs/frontend/perf-measure.md](../../docs/frontend/perf-measure.md).

- `pnpm --filter @botiverse/raft-perf measure -- --help`: a signed-in page on a deployed web, paired on/off runs, a JSON verdict and an exit code.
- `pnpm --filter @botiverse/raft-perf snapshot -- --help`: what a cold load of a deployed web downloads before boot (no build, no sign-in); JSON or one row per file.
- `pnpm --filter @botiverse/raft-perf diff -- --help`: two builds' first screens compared: growth, and the bytes returning visitors download again; exit code.
- `pnpm --filter @botiverse/raft-perf test`: unit tests (verdict rule, first-screen parsing and diff).

Imports nothing from the app, so it can move out of this repository.
