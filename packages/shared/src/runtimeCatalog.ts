// Runtime catalog: the runtime ids Raft knows, their display names, and the
// external-agent runtime. Kept dependency-light on purpose: the CLI and the SDK
// render runtime labels in agent-facing text (profile cards), and the SDK must
// not pull the whole shared root index into its bundle to do so. The root
// index re-exports everything here, so existing imports are unchanged.

export const EXTERNAL_AGENT_RUNTIME_ID = "external" as const;
export const EXTERNAL_AGENT_RUNTIME_MODEL = "external" as const;
export const EXTERNAL_AGENT_RUNTIME_DISPLAY_NAME = "External agent" as const;

export function isExternalAgentRuntime(runtime: string | null | undefined): boolean {
  return runtime === EXTERNAL_AGENT_RUNTIME_ID;
}

export interface RuntimeInfo {
  /** Short ID used in DB, protocol, and config (e.g. "claude") */
  id: string;
  /** Human-readable name (e.g. "Claude Code") */
  displayName: string;
  /** Stable, designed short label for compact runtime icons (e.g. "CC") */
  abbreviation: string;
  /** CLI binary name to detect on PATH (e.g. "claude") */
  binary: string;
  /** Whether this runtime is currently supported */
  supported: boolean;
  /** Deprecated runtimes are hidden from selectors + detection display, but kept for backward compat with existing agents on that runtime. */
  deprecated?: boolean;
  /** Experimental runtimes can be used but are marked as such wherever a runtime is named: not yet run end to end on a real account in Raft. */
  experimental?: boolean;
}

export const RUNTIMES: RuntimeInfo[] = [
  { id: "claude", displayName: "Claude Code", abbreviation: "CC", binary: "claude", supported: true },
  { id: "codex", displayName: "Codex CLI", abbreviation: "CX", binary: "codex", supported: true },
  { id: "grok", displayName: "Grok Build", abbreviation: "GK", binary: "grok", supported: true },
  { id: "builtin", displayName: "Built-in Pi", abbreviation: "BP", binary: "", supported: true },
  { id: "antigravity", displayName: "Antigravity CLI", abbreviation: "AG", binary: "agy", supported: true, deprecated: true },
  // Kimi: prefer the in-process SDK (`kimi-sdk` → "Kimi Code") for new agents.
  // The legacy `kimi` (kimi-cli child-process) entry stays for backward compat
  // with existing `runtime=kimi` agents but is labelled deprecated.
  { id: "kimi-sdk", displayName: "Kimi Code", abbreviation: "KC", binary: "", supported: true },
  { id: "kimi", displayName: "Kimi CLI", abbreviation: "KL", binary: "kimi", supported: true, deprecated: true },
  // Copilot CLI: deprecated for new agents. Kept for backward compat with
  // existing `runtime=copilot` agents (they keep launching and stay editable)
  // but hidden from create/switch/setup selectors and detection display.
  { id: "copilot", displayName: "Copilot CLI", abbreviation: "CP", binary: "copilot", supported: true, deprecated: true },
  { id: "cursor", displayName: "Cursor CLI", abbreviation: "CU", binary: "cursor-agent", supported: true },
  // Gemini CLI: deprecated — no longer maintained upstream, replaced by
  // Antigravity CLI (`antigravity` → "Antigravity CLI"). Kept for backward
  // compat with existing `runtime=gemini` agents but hidden from selectors.
  { id: "gemini", displayName: "Gemini CLI", abbreviation: "GM", binary: "gemini", supported: true, deprecated: true },
  { id: "opencode", displayName: "OpenCode", abbreviation: "OC", binary: "opencode", supported: true },
  { id: "pi", displayName: "Pi", abbreviation: "PI", binary: "pi", supported: true },
  // Run only on the Computer's OAR host (daemon drivers/oarOnly.ts). Creating or
  // switching an agent to them also needs the server's per-runtime flag
  // (`agent_runtime_oar_<id>`) and a Computer that reports the runtime.
  { id: "qwen", displayName: "Qwen Code", abbreviation: "QW", binary: "qwen", supported: true, experimental: true },
  { id: "qoder", displayName: "Qoder", abbreviation: "QD", binary: "qodercli", supported: true, experimental: true },
];

