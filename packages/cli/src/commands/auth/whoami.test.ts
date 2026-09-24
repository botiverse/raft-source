import assert from "node:assert/strict";
import test from "node:test";

import { whoamiCommand } from "./whoami.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import type { CliIo } from "../../core/io.js";

function memoryIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
    },
  };
}

test("whoami command uses injected context and redacts token", async () => {
  const { io, stdout, stderr } = memoryIo();
  const agentContext: AgentContext = {
    agentId: "agent-1",
    serverUrl: "https://slock.example",
    serverId: "server-1",
    token: "secret-token",
    clientMode: "self-hosted-runner",
    secretSource: "profile-credential-file",
    activeCapabilities: ["knowledge"],
    profileSlug: "demo",
    profileCredentialPath: "/tmp/demo/credential.json",
  };
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await whoamiCommand.handler(ctx);

  assert.deepEqual(stderr, []);
  const payload = JSON.parse(stdout.join(""));
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.data, {
    agentId: "agent-1",
    serverUrl: "https://slock.example",
    serverId: "server-1",
    clientMode: "self-hosted-runner",
    secretSource: "profile-credential-file",
    profileSlug: "demo",
    profileCredentialPath: "/tmp/demo/credential.json",
  });
  assert.equal(stdout.join("").includes("secret-token"), false);
});
