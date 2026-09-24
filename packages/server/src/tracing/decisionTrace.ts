import type { TraceAttributes } from "@botiverse/raft-shared";
import { addTraceEvent } from "./semanticTrace.js";

type DecisionScalar = string | number | boolean;

export interface DecisionEventContract<
  Action extends string,
  Reason extends string,
  AttributeKey extends string,
> {
  name: string;
  actions: readonly Action[];
  reasons: readonly Reason[];
  attributeKeys: readonly AttributeKey[];
  stringAttributeValidators?: Partial<Record<AttributeKey, (value: string) => boolean>>;
}

export interface DecisionEventInput<
  Action extends string,
  Reason extends string,
  AttributeKey extends string,
> {
  action: Action;
  reason: Reason;
  attrs?: Partial<Record<AttributeKey, DecisionScalar>>;
}

const FORBIDDEN_DECISION_ATTRIBUTE_KEY = /content|message|prompt|stack|path|url|token|secret|query|payload|body/i;

export function buildDecisionEventAttrs<
  Action extends string,
  Reason extends string,
  AttributeKey extends string,
>(
  contract: DecisionEventContract<Action, Reason, AttributeKey>,
  input: DecisionEventInput<Action, Reason, AttributeKey>,
): TraceAttributes {
  if (!(contract.actions as readonly string[]).includes(input.action)) {
    throw new Error(`Decision event ${contract.name} rejected unknown action`);
  }
  if (!(contract.reasons as readonly string[]).includes(input.reason)) {
    throw new Error(`Decision event ${contract.name} rejected unknown reason`);
  }

  const attrs: TraceAttributes = {
    event_kind: "decision",
    outcome: "decided",
    action: input.action,
    reason: input.reason,
  };
  for (const [key, value] of Object.entries(input.attrs ?? {})) {
    if (!(contract.attributeKeys as readonly string[]).includes(key) || FORBIDDEN_DECISION_ATTRIBUTE_KEY.test(key)) {
      throw new Error(`Decision event ${contract.name} rejected undeclared or unsafe attribute`);
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`Decision event ${contract.name} rejected non-scalar attribute`);
    }
    if (typeof value === "string") {
      const validator = contract.stringAttributeValidators?.[key as AttributeKey];
      if (!validator || !validator(value)) {
        throw new Error(`Decision event ${contract.name} rejected unsafe string attribute`);
      }
    }
    attrs[key] = value;
  }
  return attrs;
}

/** Trace emission is failure-isolated; a bad trace value never changes product behavior. */
export function emitDecisionEvent<
  Action extends string,
  Reason extends string,
  AttributeKey extends string,
>(
  contract: DecisionEventContract<Action, Reason, AttributeKey>,
  input: DecisionEventInput<Action, Reason, AttributeKey>,
): void {
  try {
    addTraceEvent(contract.name, buildDecisionEventAttrs(contract, input));
  } catch (error) {
    console.warn(`[Tracing] Rejected decision event ${contract.name}:`, error);
  }
}
