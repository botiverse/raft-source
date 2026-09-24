import type {
  MachineToServerMessage,
  RuntimeModelSourceOutcome,
} from "@botiverse/raft-shared";
import type { RuntimeModelVerification } from "./drivers/types.js";

type RuntimeModelSourceResultMessage = Extract<MachineToServerMessage, { type: "machine:runtime_models:result" }>;

/**
 * Build the additive daemon wire carrier: typed truth for new servers plus the
 * old models/default/error fields required by a mixed-version rollout.
 */
export function buildRuntimeModelSourceResultMessage(
  requestId: string,
  detectedOutcome: RuntimeModelSourceOutcome,
  verifiedAs: RuntimeModelVerification,
): RuntimeModelSourceResultMessage {
  const outcome: RuntimeModelSourceOutcome = detectedOutcome.kind === "live" && detectedOutcome.value.models.length === 0
    ? { kind: "no_models" }
    : detectedOutcome;

  if (outcome.kind === "live") {
    const models = outcome.value.models.map((model) => ({
      ...model,
      verified: model.verified ?? verifiedAs,
    }));
    const liveOutcome: RuntimeModelSourceOutcome = {
      kind: "live",
      value: {
        models,
        default: outcome.value.default,
        ...(outcome.value.catalog !== undefined
          ? { catalog: outcome.value.catalog }
          : {}),
      },
    };
    return {
      type: "machine:runtime_models:result",
      requestId,
      outcome: liveOutcome,
      models,
      default: outcome.value.default,
    };
  }

  return {
    type: "machine:runtime_models:result",
    requestId,
    outcome,
    ...(outcome.kind === "no_models"
      ? { models: [] }
      : { error: outcome.kind }),
  };
}
