import { open, stat } from "node:fs/promises";
import os from "node:os";
import type { AgentConfig } from "@botiverse/raft-shared";
import { resolveRuntimeSessionRef } from "./drivers/index";
import { logger } from "./logger";
import { compareRuntimeCliVersions } from "./runtimeCliVersionTracker";
import type { AxSurfaceText } from "@botiverse/raft-shared";
import { axSurface, composeAxSurfaces } from "./agentRuntimeInput";
import { WAKE_SECTION_BREAK, buildStartupMemoryBlock, resolveStartupMemoryBlockConfig } from "./startupMemoryBlock";
import { buildConstructedPanel, buildConstructedPanelFromSummary } from "./wakeBriefingPanel";
import type { SessionSummary } from "./agentHost/oarSessionSummary";

/**
 * At-wake session recycling (RFC 070, phase 1).
 *
 * When an agent wakes after its prompt cache has certainly expired AND its
 * previous runtime session carries a large context, resuming that session
 * makes the provider re-write the whole context at cache-write prices and
 * re-read it on every subsequent step. Starting a fresh session seeded with a
 * short reconstructed briefing is strictly cheaper and faster at the wake
 * boundary; the agent's durable state (MEMORY.md, notes/, Raft channels and
 * tasks) is unaffected.
 *
 * This module owns the decision and the briefing text. The only caller is
 * AgentProcessManager.startAgentNow, which applies the plan by clearing
 * `sessionId` before spawning (so the driver does not pass `--resume`) while
 * keeping the resume-shaped wake prompt ladder (catch-up messages and unread
 * summaries still deliver — they are the v0 constructed panel).
 *
 * It also holds the cold-idle gates (`coldIdleGate`, `decideColdIdle`); the
 * stop they lead to is decided by AgentProcessManager's reconcile entry.
 * The warm path (§6.5, `wake_recycle_warm`: a large session stopped at a clean
 * turn end, wakeRecycleWarm.ts) is decided here too: the `warm_recycle` reason
 * and its notice.
 *
 * Deliberately NOT here (deferred per RFC 070): at-cap recycling (compaction
 * stays the mid-turn backstop) and the block-provider panel architecture.
 */

/** Matches the 1h prompt-cache TTL measured across the fleet (RFC 070 §1):
 * past this gap the next request re-writes the resumed context in full, so
 * resuming a large session buys nothing that a fresh session does not. */
const DEFAULT_MIN_COLD_GAP_MS = 60 * 60_000;

/** RFC 070 §4: cost is insensitive to this threshold anywhere in 48k–256k
 * (cold-wake contexts are top-heavy); 128k keeps small, cheap-to-resume
 * sessions their continuity while capturing ~98.6% of the cold rewrite. */
const DEFAULT_MIN_CONTEXT_TOKENS = 128_000;

/**
 * `wake_recycle_tier_gate` (#proj-runtime:#54 phase 2): the gate for a
 * session whose last cache write was the 5-minute tier (API-key or custom
 * provider auth, overage periods). Its cache is gone five minutes after the
 * last request, so a wake after a gap this long rewrites the whole context;
 * a margin past the 5 minutes keeps a quick back-and-forth on its warm cache.
 */
const DEFAULT_MIN_COLD_GAP_5M_TIER_MS = 12 * 60_000;

/**
 * `wake_recycle_tier_gate`: the context floor once a gap is past the
 * lifetime of the cache tier the session last wrote. AndyLok's split
 * (#proj-runtime:#54, 7 days): Claude's rewrites after more than an hour
 * idle are 6.1% of its spend, with a median rewrite of 82k, so a 128k floor
 * let most of them resume into a cold cache. Below the gate nothing changes.
 */
const DEFAULT_MIN_CONTEXT_TOKENS_PAST_TIER = 64_000;

/** Bounded tail read of the session transcript; at the fleet's measured
 * ~1.4k tokens of growth per request this spans many turns, which is plenty
 * to find the last assistant usage record. */
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

/** RFC 070 §6.3 enabled set (decided 2026-09-03): recycling considers these
 * runtimes; everything else resumes as unsupported. Within the set, actually
 * firing additionally requires readable resume facts — today only the claude
 * transcript reader exists, so other members resolve to a facts-unavailable
 * resume until the daemon journal (§6.2) supplies their facts. */
export const WAKE_RECYCLE_ENABLED_RUNTIMES = new Set([
  "claude", "codex", "pi", "builtin", "grok", "kimi-sdk",
]);

/**
 * Runtimes whose resume facts come from the OAR host's session summary
 * (#wg-ax task #3, #proj-runtime:#54): an agent on the OAR host whose runtime
 * is listed here can be recycled, and its fresh session gets the panel built
 * from that summary. Only while the Server's `wake_recycle_oar` flag is on for
 * the agent (`summaryFactsRuntimesFor`): the rollout decision is the flag's,
 * and with it off this set is never read. Codex and Grok run on the OAR host;
 * their summaries carry the context size Codex and Grok report (Codex: the
 * last call's tokens in the context window, the quantity the Claude reader
 * takes from its transcript).
 */
