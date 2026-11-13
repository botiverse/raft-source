// View Context relay across two replicas: the viewer waits on replica A, the
// daemon's result lands on replica B, and B streams it to A over the signed
// internal hop. Two in-process HTTP servers, one shared request store.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import express from "express";
import {
  asAgentContextViewRequestId,
  asMachineId,
  type AgentContextViewRequestId,
  type AgentContextSearchRequestMessage,
  type AgentContextViewRequestMessage,
} from "@botiverse/raft-shared";
import { signReplicaRequestHeaders } from "../machineLocalReplay";
import {
  AGENT_CONTEXT_VIEW_FORWARD_ROUTE,
  AgentContextViewRelay,
  agentContextViewForwardPath,
  type AgentContextViewAttemptEntry,
  type AgentContextViewAuditEntry,
  type AgentContextViewOrchestrator,
  type AgentContextViewRelayDeps,
} from "./agentContextViewRelay";
import type { AgentContextViewRequestClaim, AgentContextViewRequestRecord, AgentContextViewRequestStore } from "./replicaStateStore";

const MACHINE = asMachineId("machine-1");

function requestId(value: string): AgentContextViewRequestId {
  const id = asAgentContextViewRequestId(value);
  assert.ok(id, value);
  return id;
}

function memoryStore(): AgentContextViewRequestStore {
  const records = new Map<string, { record: AgentContextViewRequestRecord; claimed: boolean }>();
  return {
    async create(record) {
      records.set(record.requestId, { record, claimed: false });
    },
    async get(requestId) {
      const entry = records.get(requestId);
      return entry ? { ...entry } : null;
    },
    async claim(requestId, callerMachineId): Promise<AgentContextViewRequestClaim> {
      const entry = records.get(requestId);
      if (!entry) return { kind: "unknown" };
      if (entry.record.machineId !== callerMachineId) return { kind: "wrong_computer" };
      if (entry.claimed) return { kind: "already_claimed" };
      entry.claimed = true;
      return { kind: "claimed", record: entry.record };
    },
  };
}

async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

type ReplicaOptions = {
  /** Deps of replica A (the viewer's) and replica B (the daemon's). */
  a?: Partial<AgentContextViewRelayDeps>;
  b?: Partial<AgentContextViewRelayDeps>;
  /** Replica A records no replay endpoint. */
  noEndpointA?: boolean;
  orchestrator?: Partial<AgentContextViewOrchestrator>;
};

