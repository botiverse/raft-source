import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ACTION_CARD_ACTION_KEYS,
  ACTION_CARD_ACTION_TYPES,
  ACTION_CARD_METADATA_KEYS,
  ACTION_CARD_RESULT_KEYS,
  ACTION_CARD_EXPIRED_ERROR_CODE,
  ACTION_CARD_EXPIRY_MS,
  actionCardActionSchema,
  actionCardExpiresAt,
  actionCardSchemaIssues,
  actionCardSchemaTypes,
  buildActionCardPresentation,
  formatInvalidActionCardNextStep,
  FEEDBACK_SUBMIT_MESSAGE_MAX_LENGTH,
  isActionCardExpiryExempt,
  isActionCardPastExpiry,
  PLAN_UPGRADE_EXTRA_FIELDS_MESSAGE,
  PLAN_UPGRADE_REASON_MAX_LENGTH,
  PLAN_UPGRADE_REASON_MESSAGE,
  PLAN_UPGRADE_REASON_PLACEHOLDER_MESSAGE,
  QUESTION_ASK_LIMITS,
  isQuestionAskConfirm,
  QUESTION_CARD_ERROR_CODES,
  QUESTION_CARD_SIZE_THRESHOLD,
  QUESTION_CARD_RATE_LIMITED_STATUS,
  QUESTION_CARD_TOO_LARGE_STATUS,
  type QuestionCardTooLargeBody,
  type QuestionRateLimitedDetails,
  questionAskOperationSchema,
  storedQuestionAskActionSchema,
  STORED_ACTION_CARD_ACTION_TYPES,
  storedActionCardActionSchema,
  type ActionCardMetadata,
  type ActionCardResult,
  type ActionCardState,
  type QuestionAskAction,
} from "./actionCards";
import { agentApiActionPrepareBodySchema } from "./agentApiContract";
import { prepareActionCardRequestSchema } from "./agentOps/actions";
import { BILLING_ENTRIES, PAYWALL_GATES } from "./productEvents";
import { AGENT_UPGRADE_CARD_GATES, GENERAL_UPGRADE_GATE, UPGRADE_GATES, isUpgradeGate } from "./upgradeGates";

test("action cards: migration export is not an action-card operation", () => {
  assert.equal((ACTION_CARD_ACTION_TYPES as readonly string[]).includes("migration:export"), false);
  assert.equal(actionCardActionSchema.safeParse({
    type: "migration:export",
    targetComputer: "computer-a",
  }).success, false);
});

test("action cards: app owner recovery is a typed human-commit operation", () => {
  assert.equal((ACTION_CARD_ACTION_TYPES as readonly string[]).includes("integration:recover_app_owner"), true);
  assert.equal(actionCardActionSchema.safeParse({
    type: "integration:recover_app_owner",
    clientKey: "demo-app",
    targetAgent: "box",
    draftHint: "Recover an orphaned app.",
  }).success, true);
});

test("action cards: Marketplace install binds the exact app, requester, and scopes", () => {
  const parsed = actionCardActionSchema.safeParse({
    type: "integration:install_marketplace_app",
    clientId: "11111111-1111-4111-8111-111111111111",
    clientKey: "me-build",
    clientName: "Me Build",
    clientNameSha256: "a".repeat(64),
    agentId: "22222222-2222-4222-8222-222222222222",
    agentName: "Peng",
    scopes: ["openid", "profile"],
  });
  assert.equal(parsed.success, true);
  assert.equal((ACTION_CARD_ACTION_TYPES as readonly string[]).includes("integration:install_marketplace_app"), true);
  if (!parsed.success) return;
  const presentation = buildActionCardPresentation(parsed.data);
  assert.equal(presentation.confirmLabel, "Install App");
  assert.equal(presentation.genericApprovalAllowed, true);
  assert.equal(presentation.riskLevel, "elevated");
  assert.equal(presentation.displayItems.some((item) => item.key === "clientNameSha256"), false);
});

test("action cards: app registration can defer client key generation to commit", () => {
  const parsed = actionCardActionSchema.safeParse({
    type: "integration:register_app",
    name: "Generated App",
    returnUrl: "https://generated.example/auth/raft/callback",
    draftHint: "Create this app.",
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.type, "integration:register_app");
    assert.equal(parsed.data.clientKey, undefined);
  }
});

test("action cards: generic approval is server-authorized only for inline actions", () => {
  const register = buildActionCardPresentation({
    type: "integration:register_app",
    name: "Build Monitor",
    returnUrl: "https://build.example/oauth/callback",
    scopes: ["identity", "profile"],
  });
  const dialogBacked = buildActionCardPresentation({
    type: "agent:create",
    name: "Build Agent",
  });
  const retired = buildActionCardPresentation({
    type: "integration:update_app_registration",
    clientKey: "build-monitor",
    name: "Build Monitor 2",
  });

  assert.equal(register.genericApprovalAllowed, true);
  assert.equal(register.confirmLabel, "Register App");
  assert.deepEqual(
    register.displayItems.find((item) => item.key === "scopes"),
    { key: "scopes", value: "identity, profile" },
  );
  assert.equal(dialogBacked.genericApprovalAllowed, false);
  assert.equal(retired.genericApprovalAllowed, false);
});

test("action cards: presentation redacts secret-shaped fields recursively", () => {
  const action = {
    type: "integration:register_app",
    name: "Build Monitor",
    returnUrl: "https://build.example/oauth/callback",
    scopes: [],
    clientSecret: "must-never-persist",
    advanced: { accessToken: "nested-must-never-persist", mode: "safe" },
  };

  // Production actions are schema-validated and cannot contain these hostile
  // fields. The cast exercises the defensive presentation boundary itself.
  const presentation = buildActionCardPresentation(action as Parameters<typeof buildActionCardPresentation>[0]);
  const encoded = JSON.stringify(presentation);

  assert.equal(encoded.includes("must-never-persist"), false);
  assert.equal(encoded.includes("nested-must-never-persist"), false);
  assert.deepEqual(
    presentation.displayItems.find((item) => item.key === "clientSecret"),
    { key: "clientSecret", value: "Hidden", redacted: true },
  );
  assert.equal(
    presentation.displayItems.find((item) => item.key === "advanced")?.value,
    "accessToken: Hidden, mode: safe",
  );
});

