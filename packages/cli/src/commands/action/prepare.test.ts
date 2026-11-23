import assert from "node:assert/strict";
import { Readable } from "node:stream";

import {
  actionCardActionSchema,
  extractHandleName,
  looksLikeUuid,
  validateActionCardAction,
} from "@botiverse/raft-shared";

import { runPinned } from "../registryPin/harness";
import { actionPrepareCommand, resolveActionInput, PrepareActionInputError } from "./prepare";

const PREPARED = { messageId: "99990000-1111-4222-8333-444455556666", metadata: { kind: "action-card" } };

test("raft action prepare sends a card type this CLI does not know to the Server as written", async () => {
  const action = { type: "future:card", title: "Plan the offsite", attendees: ["@alice"] };
  const run = await runPinned(
    ["action", "prepare", "--target", "#general"],
    [{ method: "POST", path: /prepare-action/, data: PREPARED }],
    JSON.stringify(action),
  );
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(run.requests.length, 1);
  assert.deepEqual((run.requests[0]?.body as { action?: unknown }).action, action);
  assert.equal(run.stdout, "Action card posted to #general as message 99990000-1111-4222-8333-444455556666 (short 99990000). The human can click the action verb to commit.\n");
});

test("raft action prepare: a question card says whom it asks, where the answers arrive, when it expires and how to withdraw it", async () => {
  const id = "1a2b3c4d-1111-4222-8333-444455556666";
  const question = { type: "question:ask", to: "@tenny", questions: [{ id: "window", kind: "single", text: "Which window?", options: [{ value: "tue_am", label: "Tue 10:00" }, { value: "wed_pm", label: "Wed 15:00" }] }] };
  // The Server stores whom it asks (`addressee`, resolved from `to`) and when it expires: the text says what it stored.
  const stored = (addressee: unknown) => ({
    messageId: id,
    metadata: { kind: "action-card", state: "prepared", action: { ...question, addressee, expiresInMinutes: 1440, expiresAt: "2026-10-31T16:00:00.000Z" } },
  });
  const tenny = { kind: "user", userId: "00000000-0000-4000-8000-000000000001", handle: "tenny" };
  const asked = await runPinned(["action", "prepare", "--target", "#ops"], [{ method: "POST", path: /prepare-action/, data: stored(tenny) }], JSON.stringify(question));
  assert.equal(asked.exitCode, 0, asked.stderr);
  assert.equal(
    asked.stdout,
    `Question card posted to #ops as message ${id} (short 1a2b3c4d), asking @tenny. When they answer, the answers arrive as a reply in the card's thread that @mentions you; you do not need to poll. It expires 2026-10-31 16:00 UTC; if nobody answers by then, a reply tells you. If you no longer need the answers, withdraw it with: raft action withdraw --message 1a2b3c4d\n`,
  );

  const anyone = await runPinned(["action", "prepare", "--target", "#ops"], [{ method: "POST", path: /prepare-action/, data: stored({ kind: "anyone" }) }], JSON.stringify({ ...question, to: "anyone" }));
  assert.equal(anyone.exitCode, 0, anyone.stderr);
  assert.equal(
    anyone.stdout,
    `Question card posted to #ops as message ${id} (short 1a2b3c4d), asking anyone. When someone answers, the answers arrive as a reply in the card's thread that @mentions you; you do not need to poll. It expires 2026-10-31 16:00 UTC; if nobody answers by then, a reply tells you. If you no longer need the answers, withdraw it with: raft action withdraw --message 1a2b3c4d\n`,
  );

  // In a DM `to` may be left out: the Server's addressee names the person. A card posted in a thread gets its reply there.
  const inThread = await runPinned(["action", "prepare", "--target", "dm:@tenny:aaaabbbb"], [{ method: "POST", path: /prepare-action/, data: stored(tenny) }], JSON.stringify({ ...question, to: undefined }));
  assert.equal(inThread.exitCode, 0, inThread.stderr);
  assert.match(inThread.stdout, /, asking @tenny\. When they answer, the answers arrive as a reply in this thread that @mentions you;/);
});

