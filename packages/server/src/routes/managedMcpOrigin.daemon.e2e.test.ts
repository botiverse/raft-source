import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { asAxSurfaceText, type AgentConfig, type AgentMessage } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";

import { createAgentAppInboxStore, type AgentAppInboxStore } from "../../../daemon/src/agentAppInbox";
import { AgentProcessManager } from "../../../daemon/src/agentProcessManager";
import { REMINDER_AGENT_INBOX_REGISTRY } from "../../../daemon/src/apps/reminder/inboxDefinition";
import { setDaemonFetchImplForTests } from "../../../daemon/src/daemonFetch";
import { createManagedMcpPiTools } from "../../../daemon/src/drivers/managedMcpTools";
import { PiSdkRuntimeSession } from "../../../daemon/src/drivers/pi";
import type { ParsedEvent, RuntimeDriver, SpawnContext } from "../../../daemon/src/drivers/types";
import {
  __resetManagedMcpRuntimeProxyForTest,
  prepareManagedMcpRuntimeProxy,
} from "../../../daemon/src/managedMcpRuntimeProxy";
import { afterStartupMemoryBlock } from "../../../daemon/src/testing/promptFixture";
import { getDb } from "../db/index";
import { actionCards, channelAgents, channels, managedMcpServers, messages, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createServer } from "../services/serverService";

/**
 * ⭐ Daemon → agent-api, end to end, for the turn origin of a refused managed MCP call (task #21).
 *
 * @peng's acceptance for the origin shape (msg 3bc1a766): drive BOTH real call surfaces from a real
 * daemon, and do not substitute an HTTP request with a hand-written `origin`. Nothing below writes
 * an origin. Each case feeds a real Raft message (a row in this database) to a real
 * AgentProcessManager; the manager derives the origin, the RuntimeSession holds it, and the call
 * surface reads it at call time and sends it to the real agent-api route, which validates it and
 * decides whether a Connect card is posted and where.
 *
 * What is NOT real, stated so nobody reads more into a green run:
 *   · the runtime itself. The native-proxy case uses a scripted child process in place of a vendor
 *     CLI, and the Pi case uses a scripted SDK session. Both build their call surface exactly the way
 *     the production drivers do (the construction-site wiring is pinned separately in
 *     daemon/src/runtimeTurnOrigin.test.ts), and a "tool call" is the test invoking that surface.
 *   · the runner-credential mint. It is answered locally with an agent key minted in this database.
 */

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type SurfaceKind = "native-proxy" | "pi-tools";
const SURFACES: SurfaceKind[] = ["native-proxy", "pi-tools"];

// The Pi SDK is a daemon dependency, not a server one, so its types are taken from the daemon's own
// signatures rather than imported here.
type PiSessionFactory = NonNullable<ConstructorParameters<typeof PiSdkRuntimeSession>[2]>;
// The factory may also return a reopenable handle (pi session rotation); the bare session is the one with `subscribe`.
type AgentSession = Extract<Awaited<ReturnType<PiSessionFactory>>, { subscribe: unknown }>;
type AgentSessionEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];
type ToolDefinition = Awaited<ReturnType<typeof createManagedMcpPiTools>>[number];

/* ------------------------------------------------------------------ database fixture */

async function seedServer(agentCount = 1) {
  const suffix = randomUUID();
  const db = getDb();
  const [user] = await db.insert(users).values({
    email: `mcp-origin-${suffix}@slock.test`,
    name: `mcp-origin-${suffix}`,
    displayName: "Origin Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("MCP Origin", `mcp-origin-${suffix}`, user.id);
  const agents: Array<{ id: string; apiKey: string }> = [];
  for (let i = 0; i < agentCount; i += 1) {
    const agent = await createAgent(server.id, `OriginAgent${i}${suffix.slice(0, 6)}`);
    const key = await mintAgentCredential({ agentId: agent.id, scopes: ["mcp"], name: "mcp", issuedVia: "computer", createdByUserId: null });
    agents.push({ id: agent.id, apiKey: key.apiKey });
  }
  // Registry-managed, enabled, catalogued, and no Connection: every call is refused with
  // `login_required`, which is exactly the refusal that may raise a Connect card.
  await db.insert(managedMcpServers).values({
    serverId: server.id,
    name: "Registry Docs",
    endpointUrl: "https://registry-docs.example.test/mcp",
    enabled: true,
    sourceKind: "url",
    authMode: "headers",
    requiredHeaderNames: ["X-Api-Key"],
    toolCatalog: [{ name: "search", inputSchema: { type: "object" } }],
    catalogVersion: 1,
  });
  const conversation = async (label: string) => {
    const [channel] = await db.insert(channels).values({ serverId: server.id, name: `${label}-${suffix.slice(0, 8)}` }).returning();
    for (const agent of agents) await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });
    return channel;
  };
  const say = async (channel: { id: string; name: string }, content: string): Promise<AgentMessage> => {
    const [row] = await db.insert(messages).values({
      channelId: channel.id, senderType: "user", senderId: user.id, content,
    }).returning();
    return {
      channel_id: channel.id,
      channel_name: channel.name,
      channel_type: "channel",
      sender_id: user.id,
      sender_name: "owner",
      sender_type: "human",
      content,
      timestamp: new Date().toISOString(),
      message_id: row.id,
    };
  };
  return { serverId: server.id, agents, conversation, say };
}