test("integration:connect_mcp stores ids, reason and revision — and cannot carry an identity", () => {
  // Every other integration card keeps an agentName / clientName on the durable row. This one
  // deliberately does not: whoever may act on it, and which Connections they may pick, is projected
  // fresh from the CURRENT viewer's permissions at render time. Freezing either into the card would
  // leak one viewer's visible Connections to whoever later opens it.
  const parsed = actionCardActionSchema.parse({
    type: "integration:connect_mcp",
    mcpServerId: "11111111-1111-4111-8111-111111111111",
    agentId: "22222222-2222-4222-8222-222222222222",
    reason: "login_required",
    revision: 3,
    // All of these are offered and must NOT survive into the durable action.
    agentName: "@someone",
    clientName: "Notes MCP",
    accountName: "ops@example.test",
    candidates: [{ connectionId: "33333333-3333-4333-8333-333333333333", label: "my key" }],
  });

  assert.deepEqual(
    Object.keys(parsed).sort(),
    ["agentId", "mcpServerId", "reason", "revision", "type"],
    "the durable action must carry ids, reason and revision and nothing else",
  );
  for (const leaked of ["agentName", "clientName", "accountName", "candidates"]) {
    assert.ok(!(leaked in parsed), `${leaked} must not survive into the durable action`);
  }
});

test("integration:connect_mcp cannot be approved generically, because picking IS the decision", () => {
  const presentation = buildActionCardPresentation({
    type: "integration:connect_mcp",
    mcpServerId: "11111111-1111-4111-8111-111111111111",
    agentId: "22222222-2222-4222-8222-222222222222",
    reason: "login_required",
    revision: 0,
  });
  // A blanket "approve" cannot say WHICH Connection to grant, and that choice is the entire point
  // of the card — so a generic approval must not be offered at all.
  assert.equal(presentation.genericApprovalAllowed, false);
  assert.ok(!presentation.title.includes("@"), "the title cannot name an account it does not store");
});

test("integration:connect_mcp rejects a free-text reason", () => {
  // A closed set keeps the durable row from becoming a place to write sentences about people.
  assert.throws(() => actionCardActionSchema.parse({
    type: "integration:connect_mcp",
    mcpServerId: "11111111-1111-4111-8111-111111111111",
    agentId: "22222222-2222-4222-8222-222222222222",
    reason: "because ops@example.test revoked it",
    revision: 0,
  }));
});

