import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { STORED_ACTION_CARD_ACTION_TYPES, storedActionCardActionSchema, type StoredActionCardActionType } from "@botiverse/raft-shared";

import {
  ACTION_CARD_SECOND_FACTOR,
  actionCardSecondFactorRule,
  type ActionCardSecondFactorRule,
} from "./actionCardSecondFactor";
import { STEP_UP_ACTIONS } from "./secondFactor/stepUpGate";

// Every action-card kind declares the second step executing it takes
// (actionCardSecondFactor.ts), and executeActionCard checks it once, before
// anything is written. POST /api/actions/:messageId/execute is classified
// "gated by card kind" in stepUpGate.contract.test.ts on the strength of
// this file. Each gated kind's behaviour (enforced, verified, without
// two-step verification, a refusal) is in routes/actionCardSecondFactor.api.test.ts
// and routes/antiprotonApprovals.api.test.ts (agent:approve_call).
const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The classification, pinned: changing a kind's second step (or adding a
 * kind) is a reviewed change here. A kind that issues a credential or grants
 * access is never `none`.
 */
const EXPECTED: Record<StoredActionCardActionType, ActionCardSecondFactorRule["secondFactor"]> = {
  "integration:approve_agent_login": "approver",
  "integration:install_marketplace_app": "approver",
  "integration:recover_app_owner": "approver",
  "agent:approve_call": "approver",
  "integration:register_app": "step_up",
  "integration:update_app_registration": "none",
  "integration:connect_mcp": "none",
  "channel:create": "none",
  "agent:create": "none",
  "agent:migrate": "none",
  "channel:add_member": "none",
  "feedback:submit": "none",
  "plan:upgrade": "none",
  "seats:add": "none",
  "question:ask": "none",
  // Confirm runs the owner's own route on their own session, with that route's own step-ups.
  "assistant:owner_action": "none",
};

/** Kinds whose execute issues a credential or grants access: never `none`. */
const GRANTS_ACCESS: readonly StoredActionCardActionType[] = [
  "integration:approve_agent_login",
  "integration:install_marketplace_app",
  "integration:recover_app_owner",
  "integration:register_app",
  "agent:approve_call",
];