export const WAKE_RECYCLE_SUMMARY_FACTS_RUNTIMES: ReadonlySet<string> = new Set<string>(["codex", "grok"]);

const NO_SUMMARY_FACTS_RUNTIMES: ReadonlySet<string> = new Set<string>();

/** The runtimes whose session summary may supply resume facts for this agent: none unless the Server turned `wake_recycle_oar` on. */
export function summaryFactsRuntimesFor(config: Pick<AgentConfig, "wakeRecycleOar">): ReadonlySet<string> {
  return config.wakeRecycleOar === true ? WAKE_RECYCLE_SUMMARY_FACTS_RUNTIMES : NO_SUMMARY_FACTS_RUNTIMES;
}

export interface WakeRecycleConfig {
  enabled: boolean;
  minContextTokens: number;
  minColdGapMs: number;
  /** The Server's `wake_recycle_tier_gate`: gate and floor follow the cache tier the session last wrote. */
  tierGate: boolean;
  /** With `tierGate`: the gate for a session whose last cache write was the 5-minute tier. */
  minColdGap5mTierMs: number;
  /** With `tierGate`: the context floor once the gap is past the hour (`minColdGapMs`), tier known. */
  minContextTokensPastTier: number;
}

/** The cache lifetime a session's last cache write asked for (Claude reports it per request). */
export type CacheTier = "5m" | "1h";

/** The gate and floor a decision used, and the tier they came from (`unknown`: no tier read, today's thresholds). */
export interface RecycleThresholds {
  minColdGapMs: number;
  minContextTokens: number;
  cacheTier: CacheTier | "unknown";
  tierGate: boolean;
}

/**
 * The gate and floor for one session after `idleMs` idle. Without the tier
 * gate, or with no tier known (Codex, Grok, Pi: nothing reports it; a session
 * with no cache write read yet), they are today's: the hour and 128k. With it,
 * a 5-minute-tier session's gate is the short one, and the lower floor applies
 * only once the gap is past the hour, whatever the tier: a 5-minute-tier
 * session idle 12–60 minutes keeps the 128k floor, so quick back-and-forths
 * keep their context (Tenny, #proj-runtime:#54).
 */
export function recycleThresholds(config: WakeRecycleConfig, cacheTier: CacheTier | null | undefined, idleMs: number): RecycleThresholds {
  if (!config.tierGate || !cacheTier) {
    return { minColdGapMs: config.minColdGapMs, minContextTokens: config.minContextTokens, cacheTier: cacheTier ?? "unknown", tierGate: config.tierGate };
  }
  return {
    minColdGapMs: cacheTier === "5m" ? config.minColdGap5mTierMs : config.minColdGapMs,
    minContextTokens: idleMs > config.minColdGapMs ? config.minContextTokensPastTier : config.minContextTokens,
    cacheTier,
    tierGate: true,
  };
}

/** The shortest gate any session of this agent can have: the memory-only cold-idle gate looks no further. */
function shortestColdGapMs(config: WakeRecycleConfig): number {
  return config.tierGate ? Math.min(config.minColdGap5mTierMs, config.minColdGapMs) : config.minColdGapMs;
}

/** Trace attributes of the gate and floor a decision used. */
export function recycleThresholdTraceAttrs(thresholds: RecycleThresholds): Record<string, unknown> {
  return {
    cache_tier: thresholds.cacheTier,
    tier_gate: thresholds.tierGate,
    min_cold_gap_ms: thresholds.minColdGapMs,
    min_context_tokens: thresholds.minContextTokens,
  };
}

export interface SessionResumeFacts {
  transcriptPath: string | null;
  lastActivityAtMs: number | null;
  lastContextTokens: number | null;
  /** The tier of the session's last cache write, when its transcript reports it (Claude); otherwise absent. */
  cacheTier?: CacheTier | null;
  /** Set when the facts came from the OAR host's session summary; the panel is built from it. */
  summary?: SessionSummary | null;
}

/**
 * Resume facts from the OAR host's session summary, only when it describes
 * this very session and knows both facts; otherwise null (unknown, which
 * resolves to a resume). Its context size is the last one the runtime
 * reported; the summary windows feed the panel.
 */
export function sessionSummaryResumeFacts(summary: SessionSummary | null, sessionId: string): SessionResumeFacts | null {
  if (!summary || summary.sessionId !== sessionId || !summary.context) return null;
  // A turn that started and never ended (the daemon died mid-turn): its
  // activity is newer than the file says, so the facts are not known.
  if (summary.wake) {
    const wakeAtMs = Date.parse(summary.wake.at);
    const endedAtMs = summary.turns.lastEndedAt ? Date.parse(summary.turns.lastEndedAt) : Number.NaN;
    if (!Number.isFinite(endedAtMs) || wakeAtMs > endedAtMs) return null;
  }
  const lastActivityAtMs = summary.lastActivityAt ? Date.parse(summary.lastActivityAt) : Number.NaN;
  if (!Number.isFinite(lastActivityAtMs)) return null;
  return { transcriptPath: null, lastActivityAtMs, lastContextTokens: summary.context.tokens, summary };
}