test("action cards: feedback:submit carries a type, a bounded trimmed body and a hint", () => {
  assert.equal((ACTION_CARD_ACTION_TYPES as readonly string[]).includes("feedback:submit"), true);
  const parsed = actionCardActionSchema.safeParse({
    type: "feedback:submit",
    feedbackType: "problem",
    message: "  Search misses DMs  ",
    draftHint: "You hit this twice today.",
  });
  assert.equal(parsed.success, true);
  if (parsed.success && parsed.data.type === "feedback:submit") {
    assert.equal(parsed.data.message, "Search misses DMs");
    assert.equal(parsed.data.draftHint, "You hit this twice today.");
  }
  for (const bad of [
    { type: "feedback:submit", feedbackType: "idea", message: "   " },
    { type: "feedback:submit", feedbackType: "idea", message: "x".repeat(FEEDBACK_SUBMIT_MESSAGE_MAX_LENGTH + 1) },
    { type: "feedback:submit", feedbackType: "bug", message: "x" },
    { type: "feedback:submit", message: "x" },
  ]) {
    assert.equal(actionCardActionSchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal(actionCardActionSchema.safeParse({
    type: "feedback:submit", feedbackType: "idea", message: "x".repeat(FEEDBACK_SUBMIT_MESSAGE_MAX_LENGTH),
  }).success, true);
});

test("action cards: a client that does not know feedback:submit can only view it", () => {
  const presentation = buildActionCardPresentation({
    type: "feedback:submit",
    feedbackType: "idea",
    message: "Add dark mode",
    draftHint: "You asked for this.",
  });
  assert.equal(presentation.title, "Submit feedback");
  assert.equal(presentation.genericApprovalAllowed, false);
  assert.deepEqual(presentation.displayItems.map((item) => item.key), ["feedbackType", "message"]);
});

test("action cards: plan:upgrade takes the agent's reason and, optionally, one upgrade-dialog gate", () => {
  assert.equal((ACTION_CARD_ACTION_TYPES as readonly string[]).includes("plan:upgrade"), true);
  const reason = "You asked for last quarter's launch notes, which are older than 30 days.";
  for (const gate of AGENT_UPGRADE_CARD_GATES) {
    const parsed = actionCardActionSchema.safeParse({ type: "plan:upgrade", reason, gate });
    assert.equal(parsed.success, true, gate);
    if (parsed.success) assert.deepEqual(parsed.data, { type: "plan:upgrade", reason, gate });
  }
  // Dialog-only gates: a Pro theme, a downgrade notice (Tenny), and the Free plan's
  // one external channel (its limit, and a server frozen over it), which only the
  // web's own Upgrades open.
  for (const gate of UPGRADE_GATES.filter((g) => !(AGENT_UPGRADE_CARD_GATES as readonly string[]).includes(g))) {
    assert.equal(actionCardActionSchema.safeParse({ type: "plan:upgrade", reason, gate }).success, false, gate);
  }
  assert.deepEqual(UPGRADE_GATES.filter((g) => !(AGENT_UPGRADE_CARD_GATES as readonly string[]).includes(g)), ["plan_downgraded", "pro_theme", "external_channel_free_limit", "external_channel_frozen"]);
  // No gate: an upgrade no specific limit asks for (the card reads it as `general`).
  const noGate = actionCardActionSchema.safeParse({ type: "plan:upgrade", reason });
  assert.deepEqual(noGate.success && noGate.data, { type: "plan:upgrade", reason });
  // Trimmed, and counted in code points: 200 emoji fit, 201 do not.
  const trimmed = actionCardActionSchema.safeParse({ type: "plan:upgrade", reason: `  ${reason}\n` });
  assert.deepEqual(trimmed.success && trimmed.data, { type: "plan:upgrade", reason });
  assert.equal(PLAN_UPGRADE_REASON_MAX_LENGTH, 200);
  assert.equal(actionCardActionSchema.safeParse({ type: "plan:upgrade", reason: "🙂".repeat(200) }).success, true);
  assert.equal(actionCardActionSchema.safeParse({ type: "plan:upgrade", reason: "x".repeat(200) }).success, true);
  // Plain text, not a placeholder: an apostrophe, or `<` / `>` inside the sentence, is fine.
  for (const ok of [
    "You can't read messages older than 30 days on Free, and you're asking for March.",
    "Uploads over 50 MB are blocked on Free, and your file is 80 MB (<100 MB on Pro).",
    "<b>Pro</b> keeps all history, which you asked for",
  ]) {
    assert.equal(actionCardActionSchema.safeParse({ type: "plan:upgrade", reason: ok }).success, true, ok);
  }
  for (const bad of [
    // A paywall the dialog has no copy for, and a made-up one.
    { type: "plan:upgrade", reason, gate: "seat_limit_invite" },
    { type: "plan:upgrade", reason, gate: "unlimited_everything" },
    // The reason is required, one sentence of at most 200 characters.
    { type: "plan:upgrade", gate: "history_30d" },
    { type: "plan:upgrade" },
    { type: "plan:upgrade", reason: "   ", gate: "history_30d" },
    { type: "plan:upgrade", reason: "x".repeat(201) },
    { type: "plan:upgrade", reason: "🙂".repeat(201) },
    { type: "plan:upgrade", reason: 42 },
    // The hint's placeholder posted as is.
    { type: "plan:upgrade", reason: "<why they need the older messages>", gate: "history_30d" },
    { type: "plan:upgrade", reason: "  <one sentence: why they need Pro>  " },
    // Strict: anything else is refused, not dropped.
    { type: "plan:upgrade", reason, gate: "history_30d", draftHint: "Pro is great, upgrade now" },
    { type: "plan:upgrade", reason, message: "Upgrade!" },
    { type: "plan:upgrade", reason, serverId: "11111111-1111-4111-8111-111111111111" },
  ]) {
    assert.equal(actionCardActionSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("action cards: plan:upgrade refusals say why, not only `Unrecognized key` or `Invalid input`", () => {
  const reason = "You asked for older messages.";
  const parsed = actionCardActionSchema.safeParse({ type: "plan:upgrade", reason, gate: "history_30d", message: "Upgrade!", draftHint: "Pro" });
  assert.equal(parsed.success, false);
  assert.deepEqual(
    parsed.error?.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    [{ path: [], message: 'plan:upgrade takes only "reason" and an optional "gate". Remove the other fields.' }],
  );
  assert.equal(PLAN_UPGRADE_EXTRA_FIELDS_MESSAGE, parsed.error?.issues[0]?.message);
  // A missing, blank or too long reason: one message that says what to write.
  for (const action of [
    { type: "plan:upgrade", gate: "history_30d" },
    { type: "plan:upgrade", reason: "  " },
    { type: "plan:upgrade", reason: "x".repeat(201) },
  ]) {
    const refused = actionCardActionSchema.safeParse(action);
    assert.deepEqual(
      refused.error?.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      [{ path: "reason", message: 'plan:upgrade needs "reason": one plain sentence (up to 200 characters) saying why this person needs Pro.' }],
      JSON.stringify(action),
    );
    assert.equal(refused.error?.issues[0]?.message, PLAN_UPGRADE_REASON_MESSAGE);
  }
  // A reason still wrapped whole in <…> is the hint's placeholder: say so.
  for (const placeholder of ["<why they need the older messages>", " <one sentence: why they need Pro> "]) {
    const refused = actionCardActionSchema.safeParse({ type: "plan:upgrade", reason: placeholder, gate: "history_30d" });
    assert.deepEqual(
      refused.error?.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      [{ path: "reason", message: 'plan:upgrade "reason" is still the placeholder: replace <…> with your own sentence on why this person needs Pro.' }],
      placeholder,
    );
    assert.equal(refused.error?.issues[0]?.message, PLAN_UPGRADE_REASON_PLACEHOLDER_MESSAGE);
  }
  // Too long and a placeholder: only the length is reported.
  const longPlaceholder = actionCardActionSchema.safeParse({ type: "plan:upgrade", reason: `<${"x".repeat(250)}>` });
  assert.deepEqual(longPlaceholder.error?.issues.map((issue) => issue.message), [PLAN_UPGRADE_REASON_MESSAGE]);
  // A bad gate keeps its own message.
  const badGate = actionCardActionSchema.safeParse({ type: "plan:upgrade", reason, gate: "unlimited_everything" });
  assert.equal(badGate.error?.issues[0]?.path.join("."), "gate");
  assert.notEqual(badGate.error?.issues[0]?.message, PLAN_UPGRADE_EXTRA_FIELDS_MESSAGE);
  // The actions.prepare operation's schema (what the SDK manifest documents and `invoke` checks) reports it at `action`.
  const body = prepareActionCardRequestSchema.safeParse({ target: "#general", action: { type: "plan:upgrade", reason, gate: "history_30d", message: "Upgrade!" } });
  assert.deepEqual(body.error?.issues.map((issue) => [issue.path.join("."), issue.message]), [["action", PLAN_UPGRADE_EXTRA_FIELDS_MESSAGE]]);
  const noReason = prepareActionCardRequestSchema.safeParse({ target: "#general", action: { type: "plan:upgrade", gate: "history_30d" } });
  assert.deepEqual(noReason.error?.issues.map((issue) => [issue.path.join("."), issue.message]), [["action.reason", PLAN_UPGRADE_REASON_MESSAGE]]);
  const stillPlaceholder = prepareActionCardRequestSchema.safeParse({ target: "#general", action: { type: "plan:upgrade", reason: "<why they need Pro>" } });
  assert.deepEqual(stillPlaceholder.error?.issues.map((issue) => [issue.path.join("."), issue.message]), [["action.reason", PLAN_UPGRADE_REASON_PLACEHOLDER_MESSAGE]]);
  // The Agent API body itself leaves the card to the Server (actionCardsService.prepareActionCard checks it).
  assert.equal(agentApiActionPrepareBodySchema.safeParse({ target: "#general", action: { type: "plan:upgrade", gate: "history_30d" } }).success, true);
});

test("action cards: the Agent API body carries any card with a type, as written; the Server checks the card", () => {
  // A known card parses as one (its defaults applied); any other falls back to the generic card.
  const known = agentApiActionPrepareBodySchema.safeParse({ target: "#general", action: { type: "channel:create", name: "launch" } });
  assert.deepEqual(known.data?.action, { type: "channel:create", name: "launch", visibility: "public" });
  const card = { type: "future:card", title: "Plan the offsite", attendees: ["@alice"] };
  const body = agentApiActionPrepareBodySchema.safeParse({ target: "#general", action: card, idempotencyKey: "k-1" });
  assert.equal(body.success, true);
  assert.deepEqual(body.data?.action, card);
  for (const action of [{ title: "no type" }, { type: "" }, { type: "  " }, { type: 7 }, "channel:create", null]) {
    const refused = agentApiActionPrepareBodySchema.safeParse({ target: "#general", action });
    assert.equal(refused.success, false, JSON.stringify(action));
    assert.equal(refused.error?.issues[0]?.path[0], "action", JSON.stringify(action));
  }
  assert.equal(prepareActionCardRequestSchema.safeParse({ target: "#general", action: card }).success, false, "the documented schema knows only this version's types");
});

test("action cards: the manual's plan:upgrade example pipes valid JSON through a heredoc, not echo '…'", () => {
  const manual = readFileSync(new URL("../../../manual/agent-knowledge/action-cards.md", import.meta.url), "utf8");
  const section = manual.slice(manual.indexOf("- **`plan:upgrade`**"), manual.indexOf("- **`integration:recover_app_owner`**"));
  assert.ok(!section.includes("echo '{"), "an apostrophe in the reason would end a single-quoted echo");
  const example = /raft action prepare --target "#general" <<'RAFTACTION'\n\s*(\{.*\})\n\s*RAFTACTION/.exec(section);
  assert.ok(example, "the heredoc form, as with raft message send");
  const action = JSON.parse(example[1]!) as { reason: string };
  assert.ok(action.reason.includes("'"), "the example's reason shows an apostrophe is safe");
  assert.equal(actionCardActionSchema.safeParse(action).success, true, "the example is a valid card");
});

test("action cards: the manual's question:ask example is a valid card, piped through a heredoc", () => {
  const manual = readFileSync(new URL("../../../manual/agent-knowledge/action-cards.md", import.meta.url), "utf8");
  const section = manual.slice(manual.indexOf("- **`question:ask`**"), manual.indexOf("## What it CAN'T do"));
  const example = /raft action prepare --target "#ops" <<'RAFTACTION'\n\s*(\{.*\})\n\s*RAFTACTION/.exec(section);
  assert.ok(example, "the heredoc form, as with raft message send");
  const parsed = actionCardActionSchema.safeParse(JSON.parse(example[1]!));
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  assert.equal(parsed.data?.type, "question:ask");
});

test("action cards: a client that does not know plan:upgrade sees a neutral, view-only card", () => {
  const presentation = buildActionCardPresentation({ type: "plan:upgrade", reason: "You asked for older messages.", gate: "history_30d" });
  assert.equal(presentation.title, "Upgrade to Pro");
  assert.equal(presentation.genericApprovalAllowed, false, "there is no server action to approve");
  assert.equal(presentation.riskLevel, "normal");
  assert.deepEqual(presentation.displayItems, [{ key: "reason", value: "You asked for older messages." }, { key: "gate", value: "history_30d" }]);
});

test("upgrade gates: one shared list; every gate but `general` is a paywall the analytics registry knows", () => {
  for (const gate of UPGRADE_GATES) {
    if (gate === GENERAL_UPGRADE_GATE) continue;
    assert.ok((PAYWALL_GATES as readonly string[]).includes(gate), gate);
  }
  // `general` is no paywall: only a billing entry (Nova).
  assert.ok(!(PAYWALL_GATES as readonly string[]).includes(GENERAL_UPGRADE_GATE));
  assert.ok((BILLING_ENTRIES as readonly string[]).includes(GENERAL_UPGRADE_GATE));
  assert.equal(new Set(UPGRADE_GATES).size, UPGRADE_GATES.length);
  assert.equal(isUpgradeGate("history_30d"), true);
  assert.equal(isUpgradeGate("general"), true);
  assert.equal(isUpgradeGate("seat_limit_invite"), false);
  assert.equal(isUpgradeGate(undefined), false);
});

test("action cards: the schema's own card types are the typed list's", () => {
  assert.deepEqual(new Set(actionCardSchemaTypes()), new Set(ACTION_CARD_ACTION_TYPES));
  assert.equal(actionCardSchemaTypes().length, ACTION_CARD_ACTION_TYPES.length);
});

test("action cards: an invalid card's issues are short reasons by field, never a whole echoed input", () => {
  const issuesOf = (input: unknown) => {
    const parsed = actionCardActionSchema.safeParse(input);
    assert.equal(parsed.success, false);
    return parsed.success ? [] : actionCardSchemaIssues(input, parsed.error).map((issue) => `${issue.path}: ${issue.message}`);
  };
  assert.deepEqual(issuesOf({ name: "x" }), ["type: required"]);
  assert.deepEqual(issuesOf({ type: 7 }), ["type: must be a string"]);
  assert.deepEqual(issuesOf("channel:create"), ["action: must be an object"]);
  assert.deepEqual(issuesOf(undefined), ["action: required"]);
  // Missing, wrong type, wrong option, too long, too many, too short, not a UUID, a literal.
  assert.deepEqual(issuesOf({ type: "channel:create", visibility: "secret", initialHumans: "alice" }), [
    "name: required",
    "visibility: must be one of public, private",
    "initialHumans: must be an array",
  ]);
  assert.deepEqual(issuesOf({ type: "agent:create", name: "x".repeat(61), hosting: "cloud" }), [
    "name: at most 60 characters",
    "hosting: must be one of computer, antiproton",
  ]);
  assert.deepEqual(issuesOf({ type: "channel:add_member", channel: "general", humans: Array.from({ length: 65 }, () => "a"), agents: [null] }), [
    "humans: at most 64 items",
    "agents.0: must be a string",
  ]);
  assert.deepEqual(issuesOf({ type: "feedback:submit", feedbackType: "idea", message: "  " }), ["message: at least 1 character"]);
  assert.deepEqual(issuesOf({ type: "integration:approve_agent_login", requestId: "nope", agentId: "6b1f3c2e-8a4d-4f7b-9c1e-2d3a4b5c6d7e", agentName: "a", clientId: "0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70", clientKey: "k", clientName: "n", scopes: [] }), [
    "requestId: not a valid UUID",
  ]);
  assert.match(issuesOf({ type: "integration:connect_mcp", reason: "x" }).join("; "), /reason: must be login_required/);
  // A message the schema wrote itself is kept: it already says why.
  assert.deepEqual(issuesOf({ type: "plan:upgrade" }), [`reason: ${PLAN_UPGRADE_REASON_MESSAGE}`]);
  // Unrecognized keys are the path; at most three are named.
  const withExtra = { type: "plan:upgrade", reason: "You asked for older messages.", a: 1, b: 2, c: 3, ["k".repeat(500)]: 4 };
  const parsed = actionCardActionSchema.safeParse(withExtra);
  assert.equal(parsed.success, false);
  const extra = parsed.success ? [] : actionCardSchemaIssues(withExtra, parsed.error);
  assert.deepEqual(extra, [{ path: "a, b, c and 1 more", message: PLAN_UPGRADE_EXTRA_FIELDS_MESSAGE }]);
  const [longType] = issuesOf({ type: "t".repeat(500) });
  assert.ok(longType!.length < 100, longType);
  // One string: trailing periods folded, then the accepted types.
  assert.equal(
    formatInvalidActionCardNextStep(extra, ["channel:create", "plan:upgrade"]),
    'Fix these fields and run it again: a, b, c and 1 more: plan:upgrade takes only "reason" and an optional "gate". Remove the other fields. Card types this server accepts: channel:create, plan:upgrade.',
  );
});

// ---------------------------------------------------------------------------
// question:ask (question-card spec §2.3, §4.3, §4.4).

/** The spec's example input (§2.3): option labels are the agent's plain strings; the server wraps them (§5.2). */
const QUESTION_ASK_INPUT = {
  type: "question:ask",
  to: "@tenny",
  reason: "I'm preparing this week's deploy and need your call before I start.",
  ref: "deploy-window-1030",
  expiresInMinutes: 1440,
  questions: [
    {
      id: "window", kind: "single", text: "Which window should we deploy in?", description: "All times are UTC.", required: true,
      options: [{ value: "tue_am", label: "Tue 10:00" }, { value: "wed_pm", label: "Wed 15:00" }, { value: "thu_am", label: "Thu 10:00" }],
    },
    {
      id: "envs", kind: "multiple", text: "Which environments first?",
      options: [{ value: "staging", label: "staging" }, { value: "canary", label: "canary (5%)" }, { value: "prod", label: "all of prod" }],
      minItems: 1, maxItems: 2, other: { placeholder: "Name the environment", maxLength: 200 },
    },
    { id: "notes", kind: "text", text: "Anything else I should watch for?", required: false, multiline: true, maxLength: 1000 },
  ],
  pages: [["window", "envs"], ["notes"]],
};
type QuestionInput = Record<string, unknown>;
const withQuestion = (index: number, patch: QuestionInput) => ({
  ...QUESTION_ASK_INPUT,
  questions: QUESTION_ASK_INPUT.questions.map((question, i) => (i === index ? { ...question, ...patch } : question)),
});
const questionIssues = (input: unknown) => {
  const parsed = questionAskOperationSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};

test("question:ask: the spec's input is a valid stored card, with its defaults", () => {
  const parsed = storedActionCardActionSchema.parse(QUESTION_ASK_INPUT) as QuestionAskAction;
  assert.equal(parsed.type, "question:ask");
  assert.deepEqual(parsed.questions.map((question) => question.required), [true, true, false]);
  const minimal = questionAskOperationSchema.parse({ type: "question:ask", questions: [{ id: "q", kind: "text", text: "  Why?  " }] });
  assert.equal(minimal.expiresInMinutes, QUESTION_ASK_LIMITS.expiresInMinutes.default);
  assert.equal(minimal.expiresInMinutes, 10_080, "7 days");
  assert.equal(minimal.questions[0]!.required, true);
  assert.equal(minimal.questions[0]!.text, "Why?", "trimmed");
  // Other… is always there: `other` only sets it, as an object (`true` is not a form of it any more).
  assert.deepEqual(questionIssues(withQuestion(1, { other: {} })), []);
  assert.ok(questionIssues(withQuestion(1, { other: true })).length > 0);
  // The server's fields: who it resolved `to` to, and when the card expires; only a stored card has them.
  const stored = { ...QUESTION_ASK_INPUT, addressee: { kind: "user", userId: "0f1e2d3c-4b5a-4968-8776-655443322110", handle: "tenny" }, expiresAt: "2026-10-31T16:00:00.000Z" };
  const storedIssues = (input: unknown) => {
    const result = storedQuestionAskActionSchema.safeParse(input);
    return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  };
  assert.deepEqual(storedIssues(stored), []);
  assert.deepEqual(storedIssues({ ...QUESTION_ASK_INPUT, to: "anyone", addressee: { kind: "anyone" } }), []);
  assert.ok(storedIssues({ ...QUESTION_ASK_INPUT, addressee: { kind: "user", userId: "tenny", handle: "tenny" } }).length > 0, "a resolved addressee is a UUID");
});

test("question:ask: an agent type; an agent's own addressee or expiresAt is refused (only the server writes them)", () => {
  assert.ok(STORED_ACTION_CARD_ACTION_TYPES.includes("question:ask"));
  assert.equal(STORED_ACTION_CARD_ACTION_TYPES.filter((type) => type === "question:ask").length, 1);
  assert.ok((ACTION_CARD_ACTION_TYPES as readonly string[]).includes("question:ask"));
  assert.ok(actionCardActionSchema.safeParse(QUESTION_ASK_INPUT).success);
  for (const key of ["addressee", "expiresAt"] as const) {
    const sent = { ...QUESTION_ASK_INPUT, ...(key === "addressee" ? { addressee: { kind: "anyone" } } : { expiresAt: "2026-10-31T16:00:00.000Z" }) };
    assert.equal(actionCardActionSchema.safeParse(sent).success, false, key);
    assert.deepEqual(questionIssues(sent).map((issue) => issue.split(":")[0]), [""], `${key}: an unknown key of the card`);
  }
});

test("question:ask: each field's bounds (QUESTION_ASK_LIMITS), in code points after trimming", () => {
  const long = (n: number) => "😀".repeat(n);
  const L = QUESTION_ASK_LIMITS;
  const two = (label: unknown) => [{ value: "a", label }, { value: "b", label: "B" }];
  const options = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `o${i}`, label: `O${i}` }));
  const questions = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `q${i}`, kind: "text", text: "?" }));
  assert.deepEqual({ ...L.questions, options: L.options, text: L.text, description: L.description, optionLabel: L.optionLabel, placeholder: L.placeholder, reason: L.reason, id: L.id, optionValue: L.optionValue, shown: L.shownAnswer },
    { min: 1, max: 4, options: { min: 1, max: 4 }, text: 120, description: 120, optionLabel: 40, placeholder: 40, reason: 300, id: 16, optionValue: 16, shown: 50 });
  const cases: [string, unknown, boolean][] = [
    [`text ${L.text}`, withQuestion(0, { text: long(L.text) }), true],
    [`text ${L.text + 1}`, withQuestion(0, { text: long(L.text + 1) }), false],
    ["blank text", withQuestion(0, { text: "   " }), false],
    ["a control character", withQuestion(0, { text: "Deploy\u0007?" }), false],
    ["a lone surrogate", withQuestion(0, { text: "Deploy \ud83d?" }), false],
    ["tab and newline", withQuestion(0, { description: "UTC\n\tonly" }), true],
    [`description ${L.description}`, withQuestion(0, { description: long(L.description) }), true],
    [`description ${L.description + 1}`, withQuestion(0, { description: long(L.description + 1) }), false],
    [`option label ${L.optionLabel}`, withQuestion(0, { options: two(long(L.optionLabel)) }), true],
    [`option label ${L.optionLabel + 1}`, withQuestion(0, { options: two(long(L.optionLabel + 1)) }), false],
    ["an option description (no room on the card)", withQuestion(0, { options: [{ value: "a", label: "A", description: "x" }, { value: "b", label: "B" }] }), false],
    ["a Msg as an option label", withQuestion(0, { options: two({ key: "actionCard.text.raw", text: { en: "{t}" }, params: { t: "A" } }) }), false],
    [`option value ${L.optionValue}`, withQuestion(0, { options: [{ value: "v".repeat(L.optionValue), label: "A" }, { value: "b", label: "B" }] }), true],
    [`option value ${L.optionValue + 1}`, withQuestion(0, { options: [{ value: "v".repeat(L.optionValue + 1), label: "A" }, { value: "b", label: "B" }] }), false],
    ["no options", withQuestion(0, { options: options(0) }), false],
    ["one option (a confirm)", withQuestion(0, { options: options(1) }), true],
    [`${L.options.max} options`, withQuestion(0, { options: options(L.options.max) }), true],
    [`${L.options.max + 1} options`, withQuestion(0, { options: options(L.options.max + 1) }), false],
    [`placeholder ${L.placeholder}`, withQuestion(1, { other: { placeholder: long(L.placeholder) } }), true],
    [`placeholder ${L.placeholder + 1}`, withQuestion(1, { other: { placeholder: long(L.placeholder + 1) } }), false],
    ["other maxLength 501", withQuestion(1, { other: { maxLength: 501 } }), false],
    ["other false", withQuestion(1, { other: false }), false],
    ["answer maxLength 2000", withQuestion(2, { maxLength: 2000 }), true],
    ["answer maxLength 2001", withQuestion(2, { maxLength: 2001 }), false],
    [`reason ${L.reason}`, { ...QUESTION_ASK_INPUT, reason: long(L.reason) }, true],
    [`reason ${L.reason + 1}`, { ...QUESTION_ASK_INPUT, reason: long(L.reason + 1) }, false],
    ["ref 64", { ...QUESTION_ASK_INPUT, ref: "r".repeat(64) }, true],
    ["ref with a space", { ...QUESTION_ASK_INPUT, ref: "deploy window" }, false],
    ["expires in 5 minutes", { ...QUESTION_ASK_INPUT, expiresInMinutes: 5 }, true],
    ["expires in 4 minutes", { ...QUESTION_ASK_INPUT, expiresInMinutes: 4 }, false],
    ["expires in 30 days", { ...QUESTION_ASK_INPUT, expiresInMinutes: 43_200 }, true],
    ["expires in 30 days and a minute", { ...QUESTION_ASK_INPUT, expiresInMinutes: 43_201 }, false],
    ["no questions", { ...QUESTION_ASK_INPUT, questions: [], pages: undefined }, false],
    [`${L.questions.max + 1} questions`, { ...QUESTION_ASK_INPUT, pages: undefined, questions: questions(L.questions.max + 1) }, false],
    [`${L.questions.max} questions`, { ...QUESTION_ASK_INPUT, pages: undefined, questions: questions(L.questions.max) }, true],
    ["an unknown key", { ...QUESTION_ASK_INPUT, title: "Deploy" }, false],
    ["an unknown question key", withQuestion(0, { help: "x" }), false],
    ["an id with a dash", withQuestion(0, { id: "deploy-window" }), false],
    [`an id of ${L.id}`, { ...withQuestion(0, { id: "w".repeat(L.id) }), pages: undefined }, true],
    [`an id of ${L.id + 1}`, { ...withQuestion(0, { id: "w".repeat(L.id + 1) }), pages: undefined }, false],
    ["a reserved id", withQuestion(0, { id: "constructor" }), false],
  ];
  for (const [name, input, ok] of cases) assert.equal(questionIssues(input).length === 0, ok, `${name}: ${JSON.stringify(questionIssues(input))}`);
});

