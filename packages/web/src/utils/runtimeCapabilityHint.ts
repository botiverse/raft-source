import { getRuntimeRaftCapabilities, isRecommendedRuntime } from "@botiverse/raft-shared";
import type { RuntimeRaftCapabilities } from "@botiverse/raft-shared";
import type { MessageId } from "../i18n/messages/en";

/**
 * The hint for a runtime in the runtime pickers (under the chosen runtime's
 * select; under its name in server setup's rows): what the runtime's
 * missing Raft capabilities cost (shared RUNTIME_RAFT_CAPABILITIES). One
 * whole message per combination, so each language words it as one sentence.
 * A combination no runtime has yet maps to nothing: add its copy here when a
 * runtime has it (runtimeCapabilityHint.test.ts fails until then).
 */
const HINTS: Readonly<Record<string, MessageId>> = {
  // What is missing: steering (mid-turn), sub-agents, compaction (reported).
  "subagents": "runtime.capabilityHint.noSubagents",
  "compaction": "runtime.capabilityHint.compactionUnreported",
  "subagents+compaction": "runtime.capabilityHint.noSubagentsCompactionUnreported",
  "steering+compaction": "runtime.capabilityHint.noSteeringCompactionUnreported",
  "steering+subagents": "runtime.capabilityHint.noSteeringNoSubagents",
  "steering+subagents+compaction": "runtime.capabilityHint.noSteeringNoSubagentsCompactionUnreported",
};

/** The capabilities a runtime lacks, as a HINTS key ("" when it has them all). */
export function missingRuntimeCapabilities(capabilities: RuntimeRaftCapabilities): string {
  return [
    capabilities.midTurnSteering ? null : "steering",
    capabilities.subagents ? null : "subagents",
    capabilities.compactionReported ? null : "compaction",
  ].filter(Boolean).join("+");
}

/** The hint's message for a runtime, or null when it has every capability (or Raft doesn't know it). */
export function runtimeCapabilityHintId(runtimeId: string): MessageId | null {
  const capabilities = getRuntimeRaftCapabilities(runtimeId);
  if (!capabilities) return null;
  return HINTS[missingRuntimeCapabilities(capabilities)] ?? null;
}

/**
 * Limited: the runtime can't take new messages while it is working (no
 * mid-turn steering in shared RUNTIME_RAFT_CAPABILITIES), so the pickers
 * badge it where Recommended goes (cindyz, #triage:#524). From the data, not
 * a list; a runtime Raft doesn't know is not limited.
 */
export function isLimitedRuntime(runtimeId: string): boolean {
  return getRuntimeRaftCapabilities(runtimeId)?.midTurnSteering === false;
}

/**
 * A picker row's guidance: Recommended for Claude Code and Codex, Limited for
 * a runtime without mid-turn steering (each a badge after the name in the
 * list), and the hint (the field's description once it is chosen) for any
 * runtime but a recommended one. A runtime this server lists as deprecated
 * keeps its deprecated label alone.
 */
export function runtimePickerGuidance(
  runtimeId: string,
  deprecated: boolean,
  formatMessage: (descriptor: { id: MessageId }) => string,
): { recommended?: true; limited?: true; hint?: string } {
  if (deprecated) return {};
  if (isRecommendedRuntime(runtimeId)) return { recommended: true };
  const hintId = runtimeCapabilityHintId(runtimeId);
  return {
    ...(isLimitedRuntime(runtimeId) ? { limited: true as const } : {}),
    ...(hintId ? { hint: formatMessage({ id: hintId }) } : {}),
  };
}
