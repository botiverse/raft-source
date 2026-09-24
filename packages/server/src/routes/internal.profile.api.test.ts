import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { createAgent, assignMachine } from "../services/agentService.js";
import { registerMachine } from "../services/machineService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const execFileAsync = promisify(execFile);
const cliEntry = fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url));
const ONE_BY_ONE_GIF = Buffer.from(
  "R0lGODdhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=",
  "base64",
);

async function seed() {
  const db = getDb();
  const [owner] = await db
    .insert(users)
    .values({
      email: "profile-owner@slock.test",
      name: "profile-owner",
      displayName: "Profile Owner",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
    })
    .returning();

  const server = await createServer("Profile Server", "profile-server", owner.id);
  const agent = await createAgent(server.id, "profile-agent", { runtime: "codex", model: "gpt-5.5" });
  const { machine, apiKey } = await registerMachine(server.id, owner.id, "dev-machine");
  await assignMachine(agent.id, machine.id);
  const { apiKey: agentApiKey } = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["read", "server"],
    name: "profile-cli-e2e",
    createdByUserId: owner.id,
  });

  return { owner, server, agent, machine, apiKey, agentApiKey };
}

async function runSlockCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  const childEnv = { ...env };
  let cleanupProfile: (() => void) | null = null;
  if (childEnv.SLOCK_AGENT_TOKEN) {
    const profileDir = mkdtempSync(join(tmpdir(), "slock-profile-cli-profile-"));
    writeFileSync(join(profileDir, "credential.json"), JSON.stringify({
      schemaVersion: 1,
      serverUrl: childEnv.SLOCK_SERVER_URL,
      agentId: childEnv.SLOCK_AGENT_ID,
      serverId: childEnv.SLOCK_SERVER_ID,
      apiKey: childEnv.SLOCK_AGENT_TOKEN,
      scopes: ["read", "server"],
    }));
    childEnv.RAFT_PROFILE = "cli-e2e";
    childEnv.RAFT_PROFILE_DIR = profileDir;
    childEnv.SLOCK_AGENT_ID = "";
    childEnv.SLOCK_SERVER_URL = "";
    childEnv.SLOCK_SERVER_ID = "";
    childEnv.SLOCK_AGENT_TOKEN = "";
    cleanupProfile = () => rmSync(profileDir, { recursive: true, force: true });
  }
  try {
    return await execFileAsync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
      env: {
        ...process.env,
        SLOCK_AGENT_TOKEN_FILE: "",
        ...childEnv,
      },
    });
  } finally {
    cleanupProfile?.();
  }
}

test("CLI e2e: slock profile show --json includes the user-facing computer name", async ({ app }) => {
  const { agent, machine, agentApiKey, server } = await seed();
  const { stdout, stderr } = await runSlockCli(
    ["profile", "show", "--json"],
    {
      SLOCK_SERVER_URL: app.baseUrl,
      SLOCK_AGENT_ID: agent.id,
      SLOCK_AGENT_TOKEN: agentApiKey,
      SLOCK_SERVER_ID: server.id,
    },
  );

  assert.equal(stderr, "");
  const payload = JSON.parse(stdout) as { ok: true; data: { kind: string; computerName?: string | null } };
  assert.equal(payload.ok, true);
  assert.equal(payload.data.kind, "agent");
  assert.equal(payload.data.computerName, machine.name);
});

test("CLI e2e: slock profile show @human resolves a visible human profile", async ({ app }) => {
  const { owner, agent, agentApiKey, server } = await seed();
  const { stdout, stderr } = await runSlockCli(
    ["profile", "show", `@${owner.name}`, "--json"],
    {
      SLOCK_SERVER_URL: app.baseUrl,
      SLOCK_AGENT_ID: agent.id,
      SLOCK_AGENT_TOKEN: agentApiKey,
      SLOCK_SERVER_ID: server.id,
    },
  );

  assert.equal(stderr, "");
  const payload = JSON.parse(stdout) as { ok: true; data: { kind: string; name: string } };
  assert.equal(payload.data.kind, "human");
  assert.equal(payload.data.name, owner.name);
});

