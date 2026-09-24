import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadAgentContext, AgentBootstrapError, resolveProfileDir } from "./env.js";

const baseEnv = {
  SLOCK_AGENT_ID: "agent_abc",
  SLOCK_SERVER_URL: "http://localhost:3001",
  SLOCK_SERVER_ID: "srv_xyz",
};

test("env: rejects legacy literal machine token", () => {
  assert.throws(
    () => loadAgentContext({ ...baseEnv, SLOCK_AGENT_TOKEN: "tok-literal" }),
    (err) => (
      err instanceof AgentBootstrapError
      && err.code === "LEGACY_MACHINE_UNSUPPORTED"
      && err.message.includes("SLOCK_AGENT_PROXY_URL")
    ),
  );
});

test("env: rejects legacy file machine token", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-"));
  const file = path.join(tmp, "tok");
  fs.writeFileSync(file, "tok-from-file\n", { mode: 0o600 });

  assert.throws(
    () => loadAgentContext({
      ...baseEnv,
      SLOCK_AGENT_TOKEN_FILE: file,
      SLOCK_AGENT_TOKEN: "tok-literal",
    }),
    (err) => err instanceof AgentBootstrapError && err.code === "LEGACY_MACHINE_UNSUPPORTED",
  );
});

test("env: local agent proxy wins over legacy token files", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-"));
  const oldTokenFile = path.join(tmp, "old-token");
  fs.writeFileSync(oldTokenFile, "old-token\n", { mode: 0o600 });

  const ctx = loadAgentContext({
    ...baseEnv,
    SLOCK_AGENT_PROXY_URL: "http://127.0.0.1:45678",
    SLOCK_AGENT_PROXY_TOKEN: "sap_local_proxy",
    SLOCK_AGENT_TOKEN_FILE: oldTokenFile,
  });
  assert.equal(ctx.serverUrl, "http://127.0.0.1:45678");
  assert.equal(ctx.token, "sap_local_proxy");
  assert.equal(ctx.clientMode, "managed-runner");
  assert.equal(ctx.secretSource, "agent-proxy-token-env");
});

test("env: local agent proxy can read token from daemon-owned token file", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-"));
  const proxyFile = path.join(tmp, "proxy-token");
  fs.writeFileSync(proxyFile, "sap_from_file\n", { mode: 0o600 });

  const ctx = loadAgentContext({
    ...baseEnv,
    SLOCK_AGENT_PROXY_URL: "http://127.0.0.1:45678",
    SLOCK_AGENT_PROXY_TOKEN_FILE: proxyFile,
  });
  assert.equal(ctx.serverUrl, "http://127.0.0.1:45678");
  assert.equal(ctx.token, "sap_from_file");
  assert.equal(ctx.clientMode, "managed-runner");
  assert.equal(ctx.secretSource, "agent-proxy-token-file");
});

test("env: local agent proxy rejects ambiguous token sources", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-"));
  const proxyFile = path.join(tmp, "proxy-token");
  fs.writeFileSync(proxyFile, "sap_from_file\n", { mode: 0o600 });

  assert.throws(
    () => loadAgentContext({
      ...baseEnv,
      SLOCK_AGENT_PROXY_URL: "http://127.0.0.1:45678",
      SLOCK_AGENT_PROXY_TOKEN: "sap_literal",
      SLOCK_AGENT_PROXY_TOKEN_FILE: proxyFile,
    }),
    (err) => err instanceof AgentBootstrapError && err.code === "MULTIPLE_AGENT_PROXY_TOKENS",
  );
});

test("env: missing agent id throws", () => {
  assert.throws(
    () =>
      loadAgentContext({
        SLOCK_SERVER_URL: "x",
        SLOCK_SERVER_ID: "y",
        SLOCK_AGENT_TOKEN: "z",
      }),
    (err) => err instanceof AgentBootstrapError && err.code === "MISSING_AGENT_ID",
  );
});

test("env: missing token throws", () => {
  assert.throws(
    () => loadAgentContext({ ...baseEnv }),
    (err) => err instanceof AgentBootstrapError && err.code === "MISSING_TOKEN",
  );
});

test("env: empty proxy token file throws", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-"));
  const file = path.join(tmp, "tok");
  fs.writeFileSync(file, "   \n");
  assert.throws(
    () => loadAgentContext({
      ...baseEnv,
      SLOCK_AGENT_PROXY_URL: "http://127.0.0.1:45678",
      SLOCK_AGENT_PROXY_TOKEN_FILE: file,
    }),
    (err) => err instanceof AgentBootstrapError && err.code === "TOKEN_FILE_EMPTY",
  );
});

