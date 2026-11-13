// Read coverage (passive resource "read.coverage", policy "once"): what a
// top-level channel or DM read leaves out, its "Coverage:" sentence (thread
// replies are read from their thread targets). The first top-level read of
// the conversation in a model context prints it; later ones in that context
// do not. It has its own ledger row: a thread read or a send records the
// channel card, but neither prints this sentence.
//
// Off unless the daemon switched passive AX on for this launch; then, and for
// a runtime that compacts without telling the daemon, every read prints it.
import { createHash } from "node:crypto";

import { isLocalStateAgentId } from "@botiverse/raft-shared/src/agentCliSurface";

import type { CliIo } from "../core/io";
import { flushText } from "../core/renderer";
import { claimObservation, releaseObservation } from "../state/agentLedger";
import { enabledContextSignal } from "./passiveEngine";

export interface ReadCoverageForRead {
  /** Print the sentence in this read's output. */
  show: boolean;
  /** Call after writing the output: when it did not reach stdout, the sentence counts as not shown. */
  settle: (io: CliIo) => Promise<void>;
}

const noSettle = async (): Promise<void> => {};

/**
 * `sentence`: what the read would print, or null when it prints none (a
 * thread, task or app event target). `target`: the conversation it covers.
 */
export function readCoverageForRead(
  sentence: string | null,
  target: string,
  agentId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ReadCoverageForRead {
  if (sentence === null) return { show: false, settle: noSettle };
  if (!agentId || !isLocalStateAgentId(agentId)) return { show: true, settle: noSettle };
  const signal = enabledContextSignal(env);
  if (!signal?.compactionReported) return { show: true, settle: noSettle };
  const { contextId } = signal;
  const rev = createHash("sha256").update(sentence).digest("hex").slice(0, 16);
  // A ledger error claims `true`: printing the sentence once too often is the safe direction.
  const claimed = claimObservation(agentId, "read.coverage", target, rev, contextId, env) ?? true;
  if (!claimed) return { show: false, settle: noSettle };
  return {
    show: true,
    settle: async (io) => {
      if (!(await flushText(io))) releaseObservation(agentId, "read.coverage", target, rev, contextId, env);
    },
  };
}