test("raft action prepare prints the Server's refusal of a card: its sentence, code, Retryable: no and next action", async () => {
  const run = await runPinned(
    ["action", "prepare", "--target", "#general"],
    [{
      method: "POST",
      path: /prepare-action/,
      response: {
        ok: false,
        status: 400,
        error: "The card was refused: channel:add_member must include at least one human or agent.",
        errorCode: "INVALID_ACTION",
        suggestedNextAction: "Add humans or agents to the card and prepare it again.",
        data: null,
      },
    }],
    JSON.stringify({ type: "channel:add_member", channel: "#general" }),
  );
  assert.equal(run.exitCode, 1);
  assert.equal(run.requests.length, 1, "the card reached the Server");
  assert.equal(run.stderr, [
    "Error: The card was refused: channel:add_member must include at least one human or agent.",
    "Code: INVALID_ACTION",
    "Retryable: no",
    "Next action: Add humans or agents to the card and prepare it again.",
    "",
  ].join("\n"));
});

test("raft action prepare shows any code the Server refuses with, as it sent it (an upgrade card's cooldown)", async () => {
  const error = "An upgrade card was already offered in this conversation in the last 14 days: don't offer another; say in the conversation what the limit is and why, without a card.";
  const step = "An upgrade card was already offered here on 2026-10-27. Don't offer another before 2026-11-11; say in the conversation what the limit is and why, without a card.";
  const run = await runPinned(
    ["action", "prepare", "--target", "#general"],
    [{
      method: "POST",
      path: /prepare-action/,
      response: { ok: false, status: 409, error, errorCode: "UPGRADE_CARD_COOLDOWN", suggestedNextAction: step, data: null },
    }],
    JSON.stringify({ type: "plan:upgrade", gate: "upload_file_size", reason: "You asked for the 80MB recording." }),
  );
  assert.equal(run.exitCode, 1);
  assert.equal(run.stderr, [`Error: ${error}`, "Code: UPGRADE_CARD_COOLDOWN", "Retryable: no", `Next action: ${step}`, ""].join("\n"));

  // No code from the Server: PREPARE_FAILED, and no generic next step.
  const bare = await runPinned(
    ["action", "prepare", "--target", "#general"],
    [{ method: "POST", path: /prepare-action/, response: { ok: false, status: 400, error: "Could not resolve target: #general", data: null } }],
    JSON.stringify({ type: "channel:create", name: "demo" }),
  );
  assert.equal(bare.stderr, ["Error: Could not resolve target: #general", "Code: PREPARE_FAILED", "Retryable: no", ""].join("\n"));
});

test("raft action prepare: a question card's two limits read apart — the hourly one is retryable after its wait, the per-conversation one is not", async () => {
  const question = JSON.stringify({ type: "question:ask", to: "@tenny", questions: [{ id: "q", kind: "text", text: "?" }] });
  const hourlyError = "You posted 30 question cards in the last hour, the most an agent may.";
  const hourlyStep = "Wait 12 minutes (retryAfterSeconds: 700) before preparing another question card, or put your questions in one card when you do.";
  const hourlyBody = { error: hourlyError, errorCode: "QUESTION_RATE_LIMITED", suggestedNextAction: hourlyStep, limit: 30, windowSeconds: 3600, retryAfterSeconds: 700 };
  const hourly = await runPinned(
    ["action", "prepare", "--target", "#general"],
    [{ method: "POST", path: /prepare-action/, response: { ok: false, status: 429, error: hourlyError, errorCode: "QUESTION_RATE_LIMITED", suggestedNextAction: hourlyStep, data: null, errorBody: hourlyBody } }],
    question,
  );
  assert.equal(hourly.exitCode, 1);
  assert.equal(hourly.stderr, [`Error: ${hourlyError}`, "Code: QUESTION_RATE_LIMITED", "Retryable: yes", `Next action: ${hourlyStep}`, ""].join("\n"));
  const openError = "You already have 3 unanswered question cards in this conversation.";
  const openStep = "Wait for an answer, or withdraw one you no longer need (raft action withdraw), before asking another here.";
  const open = await runPinned(
    ["action", "prepare", "--target", "#general"],
    [{ method: "POST", path: /prepare-action/, response: { ok: false, status: 409, error: openError, errorCode: "TOO_MANY_OPEN_QUESTIONS", suggestedNextAction: openStep, data: null } }],
    question,
  );
  assert.equal(open.stderr, [`Error: ${openError}`, "Code: TOO_MANY_OPEN_QUESTIONS", "Retryable: no", `Next action: ${openStep}`, ""].join("\n"));
});