export type WakeRecyclePlan =
  | {
      action: "resume";
      reason: string;
      /** The gate and floor it was decided against, once facts were read. */
      thresholds?: RecycleThresholds;
    }
  | {
      action: "recycle";
      /** `warm_recycle`: the session was stopped at a turn end for its size (`warm`), whatever the gap. */
      reason: "cold_gap_large_context" | "warm_recycle";
      priorSessionId: string;
      idleMs: number;
      priorContextTokens: number;
      thresholds: RecycleThresholds;
      /** Set with `warm_recycle`: the stop this start answers. */
      warm?: { gapSinceStopMs: number; band: WarmRecycleStop["band"] };
      briefing: AxSurfaceText;
      /** What `planWakeSessionRecycle` added to the briefing (absent: nothing, as from `decideWakeRecycle` alone). */
      briefingParts?: { memory: boolean; panel: boolean };
    };

/**
 * A warm-recycle stop the host remembers for the next start (wakeRecycleWarm.ts,
 * `WarmRecycleMarks`): the session that was stopped at a turn end for its
 * size, and when. In memory only: a daemon restart loses it, and the next
 * start then decides by the cold rules.
 */
export interface WarmRecycleStop {
  sessionId: string;
  stoppedAtMs: number;
  contextTokens: number;
  band: "quiet" | "ceiling";
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "on") return true;
  if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "") return false;
  return undefined;
}

export function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Knobs. Recycling is on by default (RFC 070; the `constructed_wake_context`
 * server flag was retired on 2026-10-23 and `AgentConfig.constructedWakeContext`
 * is no longer read here). Per-agent `agents.env_vars` win over daemon process
 * env, and RAFT_WAKE_RECYCLE=0 stays the local per-machine (or per-agent) off
 * switch.
 */
export function resolveWakeRecycleConfig(
  agentEnvVars: Record<string, string> | null | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
  options: { tierGate?: boolean } = {},
): WakeRecycleConfig {
  const pick = (key: string): string | undefined => agentEnvVars?.[key] ?? processEnv[key];
  return {
    enabled: parseBooleanFlag(pick("RAFT_WAKE_RECYCLE")) !== false,
    minContextTokens: parsePositiveInteger(pick("RAFT_WAKE_RECYCLE_MIN_CONTEXT_TOKENS")) ?? DEFAULT_MIN_CONTEXT_TOKENS,
    minColdGapMs: parsePositiveInteger(pick("RAFT_WAKE_RECYCLE_MIN_COLD_GAP_MS")) ?? DEFAULT_MIN_COLD_GAP_MS,
    tierGate: options.tierGate === true,
    minColdGap5mTierMs: parsePositiveInteger(pick("RAFT_WAKE_RECYCLE_MIN_COLD_GAP_5M_TIER_MS")) ?? DEFAULT_MIN_COLD_GAP_5M_TIER_MS,
    minContextTokensPastTier: parsePositiveInteger(pick("RAFT_WAKE_RECYCLE_MIN_CONTEXT_TOKENS_PAST_TIER")) ?? DEFAULT_MIN_CONTEXT_TOKENS_PAST_TIER,
  };
}

/** The knobs for one agent: its env, and the Server's `wake_recycle_tier_gate` (`AgentConfig.wakeRecycleTierGate`). */
export function resolveAgentWakeRecycleConfig(
  config: Pick<AgentConfig, "envVars" | "wakeRecycleTierGate">,
  processEnv: NodeJS.ProcessEnv = process.env,
): WakeRecycleConfig {
  return resolveWakeRecycleConfig(config.envVars, processEnv, { tierGate: config.wakeRecycleTierGate === true });
}

function contextTokensFromUsage(usage: unknown): number | null {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const total = finite(record.input_tokens)
    + finite(record.cache_read_input_tokens)
    + finite(record.cache_creation_input_tokens);
  return total > 0 ? total : null;
}

/**
 * The tier of a request's cache write, from its `usage.cache_creation`
 * split (`ephemeral_1h_input_tokens`, `ephemeral_5m_input_tokens`); null for
 * a request that wrote nothing. A request that wrote both counts as the hour:
 * its long-lived blocks outlive the short ones.
 */
export function cacheTierFromUsage(usage: unknown): CacheTier | null {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const creation = (usage as Record<string, unknown>).cache_creation;
  if (!creation || typeof creation !== "object" || Array.isArray(creation)) return null;
  const record = creation as Record<string, unknown>;
  const positive = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value) && value > 0;
  if (positive(record.ephemeral_1h_input_tokens)) return "1h";
  if (positive(record.ephemeral_5m_input_tokens)) return "5m";
  return null;
}

/**
 * Read the two facts the recycle decision needs from the tail of the Claude
 * session transcript: when the session last progressed, and how large its
 * context was on the last completed request. Any unreadable/missing fact
 * yields nulls, and the caller falls back to a plain resume.
 *
 * Reading the transcript (rather than tracking live state) makes the decision
 * correct across daemon restarts and costs one bounded file read per wake.
 */