/** Connect cards the server has posted for an Agent, as the channels they were posted into. */
async function cardChannels(agentId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ channelId: messages.channelId })
    .from(actionCards)
    .innerJoin(messages, eq(messages.id, actionCards.messageId))
    .where(eq(actionCards.requesterAgentId, agentId));
  return rows.map((row) => row.channelId);
}

/* ------------------------------------------------------------------ scripted runtimes */

class ScriptedChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  busyWrites = 0;
  readonly idleInputs: string[] = [];
  readonly stdin = {
    write: (chunk: string) => {
      if (chunk.startsWith("BUSY ")) this.busyWrites += 1;
      if (chunk.startsWith("IDLE ")) this.idleInputs.push(chunk.slice("IDLE ".length).replace(/\n$/, ""));
      return true;
    },
  };
  kill(): boolean {
    queueMicrotask(() => {
      this.exitCode = 0;
      this.emit("exit", 0, null);
      this.emit("close", 0, null);
    });
    return true;
  }
  line(text: string): void {
    this.stdout.emit("data", Buffer.from(`${text}\n`));
  }
}

type RuntimeProcess = {
  agentId: string;
  /**
   * What an agent does when it runs `raft message check`: the daemon-local inbox is drained through
   * the credential proxy's coordinator. Without it the manager (correctly) re-delivers the unread
   * message as the next turn, which is a new foreground turn for that message.
   */
  readInbox(): void;
  /** Ends the current runtime turn the way the runtime itself would report it. */
  endTurn(): void;
  /** Invokes the managed MCP tool through this process's call surface; resolves to the refusal code. */
  call(): Promise<string>;
  busySteers(): number;
  /** Every new-prompt input this process received, in order: the start prompt, then idle prompts. */
  inputs(): string[];
};

