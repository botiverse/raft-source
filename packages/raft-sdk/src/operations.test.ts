import assert from "node:assert/strict";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AGENT_API_ROUTE_META } from "@botiverse/raft-shared/src/agentApiRouteMeta";
import { buildRaftOperationsDocument, lookupRaftOperation, raftOperationRoutes } from "./operations";
import { RAFT_JSON_SCHEMA_KEYWORDS, type RaftJsonSchema } from "./toolSchema";
import { RAFT_OPERATIONS, RAFT_OPERATIONS_VERSION, raftToolNameFor } from "./index";
import { toRaftToolInputSchema } from "./toolSchema";
import { OPERATION_SAMPLES } from "./operationSamples.testkit";

// Name stability: a rename must add a new entry and mark the old one
// `deprecated: true` (still dispatchable) for at least one minor release.
// Never edit a pair here without that phase.
const NAME_PAIRS: Array<[string, string]> = [
  ["identity.whoami", "identity_whoami"],
  ["inbox.check", "inbox_check"],
  ["inbox.drain", "inbox_drain"],
  ["inbox.commit", "inbox_commit"],
  ["inbox.list", "inbox_list"],
  ["inbox.read", "inbox_read"],
  ["messages.read", "messages_read"],
  ["messages.send", "messages_send"],
  ["messages.reply", "messages_reply"],
  ["messages.search", "messages_search"],
  ["messages.resolve", "messages_resolve"],
  ["messages.react", "messages_react"],
  ["messages.unreact", "messages_unreact"],
  ["messages.updateCard", "messages_update_card"],
  ["attachments.downloadUrl", "attachments_download_url"],
  ["attachments.comments", "attachments_comments"],
  ["artifacts.list", "artifacts_list"],
  ["artifacts.read", "artifacts_read"],
  ["artifacts.comments", "artifacts_comments"],
  ["artifacts.fileContent", "artifacts_file_content"],
  ["artifacts.push", "artifacts_push"],
  ["artifacts.comment", "artifacts_comment"],
  ["artifacts.review", "artifacts_review"],
  ["artifacts.resolve", "artifacts_resolve"],
  ["artifacts.reopen", "artifacts_reopen"],
  ["artifacts.follow", "artifacts_follow"],
  ["artifacts.unfollow", "artifacts_unfollow"],
  ["artifacts.move", "artifacts_move"],
  ["artifacts.delete", "artifacts_delete"],
  ["artifacts.saveAttachment", "artifacts_save_attachment"],
  ["artifacts.check", "artifacts_check"],

  ["mentions.pending", "mentions_pending"],
  ["mentions.notify", "mentions_notify"],
  ["mentions.add", "mentions_add"],
  ["mentions.delivery", "mentions_delivery"],
  ["actions.prepare", "actions_prepare"],
  ["actions.withdraw", "actions_withdraw"],
  ["manual.get", "manual_get"],
  ["manual.search", "manual_search"],
  ["tasks.claim", "tasks_claim"],
  ["tasks.list", "tasks_list"],
  ["tasks.create", "tasks_create"],
  ["tasks.unclaim", "tasks_unclaim"],
  ["tasks.assign", "tasks_assign"],
  ["tasks.unassign", "tasks_unassign"],
  ["tasks.updateStatus", "tasks_update_status"],
  ["tasks.amend", "tasks_amend"],
  ["tasks.history", "tasks_history"],
  ["tasks.show", "tasks_show"],
  ["tasks.convert", "tasks_convert"],
  ["tasks.delete", "tasks_delete"],
  ["channels.join", "channels_join"],
  ["channels.leave", "channels_leave"],
  ["channels.mute", "channels_mute"],
  ["channels.unmute", "channels_unmute"],
  ["channels.members", "channels_members"],
  ["channels.info", "channels_info"],
  ["channels.create", "channels_create"],
  ["channels.update", "channels_update"],
  ["channels.archive", "channels_archive"],
  ["channels.unarchive", "channels_unarchive"],
  ["channels.addMember", "channels_add_member"],
  ["channels.removeMember", "channels_remove_member"],
  ["threads.list", "threads_list"],
  ["threads.unfollow", "threads_unfollow"],
  ["server.info", "server_info"],
  ["server.update", "server_update"],
  ["labs.list", "labs_list"],
  ["labs.setAccess", "labs_set_access"],
  ["labs.setEnrollment", "labs_set_enrollment"],
  ["users.info", "users_info"],
  ["profile.show", "profile_show"],
  ["profile.update", "profile_update"],
  ["raftbench.findings", "raftbench_findings"],
];