test("env: SLOCK_SERVER_ID is optional in v0", () => {
  const { SLOCK_SERVER_ID: _omit, ...envWithoutServerId } = baseEnv;
  const ctx = loadAgentContext({
    ...envWithoutServerId,
    SLOCK_AGENT_PROXY_URL: "http://127.0.0.1:45678",
    SLOCK_AGENT_PROXY_TOKEN: "sap_local_proxy",
  });
  assert.equal(ctx.serverId, null);
});

function writeProfileFixture(body: unknown): { profileDir: string; filePath: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-profile-"));
  const filePath = path.join(tmp, "credential.json");
  fs.writeFileSync(filePath, typeof body === "string" ? body : JSON.stringify(body), { mode: 0o600 });
  return { profileDir: tmp, filePath };
}

test("env: RAFT_PROFILE reads credential file and produces self-hosted-runner ctx", () => {
  const { profileDir } = writeProfileFixture({
    schemaVersion: 1,
    serverUrl: "https://slock.example.com",
    agentId: "agent_from_profile",
    agentName: "Huai",
    serverId: "srv_from_profile",
    credentialId: "cred_xyz",
    scopes: ["agent:send", "agent:read"],
    apiKey: "sk_agent_from_profile",
    createdAt: "2026-05-20T00:00:00.000Z",
  });

  const ctx = loadAgentContext({
    RAFT_PROFILE: "huai",
    RAFT_PROFILE_DIR: profileDir,
  });

  assert.equal(ctx.agentId, "agent_from_profile");
  assert.equal(ctx.serverUrl, "https://slock.example.com");
  assert.equal(ctx.serverId, "srv_from_profile");
  assert.equal(ctx.token, "sk_agent_from_profile");
  assert.equal(ctx.clientMode, "self-hosted-runner");
  assert.equal(ctx.secretSource, "profile-credential-file");
  assert.equal(ctx.profileSlug, "huai");
  assert.equal(ctx.profileCredentialPath, path.join(profileDir, "credential.json"));
});

test("env: RAFT_PROFILE missing serverId is allowed (defaults to null)", () => {
  const { profileDir } = writeProfileFixture({
    schemaVersion: 1,
    serverUrl: "https://slock.example.com",
    agentId: "agent_from_profile",
    apiKey: "sk_agent_from_profile",
  });

  const ctx = loadAgentContext({
    RAFT_PROFILE: "huai",
    RAFT_PROFILE_DIR: profileDir,
  });
  assert.equal(ctx.serverId, null);
});

test("env: RAFT_PROFILE wins over raw agent env vars and warns to stderr", () => {
  const { profileDir } = writeProfileFixture({
    schemaVersion: 1,
    serverUrl: "https://slock.example.com",
    agentId: "agent_from_profile",
    apiKey: "sk_agent_from_profile",
  });

  const originalWrite = process.stderr.write.bind(process.stderr);
  const stderrChunks: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const ctx = loadAgentContext({
      RAFT_PROFILE: "huai",
      RAFT_PROFILE_DIR: profileDir,
      SLOCK_AGENT_ID: "agent_other",
      SLOCK_AGENT_TOKEN: "tok_should_be_ignored",
    });
    assert.equal(ctx.agentId, "agent_from_profile");
    assert.equal(ctx.token, "sk_agent_from_profile");
  } finally {
    process.stderr.write = originalWrite;
  }
  const combined = stderrChunks.join("");
  assert.match(combined, /RAFT_PROFILE=huai active/);
  assert.match(combined, /SLOCK_AGENT_ID/);
  assert.match(combined, /SLOCK_AGENT_TOKEN/);
});

test("env: managed launch markers reject an ambient profile before reading another identity", () => {
  const { profileDir } = writeProfileFixture({
    schemaVersion: 1,
    serverUrl: "https://foreign.example.com",
    agentId: "agent_foreign",
    apiKey: "sk_agent_foreign",
  });

  assert.throws(
    () => loadAgentContext({
      RAFT_PROFILE: "foreign",
      RAFT_PROFILE_DIR: profileDir,
      SLOCK_AGENT_ID: "agent_managed",
      SLOCK_SERVER_URL: "https://managed.example.com",
      SLOCK_AGENT_LAUNCH_DIR: "launch-1",
    }),
    (error: unknown) => (
      error instanceof AgentBootstrapError
      && error.code === "PROFILE_MANAGED_CONTEXT_CONFLICT"
      && !error.message.includes("sk_agent_foreign")
    ),
  );
});

test("env: RAFT_PROFILE with unreadable file throws PROFILE_FILE_UNREADABLE", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-profile-"));
  assert.throws(
    () =>
      loadAgentContext({
        RAFT_PROFILE: "missing",
        RAFT_PROFILE_DIR: tmp,
      }),
    (err) => err instanceof AgentBootstrapError && err.code === "PROFILE_FILE_UNREADABLE",
  );
});

