import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { APPROX_PROMPT_BYTES_PER_TOKEN, RECOMMENDED_MEMORY_MD_BYTES, STARTUP_MEMORY_BLOCK_BUDGET_TOKENS, type AxSurfaceText } from "@botiverse/raft-shared";
import { axSurface, axSurfaceLiteral, composeAxSurfaces } from "./agentRuntimeInput";

/**
 * Startup memory block (RFC 070 §6 follow-up): inject the head of the agent's
 * MEMORY.md into the first input of every FRESH runtime session — at-wake
 * recycle, session/full reset, and first start after creation. Resumed
 * sessions never get it: their transcript already carries an earlier read and
 * re-injecting would duplicate content into a cached prefix.
 *
 * Rationale: MEMORY.md is the one workspace file every session needs
 * (standing prompt step 2: use this block when it is there, else read the
 * file), so pushing it saves a guaranteed round trip and removes the
 * compliance risk of the agent skipping the read. The injected view is capped; the file itself is never truncated.
 *
 * The footer reports size facts ONLY (what the file weighs, how much is
 * shown). Growth back-pressure deliberately lives elsewhere — the CLI guide's
 * 16KB target and the Cleaner app's idle-time hint — so a wake never steers
 * the agent into housekeeping ahead of the pending request.
 */

export { RECOMMENDED_MEMORY_MD_BYTES };
const DEFAULT_BLOCK_BUDGET_TOKENS = STARTUP_MEMORY_BLOCK_BUDGET_TOKENS;

export interface StartupMemoryBlockConfig {
  enabled: boolean;
  budgetTokens: number;
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "on") return true;
  if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "") return false;
  return undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Same knob semantics as the wake-recycle family: the block is on by default
 * (the `constructed_wake_context` server flag was retired on 2026-10-23 and
 * `AgentConfig.constructedWakeContext` is no longer read here); per-agent
 * `agents.env_vars` beat daemon process env, and RAFT_STARTUP_MEMORY_BLOCK=0
 * stays the local per-machine (or per-agent) off switch. */
export function resolveStartupMemoryBlockConfig(
  agentEnvVars: Record<string, string> | null | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): StartupMemoryBlockConfig {
  const pick = (key: string): string | undefined => agentEnvVars?.[key] ?? processEnv[key];
  return {
    enabled: parseBooleanFlag(pick("RAFT_STARTUP_MEMORY_BLOCK")) !== false,
    budgetTokens: parsePositiveInteger(pick("RAFT_STARTUP_MEMORY_BLOCK_TOKENS")) ?? DEFAULT_BLOCK_BUDGET_TOKENS,
  };
}

function approxTokens(text: string): number {
  return Math.max(1, Math.floor((text.length + 3) / 4));
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** Cut a UTF-8 head of at most maxBytes without splitting a code point, and
 * prefer ending on a line boundary when one is reasonably close. */
function headOf(content: string, maxBytes: number): string {
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length <= maxBytes) return content;
  let head = buffer.subarray(0, maxBytes).toString("utf8");
  if (head.endsWith("�")) head = head.slice(0, -1);
  const lastNewline = head.lastIndexOf("\n");
  if (lastNewline > head.length * 0.8) head = head.slice(0, lastNewline);
  return head;
}

/** Blank-line break between composed wake-input sections (briefing chrome,
 * memory block, constructed panel, ladder prompt). */
export const WAKE_SECTION_BREAK: AxSurfaceText = axSurfaceLiteral(
  "Blank-line separator between composed wake-input sections",
  "\n\n",
);

export const formatStartupMemoryBlock = axSurface(
  "Startup memory block: the head of the agent's MEMORY.md injected into the first input of a fresh session as an XML-delimited section whose attributes carry the size facts",
  (input: { content: string; sizeBytes: number; budgetTokens: number }): string => {
    const head = headOf(input.content, input.budgetTokens * APPROX_PROMPT_BYTES_PER_TOKEN);
    const shownBytes = Buffer.byteLength(head, "utf8");
    const truncated = shownBytes < input.sizeBytes;

    // XML section boundary: the body IS markdown (MEMORY.md), so a markdown
    // heading cannot delimit it unambiguously. Facts only, as attributes —
    // growth guidance lives in the CLI guide and the Cleaner's idle-time hint.
    const attrs = truncated
      ? `size="${kb(input.sizeBytes)}" tokens="~${approxTokens(input.content)}" shown="first ${kb(shownBytes)}" note="read the file for the rest"`
      : `size="${kb(input.sizeBytes)}" complete="true" note="no need to re-read MEMORY.md unless you change it"`;
    return [`<memory-index file="MEMORY.md" ${attrs}>`, head.trimEnd(), "</memory-index>"].join("\n");
  },
  {
    examples: [{
      title: "small index injected in full",
      args: [{ content: "# Memory\n- [note](notes/a.md)\n", sizeBytes: 30, budgetTokens: 4_000 }],
    }],
  },
);

/**
 * Read MEMORY.md and render the block, or null when it is missing, empty, or
 * unreadable (callers proceed without it — injection must never block a start).
 */
export async function buildStartupMemoryBlock(args: {
  workspacePath: string;
  budgetTokens?: number;
}): Promise<AxSurfaceText | null> {
  const budgetTokens = args.budgetTokens ?? DEFAULT_BLOCK_BUDGET_TOKENS;
  const filePath = path.join(args.workspacePath, "MEMORY.md");
  let content: string;
  let sizeBytes: number;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    sizeBytes = info.size;
    content = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  if (content.trim().length === 0) return null;
  return formatStartupMemoryBlock({ content, sizeBytes, budgetTokens });
}

/** Prepend the block to the ladder-selected startup prompt, mirroring
 * applyWakeRecycleBriefing so the call site stays one line. */
export function applyStartupMemoryBlock(
  block: AxSurfaceText | null,
  prompt: AxSurfaceText,
  promptSource: string,
): { prompt: AxSurfaceText; promptSource: string } {
  if (!block) return { prompt, promptSource };
  return { prompt: composeAxSurfaces(block, WAKE_SECTION_BREAK, prompt), promptSource: `${promptSource}_with_memory` };
}
