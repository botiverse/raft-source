import { isClaudeOAuthAppsWindow, isRuntimeUsageModelGroupWindow, runtimeUsageModelGroupOf } from "@botiverse/raft-shared";
import type { RuntimeAccountUsageWindow } from "@botiverse/raft-shared";
import { useEffect, useState } from "react";
import { runtimeAccountUsageClient } from "../utils/runtimeAccountUsageClient";
import type { RuntimeAccountUsageClient, RuntimeAccountUsageReadResult } from "../utils/runtimeAccountUsageClient";
import { usageProviderForRuntime } from "../utils/runtimeUsageProvider";

/**
 * The agent profile's Runtime config "Usage" row: every usage window of the
 * runtime's account on the agent's Computer (the usage card's cached read),
 * name first, then a thin bar and the share used. Claude's OAuth apps' window
 * is left out (third-party apps' use, not the agent's). Nothing while there is
 * nothing to show: no usage provider for the runtime, not allowed, not read
 * yet, or no windows.
 */
export function useRuntimeUsageWindows({
  enabled,
  serverId,
  machineId,
  runtimeId,
  client = runtimeAccountUsageClient,
}: {
  enabled: boolean;
  serverId: string | null;
  machineId: string;
  runtimeId: string;
  client?: RuntimeAccountUsageClient;
}): RuntimeAccountUsageWindow[] {
  const provider = usageProviderForRuntime(runtimeId);
  const subject = enabled && serverId && machineId && provider ? `${serverId}\0${machineId}\0${provider}` : null;
  const [read, setRead] = useState<{ subject: string; result: RuntimeAccountUsageReadResult } | null>(null);
  // Synchronizes with the usage client (an external cache): read on show,
  // and again whenever a usage card refreshes it.
  useEffect(() => {
    if (!subject || !serverId || !provider) return;
    let live = true;
    const load = () => {
      client.read(serverId, machineId, provider).then((result) => {
        if (live) setRead({ subject, result });
      }, () => {
        // Not allowed, or the read failed: no row.
      });
    };
    load();
    const unsubscribe = client.subscribe(load);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [client, machineId, provider, serverId, subject]);
  if (!subject || read?.subject !== subject || read.result.snapshot === null) return [];
  return read.result.snapshot.accounts.flatMap((account) => account.windows.filter((window) => !isClaudeOAuthAppsWindow(window)));
}

/**
 * The windows that can hold an agent on this runtime and model: with a model
 * Raft reads as one of Antigravity's groups ("Gemini Models"), that group's
 * windows and every window not tied to a group; otherwise all of them (also
 * when the account reports none of that group's). Display only: whether the
 * agent can run follows the account's health.
 */
export function agentUsageWindows(windows: readonly RuntimeAccountUsageWindow[], runtimeId: string, model: string | null | undefined): readonly RuntimeAccountUsageWindow[] {
  const group = runtimeUsageModelGroupOf(runtimeId, model);
  if (!group || !windows.some((window) => isRuntimeUsageModelGroupWindow(window, group))) return windows;
  return windows.filter((window) => window.scope?.kind !== "models" || isRuntimeUsageModelGroupWindow(window, group));
}