const BASE_DRIVER = {
  lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
  communication: { chat: "slock_cli", runtimeControl: "none" },
  session: { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" },
  model: { detectedModelsVerifiedAs: "suggestion_only" },
  supportsStdinNotification: true,
  busyDeliveryMode: "direct",
  supportsNativeStandingPrompt: true,
  buildSystemPrompt: () => asAxSurfaceText("standing"),
} as const;

/** A child-process runtime whose driver builds the native MCP proxy exactly like the production drivers. */
function readInboxThrough(ctx: SpawnContext): () => void {
  return () => {
    const coordinator = ctx.agentCredentialProxyInboxCoordinator;
    assert.ok(coordinator?.getAllPendingMessages, "fixture: the manager must hand the runtime its inbox coordinator");
    coordinator.consumeVisibleMessages({ messages: coordinator.getAllPendingMessages(), source: "agent_api_events_local" });
  };
}

function nativeProxyRuntime(processes: RuntimeProcess[]): RuntimeDriver {
  return {
    ...BASE_DRIVER,
    id: "origin-e2e-native",
    async spawn(ctx: SpawnContext) {
      const proxy = await prepareManagedMcpRuntimeProxy({
        agentId: ctx.agentId,
        launchId: ctx.launchId,
        processInstanceId: ctx.processInstanceId,
        readTurnOrigin: ctx.readTurnOrigin,
        serverUrl: ctx.config.serverUrl,
        agentCredentialKey: ctx.config.agentCredentialKey,
      });
      assert.ok(proxy, "fixture: the managed MCP proxy must register");
      const child = new ScriptedChild();
      const sessionId = randomUUID();
      processes.push({
        agentId: ctx.agentId,
        readInbox: readInboxThrough(ctx),
        endTurn: () => child.line("TURN_END"),
        busySteers: () => child.busyWrites,
        inputs: () => [ctx.prompt, ...child.idleInputs],
        async call() {
          const client = new Client({ name: "origin-e2e", version: "1.0.0" });
          try {
            await client.connect(new StreamableHTTPClientTransport(new URL(proxy.url)));
            const [tool] = (await client.listTools()).tools;
            const result = await client.callTool({ name: tool!.name, arguments: {} });
            const text = JSON.stringify(result.content);
            // The proxy surfaces the Server's own sentence plus guidance for the model, so the
            // refusal is identified by what it SAYS rather than by a bracketed code. (It used to
            // emit `HTTP 409 (code)`; that was the thing worth changing, not this assertion.)
            if (/not authorized for this agent/.test(text)) return "managed_mcp_login_required";
            return /\((managed_mcp_[a-z_]+)\)/.exec(text)?.[1] ?? `unexpected:${text}`;
          } catch {
            return "surface_unreachable";
          } finally {
            await client.close().catch(() => undefined);
          }
        },
      });
      // The CLI announces its session once it is up.
      setImmediate(() => child.line(`SESSION ${sessionId}`));
      return { process: child as unknown as ChildProcess };
    },
    parseLine(line: string): ParsedEvent[] {
      if (line.startsWith("SESSION ")) return [{ kind: "session_init", sessionId: line.slice("SESSION ".length) }];
      if (line === "TURN_END") return [{ kind: "turn_end" }];
      return [];
    },
    encodeStdinMessage(text: string, _sessionId: string | null, opts?: { mode?: "idle" | "busy" }) {
      return `${opts?.mode === "busy" ? "BUSY" : "IDLE"} ${text}`;
    },
  } as RuntimeDriver;
}

/** An in-process Pi SDK runtime whose session factory builds the Pi tools exactly like `pi.ts`. */
function piToolsRuntime(processes: RuntimeProcess[]): RuntimeDriver {
  return {
    ...BASE_DRIVER,
    id: "origin-e2e-pi",
    spawn() {
      throw new Error("session-backed runtime");
    },
    parseLine: () => [],
    encodeStdinMessage: () => null,
    createSession(ctx: SpawnContext) {
      return new PiSdkRuntimeSession(ctx, () => undefined, async (sessionCtx, sessionId) => {
        const tools: ToolDefinition[] = await createManagedMcpPiTools({
          serverUrl: sessionCtx.config.serverUrl,
          agentCredentialKey: sessionCtx.config.agentCredentialKey,
          processInstanceId: sessionCtx.processInstanceId,
          readTurnOrigin: sessionCtx.readTurnOrigin,
        });
        // The App's own tool first, then the three Raft Apps tools every snapshot carries.
        assert.equal(tools.length, 4, "fixture: the Pi tools must be built from the real snapshot");
        assert.match(tools[0]!.name, /_search_/u, "fixture: the first Pi tool is the App's own search");
        let listener: ((event: AgentSessionEvent) => void) | null = null;
        let steers = 0;
        const prompts: string[] = [];
        processes.push({
          agentId: sessionCtx.agentId,
          readInbox: readInboxThrough(sessionCtx),
          endTurn() {
            listener?.({ type: "agent_end", messages: [], willRetry: false } as unknown as AgentSessionEvent);
            listener?.({ type: "agent_settled" } as unknown as AgentSessionEvent);
          },
          busySteers: () => steers,
          inputs: () => [...prompts],
          async call() {
            try {
              await tools[0]!.execute("origin-e2e", {}, undefined, undefined, {} as never);
              return "unexpected_success";
            } catch (error) {
              return (error as { code?: string | null }).code ?? `unexpected:${String(error)}`;
            }
          },
        });
        return {
          sessionId,
          isStreaming: false,
          subscribe(cb: (event: AgentSessionEvent) => void) {
            listener = cb;
            return () => {
              listener = null;
            };
          },
          async prompt(text: string) {
            prompts.push(text);
          },
          async steer() {
            steers += 1;
          },
          async abort() {},
          dispose() {},
        } as unknown as AgentSession;
      });
    },
  } as RuntimeDriver;
}

/* ------------------------------------------------------------------ daemon harness */

async function withDaemon(
  app: { baseUrl: string },
  surface: SurfaceKind,
  keys: Map<string, string>,
  run: (daemon: {
    manager: AgentProcessManager;
    processes: RuntimeProcess[];
    config: (agentId: string) => AgentConfig;
    appInbox: (agentId: string) => AgentAppInboxStore;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-mcp-origin-e2e-"));
  const processes: RuntimeProcess[] = [];
  const driver = surface === "native-proxy" ? nativeProxyRuntime(processes) : piToolsRuntime(processes);
  // Only the runner-credential mint is answered locally; every managed MCP request goes to the real
  // server over the network.
  setDaemonFetchImplForTests((async (input: unknown, init?: { method?: string }) => {
    const url = String(input instanceof Request ? input.url : input);
    const agentId = /\/internal\/computer\/runners\/([^/]+)\/credentials/.exec(url)?.[1];
    if (agentId && (init?.method ?? "GET") === "POST") {
      return Response.json({ apiKey: keys.get(decodeURIComponent(agentId)), credentialId: `e2e-${agentId}` }, { status: 201 });
    }
    if (agentId) return new Response(null, { status: 204 });
    throw new Error(`Unexpected daemon request: ${url}`);
  }) as never);
  const appInboxes = new Map<string, AgentAppInboxStore>();
  const appInbox = (agentId: string) => {
    let store = appInboxes.get(agentId);
    if (!store) {
      store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
      appInboxes.set(agentId, store);
    }
    return store;
  };
  const manager = new AgentProcessManager(() => {}, "sk_machine_test", {
    appInboxForAgent: appInbox,
    dataDir,
    slockHome: dataDir,
    runtimeSessionHomeDir: dataDir,
    daemonVersion: "1.0.0-origin-e2e",
    computerVersion: "1.0.0-origin-e2e",
    serverUrl: app.baseUrl,
    driverResolver: () => driver,
  });
  const config = (agentId: string): AgentConfig => ({
    name: `origin-${agentId.slice(0, 8)}`,
    displayName: "Origin Agent",
    description: "",
    runtime: driver.id,
    model: "test-model",
    reasoningEffort: null,
    envVars: null,
    sessionId: null,
    serverUrl: app.baseUrl,
    authToken: "sk_machine_test",
  });
  try {
    await run({ manager, processes, config, appInbox });
  } finally {
    try {
      await manager.stopAll();
    } finally {
      setDaemonFetchImplForTests(undefined);
      await __resetManagedMcpRuntimeProxyForTest();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

async function until(label: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * The input really was the inbox notice, not the message itself delivered as the prompt: it announces
 * the pending message (with at most a bounded preview of the latest one, #10430) and is not the
 * message's own envelope. Asserted wherever a card is expected, so "the card came from the envelope
 * under a notice" is shown rather than assumed.
 */
function assertContentFreeNotice(input: string | undefined, message: AgentMessage): void {
  assert.ok(
    input !== undefined && input.startsWith("[Raft inbox notice:"),
    `expected an inbox notice, got: ${input?.slice(0, 80)}`,
  );
  assert.ok(input.includes("These messages have not been read."), "the notice leaves the message unread");
  assert.notEqual(input.trim(), message.content.trim(), "the notice is not the message itself");
}

/** Let the scripted runtime's session announcement land so the manager can deliver over stdin. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/* ------------------------------------------------------------------ cases */

for (const surface of SURFACES) {
  test(`[${surface}] a foreground turn for one real message posts the card back into that conversation`, async ({ app }) => {
    const f = await seedServer();
    const agent = f.agents[0]!;
    const home = await f.conversation("home");
    const wake = await f.say(home, `please search the docs ${randomUUID()}`);
    await withDaemon(app, surface, new Map([[agent.id, agent.apiKey]]), async ({ manager, processes, config }) => {
      await manager.startAgent(agent.id, config(agent.id), wake);
      await settle();
      assert.equal(processes.length, 1);
      // ⭐ The runtime never saw a message body -- only a notice. The origin comes from the envelope.
      // A fresh session's first input opens with the startup MEMORY.md block (#10953); the notice follows it.
      assertContentFreeNotice(afterStartupMemoryBlock(processes[0]!.inputs()[0]!), wake);

      assert.equal(await processes[0]!.call(), "managed_mcp_login_required", "⭐ the refusal itself is unchanged");
      assert.deepEqual(await cardChannels(agent.id), [home.id], "⭐ exactly one card, in the conversation the turn came from");
    });
  });

  test(`[${surface}] background input names no origin -- and the same process then posts once a real message arrives`, async ({ app }) => {
    const f = await seedServer();
    const agent = f.agents[0]!;
    const home = await f.conversation("home");
    await withDaemon(app, surface, new Map([[agent.id, agent.apiKey]]), async ({ manager, processes, config }) => {
      await manager.startAgent(agent.id, config(agent.id)); // cold start: no message behind it
      await settle();
      assert.equal(await processes[0]!.call(), "managed_mcp_login_required");
      assert.deepEqual(await cardChannels(agent.id), [], "no origin ⇒ no card, never a guessed channel");

      // Positive control on the SAME process, so the zero above cannot come from broken plumbing.
      processes[0]!.endTurn();
      const later = await f.say(home, `now search ${randomUUID()}`);
      await manager.deliverMessage(agent.id, later);
      await settle();
      assertContentFreeNotice(processes[0]!.inputs().at(-1), later);
      assert.equal(await processes[0]!.call(), "managed_mcp_login_required");
      assert.deepEqual(await cardChannels(agent.id), [home.id]);
    });
  });

  test(`[${surface}] an app-inbox notice has no message envelope and names no origin`, async ({ app }) => {
    const f = await seedServer();
    const agent = f.agents[0]!;
    const home = await f.conversation("home");
    await withDaemon(app, surface, new Map([[agent.id, agent.apiKey]]), async ({ manager, processes, config, appInbox }) => {
      // A real envelope was the most recent thing this process answered. A notice must not borrow it
      // ("most recent message" is exactly the guess the contract forbids).
      await manager.startAgent(agent.id, config(agent.id), await f.say(home, "earlier real message"));
      await settle();
      processes[0]!.readInbox();
      processes[0]!.endTurn();

      const minted = appInbox(agent.id).mint({
        appId: "system.reminder",
        notificationClass: "due",
        sourceRef: { kind: "reminder", id: randomUUID(), revision: "1" },
      });
      assert.equal(minted.ok, true);
      if (!minted.ok) return;
      assert.equal(await manager.notifyAgentAppInbox(agent.id, minted.item), true);
      await settle();
      assert.match(processes[0]!.inputs().at(-1) ?? "", /^\[Raft Inbox notice:/, "fixture: the app-inbox notice really was delivered as a new prompt");

      assert.equal(await processes[0]!.call(), "managed_mcp_login_required");
      assert.deepEqual(await cardChannels(agent.id), [], "⭐ a notice with no envelope must not become an origin");

      processes[0]!.endTurn();
      await manager.deliverMessage(agent.id, await f.say(home, "a real message"));
      assert.equal(await processes[0]!.call(), "managed_mcp_login_required");
      assert.deepEqual(await cardChannels(agent.id), [home.id], "control: same process, real envelope");
    });
  });

  test(`[${surface}] a transient system notice names no origin even when its id is a real message`, async ({ app }) => {
    const f = await seedServer();
    const agent = f.agents[0]!;
    const home = await f.conversation("home");
    // A stored message in a conversation the Agent belongs to -- the server WOULD accept this id, so
    // a zero here is the daemon refusing to treat a system notice as an envelope, not the server
    // refusing the id.
    const notice = await f.say(home, "system: your runtime was upgraded");
    await withDaemon(app, surface, new Map([[agent.id, agent.apiKey]]), async ({ manager, processes, config }) => {
      await manager.startAgent(agent.id, config(agent.id), notice, undefined, undefined, undefined, true);
      await settle();
      assert.equal(await processes[0]!.call(), "managed_mcp_login_required");
      assert.deepEqual(await cardChannels(agent.id), []);

      processes[0]!.endTurn();
      await manager.deliverMessage(agent.id, await f.say(home, "a real message"));
      assert.equal(await processes[0]!.call(), "managed_mcp_login_required");
      assert.deepEqual(await cardChannels(agent.id), [home.id], "control: same process, same conversation, real envelope");
    });
  });

  test(`[${surface}] a pure resume with no new message names no origin; a resumed session woken by one message does`, async ({ app }) => {
    const f = await seedServer(2);
    const [pure, woken] = f.agents;
    const home = await f.conversation("home");
    const keys = new Map(f.agents.map((agent) => [agent.id, agent.apiKey]));
    const wake = await f.say(home, `new message for a resumed session ${randomUUID()}`);
    await withDaemon(app, surface, keys, async ({ manager, processes, config }) => {
      const resumed = (agentId: string): AgentConfig => ({ ...config(agentId), sessionId: randomUUID() });
      await manager.startAgent(pure!.id, resumed(pure!.id));
      await manager.startAgent(woken!.id, resumed(woken!.id), wake);
      await settle();
      const byAgent = (agentId: string) => processes.find((p) => p.agentId === agentId)!;
      assert.equal(byAgent(pure!.id).inputs()[0]?.startsWith("[Raft inbox notice:"), false, "fixture: a pure resume carries no notice");

      assert.equal(await byAgent(pure!.id).call(), "managed_mcp_login_required");
      assert.equal(await byAgent(woken!.id).call(), "managed_mcp_login_required");
      assert.deepEqual(await cardChannels(pure!.id), [], "⭐ recovery alone answers no message");
      assertContentFreeNotice(byAgent(woken!.id).inputs()[0], wake);
      assert.deepEqual(
        await cardChannels(woken!.id), [home.id],
        "⭐ a resumed native session is not an authority dimension: one new message still names its origin",
      );
    });
  });

  test(`[${surface}] resume catch-up of an offline backlog names no origin, even for a single message`, async ({ app }) => {
    // Decision recorded for @peng: `resumeMessages` are unread messages re-driven after an offline
    // period (agentOrchestrator resume catch-up), not a new message that triggered this wake.
    const f = await seedServer();
    const agent = f.agents[0]!;
    const home = await f.conversation("home");
    const backlog = await f.say(home, "sent while the agent was offline");
    await withDaemon(app, surface, new Map([[agent.id, agent.apiKey]]), async ({ manager, processes, config }) => {
      await manager.startAgent(
        agent.id, { ...config(agent.id), sessionId: randomUUID() },
        undefined, undefined, undefined, undefined, false, [backlog],
      );
      await settle();
      assert.equal(await processes[0]!.call(), "managed_mcp_login_required");
      assert.deepEqual(await cardChannels(agent.id), []);

      processes[0]!.readInbox();
      processes[0]!.endTurn();
      await manager.deliverMessage(agent.id, await f.say(home, "a new message"));
      assert.equal(await processes[0]!.call(), "managed_mcp_login_required");
      assert.deepEqual(await cardChannels(agent.id), [home.id], "control: same process, new envelope");
    });
  });

  test(`[${surface}] a start that delivers a batch names no origin; the same path with one message does`, async ({ app }) => {
    const f = await seedServer(2);
    const [single, batch] = f.agents;
    const home = await f.conversation("home");
    const other = await f.conversation("other");
    const keys = new Map(f.agents.map((agent) => [agent.id, agent.apiKey]));
    const one = await f.say(home, "one");
    const firstOfTwo = await f.say(home, "first of two");
    const secondOfTwo = await f.say(other, "second of two");
    await withDaemon(app, surface, keys, async ({ manager, processes, config }) => {
      // Messages that arrive while a start is in flight are buffered and become that start's input.
      // Delivered synchronously after startAgent() so they land before the start prompt is built.
      const singleStart = manager.startAgent(single!.id, config(single!.id));
      void manager.deliverMessage(single!.id, one);
      await singleStart;

      const batchStart = manager.startAgent(batch!.id, config(batch!.id));
      void manager.deliverMessage(batch!.id, firstOfTwo);
      void manager.deliverMessage(batch!.id, secondOfTwo);
      await batchStart;
      await settle();

      const byAgent = (agentId: string) => processes.find((p) => p.agentId === agentId)!;
      assert.equal(await byAgent(single!.id).call(), "managed_mcp_login_required");
      assert.equal(await byAgent(batch!.id).call(), "managed_mcp_login_required");
      assert.deepEqual(await cardChannels(single!.id), [home.id], "control: one buffered message is an origin");
      assert.deepEqual(await cardChannels(batch!.id), [], "⭐ two messages: which conversation would it be? none");
    });
  });

  test(`[${surface}] after turn_end a call has no origin; the next delivered message's turn does`, async ({ app }) => {
    const f = await seedServer();
    const agent = f.agents[0]!;
    const home = await f.conversation("home");
    const next = await f.conversation("next");
    await withDaemon(app, surface, new Map([[agent.id, agent.apiKey]]), async ({ manager, processes, config }) => {
      await manager.startAgent(agent.id, config(agent.id), await f.say(home, "first"));
      await settle();
      processes[0]!.readInbox();
      processes[0]!.endTurn();

      assert.equal(await processes[0]!.call(), "managed_mcp_login_required");
      assert.deepEqual(await cardChannels(agent.id), [], "⭐ the finished turn's message must not leak into later calls");

      await manager.deliverMessage(agent.id, await f.say(next, "second"));
      assert.equal(await processes[0]!.call(), "managed_mcp_login_required");
      assert.deepEqual(await cardChannels(agent.id), [next.id], "the new turn's own conversation, not the old one");
    });
  });

  test(`[${surface}] a busy steer does not re-home the running turn`, async ({ app }) => {
    const f = await seedServer();
    const agent = f.agents[0]!;
    const home = await f.conversation("home");
    const other = await f.conversation("other");
    await withDaemon(app, surface, new Map([[agent.id, agent.apiKey]]), async ({ manager, processes, config }) => {
      await manager.startAgent(agent.id, config(agent.id), await f.say(home, "working on it"));
      await settle();
      await manager.deliverMessage(agent.id, await f.say(other, "meanwhile, elsewhere"));
      // The steer must really have reached the runtime, or this case proves nothing.
      await until("busy steer delivered", () => processes[0]!.busySteers() > 0);

      assert.equal(await processes[0]!.call(), "managed_mcp_login_required");
      assert.deepEqual(await cardChannels(agent.id), [home.id], "⭐ still the turn's own conversation");
    });
  });

  test(`[${surface}] a stale process never lends an origin; the live process does`, async ({ app }) => {
    const f = await seedServer();
    const agent = f.agents[0]!;
    const first = await f.conversation("first");
    const second = await f.conversation("second");
    await withDaemon(app, surface, new Map([[agent.id, agent.apiKey]]), async ({ manager, processes, config }) => {
      await manager.startAgent(agent.id, config(agent.id), await f.say(first, "first process"));
      await settle();
      await manager.stopAgent(agent.id, { wait: true });
      await manager.startAgent(agent.id, config(agent.id), await f.say(second, "second process"));
      await settle();
      assert.equal(processes.length, 2);

      // The native proxy registration is removed with its process, so a stale runtime cannot reach
      // the server at all. The in-process Pi tool object outlives its session and CAN still reach
      // the server -- which is exactly where it must arrive without an origin.
      assert.equal(
        await processes[0]!.call(),
        surface === "native-proxy" ? "surface_unreachable" : "managed_mcp_login_required",
      );
      assert.deepEqual(await cardChannels(agent.id), [], "⭐ neither the stopped process's turn nor the live one's");

      assert.equal(await processes[1]!.call(), "managed_mcp_login_required");
      assert.deepEqual(await cardChannels(agent.id), [second.id]);
    });
  });

  test(`[${surface}] two Agents running at once never cross origins`, async ({ app }) => {
    const f = await seedServer(2);
    const [a, b] = f.agents;
    const left = await f.conversation("left");
    const right = await f.conversation("right");
    const keys = new Map(f.agents.map((agent) => [agent.id, agent.apiKey]));
    await withDaemon(app, surface, keys, async ({ manager, processes, config }) => {
      await manager.startAgent(a!.id, config(a!.id), await f.say(left, "for a"));
      await manager.startAgent(b!.id, config(b!.id), await f.say(right, "for b"));
      await settle();
      const byAgent = (agentId: string) => processes.find((p) => p.agentId === agentId)!;

      // Interleaved, later-started first.
      const [codeB, codeA] = await Promise.all([byAgent(b!.id).call(), byAgent(a!.id).call()]);
      assert.equal(codeA, "managed_mcp_login_required");
      assert.equal(codeB, "managed_mcp_login_required");
      assert.deepEqual(await cardChannels(a!.id), [left.id]);
      assert.deepEqual(await cardChannels(b!.id), [right.id]);
    });
  });
}