/** Replica A holds the viewer (GET /view); replica B takes the daemon's POST (/result/:requestId). */
async function twoReplicas(options: ReplicaOptions = {}) {
  const store = memoryStore();
  const attempts: AgentContextViewAttemptEntry[] = [];
  const audits: AgentContextViewAuditEntry[] = [];
  const frames: Array<AgentContextViewRequestMessage | AgentContextSearchRequestMessage> = [];
  const capabilitiesAsked: string[] = [];
  let endpointA = "";
  const deps = {
    store,
    recheck: async () => "ok" as const,
    describeComputer: async () => ({ computer: null, computerOwner: null }),
    recordAttempt: async (entry: AgentContextViewAttemptEntry) => {
      attempts.push(entry);
    },
    audit: async (entry: AgentContextViewAuditEntry) => {
      audits.push(entry);
    },
  };
  const relayA = new AgentContextViewRelay({ ...deps, replicaId: "replica-a", replicaEndpoint: () => options.noEndpointA ? null : endpointA, ...options.a });
  const relayB = new AgentContextViewRelay({ ...deps, replicaId: "replica-b", replicaEndpoint: () => null, ...options.b });

  const appA = express();
  appA.get("/view", (_req, res, next) => {
    relayA.openView({
      res,
      viewerUserId: "viewer-1",
      agent: { id: "agent-1", serverId: "server-1", runtime: "claude", machineId: MACHINE },
      messageId: "message-1",
      orchestrator: {
        getMachineStatus: async () => "online",
        machineAdvertisesCapability: async () => true,
        sendAgentContextViewRequest: async (_machineId, frame) => {
          frames.push(frame);
          return true;
        },
        ...options.orchestrator,
      },
    }).catch(next);
  });
  appA.get("/query", (req, res, next) => {
    relayA.openQuery({
      viewerAgentId: "agent-1",
      agent: { id: "agent-1", serverId: "server-1", runtime: typeof req.query.runtime === "string" ? req.query.runtime : "claude", machineId: MACHINE },
      messageId: "message-1",
      query: { kind: "search", query: "deploy", limit: 20, offset: 0 },
      orchestrator: {
        getMachineStatus: async () => "online",
        machineAdvertisesCapability: async (_machineId, capability) => {
          capabilitiesAsked.push(capability);
          return true;
        },
        sendAgentContextViewRequest: async (_machineId, frame) => {
          frames.push(frame);
          return true;
        },
        ...options.orchestrator,
      },
    }).then((result) => res.json(result)).catch(next);
  });
  appA.post(AGENT_CONTEXT_VIEW_FORWARD_ROUTE, (req, res, next) => {
    relayA.receiveForward(req, res).catch(next);
  });
  const appB = express();
  appB.post("/result/:requestId", (req, res, next) => {
    relayB.receiveResult(req, res, MACHINE).catch(next);
  });
  const a = await listen(appA);
  const b = await listen(appB);
  endpointA = a.url;

  return {
    store,
    attempts,
    audits,
    frames,
    capabilitiesAsked,
    a,
    b,
    async nextFrame() {
      for (let i = 0; i < 200 && frames.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(frames[0], "request frame sent");
      return frames.shift()!;
    },
    async close() {
      a.server.closeAllConnections();
      b.server.closeAllConnections();
      a.server.close();
      b.server.close();
    },
  };
}

/** The daemon's POST, written chunk by chunk with backpressure; stops writing once the Server answers. */
function postChunks(url: string, chunks: Buffer[], delayMs = 0): Promise<{ status: number; body: string; written: number }> {
  return new Promise((resolve, reject) => {
    let written = 0;
    let answered = false;
    const outgoing = request(url, { method: "POST", headers: { "content-type": "application/json" } });
    outgoing.on("response", (response: IncomingMessage) => {
      answered = true;
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body, written }));
    });
    outgoing.on("error", (error) => {
      if (!answered) reject(error);
    });
    void (async () => {
      for (const chunk of chunks) {
        if (answered || outgoing.destroyed) return;
        written += 1;
        if (!outgoing.write(chunk)) await once(outgoing, "drain").catch(() => {});
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      outgoing.end();
    })();
  });
}

function bigBody(totalChunks: number, chunkBytes = 16 * 1024): Buffer[] {
  const chunks = [Buffer.from("{\"ok\":true,\"context\":{\"pad\":\"")];
  for (let i = 0; i < totalChunks; i++) chunks.push(Buffer.from(String(i % 10).repeat(chunkBytes)));
  chunks.push(Buffer.from("\"}}"));
  return chunks;
}

const QUERY_ANSWER = {
  ok: true,
  runtime: "claude",
  model: null,
  entryCount: 4,
  answer: { kind: "search", total: 1, matches: [{ id: "m1.p0", role: "user", type: "text", hits: 1, line: "the deploy notes" }] },
};

test("an agent's search: the search frame, behind the search capability, and the answer across replicas", async () => {
  const r = await twoReplicas();
  try {
    const asking = fetch(`${r.a.url}/query`).then(async (res) => (await res.json()) as Record<string, unknown>);
    const frame = await r.nextFrame();
    assert.equal(frame.type, "agent:context_search_request");
    assert.deepEqual((frame as AgentContextSearchRequestMessage).query, { kind: "search", query: "deploy", limit: 20, offset: 0 });
    assert.deepEqual(r.capabilitiesAsked, ["agent-context-search:v0"]);
    const daemon = await postChunks(`${r.b.url}/result/${frame.requestId}`, [Buffer.from(JSON.stringify(QUERY_ANSWER))]);
    assert.equal(daemon.status, 200, daemon.body);
    const result = await asking;
    assert.deepEqual(result, { kind: "answer", body: QUERY_ANSWER });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(r.attempts[0], {
      requestId: frame.requestId, viewerUserId: "agent-1", viewerKind: "agent", query: { mode: "search", query: "deploy", matches: null },
      agentId: "agent-1", serverId: "server-1", messageId: "message-1", machineId: MACHINE,
    });
    assert.deepEqual([r.audits[0]?.outcome, r.audits[0]?.viewerKind, r.audits[0]?.query], ["ok", "agent", { mode: "search", query: "deploy", matches: 1 }]);
    const record = (await r.store.get(frame.requestId))?.record;
    assert.deepEqual([record?.viewerKind, record?.mode], ["agent", "query"]);
  } finally {
    await r.close();
  }
});

