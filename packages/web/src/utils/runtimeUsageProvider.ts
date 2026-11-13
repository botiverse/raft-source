import type { RuntimeAccountUsageProvider } from "@botiverse/raft-shared";

/**
 * The account usage provider a runtime reports through (OAR), or null for a
 * runtime that reports none. Kimi Code and Kimi CLI share Kimi's account.
 * Kept apart from the usage chip so a page in the first download (the phone's
 * Computers page) can read it without the chip's code.
 */
export function usageProviderForRuntime(runtimeId: string): RuntimeAccountUsageProvider | null {
  if (runtimeId === "claude" || runtimeId === "codex" || runtimeId === "grok" || runtimeId === "antigravity") return runtimeId;
  if (runtimeId === "kimi" || runtimeId === "kimi-sdk") return "kimi";
  return null;
}
