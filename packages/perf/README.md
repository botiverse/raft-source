# @botiverse/raft-perf

Web performance tools for agents. The guide, and how we work on page speed: [docs/frontend/perf-measure.md](../../docs/frontend/perf-measure.md).

- `pnpm --filter @botiverse/raft-perf measure -- --help`: a signed-in page on a deployed web, paired on/off runs, a JSON verdict and an exit code. `--browser browser-run` (also on `load`) runs the browser on Cloudflare Browser Run instead of this machine.
- `pnpm --filter @botiverse/raft-perf interact -- --help`: scroll, channel switch and thread open on a deployed web; with `--trace`, what the main thread did after each click.
- `pnpm --filter @botiverse/raft-perf startup -- --help`: where the time of opening a channel goes: the first page of messages cut into before-send, first byte and download, the CORS preflights, what was asked twice, and the gap from the answer to the first message on screen with its long tasks.
- `pnpm --filter @botiverse/raft-perf ab -- --help`: two local builds with one change between them, served into a deployed page and compared pair by pair on main-thread work.
- `pnpm --filter @botiverse/raft-perf snapshot -- --help`: what a cold load of a deployed web downloads before boot (no build, no sign-in); JSON or one row per file.
- `pnpm --filter @botiverse/raft-perf diff -- --help`: two builds' first screens compared: growth, and the bytes returning visitors download again; exit code.
- `pnpm --filter @botiverse/raft-perf graph -- --help`: what the build put into the files, by package: first-visit bytes, packages in several versions, what imports a package, which of your own modules would take the most off the first visit if loaded lazily, and what entered or left the first visit between two builds.
- `pnpm --filter @botiverse/raft-perf test`: unit tests (verdict rule, first-screen parsing and diff).

Imports nothing from the app, so it can move out of this repository.