test("manifest snapshot: every (name, toolName) pair is pinned", () => {
  assert.deepEqual(RAFT_OPERATIONS.map((op) => [op.name, op.toolName]), NAME_PAIRS);
  for (const op of RAFT_OPERATIONS) {
    assert.match(op.toolName, /^[a-z0-9_]+$/);
    assert.equal(op.toolName, raftToolNameFor(op.name), `${op.name}: toolName is the snake form of the name`);
    assert.ok(op.description.length > 0 && op.description.split(/(?<=\.)\s/).length <= 3, `${op.name}: 1–3 sentences`);
    // A model only knows what a field means from its description.
    for (const [field, schema] of Object.entries(op.inputSchema.properties ?? {})) {
      assert.ok(typeof (schema as RaftJsonSchema).description === "string" && (schema as RaftJsonSchema).description!.length > 0, `${op.name}.${field}: has a description`);
    }
  }
  assert.equal(new Set(RAFT_OPERATIONS.map((op) => op.toolName)).size, RAFT_OPERATIONS.length);
});

test("every deprecated operation names an existing, non-deprecated replacement in its description", () => {
  const byName = new Map(RAFT_OPERATIONS.map((op) => [op.name, op]));
  for (const op of RAFT_OPERATIONS.filter((candidate) => candidate.deprecated)) {
    const named = /^Deprecated: use ([^.]+(?:\.[A-Za-z]+)+(?: \/ [a-z]+(?:\.[A-Za-z]+)+)*)\./.exec(op.description);
    assert.ok(named, `${op.name}: description starts with "Deprecated: use <replacement>."`);
    for (const replacement of named[1].split(" / ")) {
      const target = byName.get(replacement);
      assert.ok(target, `${op.name}: replacement ${replacement} is in the manifest`);
      assert.notEqual(target.deprecated, true, `${op.name}: replacement ${replacement} is not itself deprecated`);
    }
  }
});

