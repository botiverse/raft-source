import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), "raft-sdk-pack-"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const raw = execFileSync(
    "npm",
    [
      "pack",
      "--dry-run=false",
      "--ignore-scripts",
      "--json",
      "--loglevel=error",
      "--pack-destination",
      scratch,
    ],
    { cwd: root, encoding: "utf8" },
  );
  const pack = JSON.parse(raw)[0];
  const files = pack?.files?.map((file) => file.path) ?? [];
  const requiredFiles = [
    "README.md",
    "CHANGELOG.md",
    "dist/cjs/index.cjs",
    "dist/esm/index.js",
    "dist/index.d.ts",
    "dist/cjs/app.cjs",
    "dist/esm/app.js",
    "dist/app.d.ts",
    "dist/cjs/agent.cjs",
    "dist/esm/agent.js",
    "dist/agent.d.ts",
    "dist/cjs/continuations.cjs",
    "dist/esm/continuations.js",
    "dist/continuations.d.ts",
    "operations.json",
    "package.json",
  ];
  for (const file of requiredFiles) {
    assert(files.includes(file), `packed artifact must contain ${file}`);
  }
  assert(!files.includes("DESIGN.md"), "packed artifact must not contain the internal DESIGN.md");
  assert(
    files.every((file) => !file.startsWith("src/") && !file.startsWith("scripts/")),
    `packed artifact must not contain source or build scripts: ${files.join(", ")}`,
  );

  // Every emitted file, the shared chunks included.
  const distFiles = readdirSync(join(root, "dist"), { recursive: true })
    .map((file) => join("dist", String(file)))
    .filter((file) => /\.(c?js|d\.ts)$/.test(file));
  for (const file of distFiles) {
    const body = readFileSync(join(root, file), "utf8");
    assert(!body.includes("@botiverse/raft-shared"), `${file} leaked an unpublished workspace import`);
    assert(!body.includes("workspace:"), `${file} leaked a workspace protocol reference`);
  }

  const consumer = join(scratch, "consumer");
  const tarball = join(scratch, pack.filename);
  mkdirSync(consumer);
  execFileSync(
    "npm",
    [
      "install",
      "--dry-run=false",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ],
    { cwd: consumer, encoding: "utf8", stdio: "pipe" },
  );

  const smoke = `
    const sdk = await LOAD;
    if (typeof sdk.createRaftClient !== "function") throw new Error("createRaftClient export missing");
    if (typeof sdk.bootstrapRaftCredential !== "function") throw new Error("bootstrapRaftCredential export missing");
    if (typeof sdk.createFileCredentialStore !== "function") throw new Error("createFileCredentialStore export missing");
    if (typeof sdk.readLatestReadThread !== "function") throw new Error("readLatestReadThread export missing");
    if ((await sdk.readLatestReadThread({ env: {} })).reason !== "no_agent_id") throw new Error("readLatestReadThread did not run from the bundle");
    if (typeof sdk.createRaftClientFromStore !== "function") throw new Error("createRaftClientFromStore export missing");
    if (typeof sdk.createRaftRoutes !== "function") throw new Error("createRaftRoutes export missing");
    if (sdk.describeRaftRoute("events").sideEffect !== "destructive_read") throw new Error("route metadata missing from bundle");
    if (typeof sdk.RaftCredentialError !== "function") throw new Error("credential error export missing");
    if (!Array.isArray(sdk.RAFT_OPERATIONS) || !sdk.RAFT_OPERATIONS.some((op) => op.name === "messages.send"))
      throw new Error("operation manifest missing from bundle");
    if (typeof sdk.createRaft({ serverUrl: "https://raft.example", credential: "sk_agent_pack_smoke" }).invoke !== "function")
      throw new Error("raft.invoke missing from bundle");
    const taskRaft = sdk.createRaft({
      serverUrl: "https://raft.example", credential: "sk_agent_pack_smoke",
      fetch: async () => Response.json({ tasks: [], scope: "channel", pagination: { mode: "complete", truncated: false } }),
    });
    const taskBoard = await taskRaft.tasks.list({ target: "#board", status: "all" });
    if (!taskBoard.ok || taskBoard.data.pagination?.mode !== "complete" || taskBoard.data.pagination.truncated !== false)
      throw new Error("packed task list lost the Server's completeness assertion");
    if (typeof sdk.RaftSdkConfigurationError !== "function") throw new Error("error export missing");
    if (typeof sdk.createRaftFromStore !== "function") throw new Error("createRaftFromStore export missing");
    const appsRaft = sdk.createRaft({
      serverUrl: "https://raft.example", credential: "sk_agent_pack_smoke",
      fetch: async () => Response.json({ appId: "system.cleaner", revision: 1, schema: {}, defaults: {}, overrides: {}, effective: {} }),
    });
    const appConfig = await appsRaft.apps.getConfig({ appId: "system.cleaner" });
    if (!appConfig.ok || appConfig.state !== "config" || !appConfig.text.startsWith("App: system.cleaner"))
      throw new Error("packed raft.apps.getConfig failed");
    if (typeof appsRaft.profile.updateAvatar !== "function") throw new Error("raft.profile.updateAvatar missing from bundle");
    const receiver = sdk.createRaftClient({
      serverUrl: "https://raft.example", credential: "sk_agent_pack_smoke",
      fetch: async () => Response.json({ events: [{ sender_type: "human", content: "hello" }],
        last_seen_msgId: null, last_seen_seq: 1, has_more: false, reply_target: null,
        pending_notice_ids: [], wake_reason: null }),
    });
    const received = await receiver.events.receive({ limit: 1 });
    if (!received.ok || received.data.events[0].senderType !== "human" || received.data.lastSeenSeq !== 1)
      throw new Error("packed event receive failed");
    const contextClient = sdk.createRaftClient({
      serverUrl: "https://raft.example", credential: "sk_agent_pack_smoke",
      fetch: async () => Response.json({
        agent: { id: "a", name: "n", displayName: null, description: null, runtime: "external", external: true },
        server: { id: "s", slug: "slug", name: "Name" }, credential: { capabilities: [] }, prompt: null }),
    });
    const manageClient = sdk.createRaftClient({
      serverUrl: "https://raft.example", credential: "sk_agent_pack_smoke",
      fetch: async () => Response.json({ id: "s", name: "Renamed" }),
    });
    const renamed = await manageClient.server.update({ name: "Renamed" });
    if (!renamed.ok || renamed.data.name !== "Renamed") throw new Error("packed server update failed");
    const context = await contextClient.agent.context();
    if (!context.ok || context.data.server.slug !== "slug" || context.data.guide !== null)
      throw new Error("packed agent context failed");
    try {
      sdk.createRaftClient({ serverUrl: "", credential: "sk_agent_smoke" });
      throw new Error("invalid configuration unexpectedly passed");
    } catch (error) {
      if (!(error instanceof sdk.RaftSdkConfigurationError)) throw error;
      if (error.code !== "MISSING_SERVER_URL") throw error;
    }
  `;
  execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", smoke.replace("LOAD", 'import("@botiverse/raft-sdk")')],
    { cwd: consumer, encoding: "utf8" },
  );
  execFileSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "--eval",
      `(async () => {${smoke.replace("LOAD", 'require("@botiverse/raft-sdk")')}})()`,
    ],
    { cwd: consumer, encoding: "utf8" },
  );

  // The JSON manifest export resolves and matches the bundled manifest.
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const doc = (await import("@botiverse/raft-sdk/operations.json", { with: { type: "json" } })).default;
       const sdk = await import("@botiverse/raft-sdk");
       if (doc.version !== sdk.RAFT_OPERATIONS_VERSION) throw new Error("operations.json is stale against the bundle");
       if (doc.operations.length !== sdk.RAFT_OPERATIONS.length) throw new Error("operations.json lists different operations");`,
    ],
    { cwd: consumer, encoding: "utf8" },
  );
  execFileSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "--eval",
      `const doc = require("@botiverse/raft-sdk/operations.json");
       if (doc.version !== require("@botiverse/raft-sdk").RAFT_OPERATIONS_VERSION) throw new Error("operations.json (require) is stale");`,
    ],
    { cwd: consumer, encoding: "utf8" },
  );

  // `./app`: a Raft App's client with Server context (RFC 079). Nothing of it
  // on the root or ./agent; a Server request goes only through forServer.
  const appSmoke = `
    const app = await LOAD_APP;
    const root = await LOAD_ROOT;
    const agent = await LOAD_AGENT;
    for (const name of ["createRaftAppClient", "RaftAppError"]) {
      if (typeof app[name] !== "function") throw new Error(name + " export missing from ./app");
      if (name in root || name in agent) throw new Error(name + " must stay off the root and ./agent");
    }
    const serverId = "95f993fa-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    const urls = [];
    const raft = app.createRaftAppClient({
      accessToken: "slock_at_pack_smoke", baseUrl: "https://raft.example/",
      fetch: async (url, init) => {
        urls.push(String(url));
        if (new Headers(init.headers).get("authorization") !== "Bearer slock_at_pack_smoke") throw new Error("bearer missing");
        return String(url).includes("/servers")
          ? Response.json({ servers: [{ id: serverId, slug: "pack", name: "Pack", role: "member" }] })
          : Response.json({ error: "server_access_denied", error_description: "x" }, { status: 403 });
      },
    });
    if ("serverinfo" in raft || "membership" in raft || "agents" in raft) throw new Error("the top-level client has a Server read");
    const { servers } = await raft.servers();
    if (servers.length !== 1 || servers[0].id !== serverId) throw new Error("packed servers() failed");
    try {
      raft.forServer("pack");
      throw new Error("forServer accepted a slug");
    } catch (error) {
      if (!(error instanceof app.RaftAppError) || error.code !== "invalid_server_id") throw error;
    }
    try {
      await raft.forServer(servers[0].id).membership();
      throw new Error("a 403 passed");
    } catch (error) {
      if (!(error instanceof app.RaftAppError) || error.code !== "server_access_denied") throw error;
    }
    if (urls.length !== 2 || urls[1] !== "https://raft.example/api/oauth/membership?server_id=" + serverId)
      throw new Error("packed requests went wrong: " + urls.join(", "));
  `;
  const fillApp = (load) => appSmoke
    .replace("LOAD_APP", load("@botiverse/raft-sdk/app"))
    .replace("LOAD_ROOT", load("@botiverse/raft-sdk"))
    .replace("LOAD_AGENT", load("@botiverse/raft-sdk/agent"));
  execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", fillApp((name) => `import(${JSON.stringify(name)})`)],
    { cwd: consumer, encoding: "utf8" },
  );
  execFileSync(
    process.execPath,
    ["--input-type=commonjs", "--eval", `(async () => {${fillApp((name) => `require(${JSON.stringify(name)})`)}})().catch((error) => { console.error(error); process.exit(1); })`],
    { cwd: consumer, encoding: "utf8" },
  );

  // `./agent`: the agent layer, built on the root. Shared code is one chunk, so
  // classes and brands are the same value from either entry.
  const agentSmoke = `
    const agent = await LOAD_AGENT;
    const root = await LOAD_ROOT;
    if (typeof agent.createRaftAgent !== "function") throw new Error("createRaftAgent export missing");
    if (typeof agent.createRaftAgentFromStore !== "function") throw new Error("createRaftAgentFromStore export missing");
    if ("createRaftClient" in agent) throw new Error("./agent must not export the program-layer client");
    if ("createRaftAgent" in root) throw new Error("the root must not export createRaftAgent");
    const raft = agent.createRaftAgent({ serverUrl: "https://raft.example", credential: "sk_agent_pack_smoke" });
    if (typeof raft.invoke !== "function" || typeof raft.routes.messages.send !== "function")
      throw new Error("createRaftAgent client incomplete");
    if (typeof root.createRaft({ serverUrl: "https://raft.example", credential: "sk_agent_pack_smoke" }).invoke !== "function")
      throw new Error("deprecated createRaft alias missing");
    for (const name of ["RaftSdkConfigurationError", "RaftCredentialError", "SeenFrontier", "raftbenchFailedReport", "raftbenchFailureKind", "RAFT_OPERATIONS"]) {
      if (agent[name] === undefined || agent[name] !== root[name]) throw new Error(name + " differs between the root and ./agent");
    }
    try {
      agent.createRaftAgent({ serverUrl: "", credential: "sk_agent_smoke" });
      throw new Error("invalid configuration unexpectedly passed");
    } catch (error) {
      if (!(error instanceof root.RaftSdkConfigurationError)) throw error;
    }
  `;
  execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", agentSmoke
      .replace("LOAD_AGENT", 'import("@botiverse/raft-sdk/agent")')
      .replace("LOAD_ROOT", 'import("@botiverse/raft-sdk")')],
    { cwd: consumer, encoding: "utf8" },
  );
  execFileSync(
    process.execPath,
    ["--input-type=commonjs", "--eval", `(async () => {${agentSmoke
      .replace("LOAD_AGENT", 'require("@botiverse/raft-sdk/agent")')
      .replace("LOAD_ROOT", 'require("@botiverse/raft-sdk")')}})()`],
    { cwd: consumer, encoding: "utf8" },
  );

  // `./continuations` (experimental): the runtime under SDK names and a file
  // store; nothing of it on the root or ./agent.
  const continuationsSmoke = `
    const continuations = await LOAD_CONTINUATIONS;
    const root = await LOAD_ROOT;
    const agent = await LOAD_AGENT;
    for (const name of ["defineCommand", "startCommand", "resumeContinuation", "createFileContinuationStore", "formatContinuationPaused", "formatContinuationRefusal"]) {
      if (typeof continuations[name] !== "function") throw new Error(name + " export missing from ./continuations");
      if (name in root || name in agent) throw new Error(name + " must stay off the root and ./agent");
    }
    if (continuations.CONTINUATION_PAUSED_EXIT_CODE !== 10) throw new Error("CONTINUATION_PAUSED_EXIT_CODE missing");
    const os = await LOAD_OS;
    const path = await LOAD_PATH;
    const fs = await LOAD_FS;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-sdk-pack-cont-"));
    try {
      const store = continuations.createFileContinuationStore({ dir });
      const options = { store, ownerAgentId: "agent-1", program: { name: "pack", version: "1" } };
      const command = continuations.defineCommand("ask", async (ctx) => (await ctx.ask("q", { question: "Which?", options: { a: "A", b: "B" } })).choice);
      const paused = await continuations.startCommand(command, { ...options, args: null });
      if (paused.kind !== "paused") throw new Error("packed command did not pause");
      const done = await continuations.resumeContinuation(paused.continuation.id, { choice: "b" }, { ...options, commands: [command] });
      if (done.kind !== "done" || done.result !== "b") throw new Error("packed command did not resume from the file store");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  `;
  const fill = (source, load) => source
    .replace("LOAD_CONTINUATIONS", load("@botiverse/raft-sdk/continuations"))
    .replace("LOAD_ROOT", load("@botiverse/raft-sdk"))
    .replace("LOAD_AGENT", load("@botiverse/raft-sdk/agent"))
    .replace("LOAD_OS", load("node:os"))
    .replace("LOAD_PATH", load("node:path"))
    .replace("LOAD_FS", load("node:fs"));
  execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", fill(continuationsSmoke, (name) => `import(${JSON.stringify(name)})`)],
    { cwd: consumer, encoding: "utf8" },
  );
  execFileSync(
    process.execPath,
    ["--input-type=commonjs", "--eval", `(async () => {${fill(continuationsSmoke, (name) => `require(${JSON.stringify(name)})`)}})().catch((error) => { console.error(error); process.exit(1); })`],
    { cwd: consumer, encoding: "utf8" },
  );

  writeFileSync(
    join(consumer, "consumer.ts"),
    `import {
  bootstrapRaftCredential,
  createFileCredentialStore,
  createRaftClient,
  createRaftClientFromStore,
  type RaftClientResult,
  type RaftCredentialStore,
  type RaftEvent,
  type RaftEventsReceiveRequest,
  type RaftEventsReceiveResult,
  type RaftEventsReceiveError,
  type RaftContextResult,
  type RaftContextServer,
  type RaftApiError,
  type RaftApiResult,
  type RaftAppConfig,
} from "@botiverse/raft-sdk";
import {
  createRaftAgent,
  type CreateRaftAgentOptions,
  type RaftAgent,
  type SendMessageOutcome,
} from "@botiverse/raft-sdk/agent";
import {
  createRaftAppClient,
  RaftAppError,
  type RaftAppClient,
  type RaftAppServer,
  type RaftAppServerClient,
  type RaftAppServerRole,
  type ServerId,
} from "@botiverse/raft-sdk/app";
import { z } from "zod";

const appClient: RaftAppClient = createRaftAppClient({ accessToken: "slock_at_type_smoke" });
void appClient.servers().then(({ servers }) => {
  const first: RaftAppServer | undefined = servers[0];
  if (!first) return;
  const bound: RaftAppServerClient = appClient.forServer(first.id);
  const boundId: ServerId = bound.serverId;
  void boundId;
  void bound.membership().then((membership) => {
    const role: RaftAppServerRole = membership.role;
    const leastPrivileged = role !== "owner" && role !== "admin" && role !== "member" && role !== "guest";
    void leastPrivileged;
  });
}).catch((error: unknown) => {
  if (error instanceof RaftAppError) {
    const code: "server_access_denied" | "unauthorized" | "invalid_request" | "rate_limited" | "http_error" | "invalid_response" | "network_error" | "invalid_server_id" | "invalid_options" = error.code;
    const wait: number | undefined = error.retryAfterSeconds;
    void code;
    void wait;
  }
});
// @ts-expect-error The top-level client has no Server read: go through forServer.
void appClient.serverinfo();
// @ts-expect-error userinfo names no Server.
void appClient.userinfo({ server_id: "95f993fa-1c2d-4e5f-8a9b-0c1d2e3f4a5b" });
// @ts-expect-error A plain string is not a ServerId.
const notMinted: ServerId = "95f993fa-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
void notMinted;

const agentOptions: CreateRaftAgentOptions = { serverUrl: "https://raft.example", credential: "sk_agent_type_smoke" };
const agentClient: RaftAgent = createRaftAgent(agentOptions);
const sent: Promise<SendMessageOutcome> = agentClient.messages.send({ target: "#sdk-smoke", content: "hello" });
void sent;

// The SDK's published types must not widen the consumer's own zod typing
// (a bundled zod-openapi "declare module 'zod/v4'" once made this fail).
const metaSchema = z.string().meta({ override: "mine", param: 42 });
void metaSchema;

const client = createRaftClient({
  serverUrl: "https://raft.example",
  credential: "sk_agent_type_smoke",
});
const result: Promise<RaftClientResult> = client.messages.send({
  target: "#sdk-smoke",
  content: "hello",
});
void result;
const request: RaftEventsReceiveRequest = { since: "latest", limit: 100 };
const received: Promise<RaftEventsReceiveResult> = client.events.receive(request);
void received.then((batch) => {
  if (batch.ok) {
    const event: RaftEvent | undefined = batch.data.events[0];
    const cursor: number | null = batch.data.lastSeenSeq;
    if (event) {
      const sender: "human" | "agent" | "system" | "third_party_app" | "unknown" = event.senderType;
      // @ts-expect-error Public events have no passthrough index signature.
      void event.arbitraryWireField;
      void sender;
    }
    void cursor;
  } else {
    const error: RaftEventsReceiveError = batch.error;
    // @ts-expect-error Failed receives have no success data.
    void batch.data;
    void error;
  }
});
// @ts-expect-error Numeric cursors are numbers, not strings.
void client.events.receive({ since: "123" });
// @ts-expect-error This API is pull-only.
void client.events.stream();
const configResult: Promise<RaftApiResult<RaftAppConfig>> = client.apps.getConfig("system.cleaner");
void configResult.then((config) => {
  if (!config.ok) {
    const error: RaftApiError = config.error;
    const serverCode: string | undefined = error.errorCode;
    void serverCode;
  }
});
// @ts-expect-error Avatar uploads require a supported image MIME type.
void client.profile.updateAvatar({ data: new Uint8Array(1), filename: "a.svg", mimeType: "image/svg+xml" });
const contextResult: Promise<RaftContextResult> = client.agent.context();
void contextResult.then((context) => {
  if (context.ok) {
    const server: RaftContextServer = context.data.server;
    const slug: string = server.slug;
    void slug;
  }
});

const store: RaftCredentialStore = createFileCredentialStore("/tmp/raft-sdk-smoke.json");
const bootstrapped = bootstrapRaftCredential({
  serverUrl: "https://raft.example",
  credential: "sk_agent_type_smoke",
  store,
});
const storedClient = createRaftClientFromStore({ store });
void bootstrapped;
void storedClient;
`,
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        lib: ["ES2022", "DOM"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        target: "ES2022",
      },
      files: ["consumer.ts"],
    }),
  );
  execFileSync(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"],
    { cwd: consumer, encoding: "utf8" },
  );

  console.log(
    `@botiverse/raft-sdk packed artifact is valid (${files.length} files; ESM+CJS/type smokes passed).`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
