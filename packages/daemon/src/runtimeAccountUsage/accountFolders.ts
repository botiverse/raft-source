// Agents' own account folders (docs/contracts/runtime-account-usage.md): a
// Codex or Claude agent whose env vars set HOME or the runtime's folder key
// (CODEX_HOME, CLAUDE_CONFIG_DIR) signs in from its own folder, not the
// Computer's default account. On a refresh carrying `accountHomes` the
// collector reads each such folder beside the default account and tags its
// account with those agents. Folder paths stay in daemon memory: never traced
// or sent (the account key is a hash of one).

import {
  RUNTIME_ACCOUNT_USAGE_ACCOUNTS_MAX,
  RUNTIME_ACCOUNT_USAGE_AGENT_IDS_MAX,
  type RuntimeAccountUsageAccountHome,
  type RuntimeAccountUsageFolderProvider,
  type RuntimeAccountUsageSnapshot,
} from "@botiverse/raft-shared";

import { runtimeAccountFolder, type CredentialLocationContext } from "../credentialSource";

/** Folders read beside the default account: the snapshot holds the default account and these. */
export const RUNTIME_ACCOUNT_USAGE_EXTRA_FOLDERS_MAX = RUNTIME_ACCOUNT_USAGE_ACCOUNTS_MAX - 1;

/** One extra folder to read: the env its read runs under (the agents' own, HOME and the folder key only) and its agents. */
export type RuntimeAccountUsageFolderRead = {
  /** The normalized folder path (or `keychain:<raw CLAUDE_CONFIG_DIR>` for Claude on macOS): its account key's slot. */
  folder: string;
  env: Record<string, string>;
  agentIds: string[];
};

export type RuntimeAccountUsageFolderPlan = {
  folders: RuntimeAccountUsageFolderRead[];
  /** Distinct folders past RUNTIME_ACCOUNT_USAGE_EXTRA_FOLDERS_MAX, left unread (their agents fall back to the default account). */
  dropped: number;
};

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * On macOS, Claude Code keeps its sign-in in a Keychain item named after the
 * raw CLAUDE_CONFIG_DIR string (`claudeKeychainService`; unset: the plain
 * item), so two spellings of one folder, `$HOME/.claude` given explicitly
 * included, may be different sign-ins. Such an entry is keyed by that string
 * (trimmed only), never merged into the default account, and read with it as
 * given. Null for every other entry, platform and provider (path-resolved).
 */
function macClaudeKeychainSlot(provider: RuntimeAccountUsageFolderProvider, home: RuntimeAccountUsageAccountHome, ctx: CredentialLocationContext): string | null {
  if (provider !== "claude" || ctx.platform !== "darwin") return null;
  const raw = home.env.CLAUDE_CONFIG_DIR?.trim();
  return raw ? `keychain:${raw}` : null;
}

/**
 * Which folders to read for `accountHomes`: each entry's folder resolved as
 * its runtime resolves it (the daemon's env under the entry's), normalized and
 * deduplicated. An entry resolving to the daemon's own default folder adds
 * nothing (its agents read the default account). Claude on macOS with
 * CLAUDE_CONFIG_DIR set: keyed by that raw string instead (`macClaudeKeychainSlot`). Agents of entries sharing a
 * folder are one account. Sorted by folder; past the cap, the rest dropped.
 */
export function planRuntimeAccountUsageFolders(
  provider: RuntimeAccountUsageFolderProvider,
  accountHomes: readonly RuntimeAccountUsageAccountHome[],
  ctx: CredentialLocationContext,
): RuntimeAccountUsageFolderPlan {
  const defaultFolder = runtimeAccountFolder(provider, ctx);
  const byFolder = new Map<string, { env: Record<string, string>; envKey: string; agentIds: Set<string> }>();
  for (const home of accountHomes) {
    const folder = macClaudeKeychainSlot(provider, home, ctx) ?? runtimeAccountFolder(provider, { ...ctx, env: { ...ctx.env, ...home.env } });
    if (folder === defaultFolder) continue;
    // An env whose values need no trimming is preferred, then the smallest: the same one every time.
    const padded = Object.values(home.env).some((value) => value !== value.trim());
    const envKey = `${padded ? 1 : 0}${JSON.stringify(Object.entries(home.env).sort(([a], [b]) => compare(a, b)))}`;
    const seen = byFolder.get(folder);
    if (!seen) {
      byFolder.set(folder, { env: { ...home.env }, envKey, agentIds: new Set(home.agentIds) });
      continue;
    }
    for (const id of home.agentIds) seen.agentIds.add(id);
    // Two spellings of one folder: read it under one of them, the same one every time.
    if (compare(envKey, seen.envKey) < 0) Object.assign(seen, { env: { ...home.env }, envKey });
  }
  const folders = [...byFolder.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([folder, entry]): RuntimeAccountUsageFolderRead => ({
      folder,
      env: entry.env,
      agentIds: [...entry.agentIds].sort(compare).slice(0, RUNTIME_ACCOUNT_USAGE_AGENT_IDS_MAX),
    }));
  return {
    folders: folders.slice(0, RUNTIME_ACCOUNT_USAGE_EXTRA_FOLDERS_MAX),
    dropped: Math.max(0, folders.length - RUNTIME_ACCOUNT_USAGE_EXTRA_FOLDERS_MAX),
  };
}

/**
 * One snapshot from the default read and the folders' reads: the default
 * snapshot as read (its freshness, versions and accounts first, untagged),
 * then each folder's accounts tagged with its agents. An account key already
 * present is skipped; never more than the snapshot holds.
 */
export function mergeRuntimeAccountUsageFolders(
  base: RuntimeAccountUsageSnapshot,
  folders: ReadonlyArray<{ snapshot: RuntimeAccountUsageSnapshot; agentIds: readonly string[] }>,
): RuntimeAccountUsageSnapshot {
  if (folders.length === 0) return base;
  const accounts = [...base.accounts];
  const keys = new Set(accounts.map((account) => account.accountKey));
  for (const { snapshot, agentIds } of folders) {
    if (agentIds.length === 0) continue;
    for (const account of snapshot.accounts) {
      if (accounts.length >= RUNTIME_ACCOUNT_USAGE_ACCOUNTS_MAX) break;
      if (keys.has(account.accountKey)) continue;
      keys.add(account.accountKey);
      accounts.push({ ...account, agentIds: [...agentIds] });
    }
  }
  return { ...base, accounts };
}
