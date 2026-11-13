// Glimpse layer 2: count each passive AX block this CLI writes for the model
// (packages/shared/src/agentOps/passiveRenderCounts.ts). The daemon reports
// the counts once per turn; this CLI sends nothing anywhere itself.
//
// Only while the daemon has passive AX on for this launch, under the
// contextId of its signal. Counted when written, before the flush: a write
// that then fails (a closed pipe) still counts, which is rare and only
// over-reports.
import type { PassiveRenderKind } from "@botiverse/raft-shared/src/agentCliSurface";
import { isLocalStateAgentId } from "@botiverse/raft-shared/src/agentCliSurface";

import { countPassiveRender } from "../state/agentLedger";
import { enabledContextSignal } from "./passiveEngine";

export function countRendered(
  agentId: string | undefined,
  kind: PassiveRenderKind,
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!text || !agentId || !isLocalStateAgentId(agentId)) return;
  const signal = enabledContextSignal(env);
  if (!signal) return;
  countPassiveRender(agentId, signal.contextId, kind, Array.from(text).length, Buffer.byteLength(text, "utf8"), env);
}
