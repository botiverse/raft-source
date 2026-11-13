import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_CONTEXT_VIEW_VIEWER_WAIT_MS,
  AGENT_CONTEXT_VIEW_UNCOMPRESSED_BYTES_HEADER,
  parseAgentContextViewResultBody,
  readAgentContextViewAvailability,
  type AgentContextViewAvailabilityMessage,
} from "@botiverse/raft-shared";
import { twoRequestSession } from "../testing/claudeSessionFixture";
import {
  AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_MAX_MS,
  AgentContextViewService,
  type ContextViewAgentFacts,
} from "./agentContextViewService";
import { CONTEXT_VIEW_SOURCE_MAX_BYTES } from "./contextViewSource";
import { PiRequestLog } from "./piRequestLog";
import { agentContextDir } from "./contextViewStore";
import { restoreContextViewSource, type ContextViewRestoreRequest } from "./contextViewRestore";
import type { ContextViewRestoreOptions } from "./contextViewRestoreRunner";
import type { KimiRequestRebuild } from "./kimiSessionRestore";
import {
  appendContextViewIndexLine,
  contextViewServerDir,
  hasContextViewData,
  readContextViewIndex,
  readContextViewOffSince,
  type ContextViewServerDir,
} from "./contextViewStore";

const HOUR = 60 * 60 * 1000;
const REQUEST_ID = "ctxv_0123456789abcdef0123";
const T0 = Date.parse("2026-11-04T12:00:00.000Z");
const SERVER = "srv_a";

type Post = { url: string; headers: Record<string, string>; body: Buffer };

let root: string;
let raftHome: string;
/** Server SERVER's data directory (the daemon's own server and every test agent's, unless a test says otherwise). */
let dir: ContextViewServerDir;
let connectedServerId: string | null;
let sessionRoot: string;
let sessionFile: string;
let nowMs: number;
let posts: Post[];
let postAnswer: () => Promise<Response>;
let sent: AgentContextViewAvailabilityMessage[];
let traces: { name: string; attrs: Record<string, unknown>; status?: string }[];
let timers: { callback: () => void; ms: number; cleared: boolean }[];
let facts: Map<string, Partial<ContextViewAgentFacts>>;
let fixture: ReturnType<typeof twoRequestSession>;
let kimiRebuild: KimiRequestRebuild;
let kimiRebuildLoads: number;
let restores: { request: ContextViewRestoreRequest; options?: ContextViewRestoreOptions }[];

