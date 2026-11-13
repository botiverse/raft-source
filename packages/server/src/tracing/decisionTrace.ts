import type { TraceAttributes } from "@botiverse/raft-shared";
import { addTraceEvent } from "./semanticTrace";

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

// Keys that name raw content are never allowed. `message` and `path` are allowed only as the
// noun of a bounded identifier or counter (message_id, message_count, path_kind, ...), never on
// their own or as text (message, message_text, path, file_path). The key check is a second line
// of defence: string values stay safe only through each contract's own validator.
const FORBIDDEN_DECISION_ATTRIBUTE_KEY = /content|prompt|stack|url|token|secret|query|payload|body/i;
const CONTENT_NOUN_KEY = /message|path/i;
const BOUNDED_NOUN_SUFFIX = /_(id|id_hash|count|n|present|kind|type|seq|len|bucket)$/i;

function isUnsafeDecisionAttributeKey(key: string): boolean {
  if (FORBIDDEN_DECISION_ATTRIBUTE_KEY.test(key)) return true;
  return CONTENT_NOUN_KEY.test(key) && !BOUNDED_NOUN_SUFFIX.test(key);
}

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
    if (!(contract.attributeKeys as readonly string[]).includes(key) || isUnsafeDecisionAttributeKey(key)) {
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