test("an agent's search never gets a whole view, whatever the daemon sends: read_failed", async () => {
  const r = await twoReplicas();
  try {
    const asking = fetch(`${r.a.url}/query`).then(async (res) => (await res.json()) as Record<string, unknown>);
    const frame = await r.nextFrame();
    const view = { ok: true, context: { messageId: "message-1", system: [{ text: "secret prompt" }] } };
    await postChunks(`${r.b.url}/result/${frame.requestId}`, [Buffer.from(JSON.stringify(view))]);
    const result = await asking;
    assert.equal(result.kind, "failure");
    assert.equal(result.reason, "read_failed");
    assert.ok(!JSON.stringify(result).includes("secret prompt"));
  } finally {
    await r.close();
  }
});

test("an agent's search to a Computer without the search capability is old_daemon, with nothing sent", async () => {
  const r = await twoReplicas({ orchestrator: { machineAdvertisesCapability: async (_machineId, capability) => capability !== "agent-context-search:v0" } });
  try {
    const result = await fetch(`${r.a.url}/query`).then(async (res) => (await res.json()) as Record<string, unknown>);
    assert.deepEqual([result.kind, result.reason], ["failure", "old_daemon"]);
    assert.equal(r.frames.length, 0);
  } finally {
    await r.close();
  }
});

test("a Codex agent's context is asked only of a Computer that reads Codex sessions alone (#13469): old_daemon otherwise", async () => {
  const advertised = new Set(["agent-context-view:v0", "agent-context-search:v0"]);
  const r = await twoReplicas({ orchestrator: { machineAdvertisesCapability: async (_machineId, capability) => advertised.has(capability) } });
  try {
    const codex = await fetch(`${r.a.url}/query?runtime=codex`).then(async (res) => (await res.json()) as Record<string, unknown>);
    assert.deepEqual([codex.kind, codex.reason], ["failure", "old_daemon"]);
    assert.equal(r.frames.length, 0, "nothing sent to the old daemon");
    const claude = fetch(`${r.a.url}/query?runtime=claude`).then(async (res) => (await res.json()) as Record<string, unknown>);
    const frame = await r.nextFrame();
    assert.equal(frame.type, "agent:context_search_request", "other runtimes don't need it");
    await postChunks(`${r.b.url}/result/${frame.requestId}`, [Buffer.from(JSON.stringify(QUERY_ANSWER))]);
    assert.equal((await claude).kind, "answer");
    advertised.add("agent-context-view-codex-root:v1");
    const upgraded = fetch(`${r.a.url}/query?runtime=codex`).then(async (res) => (await res.json()) as Record<string, unknown>);
    const codexFrame = await r.nextFrame();
    await postChunks(`${r.b.url}/result/${codexFrame.requestId}`, [Buffer.from(JSON.stringify({ ...QUERY_ANSWER, runtime: "codex" }))]);
    assert.equal((await upgraded).kind, "answer");
  } finally {
    await r.close();
  }
});

test("a daemon's failure for a search reaches the agent with its cause", async () => {
  const r = await twoReplicas();
  try {
    const asking = fetch(`${r.a.url}/query`).then(async (res) => (await res.json()) as Record<string, unknown>);
    const frame = await r.nextFrame();
    await postChunks(`${r.b.url}/result/${frame.requestId}`, [Buffer.from(JSON.stringify({ ok: false, reason: "too_large", tooLargeCause: "session_file" }))]);
    const result = await asking;
    assert.deepEqual([result.kind, result.reason, result.tooLargeCause], ["failure", "too_large", "session_file"]);
  } finally {
    await r.close();
  }
});