/** Runtimes that run only on the Computer's OAR host: there is no legacy driver to fall back to. */
export const OAR_ONLY_RUNTIME_IDS: readonly string[] = ["qwen", "qoder"];

/**
 * Runtimes whose own telemetry the daemon folds into per-turn token counts:
 * the `token_usage` sources in packages/daemon/src/runtimeTurnTokens.ts
 * (`noteTurnTokenUsage`'s fold branches, mapped to runtimes in
 * `TURN_TOKEN_USAGE_SOURCE_RUNTIMES`). A daemon test keeps the two equal.
 */
export const RUNTIMES_REPORTING_TURN_TOKENS_FROM_TELEMETRY: readonly string[] = ["claude", "codex", "pi", "builtin", "kimi-sdk"];

/**
 * Runtimes whose turn tokens come from the OAR host's `usage` events
 * (`trace.noteUsage` in packages/daemon/src/agentHost/oarAgentHost.ts) because
 * they run only on the OAR host (OAR_ONLY_RUNTIME_IDS) and emit `usage`.
 */
export const RUNTIMES_REPORTING_TURN_TOKENS_FROM_OAR_USAGE: readonly string[] = ["qwen", "qoder"];

/**
 * Runtimes whose finished turns carry token counts, counted by the host the
 * runtime actually runs on; for any other runtime a turn summary carries at
 * most `tokens.model`, so "no usage yet" never resolves. Not reporting:
 * antigravity, grok, opencode, cursor (its OAR flag is off by default and the
 * legacy driver does not fold its tokens; add it here if Cursor moves fully to
 * the OAR host), and the deprecated kimi, gemini and copilot. Grok can also
 * run on OAR behind a per-server flag (off by default); grok's OAR session may
 * emit `usage`, so revisit grok here if its OAR route becomes the default.
 * OpenCode stays off on the OAR host too (`agent_runtime_oar_opencode`): its
 * context use shows from OAR's `usage` context events, as for the other OAR
 * runtimes, but per-turn token totals are not offered for it (agreed with the
 * OAR maintainer for the move); do not add it here without revisiting that.
 * Antigravity runs on OAR for every server (`agent_runtime_oar_antigravity`
 * has been on everywhere since 2026-11-13), but its OAR session does not emit
 * `usage` yet; add it here once it does.
 */
export const RUNTIMES_REPORTING_TURN_TOKENS: readonly string[] = [
  ...RUNTIMES_REPORTING_TURN_TOKENS_FROM_TELEMETRY,
  ...RUNTIMES_REPORTING_TURN_TOKENS_FROM_OAR_USAGE,
];

export function runtimeReportsTurnTokens(runtime: string | null | undefined): boolean {
  return typeof runtime === "string" && RUNTIMES_REPORTING_TURN_TOKENS.includes(runtime);
}

/**
 * Runtimes whose agents can start sub-agents that Activity lists: Claude Code,
 * Codex and Kimi Code report them from their own events (daemon
 * claudeEventNormalizer, codexEventNormalizer, drivers/kimi-sdk), Qwen Code and
 * Qoder as OAR tasks of type `agent` (agentHost/oarTaskActivity). Grok reports
 * them only on its OAR route, behind a per-server flag that is off by default:
 * add it here when that route is the default. An agent of one of these shows
 * the Sub-agents view at all times, with 0 when it has none (stdrc, 2026-11-14).
 */
export const RUNTIMES_WITH_SUBAGENTS: readonly string[] = ["claude", "codex", "kimi-sdk", "qwen", "qoder"];

export function runtimeHasSubagents(runtime: string | null | undefined): boolean {
  return typeof runtime === "string" && RUNTIMES_WITH_SUBAGENTS.includes(runtime);
}

export function isOarOnlyRuntime(runtime: string | null | undefined): boolean {
  return typeof runtime === "string" && OAR_ONLY_RUNTIME_IDS.includes(runtime);
}

