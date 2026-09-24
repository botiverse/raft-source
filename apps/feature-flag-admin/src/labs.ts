export type LabState = "draft" | "open" | "paused" | "retired";

export type LabDefinition = {
  labKey: string;
  name: string;
  description: string;
  state: LabState;
  createdAt: string;
  updatedAt: string;
};

export type FeatureFlagRuleStage =
  | "user"
  | "platform"
  | "server"
  | "audience"
  | "lab"
  | "plan"
  | "percentage";

export type FeatureFlagRuleLike = {
  id: string;
  stage: FeatureFlagRuleStage;
  priority: number;
  decision: "allow" | "deny";
  values?: string[];
  percentageBasisPoints: number | null;
};

export const EVALUATOR_STAGE_ORDER: FeatureFlagRuleStage[] = [
  "user",
  "platform",
  "server",
  "audience",
  "lab",
  "plan",
  "percentage",
];

export const LAB_OPERATOR_ENDPOINTS = {
  catalog: "/api/operator/labs",
  definition: (labKey: string) => `/api/operator/labs/${encodeURIComponent(labKey)}`,
  lifecycle: (labKey: string) => `/api/operator/labs/${encodeURIComponent(labKey)}/state`,
  rules: (flagKey: string) => `/api/operator/feature-flags/${encodeURIComponent(flagKey)}/lab-rules`,
  rule: (flagKey: string, ruleId: string) => `/api/operator/feature-flags/${encodeURIComponent(flagKey)}/lab-rules/${encodeURIComponent(ruleId)}`,
} as const;

const LAB_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;

export function labKeyValid(value: string): boolean {
  return LAB_KEY_RE.test(value);
}

export function auditReasonValid(value: string): boolean {
  const length = value.trim().length;
  return length >= 3 && length <= 500;
}

export function createLabMutationBody(
  input: { labKey: string; name: string; description: string },
  reason: string,
  expectedConfigVersion: number,
) {
  return {
    labKey: input.labKey,
    name: input.name,
    description: input.description,
    reason: reason.trim(),
    expectedConfigVersion,
  };
}

const STAGE_INDEX = new Map(EVALUATOR_STAGE_ORDER.map((stage, index) => [stage, index]));

export function orderedRules<T extends FeatureFlagRuleLike>(rules: T[]): T[] {
  return [...rules].sort((left, right) => {
    const stageOrder = (STAGE_INDEX.get(left.stage) ?? Number.MAX_SAFE_INTEGER)
      - (STAGE_INDEX.get(right.stage) ?? Number.MAX_SAFE_INTEGER);
    if (stageOrder !== 0) return stageOrder;
    return left.priority - right.priority;
  });
}

export function selectableLabs(labs: LabDefinition[]): LabDefinition[] {
  return labs.filter((lab) => lab.state === "open");
}

export function nextLabStates(state: LabState): LabState[] {
  switch (state) {
    case "draft":
      return ["open"];
    case "open":
      return ["paused", "retired"];
    case "paused":
      return ["open", "retired"];
    case "retired":
      return [];
  }
}

export function labTransitionLabel(from: LabState, to: LabState): string {
  if (from === "draft" && to === "open") return "Publish";
  if (from === "open" && to === "paused") return "Pause";
  if (from === "paused" && to === "open") return "Resume";
  if (to === "retired") return "Retire";
  return to;
}

export function fallbackLabel(defaultEnabled: boolean): string {
  return defaultEnabled ? "On" : "Off";
}

export function ruleTargetLabel(rule: FeatureFlagRuleLike): string {
  if (rule.stage === "percentage") {
    const percentage = (rule.percentageBasisPoints ?? 0) / 100;
    return `${percentage}% of the configured ${rule.stage} audience`;
  }
  return (rule.values ?? []).join(", ") || "No targets";
}

export function labRuleCanBeRemoved(rule: FeatureFlagRuleLike): boolean {
  return rule.stage === "lab";
}
