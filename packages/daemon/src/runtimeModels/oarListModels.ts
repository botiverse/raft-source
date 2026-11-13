import type { AvailableInstallation, ListModelsResult, ModelEntry, ModelLister } from "@botiverse/oar";

import {
  clearClockTimeout,
  setClockTimeout,
  sanitizeRuntimeModelUnavailable,
  type RuntimeModelInfo,
  type RuntimeModelSourceOutcome,
  type RuntimeModelUnavailable,
} from "@botiverse/raft-shared";

/**
 * Reads a runtime's usable-now model list through OAR's `listModels` and
 * projects it onto the closed `RuntimeModelSourceOutcome` the server already
 * understands. The wire stays unchanged: OAR results map only onto existing
 * outcome kinds and error codes, never a new status (installed mobile apps
 * decode the status strictly).
 *
 *  - `ok` with models            → `live` (disabled entries ride along as
 *                                   `unavailable`, never in `models`)
 *  - `ok` with no models         → `no_models`
 *  - `unauthenticated`           → retryable `runtime_not_authenticated`
 *  - `unsupported`               → `onUnsupported` (the caller decides: for
 *                                   some runtimes OAR uses it for a transient
 *                                   state, not a structural absence)
 *  - our deadline fires first    → retryable `detect_timeout`
 *  - the lister throws           → retryable error with no code
 */
export interface OarModelSourceInput {
  readonly lister: ModelLister;
  readonly installation: AvailableInstallation;
  /** Our own deadline; a lister still running when it fires reports `detect_timeout`. */
  readonly deadlineMs: number;
  /** Passed to the lister. Keep it above `deadlineMs` so our deadline, not OAR's kill, decides. */
  readonly listerTimeoutMs?: number;
  /**
   * The label the form shows. Callers decide whether OAR's `displayName` is
   * enough: for provider-routed runtimes it omits the provider, so two
   * providers' copies of one model would read the same.
   */
  readonly label: (entry: ModelEntry) => string;
  /** Keep OAR's effort menu only when the runtime's launch path applies the chosen effort. */
  readonly keepReasoningEfforts: boolean;
  /**
   * Report the entry OAR marks `default` (the model a session uses with no
   * `model` set) as the set's `default`, so the form preselects it. Opt-in:
   * the other callers' forms keep their first-listed preselection.
   */
  readonly reportDefault?: boolean;
  readonly onUnsupported: (reason: string) => RuntimeModelSourceOutcome;
}

const DEADLINE = Symbol("deadline");

/**
 * The listing each lister is running right now. Our deadline only stops
 * waiting; the listing (and its process) runs on to the lister's own timeout.
 * A request in that window joins the running listing instead of starting a
 * second one, so one runtime never has two listings at once.
 *
 * Keyed by lister function, not by installation: correct while each lister
 * serves a single installation (OpenCode's `opencode`, Claude's host `claude`). A
 * lister serving several installations needs an installation-scoped key, or
 * one installation's request would join another's listing.
 */
const runningListings = new WeakMap<ModelLister, Promise<ListModelsResult>>();

function joinOrStartListing(input: OarModelSourceInput): Promise<ListModelsResult> {
  const running = runningListings.get(input.lister);
  if (running) return running;
  const started = input.lister(input.installation, { timeoutMs: input.listerTimeoutMs ?? input.deadlineMs + 5_000 });
  runningListings.set(input.lister, started);
  const clear = () => {
    if (runningListings.get(input.lister) === started) runningListings.delete(input.lister);
  };
  started.then(clear, clear);
  return started;
}

export async function detectModelSourceViaOar(input: OarModelSourceInput): Promise<RuntimeModelSourceOutcome> {
  let timer: unknown;
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    timer = setClockTimeout(() => resolve(DEADLINE), input.deadlineMs);
  });
  let result: ListModelsResult | typeof DEADLINE;
  try {
    result = await Promise.race([
      joinOrStartListing(input),
      deadline,
    ]);
  } catch {
    return { kind: "error", retryable: true };
  } finally {
    clearClockTimeout(timer);
  }
  if (result === DEADLINE) {
    return { kind: "error", retryable: true, code: "detect_timeout" };
  }
  switch (result.kind) {
    case "ok": {
      const models = projectOarModelEntries(result.models, input);
      const unavailable = projectOarUnavailableEntries(result.models, input, models);
      const defaultId = input.reportDefault ? result.models.find((entry) => entry.default)?.id : undefined;
      const reportedDefault = defaultId && models.some((model) => model.id === defaultId) ? defaultId : undefined;
      return models.length > 0
        ? { kind: "live", value: { models, ...(reportedDefault ? { default: reportedDefault } : {}), ...(unavailable ? { unavailable } : {}) } }
        : { kind: "no_models" };
    }
    case "unauthenticated":
      return { kind: "error", retryable: true, code: "runtime_not_authenticated" };
    case "unsupported":
      return input.onUnsupported(result.reason);
  }
}

export function projectOarModelEntries(
  entries: readonly ModelEntry[],
  options: Pick<OarModelSourceInput, "label" | "keepReasoningEfforts">,
): RuntimeModelInfo[] {
  const models: RuntimeModelInfo[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    // A listed-but-refused model is not launchable; offering it would fail at start.
    if (entry.disabled || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const efforts = options.keepReasoningEfforts && entry.effortLevels?.length ? [...entry.effortLevels] : undefined;
    models.push({
      id: entry.id,
      label: options.label(entry),
      ...(efforts ? { supportedReasoningEfforts: efforts } : {}),
      ...(efforts && entry.defaultEffort && efforts.includes(entry.defaultEffort)
        ? { defaultReasoningEffort: entry.defaultEffort }
        : {}),
      ...(entry.serviceTiers?.length ? { serviceTiers: [...entry.serviceTiers] } : {}),
      ...(entry.defaultServiceTier ? { defaultServiceTier: entry.defaultServiceTier } : {}),
      verified: "launchable",
    });
  }
  return models;
}

/**
 * The entries the runtime listed but disabled (`disabled.reason`, e.g. Claude
 * Code's "upgrade" or plan notes), as a separate list so the picker can say why
 * without offering them. Kept out of `models` for older clients, which offer
 * every entry there. An id also listed as usable is not repeated.
 */
export function projectOarUnavailableEntries(
  entries: readonly ModelEntry[],
  options: Pick<OarModelSourceInput, "label">,
  usable: readonly RuntimeModelInfo[],
): RuntimeModelUnavailable[] | undefined {
  const usableIds = new Set(usable.map((model) => model.id));
  return sanitizeRuntimeModelUnavailable(entries
    .filter((entry) => entry.disabled && !usableIds.has(entry.id))
    .map((entry) => ({ id: entry.id, label: options.label(entry), reason: entry.disabled!.reason })));
}