export async function readClaudeSessionResumeFacts(
  sessionId: string,
  homeDir: string = os.homedir(),
): Promise<SessionResumeFacts> {
  const ref = resolveRuntimeSessionRef("claude", sessionId, homeDir);
  if (!ref.reachable || !ref.path) {
    return { transcriptPath: null, lastActivityAtMs: null, lastContextTokens: null };
  }
  try {
    const info = await stat(ref.path);
    const readStart = Math.max(0, info.size - TRANSCRIPT_TAIL_BYTES);
    const toRead = info.size - readStart;
    const buffer = Buffer.alloc(toRead);
    const fd = await open(ref.path, "r");
    try {
      let bytesRead = 0;
      while (bytesRead < toRead) {
        const result = await fd.read(buffer, bytesRead, toRead - bytesRead, readStart + bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
    } finally {
      await fd.close();
    }
    const lines = buffer.toString("utf8").split("\n");
    // A mid-file window starts inside a record; drop the leading fragment.
    if (readStart > 0) lines.shift();

    let lastActivityAtMs: number | null = null;
    let lastContextTokens: number | null = null;
    // The last request that wrote cache sets the lifetime (a read refreshes
    // the blocks it hits, at the tier they were written with).
    let cacheTier: CacheTier | null = null;
    for (const line of lines) {
      if (!line) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      if (typeof record.timestamp === "string") {
        const parsed = Date.parse(record.timestamp);
        if (Number.isFinite(parsed)) lastActivityAtMs = Math.max(lastActivityAtMs ?? 0, parsed);
      }
      if (record.type === "assistant") {
        const message = record.message;
        if (message && typeof message === "object" && !Array.isArray(message)) {
          const usage = (message as Record<string, unknown>).usage;
          const tokens = contextTokensFromUsage(usage);
          if (tokens !== null) lastContextTokens = tokens;
          const tier = cacheTierFromUsage(usage);
          if (tier !== null) cacheTier = tier;
        }
      }
    }
    return { transcriptPath: ref.path, lastActivityAtMs, lastContextTokens, cacheTier };
  } catch {
    return { transcriptPath: ref.path, lastActivityAtMs: null, lastContextTokens: null };
  }
}

export interface WakeRecycleDecisionInput {
  config: WakeRecycleConfig;
  runtime: string | undefined;
  sessionId: string | null | undefined;
  hasResumePrompt: boolean;
  hasRuntimeProfileControl: boolean;
  facts: SessionResumeFacts;
  nowMs: number;
  /** The Server's `wake_recycle_warm` for this agent (`AgentConfig.wakeRecycleWarm`). */
  warmEnabled?: boolean;
  /** The warm-recycle stop the host remembers for this agent, if any. */
  warmStop?: WarmRecycleStop | null;
}

/** A pending runtime-profile control blocks recycling only when it is a real
 * profile transition. A `daemon_release_notice` is just a message for the
 * agent (it re-delivers on the fresh session's ladder) — after every daemon
 * release the whole fleet carries one, and pinning giant transcripts for it
 * would suppress recycling exactly when it matters most. */
export function runtimeProfileControlBlocksRecycle(
  control: { kind: string } | null | undefined,
): boolean {
  return Boolean(control && control.kind !== "daemon_release_notice");
}

/** Facts dispatch per runtime (RFC 070 §6.2): claude reads its transcript
 * tail; every other enabled runtime reports unknown facts until the daemon
 * journal supplies them, which resolves to a conservative resume upstream. */
export async function readRuntimeSessionResumeFacts(
  runtime: string,
  sessionId: string,
  homeDir?: string,
): Promise<SessionResumeFacts> {
  if (runtimeSessionTranscriptReadable(runtime)) return readClaudeSessionResumeFacts(sessionId, homeDir);
  return { transcriptPath: null, lastActivityAtMs: null, lastContextTokens: null };
}

/** Whether the daemon can read this runtime's session transcript (today only claude's). */
export function runtimeSessionTranscriptReadable(runtime: string): boolean {
  return runtime === "claude";
}

/**
 * Pure decision core. Every gate that fails resolves to a plain resume with a
 * reason string; the transcript-derived facts must POSITIVELY establish both
 * "cache is certainly cold" and "context is large" before a session is
 * recycled. Unknown facts always mean resume.
 */
export function decideWakeRecycle(input: WakeRecycleDecisionInput): WakeRecyclePlan {
  const { config, facts } = input;
  if (!config.enabled) return { action: "resume", reason: "disabled" };
  if (!WAKE_RECYCLE_ENABLED_RUNTIMES.has(input.runtime ?? "claude")) return { action: "resume", reason: "unsupported_runtime" };
  if (!input.sessionId) return { action: "resume", reason: "no_prior_session" };
  if (input.hasResumePrompt) return { action: "resume", reason: "explicit_resume_prompt" };
  if (input.hasRuntimeProfileControl) return { action: "resume", reason: "runtime_profile_control" };
  if (facts.lastActivityAtMs === null || facts.lastContextTokens === null) {
    return { action: "resume", reason: "session_facts_unavailable" };
  }
  const idleMs = input.nowMs - facts.lastActivityAtMs;
  const thresholds = recycleThresholds(config, facts.cacheTier, idleMs);
  // Warm recycle (§6.5): this very session was stopped at a turn end for its
  // size, so it starts fresh whatever the gap. The context was measured at
  // that turn end; neither the idle gate nor the floor is asked again. Every
  // exclusion above still holds, and so do unknown facts (no panel to build).
  if (input.warmEnabled === true && input.warmStop && input.warmStop.sessionId === input.sessionId) {
    return {
      action: "recycle",
      reason: "warm_recycle",
      priorSessionId: input.sessionId,
      idleMs,
      priorContextTokens: facts.lastContextTokens,
      thresholds,
      warm: { gapSinceStopMs: Math.max(0, input.nowMs - input.warmStop.stoppedAtMs), band: input.warmStop.band },
      briefing: buildWarmRecycleNotice(),
    };
  }
  if (idleMs <= thresholds.minColdGapMs) return { action: "resume", reason: "cache_possibly_warm", thresholds };
  if (facts.lastContextTokens <= thresholds.minContextTokens) return { action: "resume", reason: "context_below_threshold", thresholds };
  return {
    action: "recycle",
    reason: "cold_gap_large_context",
    priorSessionId: input.sessionId,
    idleMs,
    priorContextTokens: facts.lastContextTokens,
    thresholds,
    briefing: buildRecycleBriefing({ idleMs, priorContextTokens: facts.lastContextTokens }),
  };
}

/**
 * The recycled-wake first input carries NO announcement and NO instructions
 * (v2, 2026-09-11). The v1 chrome ("your session was retired… consult
 * MEMORY.md first, then re-establish state…") measurably framed every wake as
 * a resume-protocol: in the 13-recycle canary batch, 13/13 fresh sessions
 * opened with state-re-establishment rituals instead of the message that woke
 * them. A chat window never announces that its context was rebuilt — history
 * sits quietly above, the new message sits at the bottom, and the thread
 * itself carries any commitments. The constructed input now has that shape:
 * ambient blocks (memory, recent messages, in-flight facts) above, the
 * ordinary wake prompt last, nothing in between telling the agent what kind
 * of start this is or what to do first.
 */
export const buildRecycleBriefing = axSurface(
  "Recycled-wake briefing: intentionally EMPTY — the context blocks are XML-delimited and self-labeling, and any announcement or recap line reads as a protocol to follow",
  (args: { idleMs: number; priorContextTokens: number }): string => {
    void args;
    return "";
  },
  { examples: [{ title: "any recycle", args: [{ idleMs: 3 * 3_600_000, priorContextTokens: 500_000 }] }] },
);

/**
 * The warm path's notice (§6.5). Unlike a cold wake, a warm recycle cuts a
 * session that was just working: the agent may be mid-task, so it is told
 * once, plainly, that the context above is a reconstruction, and to re-check
 * the two places work reaches it. Nothing else: any further line reads as a
 * protocol to follow (see `buildRecycleBriefing`).
 */
export const buildWarmRecycleNotice = axSurface(
  "Warm-recycle notice: first lines of a session restarted at a turn end for its size (wake_recycle_warm); says the context is a reconstruction and names the two re-checks (inbox, assigned tasks)",
  (): string => [
    "[This session was restarted to keep it short. Work may have been in progress.",
    "What follows is a reconstruction of recent activity, not the transcript.",
    "Before continuing, re-check two things: your unread inbox (`raft inbox check`) and the tasks assigned to you (`raft task list --mine`).]",
  ].join("\n"),
  { examples: [{ title: "any warm recycle", args: [] }] },
);

/** Compose ax-surface pieces with the section break, skipping empty pieces so
 * an empty briefing contributes no leading blank lines. */
function composeWakeSections(...pieces: AxSurfaceText[]): AxSurfaceText {
  const nonEmpty = pieces.filter((piece) => String(piece).length > 0);
  let composed = nonEmpty[0] ?? pieces[pieces.length - 1]!;
  for (const piece of nonEmpty.slice(1)) composed = composeAxSurfaces(composed, WAKE_SECTION_BREAK, piece);
  return composed;
}

/** Trace payload + log line for an applied recycle, kept here so the
 * AgentProcessManager call site stays a thin hook. */
export function describeAppliedWakeRecycle(
  agentId: string,
  plan: Extract<WakeRecyclePlan, { action: "recycle" }>,
): { traceAttrs: Record<string, unknown>; logLine: string } {
  return {
    traceAttrs: {
      agentId,
      reason: plan.reason,
      prior_session_id: plan.priorSessionId,
      idle_ms: plan.idleMs,
      prior_context_tokens: plan.priorContextTokens,
      ...recycleThresholdTraceAttrs(plan.thresholds),
    },
    logLine: plan.warm
      ? `Retiring runtime session ${plan.priorSessionId} at wake (warm recycle, ${plan.warm.gapSinceStopMs}ms since its warm stop, ${plan.priorContextTokens} context tokens); starting fresh with briefing`
      : `Retiring runtime session ${plan.priorSessionId} at wake (cold recycle, idle ${Math.round(plan.idleMs / 60_000)}m, ~${Math.round(plan.priorContextTokens / 1000)}k context); starting fresh with briefing`,
  };
}

/**
 * The one daemon-log line of a start that recycles (warm or cold), on either
 * host, beside the applied-recycle trace. The new session's id is not known
 * yet (the runtime names it once started), so it reads `pending`. Briefing
 * tokens are estimated as the panel estimates them (characters / 4).
 */
export function describeRecycledWakeLogLine(
  agentId: string,
  plan: Extract<WakeRecyclePlan, { action: "recycle" }>,
  host: "legacy" | "oar",
): string {
  const gapMs = plan.warm ? plan.warm.gapSinceStopMs : plan.idleMs;
  const briefingTokens = Math.ceil(String(plan.briefing).length / 4);
  const yesNo = (value: boolean | undefined) => (value ? "yes" : "no");
  return `[WakeRecycle] recycled: agent ${agentId} kind ${plan.warm ? "warm" : "cold"}, old session ${plan.priorSessionId}, new session pending, gap ${gapMs}ms`
    + `${plan.warm ? `, band ${plan.warm.band}` : ""}, briefing ${briefingTokens} tokens`
    + ` (panel ${yesNo(plan.briefingParts?.panel)}, memory ${yesNo(plan.briefingParts?.memory)}) (${host})`;
}

/**
 * What the applied-recycle trace says about which path led to it (§6.5):
 * `recycle_kind`, the start's trigger kind as the turn trace names it
 * (turnTriggerTrace.ts), and for a warm recycle the time since its stop.
 */
export function wakeRecycleKindTraceAttrs(
  plan: Extract<WakeRecyclePlan, { action: "recycle" }>,
  triggerKind: string | undefined,
): Record<string, unknown> {
  return {
    recycle_kind: plan.warm ? "warm" : "cold",
    ...(plan.warm ? { gap_since_stop_ms: plan.warm.gapSinceStopMs, band: plan.warm.band } : {}),
    ...(triggerKind ? { trigger_kind: triggerKind } : {}),
  };
}

/** How often the reconcile sweep runs (the legacy host's cold-idle backstop;
 * the OAR host's held-session sweep reuses it). */
export const COLD_IDLE_SWEEP_MS = 10 * 60_000;

/**
 * Cold idle (RFC 070, reconciler step 8b) is a session policy, not idle: a
 * process that is idle (agentIdle.ts, decided by the caller) is cold when no
 * event has come from it for longer than the cold gap AND its session's
 * context is past the recycle threshold. Keeping such a process alive buys
 * nothing (its prompt cache is gone; only ~1s of respawn is saved), while
 * stopping it routes the next wake through the process-start path, where the
 * at-wake recycle (chooseSession rule 3) starts a new session with a
 * briefing. This is how the recycle reaches the fleet's dominant cold-wake
 * shape (long-lived processes woken via stdin).
 *
 * Two steps, so the cheap one decides first: `coldIdleGate` (memory only:
 * config, the runtime CLI version, session, the time since the last event)
 * and, only for a process past it, `decideColdIdle` over the session facts
 * read from the transcript (async). Background work is not judged here: it
 * holds idle.
 */
export type ColdIdleSkipReason =
  /** coldIdleGate */
  | "disabled"
  | "unsupported_runtime"
  | "runtime_version_below_floor"
  | "no_session"
  | "recent_event"
  /** decideColdIdle */
  | "session_facts_unavailable"
  | "recent_activity"
  | "context_below_threshold";

export type ColdIdleGate =
  | { pass: true; sessionId: string; config: WakeRecycleConfig; sinceEventMs: number }
  | { pass: false; reason: Extract<ColdIdleSkipReason, "disabled" | "unsupported_runtime" | "runtime_version_below_floor" | "no_session" | "recent_event"> };

/**
 * The oldest runtime CLI a process may run to be stopped as cold, per
 * runtime. A cold-idle stop trusts the event stream to show every background
 * task (idle reads `backgroundTasks`): Claude Code before typed task
 * envelopes sent `task_started` / `task_notification` only for sub-agents,
 * so a background shell or Monitor was visible only in its transcript.
 * 2.1.220 is the Claude driver's tested-good version
 * (`launchVersionPolicy.testedGoodVersion`), which sends them for every task
 * kind. An older or unknown version is never stopped as cold: it only loses
 * the recycle, never work.
 */
export const COLD_IDLE_RUNTIME_VERSION_FLOORS: Readonly<Record<string, string>> = { claude: "2.1.220" };

/** Whether `version` is known and at or above the runtime's floor (a runtime without one always is). */
export function runtimeVersionAllowsColdIdle(runtime: string, version: string | null | undefined): boolean {
  const floor = COLD_IDLE_RUNTIME_VERSION_FLOORS[runtime];
  if (!floor) return true;
  if (!version) return false;
  const compared = compareRuntimeCliVersions(version, floor);
  return compared !== null && compared >= 0;
}

/** The memory-only half of cold: no I/O. */
export function coldIdleGate(input: {
  config: AgentConfig;
  /** Live session id latched from the runtime (falls back to config.sessionId). */
  liveSessionId: string | null;
  /** The process's last event (RuntimeProgressState.lastEventAt). */
  lastEventAtMs: number;
  /** The runtime CLI version the process runs, when known (unknown is below any floor). */
  runtimeCliVersion: string | null | undefined;
  nowMs: number;
  processEnv?: NodeJS.ProcessEnv;
}): ColdIdleGate {
  const config = resolveAgentWakeRecycleConfig(input.config, input.processEnv ?? process.env);
  if (!config.enabled) return { pass: false, reason: "disabled" };
  const runtime = input.config.runtime ?? "claude";
  if (!WAKE_RECYCLE_ENABLED_RUNTIMES.has(runtime)) return { pass: false, reason: "unsupported_runtime" };
  if (!runtimeVersionAllowsColdIdle(runtime, input.runtimeCliVersion)) return { pass: false, reason: "runtime_version_below_floor" };
  const sessionId = input.liveSessionId ?? input.config.sessionId;
  if (!sessionId) return { pass: false, reason: "no_session" };
  const sinceEventMs = input.nowMs - input.lastEventAtMs;
  // The session's own gate needs its tier (read with the facts, decideColdIdle);
  // here only what no session of this agent can be cold before.
  if (sinceEventMs <= shortestColdGapMs(config)) return { pass: false, reason: "recent_event" };
  return { pass: true, sessionId, config, sinceEventMs };
}

export type ColdIdleVerdict =
  | { cold: true; idleMs: number; priorContextTokens: number; thresholds: RecycleThresholds }
  | { cold: false; reason: Extract<ColdIdleSkipReason, "session_facts_unavailable" | "recent_activity" | "context_below_threshold"> };

/**
 * The transcript half of cold, over facts already read
 * (readRuntimeSessionResumeFacts). Unknown facts are never cold. The last
 * transcript activity counts with the last event, as the at-wake recycle
 * reads it: a stop it would answer with a resume is not made.
 */
export function decideColdIdle(facts: SessionResumeFacts, input: {
  config: WakeRecycleConfig;
  lastEventAtMs: number;
  nowMs: number;
}): ColdIdleVerdict {
  if (facts.lastActivityAtMs === null || facts.lastContextTokens === null) return { cold: false, reason: "session_facts_unavailable" };
  // The same gate and floor the at-wake recycle will use, so a stop is never answered by a resume.
  const idleMs = input.nowMs - Math.max(facts.lastActivityAtMs, input.lastEventAtMs);
  const thresholds = recycleThresholds(input.config, facts.cacheTier, idleMs);
  if (idleMs <= thresholds.minColdGapMs) return { cold: false, reason: "recent_activity" };
  if (facts.lastContextTokens <= thresholds.minContextTokens) return { cold: false, reason: "context_below_threshold" };
  return { cold: true, idleMs, priorContextTokens: facts.lastContextTokens, thresholds };
}

/** Prepend the briefing to the ladder-selected wake prompt and mark the
 * prompt source, as one atomic application so the call site stays one line. */
export function applyWakeRecycleBriefing(
  plan: WakeRecyclePlan,
  prompt: AxSurfaceText,
  promptSource: string,
): { prompt: AxSurfaceText; promptSource: string } {
  if (plan.action !== "recycle") return { prompt, promptSource };
  return { prompt: composeWakeSections(plan.briefing, prompt), promptSource: `recycled_${promptSource}` };
}

export interface PlanWakeSessionRecycleArgs {
  config: AgentConfig;
  hasResumePrompt: boolean;
  nowMs?: number;
  homeDir?: string;
  processEnv?: NodeJS.ProcessEnv;
  /** The OAR host's summary for this agent (its `SessionSummaryStore`); absent on the legacy host. */
  readSessionSummary?: () => SessionSummary | null;
  /** Defaults to `summaryFactsRuntimesFor(config)` (the Server's `wake_recycle_oar`); tests pass their own. */
  summaryFactsRuntimes?: ReadonlySet<string>;
  /** The warm-recycle stop the host remembers for this agent (`WarmRecycleMarks.takeStopped`); read only with `wake_recycle_warm` on. */
  warmStop?: WarmRecycleStop | null;
}

/** Async entry point for AgentProcessManager: resolve knobs, read transcript
 * facts, decide. Never throws — any failure is a plain resume. */
export async function planWakeSessionRecycle(args: PlanWakeSessionRecycleArgs): Promise<WakeRecyclePlan> {
  const recycleConfig = resolveAgentWakeRecycleConfig(args.config, args.processEnv ?? process.env);
  if (!recycleConfig.enabled || !args.config.sessionId || !WAKE_RECYCLE_ENABLED_RUNTIMES.has(args.config.runtime ?? "claude")) {
    return decideWakeRecycle({
      config: recycleConfig,
      runtime: args.config.runtime,
      sessionId: args.config.sessionId,
      hasResumePrompt: args.hasResumePrompt,
      hasRuntimeProfileControl: runtimeProfileControlBlocksRecycle(args.config.runtimeProfileControl),
      facts: { transcriptPath: null, lastActivityAtMs: null, lastContextTokens: null },
      nowMs: args.nowMs ?? Date.now(),
    });
  }
  let facts = await readRuntimeSessionResumeFacts(args.config.runtime ?? "claude", args.config.sessionId, args.homeDir);
  const summaryFactsRuntimes = args.summaryFactsRuntimes ?? summaryFactsRuntimesFor(args.config);
  if (facts.lastActivityAtMs === null && args.readSessionSummary && summaryFactsRuntimes.has(args.config.runtime ?? "claude")) {
    let summary: SessionSummary | null = null;
    try {
      summary = args.readSessionSummary();
    } catch (err) {
      logger.warn(`[WakeRecycle] session summary unreadable, resuming: ${err instanceof Error ? err.message : String(err)}`);
    }
    facts = sessionSummaryResumeFacts(summary, args.config.sessionId) ?? facts;
  }
  const plan = decideWakeRecycle({
    config: recycleConfig,
    runtime: args.config.runtime,
    sessionId: args.config.sessionId,
    hasResumePrompt: args.hasResumePrompt,
    hasRuntimeProfileControl: runtimeProfileControlBlocksRecycle(args.config.runtimeProfileControl),
    facts,
    nowMs: args.nowMs ?? Date.now(),
    warmEnabled: args.config.wakeRecycleWarm === true,
    warmStop: args.warmStop ?? null,
  });
  if (plan.action === "resume") {
    // Enabled-but-resumed is the observable a canary needs: it says why the
    // recycle held its fire (warm cache, small context, missing facts, ...).
    logger.info(`[WakeRecycle] agent session ${args.config.sessionId} resumed: ${plan.reason} (lastActivityAtMs=${facts.lastActivityAtMs}, lastContextTokens=${facts.lastContextTokens}, path=${facts.transcriptPath ?? "none"})`);
    return plan;
  }
  // Constructed briefing order: briefing chrome, then the durable memory
  // index, then session-specific working state (panel). Both extras degrade
  // to absence, never block the recycle.
  let briefing = plan.briefing;
  let memory = false;

  // Startup memory block (RFC 070 §6 follow-up): a recycled start is a fresh
  // session, so the MEMORY.md head is pushed here instead of relying on the
  // standing-prompt read.
  const memoryConfig = resolveStartupMemoryBlockConfig(args.config.envVars, args.processEnv ?? process.env);
  const workspacePath = args.config.runtimeContext?.workspacePath;
  if (memoryConfig.enabled && workspacePath) {
    const memoryBlock = await buildStartupMemoryBlock({ workspacePath, budgetTokens: memoryConfig.budgetTokens });
    if (memoryBlock) {
      briefing = composeWakeSections(briefing, memoryBlock);
      memory = true;
      logger.info(`[WakeRecycle] startup memory block injected for recycled session ${plan.priorSessionId}`);
    }
  }

  // Constructed panel (RFC 070 §9 "v3"): open loops + objects in play (live
  // re-read where possible) + last actions, built from the retired session's
  // transcript. Failure to build degrades to the bare briefing, never blocks.
  const panelBudget = parsePositiveInteger(
    (args.config.envVars ?? undefined)?.RAFT_WAKE_RECYCLE_PANEL_TOKENS
      ?? (args.processEnv ?? process.env).RAFT_WAKE_RECYCLE_PANEL_TOKENS,
  ) ?? 8_000;
  // Recent-messages section knob: same env-family semantics, `=0` disables
  // just this section (the panel's other sections are unaffected).
  const recentMessagesRaw = (args.config.envVars ?? undefined)?.RAFT_WAKE_RECYCLE_RECENT_MESSAGES
    ?? (args.processEnv ?? process.env).RAFT_WAKE_RECYCLE_RECENT_MESSAGES;
  const recentMessagesMax = recentMessagesRaw?.trim() === "0" ? 0 : parsePositiveInteger(recentMessagesRaw);
  // §6.5: a warm stop cut work in progress, so its panel adds the agent's last
  // notes, its open todo list and a longer action tail; a cold one is unchanged.
  const warm = plan.reason === "warm_recycle";
  if (facts.transcriptPath && panelBudget > 0) {
    try {
      const panel = await buildConstructedPanel({
        transcriptPath: facts.transcriptPath,
        workspacePath: workspacePath ?? undefined,
        budgetTokens: panelBudget,
        recentMessagesMax,
        ...(warm ? { warm } : {}),
      });
      if (panel) return { ...plan, briefing: composeWakeSections(briefing, panel), briefingParts: { memory, panel: true } };
    } catch (err) {
      logger.warn(`[WakeRecycle] panel construction failed, using bare briefing: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (facts.summary && panelBudget > 0) {
    // The OAR host's session summary: the same panel, built from its windows.
    try {
      const panel = await buildConstructedPanelFromSummary({
        summary: facts.summary,
        workspacePath: workspacePath ?? undefined,
        budgetTokens: panelBudget,
        recentMessagesMax,
        ...(warm ? { warm } : {}),
      });
      if (panel) return { ...plan, briefing: composeWakeSections(briefing, panel), briefingParts: { memory, panel: true } };
    } catch (err) {
      logger.warn(`[WakeRecycle] summary panel construction failed, using bare briefing: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Nothing added: the decision's own plan (no `briefingParts`: neither part).
  return memory ? { ...plan, briefing, briefingParts: { memory, panel: false } } : plan;
}
