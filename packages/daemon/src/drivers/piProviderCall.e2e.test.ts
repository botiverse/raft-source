import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BasicTracer,
  createSpanAttrContractTracer,
  MemoryTraceSink,
  RUNTIME_CONFIG_VERSION,
} from "@botiverse/raft-shared";
import { DAEMON_CORE_TRACE_ATTR_CONTRACTS } from "../core";
import { traceRows } from "../testing/traceRows";
import { restorePiContextView } from "../agentContextView/piRequestRestore";
import { BuiltInDriver } from "./pi";
import type { ParsedEvent } from "./types";
import { answerGatewayModelListRead } from "../testing/gatewayModelListProbe";

// Task #1310 through the real chain: the Built-in driver, pi's ModelRuntime and
// its Anthropic provider, against a loopback server.

const COMPACT_MARKER = "COMPACT-NOW";

type Mode = "answer" | "headers_then_silence";

async function fakeAnthropic(mode: () => Mode, bodies: unknown[] = []) {
  const held: ServerResponse[] = [];
  const server = createServer((req, res) => {
    if (answerGatewayModelListRead(req, res)) return;
    if (req.url?.endsWith("/internal/agent-api/mcp/tools")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ catalogVersion: 1, tools: [] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { system?: unknown; messages?: Array<{ content?: unknown }> };
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (mode() === "headers_then_silence") {
        res.flushHeaders();
        held.push(res);
        return;
      }
      const lastUser = JSON.stringify(parsed.messages?.at(-1)?.content ?? "");
      const agentTurn = JSON.stringify(parsed.system ?? "").includes("standing instructions");
      const inputTokens = agentTurn && lastUser.includes(COMPACT_MARKER) ? 195_000 : 1_000;
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "fake-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } });
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  onTestFinished(() => new Promise<void>((resolve) => {
    for (const res of held) res.destroy();
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return { port: (server.address() as AddressInfo).port };
}

async function waitUntil(condition: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function builtIn(port: number, contextViewRequestLogDir?: () => string | null) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-provider-call-e2e-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const sink = new MemoryTraceSink();
  const runtime = new BuiltInDriver().createSession({
    agentId: "agent-provider-call", standingPrompt: "standing instructions", prompt: "wake", workingDirectory: root, slockCliPath: "/tmp/slock-cli.js",
    daemonApiKey: "x", launchId: "launch-provider-call", contextViewRequestLogDir,
    tracer: createSpanAttrContractTracer(new BasicTracer({ sink }), DAEMON_CORE_TRACE_ATTR_CONTRACTS),
    config: {
      name: "provider-call", displayName: null, description: null, runtime: "builtin", serverUrl: `http://127.0.0.1:${port}`, authToken: "t",
      agentCredentialKey: "sk_agent_provider_call",
      sessionId: null, model: "fake-model", reasoningEffort: null, runtimeContext: null,
      envVars: {},
      runtimeConfig: {
        version: RUNTIME_CONFIG_VERSION, runtime: "builtin",
        provider: { kind: "gateway", providerId: "anthropic-compatible", baseUrl: `http://127.0.0.1:${port}/anthropic`, apiKey: "fake" },
        hostUserState: "forbidden", model: { kind: "custom", name: "fake-model" }, mode: { kind: "default" },
      },
    },
  });
  const events: ParsedEvent[] = [];
  runtime.on("runtime_event", (event) => events.push(event));
  const ended = () => traceRows(sink).filter((row) => row.name === "daemon.pi.provider_call.ended").map((row) => row.attrs ?? {});
  return { runtime, events, ended };
}

test("View Context: the log holds each body as the provider received it, and repeats nothing across turns", { timeout: 60_000 }, async () => {
  const bodies: unknown[] = [];
  const { port } = await fakeAnthropic(() => "answer", bodies);
  const logDir = mkdtempSync(path.join(os.tmpdir(), "pi-request-log-e2e-"));
  onTestFinished(() => rmSync(logDir, { recursive: true, force: true }));
  const { runtime, events } = builtIn(port, () => logDir);
  try {
    for (let n = 1; n <= 3; n++) {
      const before = events.filter((event) => event.kind === "turn_end").length;
      if (n === 1) await runtime.start({ text: `turn ${n}`, sessionId: "pi-request-log-e2e" });
      else assert.deepEqual(runtime.send({ mode: "idle", text: `turn ${n}` }), { ok: true, acceptedAs: "prompt" });
      await waitUntil(() => events.filter((event) => event.kind === "turn_end").length > before, `turn ${n}`);
    }
  } finally {
    await runtime.stop();
  }
  const records = readFileSync(path.join(logDir, "pi-request-log-e2e.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const requests = records.filter((record) => record.type === "request");
  assert.equal(requests.length, bodies.length);
  assert.equal(requests.length, 3);
  const hashesOf = (request: any): string[] => (request.base
    ? [...hashesOf(requests.find((candidate) => candidate.id === request.base)).slice(0, request.keep), ...request.tail]
    : request.tail);
  requests.forEach((request, index) => {
    const shape = records.find((record) => record.type === "shape" && record.hash === request.shapeHash);
    const messages = hashesOf(request).map((hash) => records.find((record) => record.type === "blob" && record.hash === hash).message);
    assert.deepEqual({ ...shape.shape, ...request.params, [shape.messagesKey]: messages }, bodies[index], `request ${index + 1} reads back as sent`);
    assert.equal(request.api, "anthropic-messages");
    assert.equal(request.model, "fake-model");
  });
  const blobHashes = records.filter((record) => record.type === "blob").map((record) => record.hash);
  assert.equal(new Set(blobHashes).size, blobHashes.length, "no message written twice");
  // The reader, on what the real driver wrote: the middle request, and the reply the last one kept.
  const buffer = readFileSync(path.join(logDir, "pi-request-log-e2e.jsonl"));
  const lines = buffer.toString("utf8").split("\n");
  const secondRequest = lines.map((line, index) => (line.startsWith('{"type":"request"') ? index : -1)).filter((index) => index >= 0)[1]!;
  const offset = Buffer.byteLength(`${lines.slice(0, secondRequest + 1).join("\n")}\n`);
  const restored = restorePiContextView({ buffer, offset, messageId: "m1", runtime: "builtin", sessionId: "pi-request-log-e2e" });
  assert.ok(restored.ok, JSON.stringify(restored));
  assert.equal(restored.view.verification, undefined, "this reply holds no send");
  assert.equal(restored.view.model, "fake-model");
  assert.ok(restored.view.system.map((entry) => entry.text).join("\n").includes("standing instructions"), "the system prompt as sent");
  assert.ok(restored.view.tools.length > 0, "the tool list as sent");
  assert.ok(restored.view.messages.some((message) => message.parts.some((part) => part.kind === "text" && part.text.includes("turn 2"))));
  assert.equal(restored.responseFound, true);
  assert.equal(records.filter((record) => record.type === "shape").length, 1, "one shape across the turns");
  assert.ok(requests[2].keep > 0, "a later request shares the prefix of the one before");
});

test("a turn and the compaction after it each end as one provider call, attributed by window", { timeout: 60_000 }, async () => {
  const { port } = await fakeAnthropic(() => "answer");
  const logDir = mkdtempSync(path.join(os.tmpdir(), "pi-request-log-compaction-"));
  onTestFinished(() => rmSync(logDir, { recursive: true, force: true }));
  const { runtime, events, ended } = builtIn(port, () => logDir);
  try {
    // As in the rotation end-to-end test: three ordinary turns, then one that
    // reports a near-full context so pi compacts after it.
    const prompt = (n: number) => `${n === 4 ? COMPACT_MARKER : "turn"} ${n}: ${"context line with some words ".repeat(1400)}`;
    for (let n = 1; n <= 4; n++) {
      const before = events.filter((event) => event.kind === "turn_end").length;
      if (n === 1) await runtime.start({ text: prompt(n), sessionId: "pi-provider-call-e2e" });
      else assert.deepEqual(runtime.send({ mode: "idle", text: prompt(n) }), { ok: true, acceptedAs: "prompt" });
      await waitUntil(() => events.filter((event) => event.kind === "turn_end").length > before, `turn ${n}`);
    }
    assert.ok(events.some((event) => event.kind === "compaction_finished"), "pi compacted after turn 4");
    const rows = ended();
    const turn = rows.find((row) => row.call_context === "outside_compaction");
    const compaction = rows.find((row) => row.call_context === "compaction");
    assert.ok(turn, "the turn's call ended");
    assert.ok(compaction, "the compaction's summary call ended");
    for (const row of [turn, compaction]) {
      assert.equal(row.outcome, "completed");
      assert.equal(row.phase, "streaming");
      assert.equal(row.api, "anthropic-messages");
      assert.equal(row.http_responses_seen, 1);
      assert.equal(row.last_http_status, 200);
      assert.equal(typeof row.duration_ms_bucket, "string");
      assert.equal(row.duration_ms, undefined);
      assert.equal(row.agentId, "agent-provider-call");
    }
    assert.equal(runtime.providerCallSnapshot?.().openCount, 0);
  } finally {
    await runtime.stop();
  }
  // The summary call carries its own id: it stays out of the session's log, and leaves no file of its own.
  assert.deepEqual(readdirSync(logDir), ["pi-provider-call-e2e.jsonl"]);
  const records = readFileSync(path.join(logDir, "pi-provider-call-e2e.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.filter((record) => record.type === "shape").length, 1);
  const hashes = records.filter((record) => record.type === "blob").map((record) => record.hash);
  assert.equal(new Set(hashes).size, hashes.length, "nothing written twice");
});

test("a provider that sends headers then goes silent shows as one open call in phase headers, and ends once on stop", { timeout: 60_000 }, async () => {
  const { port } = await fakeAnthropic(() => "headers_then_silence");
  const { runtime, ended } = builtIn(port);
  await runtime.start({ text: "hello", sessionId: "pi-provider-call-silent" });
  await waitUntil(() => runtime.providerCallSnapshot?.().oldest?.phase === "headers", "the open call to see headers");
  const snapshot = runtime.providerCallSnapshot!();
  assert.equal(snapshot.openCount, 1);
  assert.equal(snapshot.oldest?.callContext, "outside_compaction");
  assert.equal(snapshot.oldest?.msSinceLastStreamEvent, undefined);
  assert.equal(ended().length, 0, "an open call has no ended row");
  await runtime.stop();
  await waitUntil(() => ended().length === 1, "the one ended row");
  const [row] = ended();
  assert.ok(row!.outcome === "aborted" || row!.outcome === "abandoned", `stopped call ended as ${String(row!.outcome)}`);
  assert.equal(row!.phase, "headers");
  assert.equal(row!.http_responses_seen, 1);
});

// Pi 1.5.1 sends only the new messages when Anthropic message threads are on.
// The session reads the user's models file as is, so pi-ai's default applies
// (threads on for api.anthropic.com only, so this loopback gateway still gets
// full bodies on the wire; the wire-level threaded chain is
// piAnthropicRequests.test.ts and piRequestLog.threads.test.ts). Either way
// View Context records the full body pi-ai hands `onPayload`, so a later turn
// restores the first turn's messages.
const hasText = (view: { messages: Array<{ parts: Array<{ kind: string; text?: string | null }> }> }, text: string) =>
  view.messages.some((message) => message.parts.some((part) => part.kind === "text" && (part.text ?? "").includes(text)));

test("message threads: the LOG holds every request in full, whatever the wire carried, and each call is measured", { timeout: 60_000 }, async () => {
  const bodies: unknown[] = [];
  const { port } = await fakeAnthropic(() => "answer", bodies);
  const logDir = mkdtempSync(path.join(os.tmpdir(), "pi-request-log-threads-"));
  onTestFinished(() => rmSync(logDir, { recursive: true, force: true }));
  const { runtime, events } = builtIn(port, () => logDir);
  try {
    for (let n = 1; n <= 2; n++) {
      const before = events.filter((event) => event.kind === "turn_end").length;
      if (n === 1) await runtime.start({ text: `turn ${n}`, sessionId: "pi-threads-e2e" });
      else assert.deepEqual(runtime.send({ mode: "idle", text: `turn ${n}` }), { ok: true, acceptedAs: "prompt" });
      await waitUntil(() => events.filter((event) => event.kind === "turn_end").length > before, `turn ${n}`);
    }
  } finally {
    await runtime.stop();
  }
  const buffer = readFileSync(path.join(logDir, "pi-threads-e2e.jsonl"));
  const lines = buffer.toString("utf8").split("\n");
  const requestLines = lines.map((line, index) => (line.startsWith('{"type":"request"') ? index : -1)).filter((index) => index >= 0);
  const restoreAt = (requestIndex: number) => {
    const offset = Buffer.byteLength(`${lines.slice(0, requestLines[requestIndex]! + 1).join("\n")}\n`);
    const restored = restorePiContextView({ buffer, offset, messageId: "m1", runtime: "builtin", sessionId: "pi-threads-e2e" });
    assert.ok(restored.ok, JSON.stringify(restored));
    return restored.view;
  };
  assert.ok(bodies.length >= 2);
  // One record per request pi-ai built, each a full body: the system prompt and every earlier turn.
  assert.equal(requestLines.length, bodies.length);
  const first = restoreAt(0);
  const second = restoreAt(1);
  assert.ok(first.system.length > 0 && second.system.length > 0, "each record holds the system prompt");
  assert.ok(second.messages.length > first.messages.length, "the later record holds more of the conversation");
  assert.ok(hasText(second, "turn 1"), "the restored context still holds the first turn");
  assert.ok(hasText(second, "turn 2"));
  // Measured per call (#runtime-watch:#1): wire bytes only, no content.
  const telemetry = events.filter((event): event is Extract<ParsedEvent, { kind: "telemetry" }> => event.kind === "telemetry" && event.name === "provider_request");
  assert.equal(telemetry.length, bodies.length);
  for (const event of telemetry) {
    assert.equal(event.source, "pi_anthropic_request");
    assert.equal(typeof event.attrs.request_bytes, "number");
    assert.ok(Number(event.attrs.request_bytes) > 0);
  }
});