test("a too_large cause survives the hop to the viewer's replica", async () => {
  const r = await twoReplicas();
  try {
    const viewing = fetch(`${r.a.url}/view`).then(async (res) => (await res.json()) as { reason?: string; tooLargeCause?: string });
    const frame = await r.nextFrame();
    const daemon = await postChunks(`${r.b.url}/result/${frame.requestId}`, [Buffer.from(JSON.stringify({ ok: false, reason: "too_large", tooLargeCause: "session_file" }))]);
    assert.equal(daemon.status, 200, daemon.body);
    const viewer = await viewing;
    assert.deepEqual([viewer.reason, viewer.tooLargeCause], ["too_large", "session_file"]);
  } finally {
    await r.close();
  }
});

test("a result on another replica reaches the viewer whole and in order", async () => {
  const r = await twoReplicas();
  try {
    const viewing = fetch(`${r.a.url}/view`).then(async (res) => ({ status: res.status, text: await res.text() }));
    const frame = await r.nextFrame();
    const chunks = bigBody(64);
    const daemon = await postChunks(`${r.b.url}/result/${frame.requestId}`, chunks);
    const viewer = await viewing;
    assert.equal(daemon.status, 200, daemon.body);
    assert.equal(viewer.status, 200);
    assert.equal(viewer.text, Buffer.concat(chunks).toString("utf8"), "every byte, in order");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(r.audits[0]?.outcome, "ok");
    assert.equal(r.audits[0]?.bytes, Buffer.concat(chunks).length);
    assert.equal(r.attempts.length, 1, "one attempt, recorded before the request went out");
    assert.equal(r.attempts[0]?.requestId, frame.requestId);
    assert.equal(r.audits[0]?.requestId, frame.requestId, "the outcome is linked to its attempt");
  } finally {
    await r.close();
  }
});

