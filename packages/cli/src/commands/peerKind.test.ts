/**
 * `--peer-kind agent|human` picks the DM when a human and an agent in one
 * server share a name (task #3). It is a shortcut for the `dm:@name~kind`
 * target the server understands, so every command that takes a DM target has
 * to carry the same choice: an agent must never be able to read a DM it then
 * cannot unambiguously reply to.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "vitest";

import type { ApiResponse } from "../client";
import type { AgentContext } from "../auth/env";
import { createCommandContext } from "../core/context";
import { CliError } from "../core/errors";
import type { CliIo } from "../core/io";
import { applyDmPeerKind, requireTargetAlias } from "./_target";
import { actionPrepareCommand } from "./action/prepare";
import { attachmentUploadCommand } from "./attachment/upload";
import { messageReadCommand } from "./message/read";
import { messageSearchCommand } from "./message/search";
import { messageSendCommand } from "./message/send";
import { lookupSavedDraft, setSavedDraft } from "./message/_continueDraftState";
import { buildScheduleBody, reminderScheduleCommand } from "./reminder/schedule";
import { taskAmendCommand } from "./task/amend";
import { taskAssignCommand } from "./task/assign";
import { taskClaimCommand } from "./task/claim";
import { taskConvertCommand } from "./task/convert";
import { taskCreateCommand } from "./task/create";
import { taskDeleteCommand } from "./task/delete";
import { taskHistoryCommand } from "./task/history";
import { taskListCommand } from "./task/list";
import { taskReceiptCommand } from "./task/receipt";
import { taskShowCommand } from "./task/show";
import { taskUnassignCommand } from "./task/unassign";
import { taskUnclaimCommand } from "./task/unclaim";
import { taskUpdateCommand } from "./task/update";
import { threadFollowCommand } from "./thread/follow";
import { threadUnfollowCommand } from "./thread/unfollow";

function invalidArg(pattern: RegExp) {
  return (err: unknown) => err instanceof CliError && err.code === "INVALID_ARG" && pattern.test(err.message);
}

test("--peer-kind appends the kind to a DM target and keeps a thread suffix", () => {
  assert.equal(applyDmPeerKind("dm:@Twin", undefined), "dm:@Twin");
  assert.equal(applyDmPeerKind("dm:@Twin", "agent"), "dm:@Twin~agent");
  assert.equal(applyDmPeerKind("dm:@Twin", "HUMAN"), "dm:@Twin~human");
  assert.equal(applyDmPeerKind("dm:@Twin:deadbeef", "agent"), "dm:@Twin~agent:deadbeef");
  assert.equal(applyDmPeerKind("DM:@Twin:deadbeef", "human"), "DM:@Twin~human:deadbeef");
  // Saying the same kind both ways is not a conflict.
  assert.equal(applyDmPeerKind("dm:@Twin~agent:deadbeef", "agent"), "dm:@Twin~agent:deadbeef");
});

test("--peer-kind refuses a contradiction, a non-DM target and an unknown kind", () => {
  assert.throws(() => applyDmPeerKind("dm:@Twin~human", "agent"), invalidArg(/contradicts/));
  assert.throws(() => applyDmPeerKind("dm:@Twin~human:deadbeef", "agent"), invalidArg(/contradicts/));
  assert.throws(() => applyDmPeerKind("#general", "agent"), invalidArg(/only applies to DM targets/));
  assert.throws(() => applyDmPeerKind("#general:deadbeef", "human"), invalidArg(/only applies to DM targets/));
  assert.throws(() => applyDmPeerKind("dm:@Twin", "bot"), invalidArg(/must be 'agent' or 'human'/));
  assert.throws(() => applyDmPeerKind("dm:@Twin~bot", "agent"), invalidArg(/unknown peer kind/));
  assert.throws(() => requireTargetAlias({ peerKind: "agent" }), invalidArg(/needs a DM --target/));
  // Without --peer-kind, targets pass through untouched (the server judges them).
  assert.equal(requireTargetAlias({ target: "#general" }), "#general");
});

test("every command that takes a DM target declares --peer-kind", () => {
  const commands = {
    "message read": messageReadCommand,
    "message send": messageSendCommand,
    "message search": messageSearchCommand,
    "attachment upload": attachmentUploadCommand,
    "thread follow": threadFollowCommand,
    "thread unfollow": threadUnfollowCommand,
    "reminder schedule": reminderScheduleCommand,
    "action prepare": actionPrepareCommand,
    "task amend": taskAmendCommand,
    "task assign": taskAssignCommand,
    "task claim": taskClaimCommand,
    "task convert": taskConvertCommand,
    "task create": taskCreateCommand,
    "task delete": taskDeleteCommand,
    "task history": taskHistoryCommand,
    "task list": taskListCommand,
    "task receipt": taskReceiptCommand,
    "task show": taskShowCommand,
    "task unassign": taskUnassignCommand,
    "task unclaim": taskUnclaimCommand,
    "task update": taskUpdateCommand,
  };
  for (const [name, command] of Object.entries(commands)) {
    const flags = (command.spec.options ?? []).map((option) => option.flags);
    assert.ok(flags.includes("--peer-kind <kind>"), `${name} lacks --peer-kind`);
  }
});

function memoryIo(stdin?: Readable): CliIo {
  return {
    ...(stdin ? { stdin } : {}),
    stdout: { write: () => true },
    stderr: { write: () => true },
  } as CliIo;
}

const agentContext: AgentContext = {
  agentId: "agent-peer-kind",
  serverUrl: "https://slock.example",
  serverId: "server-1",
  token: "secret-token",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

const EMPTY_HISTORY = { messages: [], has_more: false, has_older: false, has_newer: false };

function recordingContext(stdin?: Readable, data: unknown = EMPTY_HISTORY) {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx = createCommandContext({
    io: memoryIo(stdin),
    env: {},
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, requestPath: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path: requestPath, body });
        return { ok: true, status: 200, error: null, data };
      },
    }) as never,
  });
  return { ctx, requests };
}

test("read sends the kind-pinned target and leaves --around untouched", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-peer-kind-read-"));
  const { ctx, requests } = recordingContext();

  await messageReadCommand.handler(ctx, { target: "dm:@Twin", peerKind: "agent", around: "abcd1234" });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].path,
    "/internal/agent-api/history?channel=dm%3A%40Twin%7Eagent&around=abcd1234",
  );
});

test("a saved draft for the kind-pinned DM is resent to that DM, not the bare name", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-peer-kind-send-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-peer-kind-draft-"));
  setSavedDraft(agentContext.agentId, "dm:@Twin~agent", {
    content: "for the agent Twin\n",
    attachmentIds: [],
    savedAt: Date.now(),
    reholdCount: 0,
  });
  const { ctx, requests } = recordingContext(Readable.from([]), { ok: true, state: "sent", messageId: "m-1" });

  await messageSendCommand.handler(ctx, [], { target: "dm:@Twin", peerKind: "agent", sendDraft: true });

  const sends = requests.filter((request) => request.path.endsWith("/send"));
  assert.equal(sends.length, 1, JSON.stringify(requests));
  assert.equal((sends[0].body as { target: string }).target, "dm:@Twin~agent");
  assert.equal((sends[0].body as { content: string }).content, "for the agent Twin\n");
  assert.deepEqual(lookupSavedDraft(agentContext.agentId, "dm:@Twin~agent"), { status: "missing" });
});

test("thread unfollow and reminder anchors carry the kind", async () => {
  const { ctx, requests } = recordingContext(undefined, { ok: true });
  await threadUnfollowCommand.handler(ctx, { target: "dm:@Twin:deadbeef", peerKind: "human" });
  assert.equal((requests[0].body as { thread: string }).thread, "dm:@Twin~human:deadbeef");

  const built = buildScheduleBody({ title: "t", delaySeconds: "60", messageId: "deadbeef", channel: "dm:@Twin", peerKind: "agent" });
  assert.equal(built.error, undefined);
  assert.equal(built.body.channel, "dm:@Twin~agent");

  const refused = buildScheduleBody({ title: "t", delaySeconds: "60", messageId: "deadbeef", channel: "#general", peerKind: "agent" });
  assert.equal(refused.error?.code, "INVALID_ARG");
});
