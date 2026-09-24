// Raft Computer release channel STATE (RFC v0.8 contract v6 §6/§10/§11 /
// PR-E §2.1) — the pure parse/read/write core, extracted from channel.ts so
// the ComputerApi facade and the upgrade/service internals can consume it
// without importing the CLI presenter layer (import-cycle decycle R0/R2,
// #wg-raft-computer:18ab6541).
//
// Three release channels (v6 §11 enum):
//   `latest`  — production. Tracks staging→production release cuts (default
//               if no channel file present).
//   `alpha`   — staging-tracking. Updated continuously from staging branch.
//   `pinned:<semver>` — user-pinned exact version. NEVER auto-bumped.
//
// State storage: `~/.slock/computer/channel` (one-line text). Contract-mutable
// ONLY via `raft-computer channel set <name>`. Manual edit is undefined
// behavior (per v6 §10 invariant); the service reads the file as a
// cached invariant for its lifetime.
//
// Default: `latest` when file absent or unreadable. Reading the channel
// never throws — corrupt content falls back to default.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { channelPath } from "../paths.js";

export const DEFAULT_CHANNEL = "latest";
export const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

export type Channel = "latest" | "alpha" | `pinned:${string}`;

/**
 * Validate a channel string against the v6 §11 enum. Returns the
 * canonical channel (trimmed) when valid; null when invalid.
 */
export function parseChannel(raw: string): Channel | null {
  const v = raw.trim();
  if (v === "latest" || v === "alpha") return v;
  if (v.startsWith("pinned:")) {
    const semver = v.slice("pinned:".length);
    if (SEMVER_RE.test(semver)) return `pinned:${semver}` as Channel;
    return null;
  }
  return null;
}

/**
 * Read the persisted channel from `~/.slock/computer/channel`. Returns
 * the default `latest` when file is absent / unreadable / contains an
 * unrecognized value. Reading is intentionally lenient: a corrupt file
 * should not block CLI invocations.
 */
export async function readChannel(slockHome: string): Promise<Channel> {
  try {
    const raw = await readFile(channelPath(slockHome), "utf8");
    const parsed = parseChannel(raw);
    if (parsed !== null) return parsed;
  } catch {
    /* missing / unreadable → default */
  }
  return DEFAULT_CHANNEL;
}

/**
 * Write the channel value to `~/.slock/computer/channel`. Caller MUST
 * pass an already-validated value (use `parseChannel` first). The file
 * is created with mode 0600 to match other Computer-local state.
 */
export async function writeChannel(slockHome: string, channel: Channel): Promise<void> {
  const p = channelPath(slockHome);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, `${channel}\n`, { mode: 0o600 });
}