test("raft action prepare over the write budget (429 RATE_LIMITED): retryable, how long to wait, the same command again", async () => {
  const error = "This agent made too many other writes: the limit is 60 a minute. Retry in 14 seconds.";
  const body = { error, code: "RATE_LIMITED", details: { operation: "actionPrepare", limit: 60, windowSeconds: 60, retryAfterSeconds: 14 } };
  const limited = await runPinned(
    ["action", "prepare", "--target", "#general"],
    [{ method: "POST", path: /prepare-action/, response: { ok: false, status: 429, error, errorCode: "RATE_LIMITED", data: null, errorBody: body } }],
    JSON.stringify({ type: "channel:create", name: "demo" }),
  );
  assert.equal(limited.exitCode, 1);
  assert.equal(limited.stderr, [`Error: ${error}`, "Code: RATE_LIMITED", "Retryable: yes", "Next action: Wait 14 seconds, then run the same command again (the refused request changed nothing).", ""].join("\n"));
});

test("raft action prepare refuses JSON without a card type before sending anything", async () => {
  for (const input of [{ name: "demo" }, { type: "" }, { type: 7 }, ["channel:create"], "channel:create"]) {
    const run = await runPinned(["action", "prepare", "--target", "#general"], [{ method: "POST", path: /prepare-action/, data: PREPARED }], JSON.stringify(input));
    assert.equal(run.exitCode, 1, JSON.stringify(input));
    assert.deepEqual(run.requests, [], JSON.stringify(input));
    assert.match(run.stderr, /^Error: The action JSON must be an object with a "type"/, JSON.stringify(input));
    assert.match(run.stderr, /\nCode: INVALID_ACTION\n/, JSON.stringify(input));
    assert.match(run.stderr, /\nNext action: .*raft manual get action-cards/, JSON.stringify(input));
  }
});

test("resolveActionInput parses well-formed channel:create JSON", async () => {
  const input = Readable.from([
    JSON.stringify({
      type: "channel:create",
      name: "demo",
      visibility: "public",
      description: "test channel",
    }),
  ]);

  const raw = await resolveActionInput(input);
  const parsed = actionCardActionSchema.parse(raw);
  assert.equal(parsed.type, "channel:create");
  assert.equal((parsed as { name: string }).name, "demo");
});

test("resolveActionInput strips a leading UTF-8 BOM from stdin JSON", async () => {
  const input = Readable.from([
    `\uFEFF${JSON.stringify({
      type: "channel:create",
      name: "powershell-bom",
      visibility: "public",
    })}`,
  ]);

  const raw = await resolveActionInput(input);
  const parsed = actionCardActionSchema.parse(raw);
  assert.equal(parsed.type, "channel:create");
  assert.equal((parsed as { name: string }).name, "powershell-bom");
});

test("resolveActionInput parses agent:create with only name + description", async () => {
  const input = Readable.from([
    JSON.stringify({
      type: "agent:create",
      name: "scout",
      description: "scouts the channel for incoming work",
    }),
  ]);

  const raw = await resolveActionInput(input);
  const parsed = actionCardActionSchema.parse(raw);
  assert.equal(parsed.type, "agent:create");
});

test("actionCardActionSchema accepts structured computer placement on agent:create", () => {
  const result = actionCardActionSchema.safeParse({
    type: "agent:create",
    name: "scout",
    description: "scouts the channel for incoming work",
    requiredComputer: "tygg-ec2",
  });
  assert.ok(result.success);
  if (result.success) {
    assert.equal(result.data.type, "agent:create");
    assert.equal(result.data.requiredComputer, "tygg-ec2");
    assert.equal(validateActionCardAction(result.data), null);
  }
});

test("validateActionCardAction rejects both suggested and required computers", () => {
  const result = actionCardActionSchema.safeParse({
    type: "agent:create",
    name: "scout",
    suggestedComputer: "maria",
    requiredComputer: "tygg-ec2",
  });
  assert.ok(result.success);
  const err = result.success ? validateActionCardAction(result.data) : null;
  assert.equal(err, "agent:create must include only one of suggestedComputer or requiredComputer");
});

test("resolveActionInput rejects empty stdin", async () => {
  await assert.rejects(
    () => resolveActionInput(Readable.from([])),
    (err) =>
      err instanceof PrepareActionInputError &&
      err.code === "MISSING_ACTION" &&
      err.message.includes("<<'RAFTACTION'") &&
      !err.message.includes("<<'EOF'"),
  );
});