// Derived from the shared route meta and contract: a change there shows up here as a reviewed diff.
// [sideEffect, idempotency (key arg when keyed), capability, routes]
const DERIVED: Record<string, [string, string, string, string]> = {
  "identity.whoami": ["read", "natural", "read", "agentContext"],
  "inbox.check": ["write", "none", "read", "events"],
  "inbox.drain": ["write", "none", "read", "events"],
  "inbox.commit": ["write", "natural", "", ""],
  "inbox.list": ["read", "natural", "read", "inboxList"],
  "inbox.read": ["write", "none", "read", "inboxRead"],
  "messages.read": ["read", "natural", "read", "historyRead"],
  "messages.send": ["write", "key:idempotencyKey", "send", "messageSendV2"],
  "messages.reply": ["write", "key:idempotencyKey", "send", "messageSendV2"],
  "messages.search": ["read", "natural", "read", "messageSearch+artifactList"],
  "messages.resolve": ["read", "natural", "read", "messageResolve"],
  "messages.react": ["write", "natural", "reactions", "messageReactionAdd"],
  "messages.unreact": ["write", "natural", "reactions", "messageReactionRemove"],
  "messages.updateCard": ["write", "key:idempotencyKey", "send", "messageCardUpdate"],
  "attachments.downloadUrl": ["read", "natural", "read", "attachmentDownloadUrl"],
  "attachments.comments": ["read", "natural", "read", "attachmentCommentsList"],
  "artifacts.list": ["read", "natural", "read", "artifactList"],
  "artifacts.read": ["read", "natural", "read", "artifactRead"],
  "artifacts.comments": ["read", "natural", "read", "artifactComments"],
  "artifacts.fileContent": ["read", "natural", "read", "artifactFileContent"],
  "artifacts.push": ["write", "natural", "send", "artifactPublish"],
  "artifacts.comment": ["write", "none", "send", "artifactComment"],
  "artifacts.review": ["write", "key:idempotencyKey", "send", "artifactReview"],
  "artifacts.resolve": ["write", "natural", "send", "artifactCommentResolve"],
  "artifacts.reopen": ["write", "natural", "send", "artifactCommentReopen"],
  "artifacts.follow": ["write", "natural", "send", "artifactSubscribe"],
  "artifacts.unfollow": ["write", "natural", "send", "artifactUnsubscribe"],
  "artifacts.move": ["write", "none", "send", "artifactMove"],
  "artifacts.delete": ["write", "none", "send", "artifactDelete"],
  "artifacts.saveAttachment": ["write", "natural", "send", "artifactSaveAttachment"],
  "artifacts.check": ["read", "natural", "read", "artifactCheck"],

  "mentions.pending": ["read", "natural", "mentions", "mentionActionsPending"],
  "mentions.notify": ["write", "none", "mentions", "mentionActionsExecute"],
  "mentions.add": ["write", "none", "mentions", "mentionActionsExecute"],
  "mentions.delivery": ["read", "natural", "mentions", "senderMentionDeliveries"],
  "actions.prepare": ["write", "key:idempotencyKey", "tasks", "actionPrepare"],
  "actions.withdraw": ["write", "natural", "tasks", "actionWithdraw"],
  "manual.get": ["read", "natural", "knowledge", "knowledgeGet"],
  "raftbench.findings": ["read", "natural", "read", "raftbenchFindings"],
  "manual.search": ["read", "natural", "knowledge", "knowledgeSearch"],
  "tasks.claim": ["write", "none", "tasks", "taskClaim"],
  "tasks.list": ["read", "natural", "tasks", "taskList"],
  "tasks.create": ["write", "key:idempotencyKey", "tasks", "taskCreate"],
  "tasks.unclaim": ["write", "none", "tasks", "taskUnclaim"],
  "tasks.assign": ["write", "natural", "tasks", "taskAssign"],
  "tasks.unassign": ["write", "natural", "tasks", "taskAssign"],
  "tasks.updateStatus": ["write", "natural", "tasks", "taskUpdateStatus"],
  "tasks.amend": ["write", "none", "tasks", "taskAmend"],
  "tasks.history": ["read", "natural", "tasks", "taskHistory"],
  "tasks.show": ["read", "natural", "tasks", "taskList"],
  "tasks.convert": ["write", "none", "tasks", "taskConvert"],
  "tasks.delete": ["write", "none", "tasks", "taskDelete"],
  "channels.join": ["write", "natural", "channels+read", "serverInfo+channelJoin"],
  "channels.leave": ["write", "natural", "channels+read", "serverInfo+channelLeave"],
  "channels.mute": ["write", "natural", "channels+read", "serverInfo+channelMute"],
  "channels.unmute": ["write", "natural", "channels+read", "serverInfo+channelUnmute"],
  "channels.members": ["read", "natural", "channels", "channelMembers"],
  "channels.info": ["read", "natural", "channels+read", "serverInfo+channelMembers"],
  "channels.create": ["write", "none", "channels", "channelCreate"],
  "channels.update": ["write", "natural", "channels+read", "serverInfo+channelUpdate"],
  "channels.archive": ["write", "natural", "channels", "channelArchive"],
  "channels.unarchive": ["write", "natural", "channels", "channelUnarchive"],
  "channels.addMember": ["write", "natural", "channels+read", "serverInfo+channelMemberAdd"],
  "channels.removeMember": ["write", "natural", "channels+read", "serverInfo+channelMemberRemove"],
  "threads.list": ["read", "natural", "channels", "threadList"],
  "threads.unfollow": ["write", "natural", "channels", "threadUnfollow"],
  "server.info": ["read", "natural", "read", "serverInfo"],
  "server.update": ["write", "natural", "server", "serverUpdate"],
  "labs.list": ["read", "natural", "read", "serverLabs"],
  "labs.setAccess": ["write", "natural", "read+server", "serverLabs+serverLabsAccess"],
  "labs.setEnrollment": ["write", "natural", "read+server", "serverLabs+serverLabEnrollment"],
  "users.info": ["read", "natural", "channels+read", "userChannels+serverInfo"],
  "profile.show": ["read", "natural", "read", "profileShow"],
  "profile.update": ["write", "natural", "send", "profileUpdate"],
};

test("derived fields: sideEffect / idempotency / capability per operation, from the route meta", () => {
  const actual: Record<string, [string, string, string, string]> = {};
  for (const op of RAFT_OPERATIONS) {
    actual[op.name] = [
      op.sideEffect,
      op.idempotency.kind === "key" ? `key:${op.idempotency.arg}` : op.idempotency.kind,
      op.capability.join("+"),
      raftOperationRoutes(op.name).join("+"),
    ];
    // Cross-check the derivation rule itself against the raw route meta.
    const metas = raftOperationRoutes(op.name).map((route) => AGENT_API_ROUTE_META[route]);
    if (metas.some((meta) => meta.sideEffect !== "read")) assert.equal(op.sideEffect, "write", op.name);
    if (metas.some((meta) => meta.idempotency === "none")) assert.equal(op.idempotency.kind, "none", op.name);
  }
  assert.deepEqual(actual, DERIVED);
});