test("question:ask: one option is a confirm (single or multiple); none is refused; a confirm takes no Other… and one item", () => {
  assert.deepEqual(QUESTION_ASK_LIMITS.options, { min: 1, max: 4 });
  const only = [{ value: "ok", label: "Got it" }];
  assert.deepEqual(questionIssues(withQuestion(0, { options: only })), []);
  assert.deepEqual(questionIssues(withQuestion(1, { options: only, minItems: undefined, maxItems: undefined, other: undefined })), []);
  assert.deepEqual(questionIssues(withQuestion(1, { options: only, minItems: 1, maxItems: 1, other: undefined })), []);
  // A card of one confirm, as an agent writes it.
  assert.deepEqual(questionIssues({ type: "question:ask", questions: [{ id: "ack", kind: "single", text: "Read the runbook?", options: only }] }), []);
  assert.ok(questionIssues(withQuestion(0, { options: [] })).length > 0, "no options");
  assert.ok(questionIssues(withQuestion(0, { options: Array.from({ length: 5 }, (_, i) => ({ value: `o${i}`, label: "x" })) })).length > 0, "five options");
  assert.deepEqual(questionIssues(withQuestion(0, { options: only, other: {} })),
    ["questions.0.other: a question with one option is a confirm button: it offers no Other… and takes no other"]);
  assert.deepEqual(questionIssues(withQuestion(1, { options: only, minItems: undefined, maxItems: 2, other: undefined })), ["questions.1.maxItems: at most 1 (the one option)"]);
  assert.equal(isQuestionAskConfirm({ kind: "single", options: only }), true);
  assert.equal(isQuestionAskConfirm({ kind: "multiple", options: only }), true);
  assert.equal(isQuestionAskConfirm({ kind: "single", options: [...only, { value: "no", label: "No" }] }), false);
  assert.equal(isQuestionAskConfirm({ kind: "text" }), false);
});