test("resolveActionInput rejects whitespace-only stdin", async () => {
  await assert.rejects(
    () => resolveActionInput(Readable.from(["\n  \t\n"])),
    (err) => err instanceof PrepareActionInputError && err.code === "MISSING_ACTION",
  );
});

test("resolveActionInput rejects TTY stdin without reading", async () => {
  const input = Readable.from(["{\"type\":\"channel:create\",\"name\":\"x\"}"]);
  Object.defineProperty(input, "isTTY", { value: true });

  await assert.rejects(
    () => resolveActionInput(input),
    (err) => err instanceof PrepareActionInputError && err.code === "MISSING_ACTION",
  );
});

test("resolveActionInput surfaces a parse error for invalid JSON", async () => {
  const input = Readable.from(["{not valid json"]);

  await assert.rejects(
    () => resolveActionInput(input),
    (err) =>
      err instanceof PrepareActionInputError &&
      err.code === "INVALID_JSON" &&
      err.message.includes("failed to parse"),
  );
});

test("actionCardActionSchema accepts channel:add_member with at least one human", () => {
  // Added in #proj-permission task #2 (xxchan / stdrc msg=670d903f).
  // Field names renamed `*Id`/`*Ids` → bare nouns per xxchan
  // #engineering msg=d22fb886 (2026-05-11) — they accept handles too.
  const result = actionCardActionSchema.safeParse({
    type: "channel:add_member",
    channel: "00000000-0000-0000-0000-000000000000",
    humans: ["11111111-1111-4111-8111-111111111111"],
    draftHint: "pull alice in for the prep review",
  });
  assert.ok(result.success);
});

test("actionCardActionSchema accepts channel:add_member with only agents", () => {
  const result = actionCardActionSchema.safeParse({
    type: "channel:add_member",
    channel: "00000000-0000-0000-0000-000000000000",
    agents: ["22222222-2222-4222-8222-222222222222"],
  });
  assert.ok(result.success);
});

test("validateActionCardAction rejects channel:add_member with no humans and no agents", () => {
  // Preparing a card with an empty member list would render an empty
  // dialog — the cross-field validator enforces at least one of
  // humans/agents to be non-empty so this is caught at the agent
  // boundary. The constraint lives outside the discriminated-union schema
  // because zod's discriminatedUnion requires plain ZodObject options
  // (no ZodEffects).
  const parsed = actionCardActionSchema.safeParse({
    type: "channel:add_member",
    channel: "00000000-0000-0000-0000-000000000000",
  });
  assert.ok(parsed.success);
  const err = parsed.success ? validateActionCardAction(parsed.data) : null;
  assert.equal(err, "channel:add_member must include at least one human or agent");
});

test("validateActionCardAction returns null for valid channel:add_member", () => {
  const parsed = actionCardActionSchema.safeParse({
    type: "channel:add_member",
    channel: "00000000-0000-0000-0000-000000000000",
    humans: ["11111111-1111-4111-8111-111111111111"],
  });
  assert.ok(parsed.success);
  assert.equal(parsed.success ? validateActionCardAction(parsed.data) : "no parse", null);
});

test("actionCardActionSchema rejects migration:export", () => {
  const parsed = actionCardActionSchema.safeParse({
    type: "migration:export",
    targetComputer: "target-mac",
    mode: "cooperative",
    prepDeadlineMs: 60_000,
  });
  assert.equal(parsed.success, false);
});

test("actionCardActionSchema accepts handles for channel / humans / agents", () => {
  // Handle resolution happens server-side at prepare time (see
  // actionCardsService.prepareActionCard → resolveActionHandles). The
  // schema only validates the surface shape; "@alice" / "#general" /
  // bare names are all valid strings here.
  const result = actionCardActionSchema.safeParse({
    type: "channel:add_member",
    channel: "#general",
    humans: ["@alice", "bob"],
    agents: ["@scout"],
  });
  assert.ok(result.success);
});

test("actionCardActionSchema accepts handles for channel:create initial members", () => {
  const result = actionCardActionSchema.safeParse({
    type: "channel:create",
    name: "design-review",
    visibility: "public",
    initialHumans: ["@alice", "@bob"],
    initialAgents: ["@scout", "patches"],
  });
  assert.ok(result.success);
});

