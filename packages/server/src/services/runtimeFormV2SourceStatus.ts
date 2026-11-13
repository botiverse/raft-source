/**
 * `option_source.status` (packages/runtime-form README, "Protocol v2"): how the
 * server reports an option source whose list did not come from a live probe.
 *
 * Probe outcome → reason → retryable. This table is the contract's mapping
 * (contract `OptionSource.reason` / `retryable` docs); keep them in step.
 *
 * | Computer probe outcome                                   | reason          | retryable |
 * |----------------------------------------------------------|-----------------|-----------|
 * | live with at least one model                             | (status live)   | (absent)  |
 * | missing_config                                           | missing_config  | false     |
 * | no_models, or live with an empty list                    | no_models       | true      |
 * | unsupported                                              | unsupported     | false     |
 * | error with code detect_timeout                           | probe_timeout   | true      |
 * | server wait timed out (RouteFailureError daemon_timeout) | probe_timeout   | true      |
 * | error with code computer_offline                         | machine_offline | true      |
 * | Computer not routed here / RouteFailureError daemon_offline | machine_offline | true   |
 * | any other error outcome or thrown failure                | probe_failed    | true      |
 *
 * no_models is retryable because the user may add models on the Computer;
 * missing_config and unsupported need a change the form cannot make.
 *
 * `state` (additive, next to `status`; computerProbeCacheService), only when
 * the Computer did not answer in time: stale when the list is its last good
 * one (then `fallback` + probe_timeout, with `fetchedAt`); unavailable when
 * there is no earlier list (the resolver's probe_timeout answer above).
 */
import type {
  RuntimeFormV2OptionSourceReason,
  RuntimeFormV2OptionSourceStatus,
} from "@botiverse/raft-runtime-form";
import type { RuntimeModelSourceOutcome } from "@botiverse/raft-shared";

import { RouteFailureError } from "../tracing/routeFailure";
import type { ComputerProbeFreshness } from "./computerProbeCacheService";
import type { RuntimeFormV2OptionSourceBody } from "./runtimeFormV2Registry";

export const RUNTIME_FORM_V2_REASON_RETRYABLE: Readonly<Record<RuntimeFormV2OptionSourceReason, boolean>> = Object.freeze({
  probe_timeout: true,
  probe_failed: true,
  machine_offline: true,
  no_models: true,
  missing_config: false,
  unsupported: false,
});

/** The reason a probe outcome is not a usable live list; null when it is live with models. */
export function optionSourceReasonForOutcome(outcome: RuntimeModelSourceOutcome): RuntimeFormV2OptionSourceReason | null {
  switch (outcome.kind) {
    case "live": return outcome.value.models.length > 0 ? null : "no_models";
    case "missing_config": return "missing_config";
    case "no_models": return "no_models";
    case "unsupported": return "unsupported";
    case "error":
      if (outcome.code === "detect_timeout") return "probe_timeout";
      if (outcome.code === "computer_offline") return "machine_offline";
      return "probe_failed";
    default: return "probe_failed";
  }
}

/** The reason for a probe that threw instead of answering. */
export function optionSourceReasonForProbeError(error: unknown): RuntimeFormV2OptionSourceReason {
  if (error instanceof RouteFailureError) {
    if (error.subkind === "daemon_timeout") return "probe_timeout";
    if (error.subkind === "daemon_offline") return "machine_offline";
  }
  return "probe_failed";
}

export type RuntimeFormV2SourceStatusFields =
  | { status: "live" }
  | { status: Exclude<RuntimeFormV2OptionSourceStatus, "live">; reason: RuntimeFormV2OptionSourceReason; retryable: boolean };

/**
 * The status fields for a source: live has no reason and no retryable; a
 * non-live source is `fallback` when it still offers a list, else `unavailable`.
 */
export function optionSourceStatusFields(
  reason: RuntimeFormV2OptionSourceReason | null,
  hasOptions: boolean,
): RuntimeFormV2SourceStatusFields {
  if (reason === null) return { status: "live" };
  return { status: hasOptions ? "fallback" : "unavailable", reason, retryable: RUNTIME_FORM_V2_REASON_RETRYABLE[reason] };
}

/**
 * Add the probe's `state` to a v2 source that reports a `status` (sources
 * without one, such as a static provider select, stay as they are); a probe
 * the Computer answered in time adds nothing, so those bodies are unchanged. A stale
 * list is not live: it is reported as a `fallback` that timed out, so a client
 * that ignores `state` still offers a retry.
 */
export function optionSourceWithProbeState(
  source: RuntimeFormV2OptionSourceBody,
  freshness: ComputerProbeFreshness,
): RuntimeFormV2OptionSourceBody {
  if (source.status === undefined || freshness.state === "ok") return source;
  if (freshness.state === "unavailable") return { ...source, state: "unavailable" };
  return {
    ...source,
    ...(source.status === "live" ? optionSourceStatusFields("probe_timeout", true) : {}),
    state: "stale",
    fetchedAt: freshness.fetchedAt,
  };
}
