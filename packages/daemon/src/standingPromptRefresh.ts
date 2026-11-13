import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { agentStateFile, writeAgentStateText } from "./agentStateFiles";
import type { AgentConfig } from "@botiverse/raft-shared";
import { axSurface, composeAxSurfaces, type AxSurfaceText } from "./agentRuntimeInput";
import { WAKE_SECTION_BREAK } from "./startupMemoryBlock";

/**
 * task #13 — keeping a resumed session's standing prompt current.
 *
 * Several runtimes keep the standing prompt their session started with and
 * ignore a new one passed at resume, until their next context compaction:
 * Codex from 0.105 (`developerInstructions` on `thread/resume`; 0.104 and
 * earlier appended it), Claude Code (`--append-system-prompt*` on `--resume`,
 * 2.1.288). Runtimes without a native standing prompt (Cursor, Gemini,
 * Copilot) only ever get it in a fresh session's first input. So a rule added
 * to the standing prompt never reached an existing session.
 *
 * The daemon records, per agent, a hash of the standing prompt each session
 * runs on. When a resumed session's recorded hash differs from the current
 * one, the full current prompt is put at the front of that launch's first
 * input, marked as replacing the earlier standing instructions. Nothing
 * earlier in the conversation changes, so the runtime's prompt cache stays
 * valid. A session with no record yet gets one written (`baseline_unknown`)
 * without an injection, so rolling this out does not inject into every agent
 * at once. Runtimes that rebuild the prompt on every launch (driver flag
 * `standingPromptRefreshesOnResume`: Pi / Built-in, OpenCode) are skipped.
 *
 * The hash ignores the parts of the prompt that change on every release or
 * launch (STANDING_PROMPT_VOLATILE_FIELDS): those reach a running session in
 * other ways (the daemon release notice), and hashing them would re-inject the
 * whole prompt into every agent on every release.
 */

/**
 * Config fields whose changes alone never count as a new standing prompt.
 * Pinned by a test: adding one here (or a new volatile field to the prompt)
 * is a deliberate decision.
 */
export const STANDING_PROMPT_VOLATILE_FIELDS = [
  // "- Daemon: vX" in Current Runtime Context; changes on every release.
  "runtimeContext.daemonVersion",
  // The daemon release notice section and its startup step; per launch.
  "runtimeProfileControl",
] as const;

/** `config` with the volatile fields cleared: the prompt built from it is what is hashed (and injected). */
export function stableStandingPromptConfig(config: AgentConfig): AgentConfig {
  return {
    ...config,
    runtimeProfileControl: null,
    ...(config.runtimeContext ? { runtimeContext: { ...config.runtimeContext, daemonVersion: undefined } } : {}),
  };
}

/**
 * Folded into the ledger hash of a runtime without a native standing prompt.
 *
 * Before version 2, a session of such a runtime started by anything but a cold
 * start (a wake message, resume catch-up, missing-session recovery, ...) never
 * got the standing prompt, yet the ledger recorded it as running on the current
 * one, so its resumes planned `unchanged` and never delivered it. Changing what
 * is hashed makes every record written before version 2 mismatch once: the
 * next resume of each such session re-delivers the prompt (`inject`) and
 * records the new hash, after which it is `unchanged` again. A session that
 * did get the prompt at its cold start gets it once more, which is harmless.
 * Native runtimes hash the prompt alone, as before, so their records still
 * match. Bump only to force one more re-delivery of this kind.
 */
export const STANDING_PROMPT_LEDGER_VERSION_WITHOUT_NATIVE = 2;

export function standingPromptHash(prompt: string, opts: { nativeStandingPrompt: boolean }): string {
  const hash = createHash("sha256");
  if (!opts.nativeStandingPrompt) hash.update(`raft-standing-prompt-ledger-v${STANDING_PROMPT_LEDGER_VERSION_WITHOUT_NATIVE}\n`);
  return hash.update(prompt).digest("hex").slice(0, 32);
}

interface LedgerRecord {
  version: 1;
  sessionId: string;
  promptHash: string;
  recordedAtMs: number;
}

const FILE_NAME = "standing-prompt.json";

/** One record per agent, in the daemon's agent state (`agentStateFiles.ts`), never the workspace. Ids, a hash and a time only. */
export class StandingPromptLedger {
  constructor(private readonly agentsDir: string, private readonly now: () => number = Date.now) {}

  private file(agentId: string): string {
    return agentStateFile(this.agentsDir, agentId, FILE_NAME);
  }

  read(agentId: string): LedgerRecord | null {
    try {
      const value = JSON.parse(readFileSync(this.file(agentId), "utf8")) as Partial<LedgerRecord>;
      if (value?.version !== 1 || typeof value.sessionId !== "string" || typeof value.promptHash !== "string") return null;
      return { version: 1, sessionId: value.sessionId, promptHash: value.promptHash, recordedAtMs: typeof value.recordedAtMs === "number" ? value.recordedAtMs : 0 };
    } catch {
      return null;
    }
  }

  write(agentId: string, sessionId: string, promptHash: string): void {
    const record: LedgerRecord = { version: 1, sessionId, promptHash, recordedAtMs: this.now() };
    writeAgentStateText(this.file(agentId), JSON.stringify(record));
  }
}

export type StandingPromptRefreshPlan =
  /** Not a resume, or the runtime rebuilds the prompt itself. */
  | { action: "none" }
  /** Resumed session already on this prompt. */
  | { action: "unchanged" }
  /** Resumed session with no record (or a record of another session): record it, inject nothing. */
  | { action: "baseline_unknown" }
  /** Resumed session on an older prompt: inject the current one. */
  | { action: "inject"; staleForMs: number };