test("actionCardActionSchema rejects empty-string channel reference", () => {
  // Empty strings are caught at the schema level (`z.string().min(1)`),
  // not at server resolution.
  const result = actionCardActionSchema.safeParse({
    type: "channel:add_member",
    channel: "",
    humans: ["@alice"],
  });
  assert.equal(result.success, false);
});

test("looksLikeUuid accepts canonical v1-v8 / nil / max UUIDs", () => {
  assert.equal(looksLikeUuid("11111111-1111-4111-8111-111111111111"), true);
  assert.equal(looksLikeUuid("00000000-0000-0000-0000-000000000000"), true);
  assert.equal(looksLikeUuid("ffffffff-ffff-ffff-ffff-ffffffffffff"), true);
});

test("looksLikeUuid rejects handles and malformed strings", () => {
  assert.equal(looksLikeUuid("@alice"), false);
  assert.equal(looksLikeUuid("#general"), false);
  assert.equal(looksLikeUuid("alice"), false);
  assert.equal(looksLikeUuid("not-a-uuid"), false);
  assert.equal(looksLikeUuid(""), false);
  // Wrong variant nibble (position 19 must be 8/9/a/b).
  assert.equal(looksLikeUuid("11111111-1111-4111-1111-111111111111"), false);
  // Wrong version nibble (position 14 must be 1-8).
  assert.equal(looksLikeUuid("11111111-1111-9111-8111-111111111111"), false);
});

test("extractHandleName strips the sigil when present and trims", () => {
  assert.equal(extractHandleName("@alice", "@"), "alice");
  assert.equal(extractHandleName("alice", "@"), "alice");
  assert.equal(extractHandleName("  @alice  ", "@"), "alice");
  assert.equal(extractHandleName("#general", "#"), "general");
  assert.equal(extractHandleName("general", "#"), "general");
  // Don't strip the wrong sigil.
  assert.equal(extractHandleName("@alice", "#"), "@alice");
});

test("actionCardActionSchema drops an agent-prefilled runtime on agent:create; a model needs hosting antiproton", () => {
  // Per stdrc 2026-05-10 #proj-approval msg=ae4ecedd: technical fields
  // (runtime / model / reasoningEffort) are a human prerogative,
  // not agent-prefillable. Computer placement is now a structured,
  // validated suggested/required constraint. Schema enforces this; the Server
  // checks every card with this shared schema and validator. The only
  // runtime an agent may name is `suggestedRuntime`, a starting point the
  // person can change (the Server checks the id at prepare).
  const result = actionCardActionSchema.safeParse({
    type: "agent:create",
    name: "scout",
    runtime: "claude",
    model: "opus",
  } as unknown);
  // Extra fields are allowed by passthrough on object schemas, but the
  // Server keeps only the parsed (.data) shape, so technical fields are
  // dropped before the card is stored. We assert that the parsed data
  // does NOT carry the rejected fields back through.
  // Exception (tygg/Tenny 2026-10-13, #raft-antiproton:8008c6f0): a hosted
  // agent's model may be preset, and only with `hosting: "antiproton"`.
  assert.ok(result.success);
  if (result.success) {
    assert.equal((result.data as Record<string, unknown>).runtime, undefined);
    assert.match(validateActionCardAction(result.data) ?? "", /model is only for a cloud agent \(hosting: "antiproton"\)/);
  }
  const hosted = actionCardActionSchema.safeParse({ type: "agent:create", name: "scout", hosting: "antiproton", model: "gpt-5.6-luna" });
  assert.ok(hosted.success);
  if (hosted.success) {
    assert.equal(validateActionCardAction(hosted.data), null);
    assert.equal((hosted.data as Record<string, unknown>).model, "gpt-5.6-luna");
  }
});

test("raft action prepare --help: its question:ask examples are valid cards, piped through a heredoc; the second is a confirm card (one option)", () => {
  const help = actionPrepareCommand.spec.helpAfter ?? "";
  const examples = [...help.matchAll(/raft action prepare --target "#ops" <<'RAFTACTION'\n\s*(\{.*\})\n\s*RAFTACTION/g)];
  assert.equal(examples.length, 2, help);
  const cards = examples.map((example) => {
    const parsed = actionCardActionSchema.safeParse(JSON.parse(example[1]!));
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    assert.equal(parsed.data?.type, "question:ask");
    return parsed.data as { questions: { options?: unknown[] }[] };
  });
  assert.deepEqual(cards.map((card) => card.questions.map((question) => question.options?.length)), [[2], [1]]);
  assert.match(help, /take 1-4 options/);
  assert.match(help, /One option makes a confirm card/);
});

