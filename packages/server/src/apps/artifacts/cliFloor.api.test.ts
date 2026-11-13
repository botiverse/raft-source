// Artifacts' minimum CLI version (cliFloor.ts, set as the agent API's client
// gate in mount.ts) over HTTP with real agent credentials: a CLI below the
// floor, or one that sends no version, is answered 426 CLIENT_UPGRADE_REQUIRED
// with how to upgrade on every agent API route (a read, a large-body push, an
// upload; ahead of the write budget and the body); at or above it, a
// prerelease of the floor included, it passes; a request that doesn't say it
// is the CLI (the SDK sends no X-Raft-Client) passes; the web and signed-out
// routes never see the gate.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { artifactPublicPaths, artifactWebPaths, asArtifactId } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { featureFlagRules } from "../../db/schema";
import { accessTokenForTest } from "../../test/integration/credentials";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { __setAgentApiWriteBudgetsForTests } from "../../services/agentApiWriteLimits";
import { createApiTest } from "../../test/integration/apiTest";
import type { createSeed } from "../../test/integration/seed";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";
import { ARTIFACTS_MIN_CLI_VERSION } from "./cliFloor";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-cli-floor-tests-hmac-secret-0123456789");
  // A write budget of 1: a refused request that counted would leave none for the write after it.
  __setAgentApiWriteBudgetsForTests({ artifactWrites: { perAgent: 1, perServer: 100 }, artifactUploads: { perAgent: 1, perServer: 100 } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setArtifactR2StoreForTests(undefined);
  __setAgentApiWriteBudgetsForTests(null);
});
const label = () => randomUUID().slice(0, 8);

function memoryR2(): ArtifactR2Store {
  const objects = new Map<string, Buffer>();
  return {
    async read(blob) {
      const bytes = blob.r2Key ? objects.get(blob.r2Key) : undefined;
      return bytes ? { stream: Readable.from([bytes]), size: bytes.length } : null;
    },
    async presign(blob) {
      return `https://r2.example.test/${blob.r2Key}`;
    },
    async put(key, bytes) {
      objects.set(key, bytes);
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

/** A server with the flag on: an owner and an agent in #priv, the agent with a key. */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const agent = await createAgent(server.id, `cf-${label()}`, { runtime: "claude", model: "sonnet" });
  const priv = await createChannel(server.id, `priv-${label()}`, undefined, "private");
  await addHuman(priv.id, owner.id);
  await addAgent(priv.id, agent.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  __setArtifactR2StoreForTests(memoryR2());
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["read", "send"], name: `cf-${label()}`, issuedVia: "computer", createdByUserId: null });
  return { server, owner, priv, apiKey };
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: any };

/** One agent API request with `headers` exactly as given (a declared Content-Length longer than `body` leaves it unfinished). */
function request(baseUrl: string, method: string, path: string, apiKey: string, headers: Record<string, string>, body?: Buffer): Promise<Reply> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method, path: `/internal/agent-api${path}`, headers: { Authorization: `Bearer ${apiKey}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = text || null;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* the text as is */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body) req.write(body);
    if (headers["Content-Length"] === undefined || Number(headers["Content-Length"]) === (body?.length ?? 0)) req.end();
  });
}

const cli = (version?: string): Record<string, string> => ({ "X-Raft-Client": "cli", ...(version === undefined ? {} : { "X-Raft-Client-Version": version }) });
const list = (app: { baseUrl: string }, apiKey: string, headers: Record<string, string>) => request(app.baseUrl, "GET", "/artifacts", apiKey, headers);

const STEPS = "On a Raft Computer, ask the machine's owner to click Upgrade on the Computer page in the Raft web app "
  + "(do not run `raft-computer upgrade` yourself); with a CLI installed from npm, run `npm install -g @botiverse/raft@latest`. "
  + "Then run the command again.";

function assertUpgradeRequired(res: Reply, yourVersion: string | null): void {
  assert.equal(res.status, 426, JSON.stringify(res.body));
  assert.deepEqual(res.body, {
    error: yourVersion === null
      ? `This raft CLI is too old for Artifacts (it sends no version), which needs raft CLI ${ARTIFACTS_MIN_CLI_VERSION} or newer. ${STEPS}`
      : `This raft CLI (${yourVersion}) is too old for Artifacts, which needs raft CLI ${ARTIFACTS_MIN_CLI_VERSION} or newer. ${STEPS}`,
    code: "CLIENT_UPGRADE_REQUIRED",
    minVersion: ARTIFACTS_MIN_CLI_VERSION,
    yourVersion,
    suggestedNextAction: STEPS,
  });
  assert.equal(res.headers["cache-control"], "private, no-store");
}

test("the floor is 1.0.56: raised only when the agent API needs a newer CLI and most Computers run it", () => {
  assert.equal(ARTIFACTS_MIN_CLI_VERSION, "1.0.56");
});

test("a CLI below the floor, or one that sends no version, is refused 426 with how to upgrade", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  assertUpgradeRequired(await list(app, world.apiKey, cli("1.0.55")), "1.0.55");
  assertUpgradeRequired(await list(app, world.apiKey, cli("0.0.42")), "0.0.42");
  // A prerelease below the floor's release is below it.
  assertUpgradeRequired(await list(app, world.apiKey, cli("1.0.55-rc.2")), "1.0.55-rc.2");
  // Every CLI from 1.0.55 on sends its version; one without is older (the Computer's proxy still says `cli` for it).
  assertUpgradeRequired(await list(app, world.apiKey, cli()), null);
  assertUpgradeRequired(await list(app, world.apiKey, cli("not-a-version")), null);
  // CLIs from before the slock→raft rename name themselves in X-Slock-Client.
  assertUpgradeRequired(await list(app, world.apiKey, { "X-Slock-Client": "cli" }), null);
});

test("a CLI at or above the floor passes, a prerelease of the floor included", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  for (const version of [ARTIFACTS_MIN_CLI_VERSION, "1.0.56-rc.1", "1.0.56-staging.20261027.sha.abc1234", "1.0.57", "1.0.59", "1.1.0", "2.0.0"]) {
    const res = await list(app, world.apiKey, cli(version));
    assert.equal(res.status, 200, `${version}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body.artifacts, []);
  }
});