function makeService(opts: {
  serverId?: () => string | null;
  facts?: Map<string, Partial<ContextViewAgentFacts>>;
  sweepIntervalMs?: number;
} = {}): AgentContextViewService {
  const agentFacts = opts.facts ?? facts;
  return new AgentContextViewService({
    raftHome,
    connectedServerId: opts.serverId ?? (() => connectedServerId),
    serverUrl: "https://server.test",
    apiKey: "sk_machine_test",
    fetchImpl: async (url, init) => {
      const headers = Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      posts.push({ url: url.toString(), headers, body: Buffer.from(init.body as Uint8Array) });
      return postAnswer();
    },
    sendToServer: (frame) => sent.push(frame),
    agentFacts: (agentId) => ({
      runtime: null,
      serverId: null,
      sessionId: null,
      running: false,
      sessionRoot: null,
      allowedRoots: [],
      resolveSessionFile: () => null,
      ...agentFacts.get(agentId),
    }),
    runningAgentIds: () => [...agentFacts.entries()].filter(([, f]) => f.running).map(([id]) => id),
    recordTrace: (name, attrs, status) => traces.push({ name, attrs, status }),
    restore: (restoreRequest, restoreOptions) => {
      restores.push({ request: restoreRequest, options: restoreOptions });
      return restoreContextViewSource(restoreRequest, async () => {
        kimiRebuildLoads += 1;
        return () => kimiRebuild;
      });
    },
    now: () => nowMs,
    sweepIntervalMs: opts.sweepIntervalMs ?? 0,
    random: () => 0.5,
    timers: {
      setTimeout: (callback, ms) => {
        const timer = { callback, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    },
  });
}

function claudeAgent(overrides: Partial<ContextViewAgentFacts> = {}): Partial<ContextViewAgentFacts> {
  return {
    runtime: "claude",
    serverId: SERVER,
    sessionId: "sess-1",
    running: true,
    sessionRoot,
    allowedRoots: [path.join(root, "home", ".claude")],
    resolveSessionFile: () => sessionFile,
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return { type: "agent:context_view_request", requestId: REQUEST_ID, agentId: "a1", messageId: "msg-1", maxBytes: 1024 * 1024, ...overrides };
}

function postedBody(post: Post): unknown {
  return JSON.parse(gunzipSync(post.body).toString("utf8"));
}

function indexMsg1(): void {
  appendContextViewIndexLine(dir, "a1", {
    messageId: "msg-1",
    sentAt: new Date(nowMs).toISOString(),
    runtime: "claude",
    sessionId: "sess-1",
    transcript: "proj/sess-1.jsonl",
    offset: fixture.offsetAtSend1,
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "ctxview-service-"));
  raftHome = path.join(root, "raft");
  dir = contextViewServerDir(raftHome, SERVER)!;
  connectedServerId = SERVER;
  sessionRoot = path.join(root, "home", ".claude", "projects");
  sessionFile = path.join(sessionRoot, "proj", "sess-1.jsonl");
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  fixture = twoRequestSession();
  writeFileSync(sessionFile, fixture.s.buffer());
  nowMs = T0;
  posts = [];
  postAnswer = async () => new Response("{}", { status: 200 });
  sent = [];
  traces = [];
  timers = [];
  facts = new Map([["a1", claudeAgent()]]);
  kimiRebuildLoads = 0;
  restores = [];
  kimiRebuild = {
    status: "rebuilt",
    verification: "count_matched",
    request: { model: "kimi-k9" },
    protocolVersion: "1.5",
    systemPrompt: "You are Kimi. sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: "Say hi" }], toolCalls: [] }],
    response: { role: "assistant", content: [], toolCalls: [{ id: "call_send", name: "Bash", arguments: "{}" }] },
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("send index", () => {
  it("indexes a send the Server accepted while on, naming the session file and its length; nothing while off", async () => {
    const service = makeService();
    service.observeFlag("a1", true, "start");
    service.onMessageCommitted("a1", "msg-1", "send");
    await vi.waitFor(() => expect(readContextViewIndex(dir, "a1")).toHaveLength(1));
    expect(readContextViewIndex(dir, "a1")[0]).toEqual({
      messageId: "msg-1",
      sentAt: "2026-11-04T12:00:00.000Z",
      runtime: "claude",
      sessionId: "sess-1",
      transcript: "proj/sess-1.jsonl",
      offset: statSync(sessionFile).size,
    });
    // The first retained send changes the availability report.
    await vi.waitFor(() => expect(sent.at(-1)?.retainedSince).toBe("2026-11-04T12:00:00.000Z"));

    service.observeFlag("a1", false, "server_features");
    service.onMessageCommitted("a1", "msg-2", "send");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readContextViewIndex(dir, "a1")).toHaveLength(1);
  });

  it("indexes nothing for another runtime or without a session file, and never throws", async () => {
    facts.set("a1", claudeAgent({ runtime: "opencode" }));
    facts.set("a2", claudeAgent({ resolveSessionFile: () => null }));
    const service = makeService();
    service.observeFlag("a1", true, "start");
    service.observeFlag("a2", true, "start");
    service.onMessageCommitted("a1", "m", "send");
    service.onMessageCommitted("a2", "m", "task_reply");
    await vi.waitFor(() => expect(traces.filter((t) => t.name === "daemon.agent_context_view.index")).toHaveLength(2));
    expect(traces.filter((t) => t.name === "daemon.agent_context_view.index").map((t) => t.attrs.outcome)).toEqual(["unsupported_runtime", "no_session"]);
    expect(hasContextViewData(dir, "a1") || hasContextViewData(dir, "a2")).toBe(false);
  });

  it("drops lines older than the retention on the sweep", () => {
    const service = makeService();
    service.observeFlag("a1", true, "start");
    nowMs = T0 - 31 * 24 * HOUR;
    indexMsg1();
    nowMs = T0;
    indexMsg1();
    service.sweep();
    expect(readContextViewIndex(dir, "a1").map((line) => line.sentAt)).toEqual(["2026-11-04T12:00:00.000Z"]);
  });
});

describe("Codex", () => {
  it("a file moved under the cache is looked up again: Codex decompresses a rollout when it resumes one", async () => {
    const home = path.join(root, "home", ".codex");
    mkdirSync(home, { recursive: true });
    const first = path.join(home, "first.jsonl");
    const second = path.join(home, "second.jsonl");
    writeFileSync(first, "{}\n");
    let file = first;
    facts.set("a1", { runtime: "codex", serverId: SERVER, sessionId: "thread-1", running: true, sessionRoot: home, allowedRoots: [home], resolveSessionFile: () => file });
    const service = makeService();
    service.observeFlag("a1", true, "start");
    await service.availability("a1");
    rmSync(first);
    writeFileSync(second, "{}\n{}\n");
    file = second;
    service.onMessageCommitted("a1", "msg-1", "send");
    await vi.waitFor(() => expect(readContextViewIndex(dir, "a1").map((line) => line.transcript)).toEqual(["second.jsonl"]));
  });

  it("is supported once its rollout holds the tools, and restores redacted", async () => {
    const home = path.join(root, "home", ".codex");
    const rollout = path.join(home, "sessions", "rollout-thread-1.jsonl");
    mkdirSync(path.dirname(rollout), { recursive: true });
    const line = (type: string, payload: unknown) => `${JSON.stringify({ timestamp: "2026-11-06T00:00:00.000Z", type, payload })}\n`;
    writeFileSync(rollout, line("session_meta", { cli_version: "0.163.0" }) + line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "sk_live_abcdefghijklmnopqrstuvwxyz0123" }] }));
    facts.set("a1", {
      runtime: "codex", serverId: SERVER, sessionId: "thread-1", running: true,
      sessionRoot: home, allowedRoots: [home],
      resolveSessionFile: () => rollout,
    });
    const service = makeService();
    service.observeFlag("a1", true, "start");
    expect(await service.availability("a1"), "no tool list in the file: an older Codex").toMatchObject({ supported: false, unsupportedReason: "no_session" });
    writeFileSync(rollout, line("session_meta", { cli_version: "0.167.0" }) + line("response_item", { type: "additional_tools", tools: [{ type: "function", name: "exec_command", parameters: {} }] }) + line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "token sk_live_abcdefghijklmnopqrstuvwxyz0123" }] }));
    service.onMessageCommitted("a1", "msg-1", "send");
    await vi.waitFor(() => expect(readContextViewIndex(dir, "a1")).toHaveLength(1));
    expect(await service.availability("a1")).toMatchObject({ supported: true, runtime: "codex" });
    await service.handleRequest(request({ maxBytes: 1024 * 1024 }));
    const answer = postedBody(posts.at(-1)!) as { ok: boolean; context: Record<string, any> };
    expect(answer.ok).toBe(true);
    expect(answer.context.source.format).toBe("codex-rollout");
    expect(JSON.stringify(answer.context)).not.toContain("sk_live_abcdefghijklmnopqrstuvwxyz0123");
  });
});