/** Kinds without a declaration, and declarations for no kind. */
function checkDeclarations(kinds: readonly string[], declared: Record<string, ActionCardSecondFactorRule>): { missing: string[]; unknown: string[]; problems: string[] } {
  const problems: string[] = [];
  for (const [kind, rule] of Object.entries(declared)) {
    if (!["approver", "step_up", "none"].includes(rule.secondFactor)) problems.push(`${kind}: secondFactor is approver, step_up or none`);
    if (typeof rule.reason !== "string" || rule.reason.trim().length < 20) problems.push(`${kind}: a written reason`);
    if (rule.secondFactor === "approver" && !/^Confirm it's you with your second step before /.test(rule.error)) problems.push(`${kind}: its refusal message`);
    if (rule.secondFactor === "step_up" && !Object.hasOwn(STEP_UP_ACTIONS, rule.action)) problems.push(`${kind}: a STEP_UP_ACTIONS action`);
  }
  return {
    missing: kinds.filter((kind) => !Object.hasOwn(declared, kind)).sort(),
    unknown: Object.keys(declared).filter((kind) => !kinds.includes(kind)).sort(),
    problems,
  };
}

/** The kinds the stored-card schema accepts, read from its discriminated union. */
function schemaKinds(): string[] {
  const options = (storedActionCardActionSchema as unknown as { options: Array<{ shape: { type: { value: string } } }> }).options;
  return options.map((option) => option.shape.type.value).sort();
}

test("every registered kind declares its second step, with a written reason; nothing else is declared", () => {
  assert.deepEqual([...STORED_ACTION_CARD_ACTION_TYPES].sort(), schemaKinds(), "the stored kinds list is the schema's");
  assert.deepEqual(checkDeclarations(schemaKinds(), ACTION_CARD_SECOND_FACTOR), { missing: [], unknown: [], problems: [] });
  const actual = Object.fromEntries(Object.entries(ACTION_CARD_SECOND_FACTOR).map(([kind, rule]) => [kind, rule.secondFactor]));
  assert.deepEqual(actual, EXPECTED);
});

test("no kind that issues a credential or grants access is `none`", () => {
  for (const kind of GRANTS_ACCESS) assert.notEqual(ACTION_CARD_SECOND_FACTOR[kind].secondFactor, "none", kind);
});

test("reverse control: a kind without a declaration, an empty reason or a grant classified none turns it red", () => {
  const withProbe = [...schemaKinds(), "probe:new_kind"];
  assert.deepEqual(checkDeclarations(withProbe, ACTION_CARD_SECOND_FACTOR).missing, ["probe:new_kind"]);
  const blank = { ...ACTION_CARD_SECOND_FACTOR, "channel:create": { secondFactor: "none", reason: " " } as const };
  assert.deepEqual(checkDeclarations(schemaKinds(), blank).problems, ["channel:create: a written reason"]);
  const stray = { ...ACTION_CARD_SECOND_FACTOR, "probe:gone": { secondFactor: "none", reason: "a kind no schema has any more" } as const };
  assert.deepEqual(checkDeclarations(schemaKinds(), stray).unknown, ["probe:gone"]);
  // The type refuses a missing kind too.
  // @ts-expect-error every stored kind must be declared
  const partial: typeof ACTION_CARD_SECOND_FACTOR = { "channel:create": ACTION_CARD_SECOND_FACTOR["channel:create"] };
  void partial;
  // A kind this server does not know is held to the approver's check, never let through.
  assert.equal(actionCardSecondFactorRule("probe:new_kind").secondFactor, "approver");
  assert.equal(actionCardSecondFactorRule("__proto__").secondFactor, "approver");
});

test("agent:approve_call: only exactly Deny is ungated; Approve, a missing or odd decision, no form are gated", () => {
  const rule = ACTION_CARD_SECOND_FACTOR["agent:approve_call"];
  assert.equal(rule.secondFactor, "approver");
  const applies = rule.secondFactor === "approver" ? rule.appliesTo! : () => true;
  assert.equal(applies({ id: "decision", values: { decision: "deny" } }), false);
  assert.equal(applies({ id: "decision", values: { decision: "approve" } }), true);
  assert.equal(applies({ id: "decision", values: { decision: "Deny" } }), true);
  assert.equal(applies({ id: "decision", values: {} }), true);
  assert.equal(applies(undefined), true);
  // No other kind has a refusal through execute.
  for (const [kind, other] of Object.entries(ACTION_CARD_SECOND_FACTOR)) {
    if (kind !== "agent:approve_call") assert.equal("appliesTo" in other, false, kind);
  }
});

function functionBody(source: string, signature: string, close = "\n}\n"): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, signature);
  const end = source.indexOf(close, start);
  assert.ok(end > start, `${signature}: its end`);
  return source.slice(start, end);
}

test("executeActionCard checks it once, after the read-only preflight and before anything is written", () => {
  const source = readFileSync(resolve(srcDir, "services/actionCardsService.ts"), "utf8");
  const execute = functionBody(source, "export async function executeActionCard(");
  const calls = [...execute.matchAll(/actionCardSecondFactorRefusal\(/g)];
  assert.equal(calls.length, 1, "one check");
  const check = calls[0]!.index!;
  assert.ok(check > execute.indexOf("await preflightExecuteActionCard("), "after the card is read");
  for (const write of ["recordActionCardEvent(", "deliverActionCardForm(", "executeActionCardInner(", "postActionCardResultReply("]) {
    const at = execute.indexOf(write);
    assert.ok(at > check, `${write} after the check`);
  }
  assert.match(execute.slice(check, check + 400), /if \(refusal\) throw new ActionCardSecondFactorRequiredError\(/);
  // The preflight only reads.
  const preflight = functionBody(source, "async function preflightExecuteActionCard(");
  assert.doesNotMatch(preflight, /\.(?:insert|update|delete)\(|recordActionCardEvent|transaction\(/);
  // Nowhere else in the module calls the check.
  assert.equal([...source.matchAll(/actionCardSecondFactorRefusal\(/g)].length, 1);
});

test("the execute route is the only production caller, and passes the person's own web sign-in", () => {
  const callers: string[] = [];
  for (const entry of readdirSync(srcDir, { recursive: true, encoding: "utf8" })) {
    const file = entry.split("\\").join("/");
    if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.startsWith("test/")) continue;
    const source = readFileSync(resolve(srcDir, file), "utf8");
    if (/(?<!function )executeActionCard\(\{/.test(source)) callers.push(file);
  }
  assert.deepEqual(callers, ["routes/actions.ts"]);
  const route = readFileSync(resolve(srcDir, "routes/actions.ts"), "utf8");
  assert.match(functionBody(route, 'actionsRouter.post("/:messageId/execute"', "\n});\n"), /webSessionFamilyId: webSessionFamilyOf\(req\),/);
});