test("question:ask: a question of one option is a valid card; none, or one with Other…, is not", () => {
  const card = (question: Record<string, unknown>) => ({ type: "question:ask", to: "@tenny", questions: [{ id: "ack", kind: "single", text: "Seen it?", ...question }] });
  assert.equal(actionCardActionSchema.safeParse(card({ options: [{ value: "ok", label: "Got it" }] })).success, true);
  assert.equal(actionCardActionSchema.safeParse(card({ kind: "multiple", options: [{ value: "ok", label: "Got it" }] })).success, true);
  assert.equal(actionCardActionSchema.safeParse(card({ options: [] })).success, false);
  assert.equal(actionCardActionSchema.safeParse(card({ options: [{ value: "ok", label: "Got it" }], other: {} })).success, false);
});

// RFC 085 §4.2 discovery: what the agent can prepare as a request card, as the Server lists it.
const OPERATIONS = {
  enabled: true,
  operations: [
    {
      operation: "agent:stop",
      summary: "Stop an agent.",
      args: [{ name: "agent", description: "the agent's handle, as `raft server info --agents` lists it", required: true }],
      confirmer: "a server owner or admin, or the agent's creator",
      personSees: { title: "Stop <agent>", button: "Stop agent" },
      example: { agent: "@builder" },
    },
    {
      operation: "channel:remove_admin",
      summary: "Make a channel admin an ordinary member of the channel (never the other way).",
      args: [
        { name: "channel", description: "the channel, as #name", required: true },
        { name: "member", description: "the channel admin's handle", required: true },
        { name: "why", description: "a line\nwith a break", required: false },
      ],
      confirmer: "a server owner or admin, or a channel admin of that channel (on a joint channel, an owner or admin of its host server)",
      personSees: { title: "Remove channel admin from <member> in <channel>", button: "Remove channel admin" },
      example: { channel: "#ops", member: "@alice" },
    },
  ],
};

test("raft action prepare --list prints what can be prepared as a request card, ending with the command that prepares the first", async () => {
  const run = await runPinned(["action", "prepare", "--list"], [{ method: "GET", path: /\/prepare-action\/operations$/, data: OPERATIONS }]);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.deepEqual(run.requests.map((request) => request.method), ["GET"], "nothing is prepared or posted");
  assert.equal(run.stdout, [
    "Operations you can prepare as a request card here (the person you name confirms; it runs as them):",
    "",
    "agent:stop: Stop an agent.",
    "  arg agent: the agent's handle, as `raft server info --agents` lists it",
    "  ask: a server owner or admin, or the agent's creator",
    "  they see: \"Stop <agent>\" and a \"Stop agent\" button",
    "channel:remove_admin: Make a channel admin an ordinary member of the channel (never the other way).",
    "  arg channel: the channel, as #name",
    "  arg member: the channel admin's handle",
    // A line break in any field never starts a line of its own.
    "  arg why (optional): a line with a break",
    "  ask: a server owner or admin, or a channel admin of that channel (on a joint channel, an owner or admin of its host server)",
    "  they see: \"Remove channel admin from <member> in <channel>\" and a \"Remove channel admin\" button",
    "",
    "Prepare one where the person can act (a DM with them, or a channel they are in):",
    "  raft action prepare --target \"dm:@<person>\" <<'RAFTACTION'",
    "  {\"type\":\"request:prepare\",\"to\":\"@<person>\",\"operation\":\"agent:stop\",\"args\":{\"agent\":\"@builder\"},\"note\":\"<why, in one sentence>\"}",
    "  RAFTACTION",
    "",
  ].join("\n"));
  // The printed command runs as printed: its here-string is a card the CLI sends as written.
  const command = /raft action prepare --target "([^"]+)" <<'RAFTACTION'\n {2}(.*)\n {2}RAFTACTION\n$/.exec(run.stdout)!;
  const sent = await runPinned(["action", "prepare", "--target", command[1]!], [{ method: "POST", path: /prepare-action$/, data: PREPARED }], command[2]!);
  assert.equal(sent.exitCode, 0, sent.stderr);
  assert.deepEqual((sent.requests[0]?.body as { action?: unknown }).action, { type: "request:prepare", to: "@<person>", operation: "agent:stop", args: { agent: "@builder" }, note: "<why, in one sentence>" });
});