describe("request logs of a runtime hosted in the daemon", () => {
  it("a Pi send is indexed, reported as supported, and restored in full, redacted", async () => {
    const logRoot = path.join(agentContextDir(dir, "a1"), "pi-requests");
    const logFile = path.join(logRoot, "sess-1.jsonl");
    facts.set("a1", {
      runtime: "pi", serverId: SERVER, sessionId: "sess-1", running: true,
      sessionRoot: logRoot, allowedRoots: [logRoot],
      resolveSessionFile: () => (existsSync(logFile) ? logFile : null),
    });
    const service = makeService();
    service.observeFlag("a1", true, "start");
    expect(await service.availability("a1")).toMatchObject({ supported: false, unsupportedReason: "no_session" });
    const log = new PiRequestLog(() => service.requestLogDir("a1"));
    const body = { model: "m", system: "You are Otter", messages: [{ role: "user", content: "token sk_live_abcdefghijklmnopqrstuvwxyz0123" }] };
    log.record(body, { sessionId: "sess-1", provider: "p", api: "anthropic-messages", model: "m" });
    expect(await service.availability("a1")).toMatchObject({ supported: true, runtime: "pi" });
    service.onMessageCommitted("a1", "msg-1", "send");
    await vi.waitFor(() => expect(readContextViewIndex(dir, "a1")).toHaveLength(1));
    log.record({ ...body, messages: [...body.messages, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "raft message send --target x" } }] }] }, { sessionId: "sess-1", provider: "p", api: "anthropic-messages", model: "m" });
    expect(readContextViewIndex(dir, "a1").map((line) => [line.messageId, line.transcript, line.offset > 0])).toEqual([["msg-1", "sess-1.jsonl", true]]);

    await service.handleRequest(request({ maxBytes: 1024 * 1024 }));
    const answer = postedBody(posts.at(-1)!) as { ok: boolean; context: Record<string, any> };
    expect(answer.ok).toBe(true);
    expect(answer.context.runtime).toBe("pi");
    expect(answer.context.verification).toBe("verified");
    expect(answer.context.system).toEqual([{ text: "You are Otter" }]);
    expect(answer.context.source.kind).toBe("captured");
    expect(JSON.stringify(answer.context)).not.toContain("sk_live_abcdefghijklmnopqrstuvwxyz0123");
  });

  it("has a directory only while on, kept for the retention and removed with the data", () => {
    const service = makeService();
    expect(service.requestLogDir("a1")).toBeNull();
    service.observeFlag("a1", true, "start");
    const logDir = service.requestLogDir("a1")!;
    expect(logDir.startsWith(agentContextDir(dir, "a1"))).toBe(true);
    const log = path.join(logDir, "session-1.jsonl");
    writeFileSync(log, "{}");
    const stale = path.join(logDir, "session-0.jsonl");
    writeFileSync(stale, "{}");
    const old = new Date(T0 - 31 * 24 * HOUR);
    utimesSync(stale, old, old);
    utimesSync(log, new Date(T0), new Date(T0));
    service.sweep();
    expect(readdirSync(logDir)).toEqual(["session-1.jsonl"]);

    service.observeFlag("a1", false, "server_features");
    expect(service.requestLogDir("a1"), "off stops the writing").toBeNull();
    nowMs = T0 + 25 * HOUR;
    service.sweep();
    expect(existsSync(log)).toBe(false);
  });

  it("refuses a directory planted as a link", () => {
    const service = makeService();
    service.observeFlag("a1", true, "start");
    const logDir = service.requestLogDir("a1")!;
    rmSync(logDir, { recursive: true });
    symlinkSync(raftHome, logDir);
    expect(() => service.requestLogDir("a1")).toThrow("not a plain directory");
  });
});