test("modelOnly is exactly consumes.code === \"refused\"; interrupts and consumption are declared as designed", () => {
  for (const op of RAFT_OPERATIONS) assert.equal(op.modelOnly, op.consumes.code === "refused", op.name);
  assert.deepEqual(RAFT_OPERATIONS.filter((op) => op.modelOnly).map((op) => op.name), ["inbox.check", "inbox.drain", "inbox.commit", "inbox.read"]);
  assert.deepEqual(
    RAFT_OPERATIONS.filter((op) => op.mayInterrupt).map((op) => op.name),
    ["messages.send", "messages.reply", "tasks.claim", "tasks.updateStatus", "tasks.amend"],
  );
  const read = RAFT_OPERATIONS.find((op) => op.name === "messages.read")!;
  assert.deepEqual(read.consumes, { model: ["read_cursor", "seen"], code: [] });
  assert.deepEqual(read.output, { mayBeLarge: true, boundBy: ["after", "before", "around", "limit"] });
  for (const name of ["inbox.check", "inbox.drain"]) {
    assert.deepEqual(RAFT_OPERATIONS.find((op) => op.name === name)!.consumes, { model: ["inbox", "seen"], code: "refused" });
  }
  for (const op of RAFT_OPERATIONS) {
    const properties = Object.keys(op.inputSchema.properties ?? {});
    for (const arg of op.output.boundBy) assert.ok(properties.includes(arg), `${op.name}: boundBy ${arg} is an argument`);
    if (op.idempotency.kind === "key") assert.ok(properties.includes(op.idempotency.arg), `${op.name}: key arg is an argument`);
  }
});

const FORBIDDEN = ["$ref", "$defs", "definitions", "oneOf", "anyOf", "allOf", "not", "const", "$schema", "if", "then", "else"];
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function assertSubset(schema: RaftJsonSchema, where: string): void {
  for (const key of Object.keys(schema)) {
    assert.ok(!FORBIDDEN.includes(key), `${where}: forbidden keyword ${key}`);
    assert.ok((RAFT_JSON_SCHEMA_KEYWORDS as readonly string[]).includes(key), `${where}: keyword ${key} is outside the subset`);
  }
  if (schema.type !== undefined) {
    assert.equal(typeof schema.type, "string", `${where}: type is one name, never an array`);
    assert.ok(TYPES.has(schema.type), `${where}: type ${String(schema.type)}`);
    assert.notEqual(schema.type, "null", `${where}: no null type (nullable fields are optional instead)`);
  }
  const types = schema.type === undefined ? [] : [schema.type];
  if (schema.properties) {
    assert.deepEqual(types, ["object"], `${where}: properties only on objects`);
    for (const [key, value] of Object.entries(schema.properties)) assertSubset(value, `${where}.${key}`);
  }
  for (const key of schema.required ?? []) assert.ok(schema.properties && key in schema.properties, `${where}: required ${key} is a property`);
  if (schema.items) {
    assert.deepEqual(types, ["array"], `${where}: items only on arrays`);
    assertSubset(schema.items, `${where}[]`);
  }
  if (types.includes("array")) assert.ok(schema.items, `${where}: arrays declare items`);
  if (schema.enum) assert.ok(schema.enum.length > 0, `${where}: enum non-empty`);
}

/** A validator for exactly the subset: what a strict gateway would check. */
function jsonValid(schema: RaftJsonSchema, value: unknown): boolean {
  const types = schema.type === undefined ? [] : [schema.type];
  const typeOf = (v: unknown) => v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;
  const actual = typeOf(value);
  if (types.length > 0 && !types.some((t) => t === actual || (t === "number" && actual === "integer"))) return false;
  if (schema.enum && !schema.enum.includes(value as never)) return false;
  if (typeof value === "string" && ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength))) return false;
  if (typeof value === "number" && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) return false;
  if (Array.isArray(value) && schema.items) return value.every((item) => jsonValid(schema.items!, item));
  if (actual === "object" && schema.properties) {
    const record = value as Record<string, unknown>;
    if ((schema.required ?? []).some((key) => !(key in record))) return false;
    return Object.entries(record).every(([key, v]) => !schema.properties![key] || jsonValid(schema.properties![key]!, v));
  }
  return true;
}