test("CLI e2e: slock profile update --avatar-file updates the agent avatar", async ({ app }) => {
  const { agent, agentApiKey, server } = await seed();
  const tempDir = mkdtempSync(join(tmpdir(), "slock-profile-avatar-"));
  const avatarPath = join(tempDir, "avatar.gif");
  writeFileSync(avatarPath, ONE_BY_ONE_GIF);

  const { stdout, stderr } = await runSlockCli(
    ["profile", "update", "--avatar-file", avatarPath, "--json"],
    {
      SLOCK_SERVER_URL: app.baseUrl,
      SLOCK_AGENT_ID: agent.id,
      SLOCK_AGENT_TOKEN: agentApiKey,
      SLOCK_SERVER_ID: server.id,
    },
  );

  assert.equal(stderr, "");
  const payload = JSON.parse(stdout) as { ok: true; data: { kind: string; avatarUrl: string | null } };
  assert.equal(payload.data.kind, "agent");
  assert.match(payload.data.avatarUrl ?? "", /^\/api\/avatars\//);
});

test("CLI e2e: slock profile update --avatar-url updates the agent pixel avatar", async ({ app }) => {
  const { agent, agentApiKey, server } = await seed();

  const { stdout, stderr } = await runSlockCli(
    ["profile", "update", "--avatar-url", "pixel:random:kimi-avatar", "--json"],
    {
      SLOCK_SERVER_URL: app.baseUrl,
      SLOCK_AGENT_ID: agent.id,
      SLOCK_AGENT_TOKEN: agentApiKey,
      SLOCK_SERVER_ID: server.id,
    },
  );

  assert.equal(stderr, "");
  const payload = JSON.parse(stdout) as { ok: true; data: { kind: string; avatarUrl: string | null } };
  assert.equal(payload.data.kind, "agent");
  assert.equal(payload.data.avatarUrl, "pixel:random:kimi-avatar");
});

test("CLI e2e: slock profile update --display-name --description updates both fields", async ({ app }) => {
  const { agent, agentApiKey, server } = await seed();

  const { stdout, stderr } = await runSlockCli(
    [
      "profile",
      "update",
      "--display-name",
      "Renamed Agent",
      "--description",
      "Helps with code review",
      "--json",
    ],
    {
      SLOCK_SERVER_URL: app.baseUrl,
      SLOCK_AGENT_ID: agent.id,
      SLOCK_AGENT_TOKEN: agentApiKey,
      SLOCK_SERVER_ID: server.id,
    },
  );

  assert.equal(stderr, "");
  const payload = JSON.parse(stdout) as {
    ok: true;
    data: { kind: string; displayName: string | null; description: string | null };
  };
  assert.equal(payload.data.kind, "agent");
  assert.equal(payload.data.displayName, "Renamed Agent");
  assert.equal(payload.data.description, "Helps with code review");
});

test("CLI e2e: slock profile update rejects avatar file and URL together", async ({ app }) => {
  const { agent, agentApiKey, server } = await seed();
  const tempDir = mkdtempSync(join(tmpdir(), "slock-profile-avatar-"));
  const avatarPath = join(tempDir, "avatar.gif");
  writeFileSync(avatarPath, ONE_BY_ONE_GIF);

  await assert.rejects(
    runSlockCli(
      [
        "profile",
        "update",
        "--avatar-file",
        avatarPath,
        "--avatar-url",
        "pixel:random:kimi-avatar",
        "--json",
      ],
      {
        SLOCK_SERVER_URL: app.baseUrl,
        SLOCK_AGENT_ID: agent.id,
        SLOCK_AGENT_TOKEN: agentApiKey,
        SLOCK_SERVER_ID: server.id,
      },
    ),
    (err: NodeJS.ErrnoException & { stderr?: string }) => {
      assert.match(err.stderr ?? "", /INVALID_ARG/);
      assert.match(err.stderr ?? "", /Use either --avatar-file or --avatar-url/);
      return true;
    },
  );
});

test("CLI e2e: slock profile update --display-name '' is rejected", async ({ app }) => {
  const { agent, agentApiKey, server } = await seed();

  await assert.rejects(
    runSlockCli(["profile", "update", "--display-name", "", "--json"], {
      SLOCK_SERVER_URL: app.baseUrl,
      SLOCK_AGENT_ID: agent.id,
      SLOCK_AGENT_TOKEN: agentApiKey,
      SLOCK_SERVER_ID: server.id,
    }),
    (err: NodeJS.ErrnoException & { stderr?: string }) => {
      assert.match(err.stderr ?? "", /INVALID_ARG/);
      assert.match(err.stderr ?? "", /must not be empty/);
      return true;
    },
  );
});

test("CLI e2e: slock profile update with no fields fails fast", async ({ app }) => {
  const { agent, agentApiKey, server } = await seed();

  await assert.rejects(
    runSlockCli(["profile", "update", "--json"], {
      SLOCK_SERVER_URL: app.baseUrl,
      SLOCK_AGENT_ID: agent.id,
      SLOCK_AGENT_TOKEN: agentApiKey,
      SLOCK_SERVER_ID: server.id,
    }),
    (err: NodeJS.ErrnoException & { stderr?: string }) => {
      assert.match(err.stderr ?? "", /INVALID_ARG/);
      return true;
    },
  );
});