test("the viewer leaving aborts the hop and the daemon's upload (410), and is audited cancelled", async () => {
  const r = await twoReplicas();
  try {
    let viewerRequest: ReturnType<typeof request> | null = null;
    const firstBytes = new Promise<void>((resolve) => {
      viewerRequest = request(`${r.a.url}/view`, (res) => {
        res.once("data", () => {
          resolve();
          viewerRequest!.destroy();
        });
      });
      viewerRequest.on("error", () => {});
      viewerRequest.end();
    });
    const frame = await r.nextFrame();
    const chunks = bigBody(2_000);
    const daemon = postChunks(`${r.b.url}/result/${frame.requestId}`, chunks, 2);
    await firstBytes;
    const answered = await daemon;
    assert.equal(answered.status, 410);
    assert.match(answered.body, /"code":"expired"/);
    assert.ok(answered.written < chunks.length, `upload stopped early (${answered.written} of ${chunks.length} chunks)`);
    for (let i = 0; i < 100 && r.audits.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(r.audits[0]?.outcome, "cancelled");
  } finally {
    await r.close();
  }
});

async function postForward(url: string, requestId: AgentContextViewRequestId, headers: Record<string, string>, body = "{}") {
  const res = await fetch(`${url}${agentContextViewForwardPath(requestId)}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", ...headers },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => null) as { code?: string } | null };
}

function signed(requestId: AgentContextViewRequestId) {
  return signReplicaRequestHeaders("POST", agentContextViewForwardPath(requestId), requestId);
}

test("the internal endpoint: a bad or missing signature, a wrong replica, an unclaimed request and a second stream are refused", async () => {
  const r = await twoReplicas();
  try {
    const viewing = fetch(`${r.a.url}/view`).then(async (res) => ({ status: res.status, text: await res.text() }))
      .catch((error: unknown) => ({ status: 0, text: String(error) }));
    const frame = await r.nextFrame();
    const id = frame.requestId;

    assert.equal((await postForward(r.a.url, id, {})).status, 401, "unsigned");
    const forged = { ...signed(id), "x-raft-replica-replay-signature": "0".repeat(64) };
    assert.equal((await postForward(r.a.url, id, forged)).status, 401, "bad signature");
    const otherId = requestId(`ctxv_${"a".repeat(32)}`);
    assert.equal((await postForward(r.a.url, id, signed(otherId))).status, 401, "signed for another request");

    assert.deepEqual(await postForward(r.a.url, id, signed(id)), { status: 409, body: { ok: false, code: "not_claimed" } });

    // A request whose viewer waits on another replica.
    const elsewhere: AgentContextViewRequestRecord = {
      requestId: requestId(`ctxv_${"b".repeat(32)}`),
      viewerUserId: "viewer-1",
      agentId: "agent-1",
      serverId: "server-1",
      messageId: "message-1",
      machineId: MACHINE,
      viewerReplicaId: "replica-b",
      viewerEndpoint: null,
      createdAt: new Date().toISOString(),
    };
    await r.store.create(elsewhere, 60_000);
    await r.store.claim(elsewhere.requestId, MACHINE, 60_000);
    assert.deepEqual(await postForward(r.a.url, elsewhere.requestId, signed(elsewhere.requestId)), { status: 409, body: { ok: false, code: "not_viewer_replica" } });

    // First stream in flight (held open), then a second one for the same request.
    await r.store.claim(id, MACHINE, 60_000);
    const path = agentContextViewForwardPath(id);
    const first = request(`${r.a.url}${path}`, { method: "POST", headers: { ...signed(id), "content-type": "application/octet-stream" } });
    first.on("error", () => {});
    const firstAnswer = new Promise<number>((resolve) => first.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }));
    first.write(Buffer.from("{\"ok\":true,\"context\":"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(await postForward(r.a.url, id, signed(id), "{}"), { status: 409, body: { ok: false, code: "already_answered" } });
    first.end("{\"x\":1}}");
    assert.equal(await firstAnswer, 200);
    const viewer = await viewing;
    assert.equal(viewer.text, "{\"ok\":true,\"context\":{\"x\":1}}", "the first stream, untouched by the second");
  } finally {
    await r.close();
  }
});

/** The viewer's answer, or the error a cut response gives. */
function viewOn(url: string): Promise<{ status: number; text: string } | { error: unknown }> {
  return fetch(`${url}/view`)
    .then(async (res) => ({ status: res.status, text: await res.text() }))
    .catch((error: unknown) => ({ error }));
}

async function waitForAudits(audits: AgentContextViewAuditEntry[], count = 1) {
  for (let i = 0; i < 200 && audits.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(audits.length >= count, `expected ${count} audit entries`);
}

function assertCut(answer: { status: number; text: string } | { error: unknown }) {
  if ("text" in answer) assert.throws(() => JSON.parse(answer.text), "a cut response holds no valid JSON");
  else assert.ok(!(answer.error instanceof assert.AssertionError), String(answer.error));
}

test("a failure on our side after the access check (the store, the orchestrator) answers read_failed once and is audited", async () => {
  const throwingStore = { ...memoryStore(), create: async () => {
    throw new Error("redis down");
  } };
  const r = await twoReplicas({ a: { store: throwingStore } });
  try {
    const answer = await viewOn(r.a.url);
    assert.ok("text" in answer);
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.text), { ok: false, reason: "read_failed", computer: null, computerOwner: null });
    await waitForAudits(r.audits);
    assert.equal(r.audits[0]?.outcome, "read_failed");
    assert.equal(r.audits.length, 1);
  } finally {
    await r.close();
  }

  const s = await twoReplicas({ orchestrator: { getMachineStatus: async () => {
    throw new Error("orchestrator down");
  } } });
  try {
    const answer = await viewOn(s.a.url);
    assert.ok("text" in answer);
    assert.equal(JSON.parse(answer.text).reason, "read_failed");
    await waitForAudits(s.audits);
    assert.equal(s.audits[0]?.outcome, "read_failed");
  } finally {
    await s.close();
  }
});

test("the attempt record failing: read_failed, nothing stored or sent, no outcome row", async () => {
  let created = 0;
  const store = memoryStore();
  const countingStore: AgentContextViewRequestStore = { ...store, create: async (record, ttlMs) => {
    created += 1;
    await store.create(record, ttlMs);
  } };
  const r = await twoReplicas({ a: { store: countingStore, recordAttempt: async () => {
    throw new Error("audit write failed");
  } } });
  try {
    const answer = await viewOn(r.a.url);
    assert.ok("text" in answer);
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.text), { ok: false, reason: "read_failed", computer: null, computerOwner: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(r.frames.length, 0, "no request frame to the Computer");
    assert.equal(created, 0, "no request record stored");
    assert.equal(r.audits.length, 0, "no outcome without an attempt");
  } finally {
    await r.close();
  }
});

test("the viewer's deadline ends a trickling stream: viewer cut, hop and upload stopped (410), audited expired", async () => {
  const r = await twoReplicas({ a: { deadlineMs: 400 } });
  try {
    const viewing = viewOn(r.a.url);
    const frame = await r.nextFrame();
    const chunks = bigBody(2_000);
    const startedAt = Date.now();
    const daemon = await postChunks(`${r.b.url}/result/${frame.requestId}`, chunks, 5);
    assert.equal(daemon.status, 410, daemon.body);
    assert.match(daemon.body, /"code":"expired"/);
    assert.ok(daemon.written < chunks.length, `upload stopped early (${daemon.written} of ${chunks.length} chunks)`);
    assert.ok(Date.now() - startedAt < 5_000, "ended near the deadline");
    assertCut(await viewing);
    await waitForAudits(r.audits);
    assert.equal(r.audits[0]?.outcome, "expired");
  } finally {
    await r.close();
  }
});

test("the result side's deadline ends a trickling upload and the hop: daemon 410, viewer cut (read_failed on the viewer's replica)", async () => {
  const r = await twoReplicas({ b: { deadlineMs: 400 } });
  try {
    const viewing = viewOn(r.a.url);
    const frame = await r.nextFrame();
    const chunks = bigBody(2_000);
    const daemon = await postChunks(`${r.b.url}/result/${frame.requestId}`, chunks, 5);
    assert.equal(daemon.status, 410, daemon.body);
    assert.match(daemon.body, /"code":"expired"/);
    assert.ok(daemon.written < chunks.length, `upload stopped early (${daemon.written} of ${chunks.length} chunks)`);
    assertCut(await viewing);
    await waitForAudits(r.audits);
    // The viewer's replica sees only an aborted hop (no trailer carries the cause).
    assert.equal(r.audits[0]?.outcome, "read_failed");
  } finally {
    await r.close();
  }
});

test("a viewer replica with no endpoint: the daemon gets 410, the viewer expired", async () => {
  const r = await twoReplicas({ noEndpointA: true, a: { waitMs: 300 } });
  try {
    const viewing = viewOn(r.a.url);
    const frame = await r.nextFrame();
    const daemon = await postChunks(`${r.b.url}/result/${frame.requestId}`, [Buffer.from(JSON.stringify({ ok: false, reason: "not_found" }))]);
    assert.equal(daemon.status, 410, daemon.body);
    assert.match(daemon.body, /"code":"expired"/);
    const answer = await viewing;
    assert.ok("text" in answer);
    assert.equal(JSON.parse(answer.text).reason, "expired");
  } finally {
    await r.close();
  }
});

test("the hop has an idle timeout: a viewer replica that never answers gives the daemon 410", async () => {
  const sockets: Socket[] = [];
  const blackHole = createNetServer((socket) => {
    sockets.push(socket);
  });
  blackHole.listen(0, "127.0.0.1");
  await once(blackHole, "listening");
  const r = await twoReplicas({ b: { forwardIdleTimeoutMs: 200 } });
  try {
    const record: AgentContextViewRequestRecord = {
      requestId: requestId(`ctxv_${"c".repeat(32)}`),
      viewerUserId: "viewer-1",
      agentId: "agent-1",
      serverId: "server-1",
      messageId: "message-1",
      machineId: MACHINE,
      viewerReplicaId: "replica-x",
      viewerEndpoint: `http://127.0.0.1:${(blackHole.address() as AddressInfo).port}`,
      createdAt: new Date().toISOString(),
    };
    await r.store.create(record, 60_000);
    const startedAt = Date.now();
    const daemon = await postChunks(`${r.b.url}/result/${record.requestId}`, [Buffer.from(JSON.stringify({ ok: false, reason: "not_found" }))]);
    assert.equal(daemon.status, 410, daemon.body);
    assert.ok(Date.now() - startedAt < 5_000, "did not wait for the request deadline");
  } finally {
    for (const socket of sockets) socket.destroy();
    blackHole.close();
    await r.close();
  }
});
