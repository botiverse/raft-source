#!/usr/bin/env bash
# The first-screen record of one web deploy (docs/frontend/perf-measure.md, `deploy-record`).
#
#   packages/perf/scripts/first-screen-record.sh <deployed origin> <dir of the previous record> <dir for this record>
#
# Run from the repository root after a deploy is live. It reads the deployed files' sizes (raft-perf snapshot),
# builds the same commit a second time with the build-graph plugin (raft-perf graph --build: the web's own
# `vite build`, the environment of this shell, nothing published), and writes summary.md comparing both with the
# previous record. Every part is best effort and the script always exits 0: it must never fail a deploy.
set -uo pipefail
origin="${1:?deployed origin}"; previous="${2:?directory of the previous record}"; out="${3:?directory for this record}"
mkdir -p "$out"; out="$(cd "$out" && pwd)"; previous="$(mkdir -p "$previous" && cd "$previous" && pwd)"
perf() { (cd packages/perf && node --import @oxc-node/core/register "$@"); }

commit="$(git rev-parse HEAD 2>/dev/null || true)"
perf src/snapshot.ts --origin "$origin" --out "$out/first-screen.json" || { rm -f "$out/first-screen.json"; echo "first-screen record: reading the deployed files failed"; }
# RAFT_BOOT_SHELL_AFTER_BUILD: as the web's own build:vite script sets it.
# Its files go to a directory of their own, removed afterwards: the deploy's packages/web/dist is left as it was
# (checked by checksum; the web's closeBundle plugins that name dist themselves rewrite it with the same bytes).
# A build that fails after the plugin wrote the graph leaves no graph: a graph is only of a build that finished.
# Only when there is a dist to protect: in a fresh checkout those plugins need the build to write dist itself.
elsewhere=(); if [ -d packages/web/dist ]; then elsewhere=(--out-dir "$out/second-build"); fi
RAFT_BOOT_SHELL_AFTER_BUILD=1 perf src/graph.ts --build ../web --out "$out/build-graph.json" "${elsewhere[@]}" > "$out/graph-report.json" || { rm -f "$out/build-graph.json"; echo "first-screen record: the build-graph build failed"; }
rm -rf "$out/second-build"
[ -s "$out/build-graph.json" ] && [ -n "$commit" ] && printf '%s\n' "$commit" > "$out/graph-commit"

if [ -s "$out/first-screen.json" ] && [ -s "$out/build-graph.json" ]; then
  args=(--graph "$out/build-graph.json" --snapshot "$out/first-screen.json" --out "$out/summary.md")
  [ -n "$commit" ] && args+=(--graph-commit "$commit")
  [ -s "$previous/build-graph.json" ] && args+=(--base-graph "$previous/build-graph.json")
  [ -s "$previous/first-screen.json" ] && args+=(--base-snapshot "$previous/first-screen.json")
  [ -s "$previous/graph-commit" ] && args+=(--base-graph-commit "$(cat "$previous/graph-commit")")
  perf src/deployRecord.ts "${args[@]}" || echo "first-screen record: writing the summary failed"
else
  printf '## First screen of this deploy\n\nNo record this time: %s\n' "$([ -s "$out/first-screen.json" ] || echo 'the deployed files could not be read;') $([ -s "$out/build-graph.json" ] || echo 'the build-graph build did not produce a graph.')" > "$out/summary.md"
fi
if [ -s "$out/summary.md" ]; then cat "$out/summary.md"; fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ] && [ -s "$out/summary.md" ]; then cat "$out/summary.md" >> "$GITHUB_STEP_SUMMARY"; fi
exit 0