test("env: RAFT_PROFILE with malformed JSON throws PROFILE_FILE_INVALID", () => {
  const { profileDir } = writeProfileFixture("not json {");
  assert.throws(
    () =>
      loadAgentContext({
        RAFT_PROFILE: "huai",
        RAFT_PROFILE_DIR: profileDir,
      }),
    (err) => err instanceof AgentBootstrapError && err.code === "PROFILE_FILE_INVALID",
  );
});

test("env: RAFT_PROFILE with missing apiKey throws PROFILE_FILE_INVALID", () => {
  const { profileDir } = writeProfileFixture({
    schemaVersion: 1,
    serverUrl: "https://slock.example.com",
    agentId: "agent_from_profile",
  });
  assert.throws(
    () =>
      loadAgentContext({
        RAFT_PROFILE: "huai",
        RAFT_PROFILE_DIR: profileDir,
      }),
    (err) => err instanceof AgentBootstrapError && err.code === "PROFILE_FILE_INVALID",
  );
});

test("env: RAFT_PROFILE forwards SLOCK_AGENT_ACTIVE_CAPABILITIES filter", () => {
  const { profileDir } = writeProfileFixture({
    schemaVersion: 1,
    serverUrl: "https://slock.example.com",
    agentId: "agent_from_profile",
    apiKey: "sk_agent_from_profile",
  });

  const ctx = loadAgentContext({
    RAFT_PROFILE: "huai",
    RAFT_PROFILE_DIR: profileDir,
    SLOCK_AGENT_ACTIVE_CAPABILITIES: "agent:send,agent:read",
  });
  assert.deepEqual(ctx.activeCapabilities, ["agent:send", "agent:read"]);
});

// --- SLOCK_HOME isolation regression (Hao layer-1 checklist #5,
// Dayu #wg-raft-computer msg=15528a10 §10 invariant) ---
//
// All these tests share one rule: profile credential read MUST resolve
// under the effective SLOCK_HOME when it is set, never under default
// $HOME/.slock. The fallback to $HOME is only legitimate when SLOCK_HOME
// is unset (i.e. the user is running outside a daemon-spawned context).

test("env: RAFT_PROFILE resolves under SLOCK_HOME/profiles/<slug> when set", () => {
  const slockHome = fs.mkdtempSync(path.join(os.tmpdir(), "slock-home-"));
  const profileDir = path.join(slockHome, "profiles", "huai");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "credential.json"),
    JSON.stringify({
      schemaVersion: 1,
      serverUrl: "https://slock.example.com",
      agentId: "agent_from_slock_home",
      apiKey: "sk_agent_from_slock_home",
    }),
    { mode: 0o600 },
  );

  const ctx = loadAgentContext({
    RAFT_PROFILE: "huai",
    SLOCK_HOME: slockHome,
    // Deliberately set HOME to a different tmp dir to prove SLOCK_HOME wins
    // and we are NOT leaking to default $HOME/.slock/profiles/...
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), "slock-fake-home-")),
  });
  assert.equal(ctx.agentId, "agent_from_slock_home");
  assert.equal(ctx.profileCredentialPath, path.join(profileDir, "credential.json"));
});

test("env: RAFT_PROFILE_DIR wins over SLOCK_HOME (explicit override)", () => {
  const slockHome = fs.mkdtempSync(path.join(os.tmpdir(), "slock-home-"));
  // Decoy: a credential exists under SLOCK_HOME — must NOT be the one read.
  fs.mkdirSync(path.join(slockHome, "profiles", "huai"), { recursive: true });
  fs.writeFileSync(
    path.join(slockHome, "profiles", "huai", "credential.json"),
    JSON.stringify({
      schemaVersion: 1,
      serverUrl: "https://decoy.example.com",
      agentId: "agent_decoy",
      apiKey: "sk_agent_decoy",
    }),
    { mode: 0o600 },
  );
  // The override path: this is what should win.
  const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-override-"));
  fs.writeFileSync(
    path.join(overrideDir, "credential.json"),
    JSON.stringify({
      schemaVersion: 1,
      serverUrl: "https://override.example.com",
      agentId: "agent_override",
      apiKey: "sk_agent_override",
    }),
    { mode: 0o600 },
  );

  const ctx = loadAgentContext({
    RAFT_PROFILE: "huai",
    SLOCK_HOME: slockHome,
    RAFT_PROFILE_DIR: overrideDir,
  });
  assert.equal(ctx.agentId, "agent_override");
  assert.equal(ctx.profileCredentialPath, path.join(overrideDir, "credential.json"));
});

