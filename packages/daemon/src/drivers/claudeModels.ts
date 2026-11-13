import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ListModelsResult, ModelEntry, ModelLister } from "@botiverse/oar";
import {
  getStaticRuntimeModelSourceSet,
  type RuntimeModelInfo,
  type RuntimeModelSet,
  type RuntimeModelSourceOutcome,
} from "@botiverse/raft-shared";

import { loadOarRuntime } from "../oarLoader";
import { detectModelSourceViaOar } from "../runtimeModels/oarListModels";
import { resolveClaudeCommandAsync } from "./claudeLaunch";

/** Claude answers `list_models` in a few seconds; stay under the server's 20 s per-detection budget. */
const CLAUDE_MODEL_DETECTION_DEADLINE_MS = 15_000;

/**
 * Claude Code's `default` entry means "no `--model`", which the form already
 * offers as inheriting the default; listing it would make a second, unverified
 * `--model default` launch.
 */
const CLAUDE_INHERIT_ENTRY_ID = "default";

function isAlias(entry: ModelEntry): boolean {
  return entry.resolvedId !== undefined && entry.resolvedId !== entry.id;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Claude lists aliases (`opus`, resolving to today's Opus) and only older
 * concrete IDs, so today's concrete IDs would disappear from the picker that
 * used to offer them. Each alias's resolved ID is added after the aliases, as a
 * pinnable entry with the alias's capabilities, unless Claude already lists it.
 */
export function expandClaudeModelEntries(entries: readonly ModelEntry[]): ModelEntry[] {
  const listed = entries.filter((entry) => entry.id !== CLAUDE_INHERIT_ENTRY_ID);
  const ids = new Set(listed.map((entry) => entry.id));
  const aliases = listed.filter(isAlias);
  const pinned: ModelEntry[] = [];
  for (const alias of aliases) {
    const id = alias.resolvedId!;
    if (ids.has(id)) continue;
    ids.add(id);
    pinned.push({ ...alias, id, resolvedId: id });
  }
  return [...aliases, ...pinned, ...listed.filter((entry) => !isAlias(entry))];
}

/** "Claude Opus (Opus 5.5)" for an alias, so the label says what it runs today; "Claude Opus 4.8" otherwise. */
export function claudeModelLabel(entry: ModelEntry): string {
  const name = entry.displayName ?? entry.id;
  return isAlias(entry) ? `Claude ${titleCase(entry.id)} (${name})` : `Claude ${name}`;
}

/**
 * Claude reads project settings (hooks, MCP servers) from its cwd, so each
 * listing runs in a fresh private directory (mkdtemp, mode 0700) rather than
 * the daemon's cwd or a fixed shared path another user could pre-create, and
 * removes it afterwards.
 */
function expandingLister(listModels: ModelLister): ModelLister {
  return async (installation, options): Promise<ListModelsResult> => {
    let cwd: string | undefined;
    try {
      cwd = mkdtempSync(path.join(os.tmpdir(), "raft-claude-models-"));
    } catch {
      cwd = undefined;
    }
    try {
      const result = await listModels(installation, { ...options, ...(cwd ? { cwd } : {}) });
      return result.kind === "ok" ? { ...result, models: expandClaudeModelEntries(result.models) } : result;
    } finally {
      if (cwd) rmSync(cwd, { recursive: true, force: true });
    }
  };
}

let claudeLister: ModelLister | null = null;

/** One lister instance, so concurrent detections join one running listing (see `detectModelSourceViaOar`). */
async function claudeModelLister(): Promise<ModelLister> {
  if (claudeLister) return claudeLister;
  const { listModels } = await loadOarRuntime("claude");
  if (!listModels) throw new Error("OAR's claude runtime has no model listing");
  claudeLister = expandingLister(listModels);
  return claudeLister;
}

/**
 * Lists the models this machine's Claude Code offers through OAR's
 * `listModels` (Claude's `list_models` control request, no tokens spent).
 *
 * Claude's bundled catalog is its declared source, so any outcome other than a
 * live list (no claude on PATH, not logged in, timeout, an older claude without
 * `list_models`) answers with that catalog, exactly as before this detection
 * existed. The listing runs the host's default `claude`; an agent's configured
 * command or custom provider is not consulted, as it was not for the catalog.
 */
export async function detectClaudeModelSource(
  deps: {
    /** OAR's raw Claude lister; tests pass a fake. */
    listModels?: ModelLister;
    resolveCommand?: () => Promise<string | null>;
    deadlineMs?: number;
  } = {},
): Promise<RuntimeModelSourceOutcome> {
  const bundled = getStaticRuntimeModelSourceSet("claude");
  const fallback: RuntimeModelSourceOutcome = bundled ? { kind: "live", value: bundled } : { kind: "unsupported" };
  let outcome: RuntimeModelSourceOutcome;
  try {
    const command = await (deps.resolveCommand ?? (() => resolveClaudeCommandAsync()))();
    if (!command) return fallback;
    outcome = await detectModelSourceViaOar({
      lister: deps.listModels ? expandingLister(deps.listModels) : await claudeModelLister(),
      installation: { kind: "available", via: "executable", command },
      deadlineMs: deps.deadlineMs ?? CLAUDE_MODEL_DETECTION_DEADLINE_MS,
      label: claudeModelLabel,
      // buildClaudeArgs passes the chosen effort as `--effort`.
      keepReasoningEfforts: true,
      onUnsupported: () => ({ kind: "unsupported" }),
    });
  } catch {
    return fallback;
  }
  if (outcome.kind !== "live") return fallback;
  return bundled ? { kind: "live", value: keepBundledEfforts(outcome.value, bundled) } : outcome;
}

/**
 * Agents saved against the bundled list may hold an effort Claude does not
 * report for that model (the bundled list offers `xhigh` on Opus/Sonnet 4.6,
 * which Claude runs as `high`). The server refuses a submitted effort the live
 * option lacks, so such an agent could no longer be saved. A model the bundled
 * list also offers keeps the bundled efforts alongside Claude's, in the
 * bundled order.
 */
function keepBundledEfforts(live: RuntimeModelSet, bundled: RuntimeModelSet): RuntimeModelSet {
  const bundledById = new Map(bundled.models.map((model) => [model.id, model]));
  const bundledOrder = [...new Set(bundled.models.flatMap((model) => model.supportedReasoningEfforts ?? []))];
  const order = (effort: string) => {
    const index = bundledOrder.indexOf(effort);
    return index < 0 ? bundledOrder.length : index;
  };
  return {
    ...live,
    models: live.models.map((model): RuntimeModelInfo => {
      const extra = bundledById.get(model.id)?.supportedReasoningEfforts ?? [];
      const own = model.supportedReasoningEfforts ?? [];
      if (extra.every((effort) => own.includes(effort))) return model;
      const merged = [...new Set([...own, ...extra])].sort((a, b) => order(a) - order(b));
      return { ...model, supportedReasoningEfforts: merged };
    }),
  };
}
