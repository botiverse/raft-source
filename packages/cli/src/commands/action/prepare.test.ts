import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  actionCardActionSchema,
  extractHandleName,
  looksLikeUuid,
  validateActionCardAction,
} from "@botiverse/raft-shared";

import { resolveActionInput, PrepareActionInputError } from "./prepare.js";

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

test("actionCardActionSchema rejects agent-prefilled runtime/model fields on agent:create", () => {
  // Per stdrc 2026-05-10 #proj-approval msg=ae4ecedd: technical fields
  // (runtime / model / reasoningEffort) are a human prerogative,
  // not agent-prefillable. Computer placement is now a structured,
  // validated suggested/required constraint. Schema enforces this; the CLI inherits the
  // restriction for free by reusing the shared validator.
  const result = actionCardActionSchema.safeParse({
    type: "agent:create",
    name: "scout",
    runtime: "claude",
    model: "opus",
  } as unknown);
  // Extra fields are allowed by passthrough on object schemas, but the
  // CLI only forwards the parsed (.data) shape, so technical fields are
  // dropped before reaching the server. We assert that the parsed data
  // does NOT carry the rejected fields back through.
  assert.ok(result.success);
  if (result.success) {
    assert.equal((result.data as Record<string, unknown>).runtime, undefined);
    assert.equal((result.data as Record<string, unknown>).model, undefined);
  }
});
