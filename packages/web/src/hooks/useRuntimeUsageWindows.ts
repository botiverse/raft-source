import { isClaudeOAuthAppsWindow, isRuntimeUsageModelGroupWindow, runtimeUsageAccountsForAgent, runtimeUsageModelGroupOf } from "@botiverse/raft-shared";
import type { RuntimeAccountUsageWindow } from "@botiverse/raft-shared";
import { useEffect, useState } from "react";
import { usageOnCredits } from "../components/machine/runtimeUsageCredits";
import type { RuntimeUsageListWindow } from "../components/machine/runtimeUsageCredits";
import { runtimeAccountUsageClient } from "../utils/runtimeAccountUsageClient";
import type { RuntimeAccountUsageClient, RuntimeAccountUsageReadResult } from "../utils/runtimeAccountUsageClient";
import { usageProviderForRuntime } from "../utils/runtimeUsageProvider";

/**
 * The agent profile's Runtime config "Usage" row: every usage window of the
 * runtime's account on the agent's Computer that the agent runs on (the usage
 * card's cached read; its own account folder's account when it has one,
 * else the Computer's default account, `runtimeUsageAccountsForAgent`),
 * name first, then a thin bar and the share used. Claude's OAuth apps' window
 * is left out (third-party apps' use, not the agent's). Each window says
 * whether its account runs on credits once it is used up (`usageOnCredits`).
 * Nothing while there is nothing to show: no usage provider for the runtime,
 * not allowed, not read yet, or no windows.
 */
export function useRuntimeUsageWindows({
  enabled,
  serverId,
  machineId,
  runtimeId,
  agentId,
  client = runtimeAccountUsageClient,
}: {
  enabled: boolean;
  serverId: string | null;
  machineId: string;
  runtimeId: string;
  agentId: string | null;
  client?: RuntimeAccountUsageClient;
}): RuntimeUsageListWindow[] {
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
  return runtimeUsageAccountsForAgent(read.result.snapshot, agentId).flatMap((account) => {
    const onCredits = usageOnCredits(account);
    return account.windows.filter((window) => !isClaudeOAuthAppsWindow(window)).map((window) => ({ ...window, onCredits }));
  });
}

/**
 * The windows that can hold an agent on this runtime and model: with a model
 * Raft reads as one of Antigravity's groups ("Gemini Models"), that group's
 * windows and every window not tied to a group; otherwise all of them (also
 * when the account reports none of that group's). Display only: whether the
 * agent can run follows the account's health.
 */
export function agentUsageWindows<W extends RuntimeAccountUsageWindow>(windows: readonly W[], runtimeId: string, model: string | null | undefined): readonly W[] {
  const group = runtimeUsageModelGroupOf(runtimeId, model);
  if (!group || !windows.some((window) => isRuntimeUsageModelGroupWindow(window, group))) return windows;
  return windows.filter((window) => window.scope?.kind !== "models" || isRuntimeUsageModelGroupWindow(window, group));
}