test("env: fresh SLOCK_HOME with no profile throws PROFILE_FILE_UNREADABLE without touching $HOME/.slock", () => {
  // Fresh SLOCK_HOME = no profiles directory at all yet. We're proving:
  //   (a) the error is the existing PROFILE_FILE_UNREADABLE code (no new
  //       error taxonomy until layer-2 needs it).
  //   (b) the error path string points inside SLOCK_HOME, not $HOME/.slock.
  //   (c) we do NOT silently fall through to $HOME/.slock/profiles/<slug>
  //       even if such a file happened to exist there (operator sandbox
  //       contract).
  const slockHome = fs.mkdtempSync(path.join(os.tmpdir(), "slock-home-fresh-"));
  // Decoy: put a profile under a fake $HOME/.slock that SHOULD be ignored.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "slock-fake-home-"));
  const fakeProfileDir = path.join(fakeHome, ".slock", "profiles", "huai");
  fs.mkdirSync(fakeProfileDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeProfileDir, "credential.json"),
    JSON.stringify({
      schemaVersion: 1,
      serverUrl: "https://leak.example.com",
      agentId: "agent_leak",
      apiKey: "sk_agent_leak",
    }),
    { mode: 0o600 },
  );

  assert.throws(
    () =>
      loadAgentContext({
        RAFT_PROFILE: "huai",
        SLOCK_HOME: slockHome,
        HOME: fakeHome,
      }),
    (err) => {
      if (!(err instanceof AgentBootstrapError)) return false;
      if (err.code !== "PROFILE_FILE_UNREADABLE") return false;
      // Error path must point inside SLOCK_HOME, never into the decoy $HOME.
      if (!err.message.includes(slockHome)) return false;
      if (err.message.includes(fakeHome)) return false;
      return true;
    },
  );
});

test("env: no home roots set falls back to $HOME/.slock/profiles/<slug>", () => {
  // The "outside a daemon context" path: no SLOCK_HOME, no override, we
  // should land on $HOME/.slock/profiles/<slug>/credential.json.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "slock-home-fallback-"));
  const profileDir = path.join(home, ".slock", "profiles", "huai");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "credential.json"),
    JSON.stringify({
      schemaVersion: 1,
      serverUrl: "https://fallback.example.com",
      agentId: "agent_fallback",
      apiKey: "sk_agent_fallback",
    }),
    { mode: 0o600 },
  );

  const ctx = loadAgentContext({
    RAFT_PROFILE: "huai",
    HOME: home,
  });
  assert.equal(ctx.agentId, "agent_fallback");
  assert.equal(ctx.profileCredentialPath, path.join(profileDir, "credential.json"));
});

// Alias window (Stone's ruling, #proj-aiax 2026-06-12): RAFT_* canonical,
// SLOCK_* deprecation aliases; conflicting values fail loudly.
test("env: SLOCK_PROFILE alias still selects a profile; conflicting RAFT/SLOCK values fail closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-alias-"));
  fs.mkdirSync(path.join(dir, "profiles", "ali"), { recursive: true });
  fs.writeFileSync(path.join(dir, "profiles", "ali", "credential.json"), JSON.stringify({
    schemaVersion: 1, serverUrl: "https://s.example", agentId: "agent-ali", apiKey: "sk_agent_x",
  }));

  const viaAlias = loadAgentContext({ SLOCK_PROFILE: "ali", RAFT_HOME: dir } as NodeJS.ProcessEnv);
  assert.equal(viaAlias.profileSlug, "ali");

  assert.throws(
    () => loadAgentContext({ RAFT_PROFILE: "a", SLOCK_PROFILE: "b", RAFT_HOME: dir } as NodeJS.ProcessEnv),
    (err: unknown) => (err as { code?: string }).code === "PROFILE_ENV_CONFLICT",
  );
  // Same value in both = no conflict (transition period).
  const both = loadAgentContext({ RAFT_PROFILE: "ali", SLOCK_PROFILE: "ali", RAFT_HOME: dir } as NodeJS.ProcessEnv);
  assert.equal(both.profileSlug, "ali");
});

test("env: RAFT_HOME takes precedence over SLOCK_HOME (§10 isolation still honored)", () => {
  const raftRoot = fs.mkdtempSync(path.join(os.tmpdir(), "raft-home-"));
  const slockRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slock-home-"));
  assert.equal(
    resolveProfileDir("x", { RAFT_HOME: raftRoot, SLOCK_HOME: slockRoot } as NodeJS.ProcessEnv),
    path.join(raftRoot, "profiles", "x"),
  );
  // Daemon-exported SLOCK_HOME alone still scopes state (the §10 invariant).
  assert.equal(
    resolveProfileDir("x", { SLOCK_HOME: slockRoot } as NodeJS.ProcessEnv),
    path.join(slockRoot, "profiles", "x"),
  );
});