describe("gate", () => {
  it("removes the data only after 24 h continuously off; on again within it keeps the data", () => {
    const service = makeService();
    service.observeFlag("a1", true, "start");
    indexMsg1();
    service.observeFlag("a1", false, "server_features");
    expect(service.isEnabled("a1")).toBe(false);
    expect(readContextViewOffSince(dir, "a1")).toBe(T0);

    nowMs = T0 + 23 * HOUR;
    service.sweep();
    expect(hasContextViewData(dir, "a1")).toBe(true);
    // A blip: on again before the grace ran out.
    service.observeFlag("a1", true, "server_features");
    expect(readContextViewOffSince(dir, "a1")).toBeNull();
    nowMs = T0 + 48 * HOUR;
    service.sweep();
    expect(readContextViewIndex(dir, "a1")).toHaveLength(1);

    // Off again: the 24 h count starts over from this time.
    service.observeFlag("a1", false, "server_features");
    nowMs = T0 + 48 * HOUR + 24 * HOUR - 1;
    service.sweep();
    expect(hasContextViewData(dir, "a1")).toBe(true);
    nowMs = T0 + 48 * HOUR + 24 * HOUR;
    service.sweep();
    expect(hasContextViewData(dir, "a1")).toBe(false);
    expect(traces.some((t) => t.name === "daemon.agent_context_view.data_removed")).toBe(true);
  });

  it("after a restart: the state left on disk until the flag is seen again; a server answer reaches agents known only from their data", () => {
    const first = makeService();
    first.observeFlag("a1", true, "start");
    indexMsg1();
    const second = makeService();
    expect(second.isEnabled("a1")).toBe(true);
    second.applyServerFlag(false, []);
    expect(second.isEnabled("a1")).toBe(false);
    expect(readContextViewOffSince(dir, "a1")).toBe(T0);
    expect(makeService().isEnabled("a1")).toBe(false);
  });
});