test("raft action prepare --list: none to prepare says why and what to do instead; a Server too old to list them says so", async () => {
  const off = await runPinned(["action", "prepare", "--list"], [{ method: "GET", path: /\/prepare-action\/operations$/, data: { enabled: false, operations: [] } }]);
  assert.equal(off.exitCode, 0, off.stderr);
  assert.equal(off.stdout, "You can't prepare any operation as a request card here: request cards are off on this server. Ask the person in a message to do it themselves in Raft: raft message send --target \"dm:@<person>\" <<<'<your reply>'\n");
  const none = await runPinned(["action", "prepare", "--list"], [{ method: "GET", path: /\/prepare-action\/operations$/, data: { enabled: true, operations: [] } }]);
  assert.match(none.stdout, /: none is listed on this server yet\. Ask the person in a message/);

  const old = await runPinned(["action", "prepare", "--list"], [{ method: "GET", path: /\/prepare-action\/operations$/, response: { ok: false, status: 404, error: "Not found", data: null } as never }]);
  assert.equal(old.exitCode, 1);
  assert.equal(old.stdout, "");
  assert.equal(old.stderr, [
    "Error: This Raft Server can't list the operations you can prepare as a request card (it is older than this command).",
    "Code: LIST_UNAVAILABLE",
    "Retryable: no",
    "Next action: Ask the person in a message to do it themselves in Raft: raft message send --target \"dm:@<person>\" <<<'<your reply>'",
    "",
  ].join("\n"));
});

test("raft action prepare: a request card echoes the summary the person sees, whom it is for, where the result arrives and how to withdraw it", async () => {
  const id = "1a2b3c4d-1111-4222-8333-444455556666";
  const action = { type: "request:prepare", to: "@tenny", operation: "agent:stop", args: { agent: "@builder" }, note: "It loops." };
  const answer = {
    messageId: id,
    metadata: { kind: "action-card", state: "prepared" },
    preparedRequest: { summary: "Stop @builder (Agent: @builder)", title: "Stop @builder", for: "@tenny", operation: "agent:stop", result: "reply" },
  };
  const run = await runPinned(["action", "prepare", "--target", "#ops"], [{ method: "POST", path: /prepare-action$/, data: answer }], JSON.stringify(action));
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(
    run.stdout,
    `Request card posted to #ops as message ${id} (short 1a2b3c4d) for @tenny. It shows them: Stop @builder. When they confirm or decline it, the result arrives as a reply in the card's thread that @mentions you; you do not need to poll. If you no longer need it, withdraw it with: raft action withdraw --message 1a2b3c4d\n`,
  );
  // An older Server that echoes nothing: the generic line.
  const older = await runPinned(["action", "prepare", "--target", "#ops"], [{ method: "POST", path: /prepare-action$/, data: { messageId: id, metadata: { kind: "action-card" } } }], JSON.stringify(action));
  assert.match(older.stdout, /^Action card posted to #ops as message /);
});

test("raft action prepare --help points at --list for request cards", async () => {
  const help = (await runPinned(["action", "prepare", "--help"], [])).stdout;
  assert.match(help, /--list +List the operations you can prepare as a request card/);
  assert.match(help, /request:prepare.*\n.*\n.*\n {2}raft action prepare --list/);
});

test("actionCardActionSchema keeps agent:create's suggestedRuntime; it is not for a cloud agent", () => {
  const result = actionCardActionSchema.safeParse({ type: "agent:create", name: "scout", suggestedRuntime: "codex" });
  assert.ok(result.success);
  if (result.success) {
    assert.equal((result.data as Record<string, unknown>).suggestedRuntime, "codex");
    assert.equal(validateActionCardAction(result.data), null);
  }
  const hosted = actionCardActionSchema.safeParse({ type: "agent:create", name: "scout", hosting: "antiproton", suggestedRuntime: "codex" });
  assert.ok(hosted.success);
  if (hosted.success) assert.match(validateActionCardAction(hosted.data) ?? "", /leave out suggestedRuntime/);
});