test("every inputSchema stays inside the conservative JSON Schema subset", () => {
  for (const op of RAFT_OPERATIONS) {
    assert.equal(op.inputSchema.type, "object", op.name);
    assertSubset(op.inputSchema, op.name);
  }
  // Flattened unions: actions.prepare's card is one object with a type enum; only `type` is required.
  const action = RAFT_OPERATIONS.find((op) => op.name === "actions.prepare")!.inputSchema.properties!.action!;
  assert.deepEqual(action.required, ["type"]);
  assert.ok(action.properties!.type!.enum!.includes("channel:create"));
  assert.match(action.properties!.visibility!.description!, /Only for type channel:create\./);
  // Nullable fields are their non-null type and optional (omitted = null); a seq-or-id union is advertised as a string.
  const amend = RAFT_OPERATIONS.find((op) => op.name === "tasks.amend")!.inputSchema;
  assert.equal(amend.properties!.description!.type, "string");
  assert.ok(!amend.required!.includes("description"));
  const assign = RAFT_OPERATIONS.find((op) => op.name === "tasks.assign")!.inputSchema;
  assert.equal(assign.properties!.assignee!.type, "string");
  assert.deepEqual(assign.required, ["target", "taskNumber", "assignee"], "an omitted assignee is an error, never a silent clear");
  const read = RAFT_OPERATIONS.find((op) => op.name === "messages.read")!.inputSchema;
  assert.equal(read.properties!.around!.type, "string");
  // Code-only knobs are accepted at runtime but not advertised to models.
  const send = RAFT_OPERATIONS.find((op) => op.name === "messages.send")!.inputSchema;
  assert.equal(send.properties!.seen, undefined);
});

// Spelled the JSON way: a seq `around` as its string, null as an omitted field
// (invoke.test.ts checks the runtime treats those spellings the same).
test("the JSON projection is never stricter than the runtime: every runtime-valid sample is JSON-valid", () => {
  const extra: Record<string, unknown[]> = {
    "messages.read": [{ target: "#a", around: "12" }, { target: "#a", around: "abcd1234" }],
    "tasks.amend": [{ target: "#a", taskNumber: 1, description: "" }],
    "actions.prepare": [
      { target: "#a", action: { type: "agent:create", name: "x".repeat(60) } },
      { target: "#a", action: { type: "integration:register_app", name: "x".repeat(120), returnUrl: "https://e.example" } },
      { target: "#a", action: { type: "channel:add_member", channel: "#a", humans: ["@h"] } },
    ],
  };
  for (const op of RAFT_OPERATIONS) {
    const { schema } = lookupRaftOperation(op.name)!;
    for (const sample of [OPERATION_SAMPLES[op.name as keyof typeof OPERATION_SAMPLES].args, ...(extra[op.name] ?? [])]) {
      assert.ok(schema.safeParse(sample).success, `${op.name}: sample is runtime-valid`);
      assert.ok(jsonValid(op.inputSchema, sample), `${op.name}: runtime-valid sample ${JSON.stringify(sample)} must be JSON-valid`);
    }
  }
});

test("operations.json is fresh (pnpm generate:operations) and RAFT_OPERATIONS_VERSION is its content hash", () => {
  const committed = JSON.parse(readFileSync(resolve(import.meta.dirname, "../operations.json"), "utf8")) as unknown;
  assert.deepEqual(committed, JSON.parse(JSON.stringify(buildRaftOperationsDocument())), "operations.json is stale: run `pnpm --filter @botiverse/raft-sdk generate:operations`");
  assert.match(RAFT_OPERATIONS_VERSION, /^[0-9a-f]{16}$/);
});

test("app names the first-party app of exactly the artifacts.* operations, by its enabledApps id; Raft's own carry none", () => {
  for (const op of RAFT_OPERATIONS) {
    if (op.name.startsWith("artifacts.")) assert.equal(op.app, "artifacts", op.name);
    else assert.equal("app" in op, false, op.name);
  }
  assert.ok(RAFT_OPERATIONS.some((op) => op.app === "artifacts"), "fixture: the manifest has Artifacts operations");
});

test("a nullable field projects to its non-null type (zod 4.6 emits type: [T, \"null\"])", () => {
  // zod 4.6's toJSONSchema emits a nullable as a type ARRAY — the projector
  // accepts the two-member ["T","null"] form and advertises T (omitted = null).
  const amend = RAFT_OPERATIONS.find((op) => op.name === "tasks.amend")!.inputSchema;
  assert.equal(amend.properties!.description!.type, "string");
  assert.ok(!amend.required!.includes("description"));
});

test("a REQUIRED nullable field is rejected, not silently projected as its non-null type", () => {
  // Regression guard for the projector's required-nullable rule: a required
  // `z.string().nullable()` has no tool-schema form (omitted = null only works
  // for OPTIONAL fields). zod 4.6 emits it as `type: ["string","null"]`, and
  // the projector's isNullable must read that form as nullable or the field
  // would be silently accepted as a required string.
  const schema = z.object({ description: z.string().nullable() });
  assert.throws(
    () => toRaftToolInputSchema(schema as never),
    /required nullable field has no tool-schema form/,
  );
});
