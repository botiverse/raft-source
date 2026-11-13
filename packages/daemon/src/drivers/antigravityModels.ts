import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ListModelsResult, ModelEntry, ModelLister } from "@botiverse/oar";
import type { RuntimeModelSourceOutcome } from "@botiverse/raft-shared";

import { loadOarRuntime } from "../oarLoader";
import { detectModelSourceViaOar } from "../runtimeModels/oarListModels";
import { ANTIGRAVITY_ENV_OVERRIDES, resolveAntigravitySpawn } from "./index";
import { resolveCommandOnPathAsync } from "./probe";

// OAR opens a temporary `agy` ACP session (no prompt) and reads its model
// picker; keep below the server's 20 s per-detection budget.
const ANTIGRAVITY_MODEL_DETECTION_DEADLINE_MS = 18_000;

/**
 * The listing's environment: what a launch removes (`agy` picks a separate
 * token store under SSH, ANTIGRAVITY_ENV_OVERRIDES), so it reads the same
 * sign-in an agent will run on.
 */
function listingEnv(): Record<string, string | null> {
  // A function, not a module constant: this module and the driver import each other.
  return { NO_COLOR: "1", ...Object.fromEntries(Object.keys(ANTIGRAVITY_ENV_OVERRIDES).map((name) => [name, null])) };
}

/**
 * agy builds can name the thought level in the model id itself
 * (`gemini-4-carbon-medium`, one id per level). An entry whose id already ends
 * in one of its listed levels keeps no effort menu, so the form never offers
 * the same choice twice (the model picker already holds it).
 */
export function withoutEmbeddedEffortLevels(entries: readonly ModelEntry[]): ModelEntry[] {
  return entries.map((entry) => {
    const levels = entry.effortLevels ?? [];
    if (!levels.some((level) => entry.id.toLowerCase().endsWith(`-${level.toLowerCase()}`))) return entry;
    const { effortLevels: _levels, defaultEffort: _default, ...rest } = entry;
    return rest;
  });
}

/**
 * `agy` reads workspace configuration (`.agents/`) from its cwd, so each
 * listing runs in a fresh private directory rather than the daemon's cwd, and
 * removes it afterwards (as Claude's listing does).
 */
function privateDirLister(listModels: ModelLister): ModelLister {
  return async (installation, options): Promise<ListModelsResult> => {
    let cwd: string | undefined;
    try {
      cwd = mkdtempSync(path.join(os.tmpdir(), "raft-antigravity-models-"));
    } catch {
      cwd = undefined;
    }
    try {
      const result = await listModels(installation, { ...options, env: { ...options?.env, ...listingEnv() }, ...(cwd ? { cwd } : {}) });
      return result.kind === "ok" ? { ...result, models: withoutEmbeddedEffortLevels(result.models) } : result;
    } finally {
      if (cwd) rmSync(cwd, { recursive: true, force: true });
    }
  };
}

let antigravityLister: ModelLister | null = null;

/** One lister instance, so concurrent detections join one running listing (see `detectModelSourceViaOar`). */
async function antigravityModelLister(): Promise<ModelLister> {
  if (antigravityLister) return antigravityLister;
  const { listModels } = await loadOarRuntime("antigravity");
  if (!listModels) throw new Error("OAR's antigravity runtime has no model listing");
  antigravityLister = privateDirLister(listModels);
  return antigravityLister;
}

/**
 * The models this machine's `agy` login offers, through OAR's `listModels`.
 * agy reports a thinking-level menu only for the model a new session starts
 * on (OAR `projectAntigravityModels`), so only that entry carries efforts; it
 * is also reported as the set's default. The OAR launch passes the chosen
 * model and effort (agentHost/oarAntigravityLaunch.ts).
 */
export async function detectAntigravityModelSource(
  deps: {
    /** OAR's raw Antigravity lister; tests pass a fake. */
    listModels?: ModelLister;
    resolveCommand?: () => Promise<string | null>;
    deadlineMs?: number;
  } = {},
): Promise<RuntimeModelSourceOutcome> {
  const command = await (deps.resolveCommand ?? (async () => (await resolveCommandOnPathAsync("agy")) ? resolveAntigravitySpawn([]).command : null))();
  if (!command) return { kind: "error", retryable: true, code: "runtime_not_found" };
  let lister: ModelLister;
  try {
    lister = deps.listModels ? privateDirLister(deps.listModels) : await antigravityModelLister();
  } catch {
    return { kind: "error", retryable: false, code: "detect_failed" };
  }
  return detectModelSourceViaOar({
    lister,
    installation: { kind: "available", via: "executable", command },
    deadlineMs: deps.deadlineMs ?? ANTIGRAVITY_MODEL_DETECTION_DEADLINE_MS,
    label: (entry: ModelEntry) => entry.displayName ?? entry.id,
    keepReasoningEfforts: true,
    reportDefault: true,
    // An agy build whose session/new has no model option: the form keeps
    // its configured-default entry.
    onUnsupported: () => ({ kind: "unsupported" }),
  });
}
