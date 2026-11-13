import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { AgentContext } from "../../auth/env";
import { loginWithAgentProof } from "./agentHandoffProof";

test("concurrent approval requests retain both verifiers and resume the one approved first", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-handoff-proof-"));
  const context = { agentId: "11111111-1111-4111-8111-111111111111", serverUrl: "https://raft.example", profileCredentialPath: path.join(root, "credential.json") } as AgentContext;
  const body = { service: "app", scopes: ["identity"] };
  const requests = new Map<string, { challenge: string; approved: boolean }>();
  const api = { integrations: { login: async (input: typeof body & { agentHandoffChallenge?: string; resumeRequestId?: string }) => {
    if (!input.agentHandoffChallenge) return { ok: false, status: 400, errorCode: "INTEGRATION_HANDOFF_UPGRADE_REQUIRED", data: null };
    if (input.resumeRequestId) {
      const row = requests.get(input.resumeRequestId);
      if (!row || row.challenge !== input.agentHandoffChallenge) throw new Error("wrong challenge");
      return { ok: true, data: { status: row.approved ? "already_logged_in" : "approval_required", agentHandoffProtocol: "v1", requestId: input.resumeRequestId } };
    }
    const id = requests.size === 0 ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    requests.set(id, { challenge: input.agentHandoffChallenge, approved: false });
    return { ok: true, data: { status: "approval_required", agentHandoffProtocol: "v1", requestId: id } };
  } } } as never;
  try {
    const run = () => loginWithAgentProof({ api, body, context, env: { HOME: root } });
    const dir = path.join(root, "integrations");
    await run();
    const firstFile = fs.readdirSync(dir).find((file) => file.startsWith(".handoff-"))!;
    // Model two processes that each observed no file before either save was
    // visible: temporarily hide the first completed request from the second.
    const hidden = path.join(root, "hidden-fixture");
    fs.renameSync(path.join(dir, firstFile), hidden);
    await run();
    fs.renameSync(hidden, path.join(dir, firstFile));
    const files = fs.readdirSync(dir).filter((file) => file.startsWith(".handoff-")).sort();
    assert.equal(files.length, 2);
    for (const file of files) assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600);
    const { requestId: approvedId } = JSON.parse(fs.readFileSync(path.join(dir, files[1]!), "utf8")) as { requestId: string };
    requests.get(approvedId)!.approved = true;
    const resumed = await run();
    assert.equal(resumed.result.data?.requestId, approvedId);
    assert.equal(resumed.result.data?.status, "already_logged_in");
    assert.ok(resumed.verifier);
    resumed.clear();
    assert.equal(fs.readdirSync(dir).filter((file) => file.startsWith(".handoff-")).length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a committed approval request remains recoverable when its response is lost", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-handoff-lost-"));
  const context = { agentId: "11111111-1111-4111-8111-111111111111", serverUrl: "https://raft.example", profileCredentialPath: path.join(root, "credential.json") } as AgentContext;
  const body = { service: "app", scopes: ["identity"] };
  let recordedChallenge: string | undefined;
  let approved = false;
  let calls = 0;
  const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const api = { integrations: { login: async (input: typeof body & { agentHandoffChallenge?: string }) => {
    if (!input.agentHandoffChallenge) return { ok: false, status: 400, errorCode: "INTEGRATION_HANDOFF_UPGRADE_REQUIRED", data: null };
    calls += 1;
    if (!recordedChallenge) { recordedChallenge = input.agentHandoffChallenge; return { ok: false, status: 503, errorCode: "TIMEOUT", data: null }; }
    assert.equal(input.agentHandoffChallenge, recordedChallenge);
    return { ok: true, data: { status: approved ? "already_logged_in" : "approval_required", agentHandoffProtocol: "v1", requestId } };
  } } } as never;
  try {
    const run = () => loginWithAgentProof({ api, body, context, env: { HOME: root } });
    const lost = await run();
    assert.equal(lost.result.ok, false);
    const files = fs.readdirSync(path.join(root, "integrations")).filter((name) => name.startsWith(".handoff-"));
    assert.equal(files.length, 1);
    assert.equal(fs.statSync(path.join(root, "integrations", files[0]!)).mode & 0o777, 0o600);
    approved = true;
    const resumed = await run();
    assert.equal(resumed.result.data?.requestId, requestId);
    assert.equal(resumed.result.data?.status, "already_logged_in");
    assert.equal(calls, 2);
    resumed.clear();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