test("question:ask: rules across fields say which field and why", () => {
  const one = (input: unknown) => {
    const issues = questionIssues(input);
    assert.equal(issues.length, 1, JSON.stringify(issues));
    return issues[0]!;
  };
  assert.match(one(withQuestion(2, { options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] })), /^questions\.2\.options: a text question takes no options$/);
  assert.match(one(withQuestion(0, { options: undefined })), /^questions\.0\.options: a single question needs 1-4 options$/);
  assert.match(one(withQuestion(0, { multiline: false })), /^questions\.0\.multiline: a single question takes no multiline$/);
  assert.match(one(withQuestion(0, { maxItems: 1 })), /^questions\.0\.maxItems: a single question takes one answer/);
  assert.match(one(withQuestion(0, { options: [{ value: "a", label: "A" }, { value: "a", label: "A2" }] })), /^questions\.0\.options: option values must be unique$/);
  assert.match(one(withQuestion(0, { options: [{ value: "a", label: "A" }, { value: "other", label: "Other" }] })), /^questions\.0\.options\.1\.value: "other" is reserved/);
  // A multiple question's items are its options and Other…: 3 + 1.
  assert.deepEqual(questionIssues(withQuestion(1, { minItems: 4, maxItems: 4 })), []);
  assert.match(one(withQuestion(1, { maxItems: 5 })), /^questions\.1\.maxItems: at most 4/);
  assert.match(one(withQuestion(1, { minItems: 3, maxItems: 2 })), /^questions\.1\.maxItems: maxItems is less than minItems$/);
  assert.match(one(withQuestion(2, { multiline: false, maxLength: 501 })), /^questions\.2\.maxLength: a one-line answer/);
  assert.match(one(withQuestion(2, { multiline: false, maxLength: undefined })), /^questions\.2\.maxLength: a one-line answer/, "the default 1000 is too long for one line");
  assert.deepEqual(questionIssues(withQuestion(2, { multiline: false, maxLength: 500 })), []);
  assert.match(one({ ...withQuestion(1, { id: "window" }), pages: undefined }), /^questions\.1\.id: question id "window" is used twice$/);
  // pages name every question exactly once.
  assert.match(one({ ...QUESTION_ASK_INPUT, pages: [["window"], ["notes"]] }), /^pages: pages leave out "envs"$/);
  assert.match(one({ ...QUESTION_ASK_INPUT, pages: [["window", "envs"], ["notes", "envs"]] }), /^pages: pages name "envs" more than once$/);
  assert.match(one({ ...QUESTION_ASK_INPUT, pages: [["window", "envs", "notes"], ["later"]] }), /^pages: pages name no question "later"$/);
  assert.deepEqual(questionIssues({ ...QUESTION_ASK_INPUT, pages: [["window", "envs", "notes"]] }), [], "one page: no paging");
  assert.ok(questionIssues({ ...QUESTION_ASK_INPUT, pages: Array.from({ length: QUESTION_ASK_LIMITS.pages + 1 }, () => ["window"]) }).length > 0, "at most a page per question");
});

