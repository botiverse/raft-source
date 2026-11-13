#!/bin/bash
# Re-records ../kimi-sdk-wire.jsonl with the Kimi Code SDK the daemon pins, for
# kimiSessionRestore.test.ts. Run it after bumping @botiverse/kimi-code-sdk:
#
#   packages/daemon/src/agentContextView/fixtures/kimi-sdk-wire.record/run.sh
#
# drive.mjs starts a scripted local chat-completions server (no account, no
# network) and drives the real SDK as the daemon launches it; bin/raft stands
# in for the Raft CLI. bwrap gives the session neutral paths (/work,
# /kimi-home, /agent-home) and hostname, so the file needs no scrubbing.
# Check the new file for anything host-specific before committing it.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DAEMON="$(cd "$HERE/../../../.." && pwd)"
SDK="$(cd "$DAEMON" && node -p 'require.resolve("@botiverse/kimi-code-sdk").replace(/index\.c?js$/, "index.mjs")')"
REPO="$(cd "$DAEMON/../.." && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/work" "$SCRATCH/kimi-home" "$SCRATCH/home"
timeout 120 bwrap --die-with-parent --unshare-pid --unshare-uts --hostname fixture-host \
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/sbin /sbin \
  --ro-bind /etc /etc --ro-bind "$REPO" "$REPO" --ro-bind "$(dirname "$(command -v node)")" /node-bin \
  --proc /proc --dev /dev --tmpfs /tmp --tmpfs /var \
  --bind "$SCRATCH/work" /work --bind "$SCRATCH/kimi-home" /kimi-home --bind "$SCRATCH/home" /agent-home \
  --ro-bind "$HERE/bin" /raft-bin --ro-bind "$HERE/drive.mjs" /drive.mjs \
  --chdir /work --clearenv --setenv HOME /agent-home --setenv PATH /node-bin:/usr/bin:/bin \
  --setenv KIMI_CODE_HOME /kimi-home --setenv LANG C.UTF-8 --setenv USER agent \
  node /drive.mjs "$SDK" /kimi-home /work /raft-bin /kimi-home/requests.json
WIRE="$(find "$SCRATCH/kimi-home/sessions" -path '*/agents/main/wire.jsonl' | head -1)"
cp "$WIRE" "$HERE/../kimi-sdk-wire.jsonl"
echo "Wrote $(wc -l < "$HERE/../kimi-sdk-wire.jsonl") records to fixtures/kimi-sdk-wire.jsonl"