test("a request that doesn't say it is the CLI passes (the SDK sends no X-Raft-Client; the daemon names itself)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const callers: Record<string, string>[] = [{}, { "X-Raft-Client": "daemon" }, { "X-Raft-Client": "daemon-server-session-worker", "X-Raft-Client-Version": "0.0.1" }];
  for (const headers of callers) {
    const res = await list(app, world.apiKey, headers);
    assert.equal(res.status, 200, `${JSON.stringify(headers)}: ${JSON.stringify(res.body)}`);
  }
});

test("writes: a push and an upload from an old CLI are refused before their body is read and don't count against the write limit", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const push = Buffer.from(JSON.stringify({ target: `#${world.priv.name}`, title: `Site ${label()}`, files: [{ path: "index.html", content: "<h1>home</h1>" }] }));
  // The declared length is longer than what is sent: answered only because the body is never waited for.
  const refusedPush = await request(app.baseUrl, "POST", "/artifacts/push", world.apiKey, { ...cli("1.0.55"), "Content-Type": "application/json", "Content-Length": String(push.length + 1024) }, push);
  assertUpgradeRequired(refusedPush, "1.0.55");
  assert.equal(refusedPush.headers.connection, "close");
  const bytes = Buffer.from("logo bytes");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const refusedUpload = await request(app.baseUrl, "PUT", `/artifacts/uploads/${sha}`, world.apiKey, { ...cli("1.0.55"), "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length + 1024) }, bytes);
  assertUpgradeRequired(refusedUpload, "1.0.55");
  // The one write the budget allows still goes through from a current CLI.
  const pushed = await request(app.baseUrl, "POST", "/artifacts/push", world.apiKey, { ...cli(ARTIFACTS_MIN_CLI_VERSION), "Content-Type": "application/json", "Content-Length": String(push.length) }, push);
  assert.equal(pushed.status, 201, JSON.stringify(pushed.body));
});

test("the web and signed-out routes never see the gate, whatever the request says it is", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const push = Buffer.from(JSON.stringify({ target: `#${world.priv.name}`, title: `Site ${label()}`, files: [{ path: "index.html", content: "<h1>home</h1>" }] }));
  const pushed = await request(app.baseUrl, "POST", "/artifacts/push", world.apiKey, { ...cli(ARTIFACTS_MIN_CLI_VERSION), "Content-Type": "application/json", "Content-Length": String(push.length) }, push);
  assert.equal(pushed.status, 201, JSON.stringify(pushed.body));
  const id = asArtifactId(pushed.body.artifact.id as string);
  const web = await fetch(`${app.baseUrl}${artifactWebPaths.viewer(id)}`, {
    headers: { Authorization: `Bearer ${await accessTokenForTest(world.owner.id)}`, "X-Server-Id": world.server.id, ...cli("1.0.1") },
  });
  assert.equal(web.status, 200, await web.text());
  // Not public: the signed-out answer is its own refusal, not the gate's.
  const signedOut = await fetch(`${app.baseUrl}${artifactPublicPaths.view(id)}`, { headers: cli("1.0.1") });
  assert.notEqual(signedOut.status, 426);
  assert.notEqual(((await signedOut.json()) as { code?: string }).code, "CLIENT_UPGRADE_REQUIRED");
});