test("question:ask: a client that does not know it sees For and each question as asked, view-only", () => {
  const action = storedActionCardActionSchema.parse({ ...QUESTION_ASK_INPUT, addressee: { kind: "user", userId: "0f1e2d3c-4b5a-4968-8776-655443322110", handle: "tenny" } });
  assert.deepEqual(buildActionCardPresentation(action), {
    title: "Answer Questions",
    confirmLabel: "Answer Questions",
    genericApprovalAllowed: false,
    displayItems: [
      { key: "For", value: "@tenny" },
      { key: "Question 1", value: "Which window should we deploy in?" },
      { key: "Question 2", value: "Which environments first?" },
      { key: "Question 3", value: "Anything else I should watch for?" },
    ],
    riskLevel: "normal",
  });
  const single = storedActionCardActionSchema.parse({ type: "question:ask", to: "anyone", addressee: { kind: "anyone" }, questions: [{ id: "q", kind: "text", text: "Who owns billing?" }] });
  const presentation = buildActionCardPresentation(single);
  assert.equal(presentation.title, "Answer Question");
  assert.deepEqual(presentation.displayItems, [{ key: "For", value: "Anyone in this channel" }, { key: "Question", value: "Who owns billing?" }]);
  // Before the server resolved `to`, the handle as sent.
  const unresolved = storedActionCardActionSchema.parse({ type: "question:ask", to: "@tenny", questions: [{ id: "q", kind: "text", text: "?" }] });
  assert.deepEqual(buildActionCardPresentation(unresolved).displayItems[0], { key: "For", value: "@tenny" });
});

