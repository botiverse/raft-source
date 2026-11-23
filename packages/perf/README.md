# @botiverse/raft-perf

Web performance tools for agents. The guide, and how we work on page speed: [docs/frontend/perf-measure.md](../../docs/frontend/perf-measure.md).

Run any command through `./packages/perf/bin/raft-perf.mjs <command> [options]` (keeps your working directory) or `pnpm --filter @botiverse/raft-perf <command> -- [options]`:

- `raft-perf startup --help`: where the time of opening a channel goes: the first page of messages cut into before-send, first byte, `Server-Timing` and download, the CORS preflights, what was asked twice, the gap from the answer to the first message on screen with its long tasks, and per-session browser/PoP telemetry.
- `raft-perf diagnose --help`: source-level V8 CPU profile, zero-dependency SourceMap v3 line/symbol resolution (`--dist` or `--sourcemaps`), forced synchronous layout/style call-stack extraction, and critical-path vs parallel network-slack decomposition for `startup` (`response-to-paint` / `full-load` / `post-paint`) and `switch`.
- `raft-perf measure --help`: a signed-in page on a deployed web, paired on/off runs, a JSON verdict and an exit code. `--browser browser-run` (also on `load` and `startup`) runs the browser on Cloudflare Browser Run and records its `cohort` (`browser_where`, `edge_colo`, `browser_benchmark_ms`, `connect_rtt_ms`).
- `raft-perf interact --help`: scroll, channel switch and thread open on a deployed web; with `--trace`, what the main thread did after each click.
- `raft-perf ab --help`: two local builds with one change between them, served into a deployed page and compared pair by pair on channel `switch` or channel `startup` (`--scenario startup --cpu 4 --replay`).
- `raft-perf bench-check --help`: verify that a frozen benchmark channel (`--fixture bench-v1`) matches its expected message/thread counts and SHA-256 digest; `--fixture` on `startup`, `measure`, `interact` and `ab` runs this check automatically before measuring.
- `raft-perf check --help` / `raft-perf claim --help`: hold measured values against watermarks and falsifiable claims, refusing cross-page and cross-cohort comparisons.
- `raft-perf snapshot --help` / `raft-perf diff --help` / `raft-perf graph --help`: cold first-screen brotli bytes, release cache invalidation, and Vite/Rolldown module dominator trees.
- `pnpm --filter @botiverse/raft-perf test`: unit tests.

Imports nothing from the app, so it can move out of this repository.
