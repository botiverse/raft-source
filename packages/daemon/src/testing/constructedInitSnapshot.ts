// Constructed-init baseline snapshots (plan oar39 §E, PR S0): what each host
// hands a runtime at session start, per runtime and scenario, so a refactor
// of constructed initialization can prove byte-identical agent-visible
// output. Each case file records the prompt source, the standing prompt (the
// host's shared `standing-prompt.md`, plus a lossless patch when the case's
// differs), the carrier that takes it to the runtime, and the full first
// input, where the case's standing prompt is written as STANDING_PROMPT_TOKEN.
// No hash of the prompt appears in a case file: a wording change to the
// standing prompt rewrites only `standing-prompt.md` (and a case whose patch
// itself changes). Used by agentProcessManager.constructedInit.snapshot.test.ts
// and agentHost/oarAgentHost.constructedInit.snapshot.test.ts. Must not import
// the AgentProcessManager module (daemon-runtime-boundaries).
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { applyPatch, createTwoFilesPatch } from "diff";

/** Fixed wall clock for every case (also the base of fixture timestamps). */
export const CONSTRUCTED_INIT_NOW_MS = Date.parse("2026-10-01T12:00:00.000Z");

/** Stands for the case's standing prompt (its `## standing prompt` section) wherever it occurs exactly. */
export const STANDING_PROMPT_TOKEN = "\u27EASTANDING_PROMPT\u27EB";

/**
 * Replaces the given paths (the harness's own temp data dir and the agent
 * workspace in it) with placeholders, on path boundaries only: the value must
 * not be followed by more of a path segment. Snapshots must not depend on the
 * host or its temp dir. Nothing machine-wide (tmpdir, home, the node binary)
 * is listed: none occurs in the output, and a literal `/tmp` in copy must
 * stay as written on every machine.
 */
export function makeNormalizer(paths: Array<[placeholder: string, value: string]>): (text: string) => string {
  const ordered = paths.filter(([, value]) => value.length > 0).sort((a, b) => b[1].length - a[1].length);
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (text) => {
    let out = text;
    for (const [placeholder, value] of ordered) out = out.replace(new RegExp(`${escape(value)}(?![\\w.-])`, "g"), placeholder);
    return out;
  };
}

export const sha = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;

export interface ConstructedInitCase {
  host: "legacy" | "oar";
  runtime: string;
  scenario: string;
  /** Free-form lines recorded above the sections (driver flags, known divergences). */
  notes?: string[];
  promptSource: string | null;
  /** Normalized standing prompt the host handed the runtime; null when no runtime was started. */
  standingPrompt: string | null;
  /** Normalized shared standing prompt of this host (`standing-prompt.md`). */
  basePrompt: string;
  /** Carrier fields, normalized; `undefined` is recorded as absent. */
  carrier: Array<[label: string, value: string | undefined]>;
  /** The full first input sent to the runtime, normalized; null when no runtime was started. */
  firstInput: string | null;
}

/** `= standing prompt` when equal, else the value in full. */
export function carrierValue(value: string | undefined, standingPrompt: string | null): string {
  if (value === undefined) return "(absent)";
  if (standingPrompt !== null && value === standingPrompt) return "= standing prompt";
  return `\n${value}`;
}

function standingPromptSection(prompt: string | null, base: string): string {
  if (prompt === null) return "(none: no runtime started)";
  if (prompt === base) return "= standing-prompt.md";
  const patch = createTwoFilesPatch("standing-prompt.md", "this-case", base, prompt, undefined, undefined, { context: 0 });
  // The patch must rebuild the exact prompt, or the snapshot would lose bytes.
  if (applyPatch(base, patch) !== prompt) throw new Error("standing prompt patch is not lossless");
  return `= standing-prompt.md with:\n${patch}`;
}

/**
 * The first input with every exact occurrence of the case's standing prompt
 * replaced by STANDING_PROMPT_TOKEN, so a file stays readable and a prompt
 * wording change does not touch it. Throws unless expanding the token gives
 * back the original input byte for byte; checked on every run.
 */
export function withStandingPromptToken(firstInput: string, standingPrompt: string | null): { text: string; replaced: boolean } {
  if (firstInput.includes(STANDING_PROMPT_TOKEN)) throw new Error("first input already contains the standing prompt token");
  if (!standingPrompt || !firstInput.includes(standingPrompt)) return { text: firstInput, replaced: false };
  const text = firstInput.split(standingPrompt).join(STANDING_PROMPT_TOKEN);
  if (text.split(STANDING_PROMPT_TOKEN).join(standingPrompt) !== firstInput) throw new Error("standing prompt token is not lossless");
  return { text, replaced: true };
}

export function renderConstructedInitCase(c: ConstructedInitCase): string {
  const lines = [
    `host: ${c.host}`,
    `runtime: ${c.runtime}`,
    `scenario: ${c.scenario}`,
    `promptSource: ${c.promptSource ?? "(none)"}`,
    ...(c.notes ?? []).map((note) => `note: ${note}`),
    "",
    "## standing prompt",
    standingPromptSection(c.standingPrompt, c.basePrompt),
    "",
    "## carrier",
    ...c.carrier.map(([label, value]) => {
      const shown = carrierValue(value, c.standingPrompt);
      return shown.startsWith("\n") ? `${label}:${shown}` : `${label}: ${shown}`;
    }),
    "",
  ];
  if (c.firstInput === null) {
    lines.push("## first input", "(no runtime started)", "");
  } else {
    const shown = withStandingPromptToken(c.firstInput, c.standingPrompt);
    const contains = shown.replaced ? `the standing prompt written as ${STANDING_PROMPT_TOKEN}` : "does not contain the standing prompt";
    // Length and hash of the text as written (token in place): stable across prompt wording changes, lossless through the token.
    lines.push(`## first input (${shown.text.length} chars, ${sha(shown.text)}, ${contains})`, shown.text, "");
  }
  return lines.join("\n");
}

export function constructedInitSnapshotPath(host: string, runtime: string, scenario: string): string {
  return `./__snapshots__/constructedInit/${host}/${runtime}/${scenario}.txt`;
}

/** The agent identity both hosts' cases start (merged into each harness's own config fixture). */
export const CONSTRUCTED_INIT_IDENTITY = { name: "alice", displayName: "Alice", description: "Keeps the release notes", serverUrl: "https://raft.example.test" } as const;

/** The message that wakes a start, on both hosts. */
export const CONSTRUCTED_INIT_WAKE_MESSAGE = {
  message_id: "wake-1", channel_id: "channel-1", channel_name: "general", channel_type: "channel",
  sender_id: "human-1", sender_name: "bob", sender_type: "human",
  content: "Can you check the deploy notes?", timestamp: "2026-10-01T11:58:00.000Z",
} as const;

/** A user-written MEMORY.md (the workspace seed writes its own otherwise). */
export const CONSTRUCTED_INIT_MEMORY_MD = "# Notes\n\n- Release train: Thursdays.\n- [deploy runbook](notes/deploy.md)\n";

/**
 * Files under a host's snapshot directory that no case writes: a case dropped
 * from a test must not leave its file behind. (A missing file fails its own
 * case in CI.) Written files may land only when the run ends, so a first local
 * run sees an empty or partial directory, never a stale one.
 */
export function staleConstructedInitSnapshotFiles(dir: string, expected: readonly string[]): string[] {
  if (!existsSync(dir)) return [];
  const wanted = new Set(expected);
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .filter((file) => !wanted.has(file))
    .sort();
}