test("question:ask: the result, the withdrawn state and the refusals are additive protocol", () => {
  const result: ActionCardResult = {
    kind: "question-answers",
    ref: "deploy-window-1030",
    answeredBy: { userId: "0f1e2d3c-4b5a-4968-8776-655443322110", handle: "tenny" },
    answeredAt: "2026-10-30T10:51:00Z",
    answers: { window: { kind: "choice", selected: ["tue_am"] }, envs: { kind: "choice", selected: ["staging"], other: "preview-eu" }, notes: { kind: "skipped" } },
  };
  const state: ActionCardState = "withdrawn";
  const metadata: Pick<ActionCardMetadata, "state" | "withdrawnAt" | "result"> = { state, withdrawnAt: "2026-10-30T11:00:00Z", result: null };
  assert.equal(metadata.state, "withdrawn");
  assert.equal(result.kind, "question-answers");
  assert.deepEqual(QUESTION_CARD_ERROR_CODES, {
    notAddressee: "NOT_ADDRESSEE", expired: "QUESTION_EXPIRED", withdrawn: "QUESTION_WITHDRAWN", alreadyAnswered: "ALREADY_ANSWERED", tooManyOpen: "TOO_MANY_OPEN_QUESTIONS",
    rateLimited: "QUESTION_RATE_LIMITED", cardTooLarge: "CARD_TOO_LARGE",
  });
  assert.equal(QUESTION_CARD_TOO_LARGE_STATUS, 400);
  // The hourly cap is a rate limit (wait), not the per-conversation one (answer or withdraw).
  assert.equal(QUESTION_CARD_RATE_LIMITED_STATUS, 429);
  const limited: QuestionRateLimitedDetails = { limit: 30, windowSeconds: 3600, retryAfterSeconds: 120 };
  assert.equal(limited.retryAfterSeconds, 120);
  const tooLarge: QuestionCardTooLargeBody = {
    error: "The question card is too large: shorten the questions or options.", errorCode: "CARD_TOO_LARGE",
    bytes: 24_738, threshold: QUESTION_CARD_SIZE_THRESHOLD, perQuestion: [{ id: "window", bytes: 3937 }],
    suggestedNextAction: "Shorten the text or options of the largest questions, then prepare the card again.",
  };
  assert.equal(tooLarge.threshold, 20_890);
});