/**
 * Label suffix for a runtime in a machine's runtime picker. A runtime is offered
 * only when the daemon reports it in `machineRuntimeIds` (its capability list) —
 * that gating is intentional: a runtime the daemon can't run must not be
 * selectable. This helper only chooses the *wording* for an unavailable one:
 *
 * - unsupported → " (coming soon)"
 * - in-process runtime (`binary === ""`, e.g. Built-in, Kimi Code) that the
 *   daemon doesn't report → " (update Raft Computer)": there is nothing to install
 *   locally; the daemon/computer simply predates the runtime, so "(not
 *   installed)" would be misleading.
 * - local CLI runtime (`binary !== ""`) the daemon didn't detect → " (not installed)"
 * - available → "" (no suffix)
 */
export type RuntimeAvailabilitySuffix =
  | { kind: "none" }
  | { kind: "comingSoon" }
  | { kind: "updateComputer" }
  | { kind: "notInstalled" };

/**
 * Locale-free runtime availability classifier (the machineRunLabel pattern):
 * returns a KIND, never display text. Web consumers map the kind to a catalog
 * id so the zh UI renders （未安装）/（需更新计算机）instead of the old hardcoded
 * English suffixes (" (not installed)" etc.).
 */
export function runtimeAvailabilitySuffix(r: RuntimeInfo, machineRuntimeIds: readonly string[]): RuntimeAvailabilitySuffix {
  if (!r.supported) return { kind: "comingSoon" };
  if (machineRuntimeIds.includes(r.id)) return { kind: "none" };
  return r.binary === "" ? { kind: "updateComputer" } : { kind: "notInstalled" };
}

export function isRuntimeDeprecated(runtimeId: string): boolean {
  return RUNTIMES.some((runtime) => runtime.id === runtimeId && Boolean(runtime.deprecated));
}

export function isRuntimeExperimental(runtimeId: string): boolean {
  return RUNTIMES.some((runtime) => runtime.id === runtimeId && Boolean(runtime.experimental));
}

export function isRuntimeSelectableForNewAgent(runtime: RuntimeInfo): boolean {
  return runtime.supported && !runtime.deprecated;
}

export function getCreatableRuntimeOptions(): RuntimeInfo[] {
  return RUNTIMES.filter(isRuntimeSelectableForNewAgent);
}

export function isRuntimeVisibleForExistingAgent(runtime: RuntimeInfo, currentRuntime: string): boolean {
  return !runtime.deprecated || runtime.id === currentRuntime;
}

export function getExistingAgentRuntimeOptions(currentRuntime: string): RuntimeInfo[] {
  return RUNTIMES.filter((runtime) => isRuntimeVisibleForExistingAgent(runtime, currentRuntime));
}

/** Server setup offers neither Built-in nor the per-server preview runtimes (OAR-only). */
export function isRuntimeSetupCandidate(runtime: RuntimeInfo): boolean {
  return runtime.supported && !runtime.deprecated && runtime.id !== "builtin" && !isOarOnlyRuntime(runtime.id);
}

export function getSetupRuntimeOptions(): RuntimeInfo[] {
  return RUNTIMES.filter(isRuntimeSetupCandidate);
}

export function getMachineRuntimeDisplayOptions(): RuntimeInfo[] {
  return RUNTIMES.filter((runtime) => runtime.supported && !runtime.deprecated);
}

/**
 * The bundled entry for a runtime id, to name a runtime a server already
 * listed (its runtime-options rows, its catalog). Whether a runtime is offered
 * on a server is that server's answer, never this catalog's `deprecated`.
 */
export function getRuntimeInfo(id: string): RuntimeInfo | undefined {
  return RUNTIMES.find((runtime) => runtime.id === id);
}

/** Map runtime ID → display name. Falls back to the ID itself. */
export function getRuntimeDisplayName(id: string): string {
  if (isExternalAgentRuntime(id)) return EXTERNAL_AGENT_RUNTIME_DISPLAY_NAME;
  return RUNTIMES.find((r) => r.id === id)?.displayName ?? id;
}