describe("per-server data (one daemon per server on one Raft home)", () => {
  it("two daemons on one Raft home: each server's flag, gate and sweep reach only its own agents", async () => {
    const dirB = contextViewServerDir(raftHome, "srv_b")!;
    const factsB = new Map<string, Partial<ContextViewAgentFacts>>([["b1", claudeAgent({ serverId: "srv_b" })]]);
    const daemonA = makeService({ serverId: () => SERVER });
    const daemonB = makeService({ serverId: () => "srv_b", facts: factsB });

    // Server A's flag on: a1's send is indexed under A's directory.
    daemonA.applyServerFlag(true, ["a1"]);
    daemonA.onMessageCommitted("a1", "msg-1", "send");
    await vi.waitFor(() => expect(readContextViewIndex(dir, "a1")).toHaveLength(1));
    // b1 has data of its own from an earlier on period of server B.
    appendContextViewIndexLine(dirB, "b1", { messageId: "mb", sentAt: new Date(T0).toISOString(), runtime: "claude", sessionId: "s", transcript: "p/s.jsonl", offset: 1 });

    // Server B's flag off: only B's agents are marked.
    daemonB.applyServerFlag(false, ["b1"]);
    daemonB.applyServerFlag(false, []);
    expect(readContextViewOffSince(dirB, "b1")).toBe(T0);
    expect(existsSync(path.join(dir, "a1", "off-since"))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["a1"]);
    expect(daemonB.isEnabled("a1")).toBe(false);
    expect(daemonA.isEnabled("a1")).toBe(true);

    nowMs = T0 + 25 * HOUR;
    daemonA.sweep();
    daemonB.sweep();
    expect(readContextViewIndex(dir, "a1")).toHaveLength(1);
    expect(hasContextViewData(dirB, "b1")).toBe(false);
    // B restarted (nothing seen yet) and still off: A's agent stays untouched.
    const daemonB2 = makeService({ serverId: () => "srv_b", facts: factsB });
    daemonB2.applyServerFlag(false, []);
    nowMs = T0 + 50 * HOUR;
    daemonB2.sweep();
    expect(existsSync(path.join(dir, "a1", "off-since"))).toBe(false);
    expect(readContextViewIndex(dir, "a1")).toHaveLength(1);
  });

  it("skips a server id that is not one path segment (traced once) and an agent without one", async () => {
    facts.set("a1", claudeAgent({ serverId: "../srv_a" }));
    facts.set("a2", claudeAgent({ serverId: null }));
    const service = makeService();
    service.onAgentStart("a1", true);
    service.onAgentStart("a2", true);
    service.onMessageCommitted("a1", "m1", "send");
    service.onMessageCommitted("a2", "m2", "send");
    service.onMessageCommitted("a1", "m3", "send");
    await vi.waitFor(() => expect(traces.filter((t) => t.name === "daemon.agent_context_view.index")).toHaveLength(3));
    expect(traces.filter((t) => t.name === "daemon.agent_context_view.index").map((t) => t.attrs.outcome)).toEqual(["no_server", "no_server", "no_server"]);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    for (const report of sent) expect(report).toMatchObject({ supported: false, unsupportedReason: "no_session", retainedSince: null });
    expect(traces.filter((t) => t.name === "daemon.agent_context_view.server_id_rejected")).toHaveLength(1);
    expect(existsSync(path.join(raftHome, "agent-context"))).toBe(false);
    expect(existsSync(path.join(raftHome, "srv_a"))).toBe(false);
    await service.handleRequest(request());
    expect(postedBody(posts[0]!)).toEqual({ ok: false, reason: "not_found" });

    // A daemon whose own server id is not a path segment does no whole-server work.
    facts.set("a1", claudeAgent());
    const good = makeService();
    good.observeFlag("a1", true, "start");
    indexMsg1();
    good.observeFlag("a1", false, "server_features");
    const bad = makeService({ serverId: () => "..", facts: new Map() });
    bad.applyServerFlag(true, []);
    expect(readContextViewOffSince(dir, "a1")).toBe(T0);
    nowMs = T0 + 48 * HOUR;
    bad.sweep();
    expect(readContextViewIndex(dir, "a1")).toHaveLength(1);
    expect(traces.filter((t) => t.name === "daemon.agent_context_view.server_id_rejected").map((t) => t.attrs.source)).toEqual(["agent", "daemon"]);
  });

  it("runs no whole-server sweep before the daemon knows its server, and the startup sweep once it does", async () => {
    const first = makeService();
    first.observeFlag("a1", true, "start");
    nowMs = T0 - 25 * HOUR;
    indexMsg1();
    first.observeFlag("a1", false, "server_features");
    nowMs = T0;

    connectedServerId = null;
    const later = makeService({ sweepIntervalMs: HOUR });
    later.observeFlag("a2", false, "start");
    later.applyServerFlag(false, []);
    later.reportAllRunning("ready");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(hasContextViewData(dir, "a1")).toBe(true);

    connectedServerId = SERVER;
    later.reportAllRunning("ready");
    await vi.waitFor(() => expect(hasContextViewData(dir, "a1")).toBe(false));
    later.dispose();
  });
});