test("a card prepared more than 30 days ago is past its expiry; an exempt type keeps its own deadline, or none", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-11-05T12:00:00.000Z");
  const ago = (days: number) => new Date(now - days * DAY);
  const PERSON = "0f1e2d3c-4b5a-4968-8776-655443322110";
  assert.equal(ACTION_CARD_EXPIRY_MS, 30 * DAY);
  assert.equal(ACTION_CARD_EXPIRED_ERROR_CODE, "ACTION_CARD_EXPIRED");
  const agentCard = { actionType: "channel:create" };
  assert.equal(isActionCardPastExpiry({ ...agentCard, createdAt: ago(29) }, now), false, "29 days: still open");
  assert.equal(isActionCardPastExpiry({ ...agentCard, createdAt: ago(30) }, now), false, "exactly 30 days: not more than 30");
  assert.equal(isActionCardPastExpiry({ ...agentCard, createdAt: ago(31) }, now), true, "31 days: expired");
  assert.equal(isActionCardPastExpiry({ ...agentCard, createdAt: ago(31).toISOString() }, now), true, "an ISO string reads the same");
  // Its deadline: 30 days after it was prepared.
  assert.equal(actionCardExpiresAt({ action: { type: "channel:create" }, createdAt: "2026-10-01T09:30:00.000Z" }), "2026-10-31T09:30:00.000Z");
  // Every type an agent prepares, but question:ask and plan:upgrade.
  for (const actionType of ACTION_CARD_ACTION_TYPES.filter((type) => type !== "question:ask" && type !== "plan:upgrade")) {
    assert.equal(isActionCardExpiryExempt(actionType), false, actionType);
    assert.equal(isActionCardPastExpiry({ actionType, createdAt: ago(31) }, now), true, actionType);
  }
  // Exempt types keep their own deadline, however old, and serve it.
  const own = "2026-11-12T08:00:00.000Z";
  for (const actionType of ["question:ask", "agent:approve_call", "assistant:owner_action", "seats:add"]) {
    assert.equal(isActionCardExpiryExempt(actionType), true, actionType);
    assert.equal(isActionCardPastExpiry({ actionType, createdAt: ago(31) }, now), false, `${actionType} keeps its own deadline`);
    assert.equal(actionCardExpiresAt({ action: { type: actionType, expiresAt: own } as never, createdAt: ago(31) }), own, actionType);
  }
  assert.equal(actionCardExpiresAt({ action: { type: "agent:approve_call", expiresAt: null } as never, createdAt: ago(1) }), null, "a held call with expiry off has none");
  // plan:upgrade: a person's ends 7 days after it was asked; an agent's has no deadline.
  assert.equal(isActionCardPastExpiry({ actionType: "plan:upgrade", createdAt: ago(31) }, now), false);
  assert.equal(actionCardExpiresAt({ action: { type: "plan:upgrade" }, requesterUserId: PERSON, createdAt: "2026-10-01T09:30:00.000Z" }), "2026-10-08T09:30:00.000Z");
  assert.equal(actionCardExpiresAt({ action: { type: "plan:upgrade" }, requesterUserId: null, createdAt: ago(31) }), null);
});

// The mobile App's V2 conversion keeps exactly these action_metadata keys
// (ACTION_CARD_ROOT_KEYS in the App's CanonicalMessageV2ProductionCanary.kt,
// 1.16.1 to 1.20.0, release tags checked; Lagoon f1c1f63c, #proj-apps:#40). `version` is the App's own; the
// server never sends it.
const APP_KEPT_ACTION_METADATA_KEYS = [
  "kind", "version", "action", "state", "executedAt", "executedByUserName", "result",
  "sourceServerId", "targetServerName", "confirmationVersion", "presentation", "executedByUserId",
];

test("ACTION_CARD_METADATA_KEYS: what it marks v2-keeps is exactly what the App's V2 keeps", () => {
  const keeps = Object.entries(ACTION_CARD_METADATA_KEYS).filter(([, app]) => app === "v2-keeps").map(([key]) => key).sort();
  assert.deepEqual(keeps, APP_KEPT_ACTION_METADATA_KEYS.filter((key) => key !== "version").sort());
  // A key the App drops must not be one it keeps.
  for (const [key, app] of Object.entries(ACTION_CARD_METADATA_KEYS)) {
    if (app === "v2-drops") assert.ok(!APP_KEPT_ACTION_METADATA_KEYS.includes(key), key);
  }
});

// The mobile App's V2 conversion keeps exactly these keys of a card's
// `action`, whatever its type (ACTION_CARD_ACTION_KEYS in the App's
// CanonicalMessageV2ProductionCanary.kt; the same in its tags 1.16.0 to
// 1.20.0 and main 1e916283d; Lagoon, #proj-apps:#40).
const APP_KEPT_ACTION_CARD_ACTION_KEYS = [
  "type", "name", "description", "visibility", "channel", "suggestedComputer", "requiredComputer",
  "humans", "agents", "initialHumans", "initialAgents", "draftHint", "requestId", "agentId",
  "agentName", "clientId", "clientKey", "clientName", "scopes",
];

test("ACTION_CARD_ACTION_KEYS: what it marks v2-keeps is exactly what the App's V2 keeps of an action", () => {
  const keeps = Object.entries(ACTION_CARD_ACTION_KEYS).filter(([, app]) => app === "v2-keeps").map(([key]) => key).sort();
  assert.deepEqual(keeps, [...APP_KEPT_ACTION_CARD_ACTION_KEYS].sort());
});

// The mobile App's V2 conversion keeps exactly these keys of a card's
// `result`, by kind, and only `kind` of a kind it does not list
// (CANONICAL_ACTION_CARD_RESULT_KEYS_BY_KIND in the App's
// CanonicalMessageEnvelopeV2.kt; the same in its tags 1.16.1 to 1.20.0 and
// main 1e916283d). App 1.16.0 had one strict set for every kind instead:
// kind, id, name, channelId, channelName, addedHumanIds, addedAgentIds.
const APP_KEPT_ACTION_CARD_RESULT_KEYS_BY_KIND: Record<string, string[]> = {
  channel: ["kind", "id", "name"],
  agent: ["kind", "id", "name"],
  "channel-members": ["kind", "channelId", "channelName", "addedHumanIds", "addedAgentIds"],
  "mcp-connection": ["kind", "mcpServerId", "agentId"],
  "agent-integration-login": ["kind", "requestId", "agentId", "agentName", "clientId", "clientKey", "clientName", "scopes", "grantId"],
  "marketplace-app-installation": ["kind", "clientId", "clientKey", "clientName", "serverId", "agentId", "agentName", "scopes", "setupUrl"],
  "integration-app-registration": [
    "kind", "mode", "clientId", "clientKey", "clientName", "returnUrl", "homepageUrl", "agentManifestUrl",
    "setupUrl", "setupDescription", "scopes", "unsafeDemoUrlOverride",
  ],
  "integration-app-owner-recovery": ["kind", "clientId", "clientKey", "clientName", "ownerAgentId", "ownerAgentName"],
  "product-feedback": ["kind", "ticketId", "reference", "source"],
};

test("ACTION_CARD_RESULT_KEYS: for each kind, what it marks v2-keeps is exactly what the App's V2 keeps of that kind's result", () => {
  for (const [kind, keys] of Object.entries(ACTION_CARD_RESULT_KEYS)) {
    const keeps = Object.entries(keys).filter(([, app]) => app === "v2-keeps").map(([key]) => key).sort();
    assert.deepEqual(keeps, [...(APP_KEPT_ACTION_CARD_RESULT_KEYS_BY_KIND[kind] ?? ["kind"])].sort(), kind);
  }
  // Every kind the App lists is one the server has.
  for (const kind of Object.keys(APP_KEPT_ACTION_CARD_RESULT_KEYS_BY_KIND)) assert.ok(Object.hasOwn(ACTION_CARD_RESULT_KEYS, kind), kind);
});