export function planStandingPromptRefresh(input: {
  ledger: StandingPromptLedger;
  agentId: string;
  /** The session this launch resumes; null for a fresh session. */
  resumeSessionId: string | null;
  refreshesOnResume: boolean;
  promptHash: string;
  nowMs: number;
}): StandingPromptRefreshPlan {
  if (!input.resumeSessionId || input.refreshesOnResume) return { action: "none" };
  let record: LedgerRecord | null;
  try {
    record = input.ledger.read(input.agentId);
  } catch {
    record = null;
  }
  if (!record || record.sessionId !== input.resumeSessionId) return { action: "baseline_unknown" };
  if (record.promptHash === input.promptHash) return { action: "unchanged" };
  return { action: "inject", staleForMs: Math.max(0, input.nowMs - record.recordedAtMs) };
}

export const formatStandingPromptUpdate = axSurface(
  "Current standing prompt re-delivered at the front of a resumed session's first input, when the runtime keeps the session's original standing prompt (task #13).",
  (standingPrompt: string): string => [
    "<raft-standing-prompt-update>",
    "Raft updated your standing instructions since this session started. The instructions below replace the earlier standing instructions (system or developer prompt) for the rest of this session; where they differ, follow these.",
    "",
    standingPrompt,
    "</raft-standing-prompt-update>",
    "",
    "",
  ].join("\n"),
  { examples: [{ args: ["You are \"Example\", an AI agent in Raft. <standing prompt>"] }] },
);

export function applyStandingPromptUpdate(
  plan: StandingPromptRefreshPlan,
  standingPrompt: string,
  prompt: AxSurfaceText,
  promptSource: string,
): { prompt: AxSurfaceText; promptSource: string } {
  if (plan.action !== "inject") return { prompt, promptSource };
  return { prompt: composeAxSurfaces(formatStandingPromptUpdate(standingPrompt), prompt), promptSource: `${promptSource}_with_standing_prompt_update` };
}

/**
 * A runtime without a native standing prompt (Cursor, Gemini, Copilot) sees
 * the standing prompt only if a fresh session's first input carries it. Every
 * fresh start goes through here, whatever triggered it (cold start, a wake
 * message, a thread join, resume catch-up for a dropped session, missing-session
 * recovery), so the prompt opens the first input the daemon composes, the way a
 * native runtime has it ahead of the first input. Two short spawn-time
 * prefixes can still go in front of it when they apply (the memory-limit
 * recovery note and the held server context, see `startAgent`).
 */
export function standingPromptGoesInFirstInput(input: { nativeStandingPrompt: boolean; resumeSessionId: string | null }): boolean {
  return !input.nativeStandingPrompt && !input.resumeSessionId;
}

/**
 * Puts the standing prompt ahead of a fresh session's first input. The prompt
 * source is left as it is (the feedback event tail only accepts the known
 * sources); traces record the fact as `runtime_input_standing_prompt_present`.
 */
export function applyFreshSessionStandingPrompt(
  inFirstInput: boolean,
  standingPrompt: AxSurfaceText,
  prompt: AxSurfaceText,
): AxSurfaceText {
  if (!inFirstInput) return prompt;
  return composeAxSurfaces(standingPrompt, WAKE_SECTION_BREAK, prompt);
}

/**
 * Recorded for a session the current standing prompt did not reach (a runtime
 * without a native standing prompt that came up on another session than the
 * one this launch resumed). Never equal to a real hash, so that session's
 * next resume re-delivers the prompt instead of treating it as current.
 */
export const UNDELIVERED_STANDING_PROMPT_HASH = "undelivered";

/**
 * Which sessions reported by a launch run on the current standing prompt:
 * - `any`: the runtime carries it natively, so every session it reports has it;
 * - `first_reported`: it went in the first input, which reaches the first session the runtime reports
 *   (`sessionId` is null until that session is reported);
 * - `resumed`: it is not in this launch's input, so only the resumed session (recorded or baselined earlier) is on it.
 */
export type StandingPromptSessionBinding =
  | { kind: "any" }
  | { kind: "first_reported"; sessionId: string | null }
  | { kind: "resumed"; sessionId: string };

export function standingPromptSessionBinding(input: {
  nativeStandingPrompt: boolean;
  resumeSessionId: string | null;
  /** The launch's first input carries the full prompt (fresh session, or a re-delivery). */
  promptInFirstInput: boolean;
}): StandingPromptSessionBinding {
  if (input.nativeStandingPrompt) return { kind: "any" };
  if (input.promptInFirstInput || !input.resumeSessionId) return { kind: "first_reported", sessionId: null };
  return { kind: "resumed", sessionId: input.resumeSessionId };
}

/**
 * What to record when the runtime reports `sessionId`: the launch's hash if
 * its standing prompt reached that session, else UNDELIVERED_STANDING_PROMPT_HASH.
 * Returns the binding to keep for later reports: a `first_reported` binding
 * becomes bound to the first session reported. The input is not modified.
 */
export function standingPromptRecordForReportedSession(
  binding: StandingPromptSessionBinding,
  sessionId: string,
  promptHash: string,
): { promptHash: string; binding: StandingPromptSessionBinding } {
  const next: StandingPromptSessionBinding = binding.kind === "first_reported" && binding.sessionId === null
    ? { kind: "first_reported", sessionId }
    : binding;
  const current = next.kind === "any" || next.sessionId === sessionId;
  return { promptHash: current ? promptHash : UNDELIVERED_STANDING_PROMPT_HASH, binding: next };
}
