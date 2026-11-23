import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ListModelsResult, ModelEntry, ModelLister } from "@botiverse/oar";
import type { RuntimeModelSourceOutcome } from "@botiverse/raft-shared";

import { loadOarRuntime } from "../oarLoader";
import { detectModelSourceViaOar } from "../runtimeModels/oarListModels";
import { ANTIGRAVITY_ENV_OVERRIDES, resolveAntigravitySpawn } from "./index";
import { resolveCommandOnPathAsync } from "./probe";

// OAR opens a temporary `agy` ACP session (no prompt), reads its model picker
// and, from OAR 0.115, selects each model to read its own effort menu, then
// restores the original model and effort (a listing that cannot confirm the
// restore throws: a transient failure that keeps the cached list). About 2 s on
// agy 1.5.10; keep below the server's 20 s per-detection budget. Each listing
// leaves an agy conversation record, so the form cache keeps the list for a
// day (RUNTIME_MODEL_CACHE_FRESH_MS_BY_RUNTIME).
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
 * OAR >= 0.111's agy lister gives an entry no `effortLevels` and no
 * `effortUnavailableReason` only when agy has no effort menu for that model
 * (it lists the model bare, or exposes no levels at all); one it could not
 * read carries the reason. So such an entry takes no effort: mark it with an
 * explicit `[]`, which the projection reports as "none"
 * (`keepEmptyEffortLevels`). An entry whose id names its level keeps no menu
 * and stays unmarked: the model picker holds that choice.
 */
export function withAntigravityEffortLevels(entries: readonly ModelEntry[]): ModelEntry[] {
  return entries.map((entry) => {
    const [stripped] = withoutEmbeddedEffortLevels([entry]);
    if (stripped !== entry) return stripped!;
    if (entry.effortLevels !== undefined || entry.effortUnavailableReason) return entry;
    return { ...entry, effortLevels: [] };
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
      return result.kind === "ok" ? { ...result, models: withAntigravityEffortLevels(result.models) } : result;
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
 * agy's session reports a thinking-level menu for the model it starts on;
 * OAR (>= 0.111) reads the other models' menus from agy's catalog, and says
 * why when it cannot (`reasoningEffortUnavailableReason`). A model with no
 * menu is reported with an empty one (withAntigravityEffortLevels). The
 * session's model is also reported as the set's default. The OAR launch passes the chosen
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
    keepEmptyEffortLevels: true,
    reportDefault: true,
    // An agy build whose session/new has no model option: the form keeps
    // its configured-default entry.
    onUnsupported: () => ({ kind: "unsupported" }),
  });
}