describe("view request (kimi-sdk)", () => {
  function kimiAgent(): Partial<ContextViewAgentFacts> {
    const kimiHome = path.join(root, "home", ".kimi-code");
    const wire = path.join(kimiHome, "sessions", "wk", "sess-k", "agents", "main", "wire.jsonl");
    mkdirSync(path.dirname(wire), { recursive: true });
    const lines = [
      { type: "llm.request", kind: "loop", model: "kimi-k9" },
      { type: "context.append_loop_event", event: { type: "tool.call", toolCallId: "call_send", name: "Bash", args: { command: "raft message send --target x" } } },
      { type: "context.append_loop_event", event: { type: "tool.result", toolCallId: "call_send", result: { output: "Message ID: msg-k" } } },
    ];
    writeFileSync(wire, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
    return {
      runtime: "kimi-sdk",
      serverId: SERVER,
      sessionId: "sess-k",
      running: true,
      sessionRoot: kimiHome,
      allowedRoots: [kimiHome],
      resolveSessionFile: () => wire,
    };
  }

  async function view(service: AgentContextViewService) {
    await service.handleRequest(request({ messageId: "msg-k" }));
    expect(posts).toHaveLength(1);
    const parsed = parseAgentContextViewResultBody(postedBody(posts[0]!));
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.body;
  }

  it("answers with the redacted rebuild and its verification, whether or not the send was indexed", async () => {
    facts.set("a1", kimiAgent());
    const service = makeService();
    service.observeFlag("a1", true, "start");

    const body = await view(service);

    if (!body.ok) throw new Error("expected a view");
    expect(body.context).toMatchObject({
      runtime: "kimi-sdk",
      messageId: "msg-k",
      verification: "count_matched",
      source: { format: "kimi-wire" },
      trigger: { messageIndex: 1, partIndex: 0, toolUseId: "call_send" },
    });
    expect(JSON.stringify(body.context)).not.toContain("sk-ant-api03");
    expect(traces.find((t) => t.name === "daemon.agent_context_view.request")!.attrs).toMatchObject({ outcome: "ok", verification: "count_matched" });
  });

  it("indexes a send under the SDK home, and reports support once the file records requests", async () => {
    facts.set("a1", kimiAgent());
    const service = makeService();
    service.observeFlag("a1", true, "start");

    expect(await service.availability("a1")).toMatchObject({ runtime: "kimi-sdk", supported: true });
    service.onMessageCommitted("a1", "m", "send");
    await vi.waitFor(() => expect(traces.some((t) => t.name === "daemon.agent_context_view.index" && t.attrs.outcome === "indexed")).toBe(true));
  });

  it("refuses with the mismatch reason, showing nothing", async () => {
    facts.set("a1", kimiAgent());
    kimiRebuild = { status: "refused", reason: "messages_hash_mismatch", detail: "no" };
    const service = makeService();
    service.observeFlag("a1", true, "start");

    expect(await view(service)).toEqual({ ok: false, reason: "context_mismatch" });
    expect(traces.find((t) => t.name === "daemon.agent_context_view.request")!.attrs).toMatchObject({ outcome: "context_mismatch" });
  });

  it("does not load the SDK for a Claude view", async () => {
    const service = makeService();
    service.observeFlag("a1", true, "start");
    indexMsg1();

    await service.handleRequest(request());

    expect(kimiRebuildLoads).toBe(0);
  });
});

describe("view request", () => {
  async function answer(service: AgentContextViewService, frame: unknown = request()) {
    await service.handleRequest(frame);
    expect(posts).toHaveLength(1);
    return { post: posts[0]!, body: postedBody(posts[0]!) };
  }

  it("skips a request with too little of the viewer's wait left to restore in, and any once the daemon is stopping", async () => {
    const service = makeService();
    service.observeFlag("a1", true, "start");
    indexMsg1();

    const late = service.handleRequest(request());
    nowMs += 23_000;
    await late;
    expect(restores).toHaveLength(0);
    expect(posts).toHaveLength(0);
    expect(traces.some((t) => t.name === "daemon.agent_context_view.request_expired")).toBe(true);

    service.dispose();
    await service.handleRequest(request());
    expect(restores).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  it("gives the restore what's left of the viewer's wait, and a signal the daemon's stop ends", async () => {
    const service = makeService();
    service.observeFlag("a1", true, "start");
    indexMsg1();
    const waited = 22_000;
    const held = service.handleRequest(request());
    nowMs += waited;
    await held;

    expect(restores[0]!.options?.timeoutMs).toBe(30_000 - waited - 5_000);
    expect(restores[0]!.request).toMatchObject({ runtime: "claude", messageId: "msg-1" });
    expect(restores[0]!.options?.signal?.aborted).toBe(false);
    service.dispose();
    expect(restores[0]!.options?.signal?.aborted).toBe(true);
  });

  it("answers with one gzipped, authenticated POST of the restored, redacted view", async () => {
    const service = makeService();
    service.observeFlag("a1", true, "start");
    indexMsg1();
    const { post, body } = await answer(service);
    expect(post.url).toBe(`https://server.test/internal/computer/agent-context/${REQUEST_ID}`);
    expect(post.headers.authorization).toBe("Bearer sk_machine_test");
    expect(post.headers["content-type"]).toBe("application/json");
    expect(post.headers["content-encoding"]).toBe("gzip");
    expect(Number(post.headers[AGENT_CONTEXT_VIEW_UNCOMPRESSED_BYTES_HEADER])).toBe(gunzipSync(post.body).length);
    const parsed = parseAgentContextViewResultBody(body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.body.ok) throw new Error("expected a view");
    expect(parsed.body.context.messageId).toBe("msg-1");
    expect(parsed.body.context.trigger).toEqual({ messageIndex: 1, partIndex: 2, toolUseId: "toolu_1" });
    const trace = traces.find((t) => t.name === "daemon.agent_context_view.request")!;
    expect(parsed.body.context.verification).toBe("verified");
    expect(trace.attrs).toMatchObject({ outcome: "ok", source: "index", digest_match: true, post_outcome: "accepted", http_status: 200, trigger_found: true });
    // Low cardinality: no content or path in the trace.
    expect(JSON.stringify(trace.attrs)).not.toMatch(/proj|sess-1|plan/);
  });

  it("an agent's search answers entries of the redacted view, never the view, and keeps the query out of traces", async () => {
    const service = makeService();
    service.observeFlag("a1", true, "start");
    indexMsg1();
    const frame = request({ type: "agent:context_search_request", query: { kind: "search", query: "plan", limit: 5, offset: 0 } });
    const { body } = await answer(service, frame);
    expect(body).toMatchObject({ ok: true, runtime: "claude", answer: { kind: "search" } });
    expect(body).not.toHaveProperty("context");
    const answerBody = body as { entryCount: number; answer: { total: number; matches: Array<{ id: string; line: string }> } };
    expect(answerBody.entryCount).toBeGreaterThan(0);
    expect(answerBody.answer.total).toBeGreaterThan(0);
    for (const match of answerBody.answer.matches) {
      expect(match.id).toMatch(/^(s\d+|t\d+|m\d+\.p\d+)$/);
      expect(match.line.toLowerCase()).toContain("plan");
    }
    const trace = traces.find((t) => t.name === "daemon.agent_context_view.request")!;
    expect(trace.attrs).toMatchObject({ mode: "search", query_kind: "search", outcome: "ok" });
    expect(JSON.stringify(traces)).not.toContain('"plan"');
  });

  it("an agent's read answers a window around one entry; an unknown entry says so", async () => {
    const service = makeService();
    service.observeFlag("a1", true, "start");
    indexMsg1();
    const { body } = await answer(service, request({ type: "agent:context_search_request", query: { kind: "read", around: "m1.p0", limit: 3, page: 1 } }));
    expect(body).toMatchObject({ ok: true, answer: { kind: "read", found: true } });
    expect((body as { answer: { entries: Array<{ id: string }> } }).answer.entries.map((entry) => entry.id)).toContain("m1.p0");
    posts.length = 0;
    const missing = await answer(service, request({ type: "agent:context_search_request", query: { kind: "read", around: "m99.p0", limit: 3, page: 1 } }));
    expect(missing.body).toMatchObject({ ok: true, answer: { kind: "read", found: false } });
  });

  it("a search frame that doesn't parse is dropped, as a bad view frame is", async () => {
    const service = makeService();
    service.observeFlag("a1", true, "start");
    await service.handleRequest(request({ type: "agent:context_search_request", query: { kind: "search", query: "", limit: 5, offset: 0 } }));
    await service.handleRequest(request({ type: "agent:context_search_request", query: { kind: "read", around: "../x", limit: 3, page: 1 } }));
    expect(posts).toHaveLength(0);
    expect(traces.filter((t) => t.name === "daemon.agent_context_view.request_invalid")).toHaveLength(2);
  });

  it("finds a message with no index line in the current session (the CLI's `Message ID:` output)", async () => {
    const service = makeService();
    service.observeFlag("a1", true, "start");
    const { body } = await answer(service, request({ messageId: "msg-2" }));
    expect(body).toMatchObject({ ok: true, context: { messageId: "msg-2", trigger: { toolUseId: "toolu_2" } } });
  });

  it.each([
    ["the gate is off", (service: AgentContextViewService) => service.observeFlag("a1", false, "server_features"), request(), "not_found"],
    ["the agent is unknown", () => facts.set("a1", {}), request(), "not_found"],
    // The boundary between servers on a shared Computer: this daemon's key never uploads another server's agent.
    ["the agent belongs to another server than this daemon's", () => facts.set("a1", claudeAgent({ serverId: "srv_b" })), request(), "not_found"],
    ["this daemon's server is not known yet", () => { connectedServerId = null; }, request(), "not_found"],
    ["the runtime has no reader", () => facts.set("a1", claudeAgent({ runtime: "opencode" })), request(), "unsupported_runtime"],
    ["no line and not in the session", () => {}, request({ messageId: "msg-404" }), "not_found"],
    ["the session file is gone", () => rmSync(sessionFile), request(), "not_found"],
    // Sparse: over the source cap on disk, nothing to read.
    ["the session file is over the source cap", () => truncateSync(sessionFile, CONTEXT_VIEW_SOURCE_MAX_BYTES + 1), request(), "too_large", "session_file"],
    ["the restored view is over maxBytes", () => {}, request({ maxBytes: 200 }), "too_large", "request"],
  ] as const)("posts {ok:false} when %s", async (_label, arrange: (service: AgentContextViewService) => unknown, frame, reason, tooLargeCause?: string) => {
    const service = makeService();
    service.observeFlag("a1", true, "start");
    indexMsg1();
    arrange(service);
    const { body } = await answer(service, frame);
    expect(body).toEqual({ ok: false, reason, ...(tooLargeCause ? { tooLargeCause } : {}) });
  });

  it("refuses an index path that leaves the session root (read_failed)", async () => {
    const service = makeService();
    service.observeFlag("a1", true, "start");
    appendContextViewIndexLine(dir, "a1", { messageId: "msg-1", sentAt: new Date(nowMs).toISOString(), runtime: "claude", sessionId: "s", transcript: "../../escape.jsonl", offset: 1 });
    const { body } = await answer(service);
    expect(body).toEqual({ ok: false, reason: "read_failed" });
  });

  it("posts nothing for a frame that is not a valid request", async () => {
    const service = makeService();
    service.observeFlag("a1", true, "start");
    await service.handleRequest(request({ requestId: "not-an-id" }));
    await service.handleRequest(request({ maxBytes: 0 }));
    expect(posts).toHaveLength(0);
    expect(traces.filter((t) => t.name === "daemon.agent_context_view.request_invalid")).toHaveLength(2);
  });

  it("runs one restore at a time, and skips one that waited past the viewer's wait (the server already answered it `expired`)", async () => {
    let release!: () => void;
    postAnswer = () => new Promise((resolve) => { release = () => resolve(new Response("{}", { status: 200 })); });
    const service = makeService();
    service.observeFlag("a1", true, "start");
    indexMsg1();
    const first = service.handleRequest(request());
    const queued = service.handleRequest(request({ requestId: "ctxv_fedcba9876543210fedc" }));
    const queuedToo = service.handleRequest(request({ requestId: "ctxv_00000000000000000001" }));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    // While the first is still answering, nothing else restores.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posts).toHaveLength(1);
    expect(traces.filter((t) => t.name === "daemon.agent_context_view.request")).toHaveLength(0);

    nowMs += AGENT_CONTEXT_VIEW_VIEWER_WAIT_MS;
    release();
    await Promise.all([first, queued, queuedToo]);
    expect(posts).toHaveLength(1);
    expect(traces.filter((t) => t.name === "daemon.agent_context_view.request_expired").map((t) => t.attrs)).toEqual([
      { agentId: "a1", queued_ms: AGENT_CONTEXT_VIEW_VIEWER_WAIT_MS },
      { agentId: "a1", queued_ms: AGENT_CONTEXT_VIEW_VIEWER_WAIT_MS },
    ]);

    // One that waited just under the viewer's wait is still answered.
    const waiting = service.handleRequest(request({ requestId: "ctxv_00000000000000000002" }));
    const justInTime = service.handleRequest(request({ requestId: "ctxv_00000000000000000003" }));
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    nowMs += 22_999; // the last moment a restore still starts: 5 s for the POST, 2 s to run
    postAnswer = async () => new Response("{}", { status: 200 });
    release();
    await Promise.all([waiting, justInTime]);
    expect(posts).toHaveLength(3);
    expect(traces.filter((t) => t.name === "daemon.agent_context_view.request_expired")).toHaveLength(2);
  });

  it.each([
    ["a network failure", async () => { throw new TypeError("fetch failed"); }, "failed"],
    ["410 expired", async () => new Response("{}", { status: 410 }), "refused"],
    ["409 already answered", async () => new Response("{}", { status: 409 }), "refused"],
    ["500", async () => new Response("{}", { status: 500 }), "refused"],
  ] as const)("never retries the POST after %s", async (_label, reply, outcome) => {
    postAnswer = reply;
    const service = makeService();
    service.observeFlag("a1", true, "start");
    indexMsg1();
    await service.handleRequest(request());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posts).toHaveLength(1);
    expect(traces.find((t) => t.name === "daemon.agent_context_view.request")?.attrs.post_outcome).toBe(outcome);
  });
});

describe("availability", () => {
  it("reports at start: supported once the session records requests, else no_session; other runtimes unsupported", async () => {
    facts.set("a2", claudeAgent({ resolveSessionFile: () => null }));
    facts.set("a3", claudeAgent({ runtime: "opencode" }));
    const service = makeService();
    service.onAgentStart("a1", true);
    service.onAgentStart("a2", true);
    service.onAgentStart("a3", true);
    service.onAgentStart("a4", false);
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent.sort((a, b) => a.agentId.localeCompare(b.agentId))).toEqual([
      { type: "agent:context_view_availability", agentId: "a1", runtime: "claude", supported: true, retainedSince: null, retentionDays: 30 },
      { type: "agent:context_view_availability", agentId: "a2", runtime: "claude", supported: false, unsupportedReason: "no_session", retainedSince: null, retentionDays: 30 },
      { type: "agent:context_view_availability", agentId: "a3", runtime: "opencode", supported: false, unsupportedReason: "unsupported_runtime", retainedSince: null, retentionDays: 30 },
    ]);
    // What the Server's reader accepts, unchanged.
    for (const frame of sent) expect(readAgentContextViewAvailability(frame)).toEqual(frame);
  });

  it("reports a running agent when a server answer turns the gate on, not when it stays on", async () => {
    const service = makeService();
    service.applyServerFlag(true, ["a1"]);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    service.applyServerFlag(true, ["a1"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);
  });

  it("resends every running agent's report within 24 h (20-24 h, jittered), and stops on dispose", async () => {
    const service = makeService();
    service.onAgentStart("a1", true);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const refresh = timers.filter((timer) => !timer.cleared);
    expect(refresh).toHaveLength(1);
    expect(refresh[0]!.ms).toBe(AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_MAX_MS - 2 * HOUR);
    expect(refresh[0]!.ms).toBeLessThanOrEqual(24 * HOUR);
    nowMs += refresh[0]!.ms;
    refresh[0]!.callback();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual(sent[0]);
    const next = timers.filter((timer) => !timer.cleared && timer !== refresh[0]);
    expect(next).toHaveLength(1);
    service.dispose();
    expect(next[0]!.cleared).toBe(true);
  });
});
