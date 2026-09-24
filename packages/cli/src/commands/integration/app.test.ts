import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Command } from "commander";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import type { CliIo } from "../../core/io.js";
import {
  integrationAppPrepareRecoverOwnerCommand,
  integrationAppPrepareRegisterCommand,
  integrationAppClearLogoCommand,
  integrationAppDeleteCommand,
  integrationAppLogoCommand,
  integrationAppRequestPublishCommand,
  integrationAppRequestUnpublishCommand,
  integrationAppRotateSecretCommand,
  integrationAppShareLinkCreateCommand,
  integrationAppShareLinkRevokeCommand,
  integrationAppShareLinkStatusCommand,
  integrationAppTransferOwnerCommand,
  integrationAppUpdateCommand,
  integrationAppListCommand,
  integrationAppStatusCommand,
  registerIntegrationAppCommands,
} from "./app.js";
import {
  closePrivateSecretSink,
  preparePrivateSecretSink,
  writePrivateSecretSink,
} from "./privateSecretSink.js";

test("integration app list/status reconstruct pending and committed state without secret-shaped fields", async () => {
  const listIo = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const app = {
    state: "committed" as const,
    card: null,
    name: "Demo App",
    clientKey: "demo-app",
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    description: "Agent-managed demo",
    homepageUrl: "https://demo.example",
    callbackUrl: "https://demo.example/auth/raft/callback",
    agentManifestUrl: "https://demo.example/.well-known/raft-app.json",
    scopes: ["openid"],
    category: "Developer Tools",
    dataAccessSummary: "Reads basic profile information",
    appType: "oauth2",
    enabled: true,
    recoveryCommand: "raft integration app rotate-secret --client demo-app --output <new-private-path>",
  };
  const createCtx = (io: CliIo, response: unknown) => createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        return { ok: true, status: 200, error: null, data: response };
      },
    }) as any,
  });

  await integrationAppListCommand.handler(createCtx(listIo.io, { apps: [app] }), {});
  assert.deepEqual(requests.shift(), { method: "GET", path: "/internal/agent-api/integrations/app" });
  const listText = listIo.stdout.join("");
  assert.match(listText, /state: committed/);
  assert.match(listText, /description: Agent-managed demo/);
  assert.match(listText, /app type: oauth2/);
  assert.match(listText, /enabled: yes/);
  assert.match(listText, /updated: 2026-07-23T00:00:00.000Z/);
  assert.match(listText, /homepage URL: https:\/\/demo\.example/);
  assert.match(listText, /agent manifest URL: https:\/\/demo\.example\/\.well-known\/raft-app\.json/);
  assert.match(listText, /data access: Reads basic profile information/);
  assert.match(listText, /raft integration app rotate-secret --client demo-app --output <new-private-path>/);
  assert.match(listText, /raft integration app update --client demo-app --redirect-url <https-callback-url>/);
  assert.match(listText, /raft integration app transfer-owner --client demo-app --to-agent <handle>/);
  assert.match(listText, /pass that file directly to the authorized secret store/);
  assert.match(listText, /choose a path outside Web\/static\/shared surfaces/);
  assert.match(listText, /path is caller-managed after return/);
  assert.match(listText, /not disclosed through stdout\/JSON, Raft messages or chat, logs, receipts, history, or Raft\/server persistence outside the selected private file/);
  assert.doesNotMatch(listText, /never enter CLI output, Raft/);
  assert.match(listText, /Only apps this agent may manage are shown/);
  assert.doesNotMatch(listText, /clientSecret|client_secret|secretHash|secret_hash|ownerAgentId/);

  const statusIo = memoryIo();
  await integrationAppStatusCommand.handler(createCtx(statusIo.io, {
    app: { ...app, clientSecret: "raft_secret_must_never_render", ownerAgentId: "internal-owner-id" },
    token: "internal-token-must-never-render",
  }), { client: "demo-app", json: true });
  assert.deepEqual(requests.shift(), { method: "GET", path: "/internal/agent-api/integrations/app/status?client=demo-app" });
  const json = JSON.parse(statusIo.stdout.join(""));
  assert.equal(json.data.app.clientKey, "demo-app");
  assert.doesNotMatch(JSON.stringify(json), /clientSecret|client_secret|secretHash|secret_hash|ownerAgentId/);

  await assert.rejects(
    async () => integrationAppStatusCommand.handler(createCtx(memoryIo().io, { app }), { card: "abcd1234", client: "demo-app" }),
    /Exactly one of --card or --client is required/,
  );
});

test("integration app list gives an explicit non-owner handoff instead of a generic no-action dead end", async () => {
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: { apps: [] },
      }),
    }) as any,
  });

  await integrationAppListCommand.handler(ctx, {});

  const output = stdout.join("");
  assert.match(output, /this agent is not its owner or a server admin/);
  assert.match(output, /raft integration app transfer-owner --client <client-key> --to-agent <handle>/);
});

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

const agentContext: AgentContext = {
  agentId: "agent-1",
  serverUrl: "https://raft.example",
  serverId: "server-1",
  token: "secret-token",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

test("integration app prepare register posts sanitized action-card request", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        return {
          ok: true,
          status: 201,
          error: null,
          data: {
            status: "prepared",
            mode: "register",
            target: "#proj-auth",
            actionCardMessageId: "card-message-1",
            action: {
              type: "integration:register_app",
              name: "Demo App",
              clientKey: "demo-app",
              category: "Developer Tools",
              homepageUrl: "https://demo.example",
              returnUrl: "https://demo.example/auth/raft/callback",
              scopes: ["email", "openid", "profile"],
            },
          },
        };
      },
    }) as any,
  });

  await integrationAppPrepareRegisterCommand.handler(ctx, {
    name: "Demo App",
    clientKey: "demo-app",
    appUrl: "https://demo.example",
    category: "Developer Tools",
    redirectUrl: "https://demo.example/auth/raft/callback",
    scope: ["openid profile", "email"],
    target: "#proj-auth",
  });

  assert.deepEqual(requests, [
    {
      method: "POST",
      path: "/internal/agent-api/integrations/app/prepare",
      body: {
        mode: "register",
        target: "#proj-auth",
        clientKey: "demo-app",
        name: "Demo App",
        description: undefined,
        category: "Developer Tools",
        homepageUrl: "https://demo.example",
        returnUrl: "https://demo.example/auth/raft/callback",
        agentManifestUrl: undefined,
        scopes: ["email", "openid profile"],
        unsafeDemoUrlOverride: false,
      },
    },
  ]);
  assert.deepEqual(stderr, []);
  const out = stdout.join("");
  assert.match(out, /Integration app register card prepared/);
  assert.match(out, /card: card-message-1/);
  assert.match(out, /category: Developer Tools/);
  assert.match(out, /requesting owner agent receives the initial secret once through a private transient notice/);
  assert.match(out, /never stored in the card or chat history/);
  assert.match(out, /raft integration app rotate-secret --client <client-key-from-receipt> --output <new-private-path>/);
  assert.match(out, /invalidates the previous one/);
});

test("integration app prepare register allows server-generated client key", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        return {
          ok: true,
          status: 201,
          error: null,
          data: {
            status: "prepared",
            mode: "register",
            target: "#proj-auth",
            actionCardMessageId: "card-message-2",
            action: {
              type: "integration:register_app",
              name: "Generated App",
              returnUrl: "https://generated.example/auth/raft/callback",
              scopes: ["openid", "profile"],
            },
          },
        };
      },
    }) as any,
  });

  await integrationAppPrepareRegisterCommand.handler(ctx, {
    name: "Generated App",
    redirectUrl: "https://generated.example/auth/raft/callback",
    target: "#proj-auth",
  });

  assert.deepEqual(requests, [
    {
      method: "POST",
      path: "/internal/agent-api/integrations/app/prepare",
      body: {
        mode: "register",
        target: "#proj-auth",
        clientKey: undefined,
        name: "Generated App",
        description: undefined,
        category: undefined,
        homepageUrl: undefined,
        returnUrl: "https://generated.example/auth/raft/callback",
        agentManifestUrl: undefined,
        scopes: undefined,
        unsafeDemoUrlOverride: false,
      },
    },
  ]);
  assert.deepEqual(stderr, []);
  const out = stdout.join("");
  assert.match(out, /client key: auto-generated on commit/);
  assert.match(out, /client-key-from-receipt/);
});

test("integration app CLI does not expose the legacy prepare-update authority path", () => {
  const root = new Command();
  registerIntegrationAppCommands(root);
  const app = root.commands.find((command) => command.name() === "app");
  const prepare = app?.commands.find((command) => command.name() === "prepare");
  const update = app?.commands.find((command) => command.name() === "update");
  assert.deepEqual(prepare?.commands.map((command) => command.name()), ["register", "recover-owner"]);
  assert.deepEqual(app?.commands.map((command) => command.name()), [
    "prepare",
    "rotate-secret",
    "transfer-owner",
    "update",
    "logo",
    "clear-logo",
    "share-link",
    "share-link-status",
    "revoke-share-link",
    "request-publish",
    "request-unpublish",
    "delete",
    "list",
    "status",
  ]);
  assert.ok(update?.options.some((option) => option.long === "--category"));
});

test("integration app rotate-secret writes only to a new mode-0600 sink and emits a sanitized receipt", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const dir = mkdtempSync(join(tmpdir(), "raft-app-secret-"));
  const output = join(dir, "client-secret");
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            clientId: "client-uuid-1",
            clientKey: "demo-app",
            clientName: "Demo App",
            clientSecret: "raft_secret_rotated123",
            client_secret: "rotate_alias_must_not_render",
            credentials: { clientSecret: "rotate_nested_must_not_render" },
            unknownTopLevel: "rotate_unknown_must_not_render",
          },
        };
      },
    }) as any,
  });

  try {
    await integrationAppRotateSecretCommand.handler(ctx, { client: "demo-app", output });

    assert.deepEqual(requests, [
      {
        method: "POST",
        path: "/internal/agent-api/integrations/app/rotate-secret",
        body: { clientKey: "demo-app" },
      },
    ]);
    assert.deepEqual(stderr, []);
    assert.equal(readFileSync(output, "utf8"), "raft_secret_rotated123");
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const out = stdout.join("");
    assert.match(out, new RegExp(`secret file: ${output.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(out, /mode: 0600/);
    assert.match(out, /path policy: agent-selected; keep it out of Web\/static\/shared surfaces/);
    assert.match(out, /path binding: caller-managed-after-return/);
    assert.match(out, /secret disclosure: none/);
    assert.doesNotMatch(out, /raft_secret_rotated123|rotate_alias_must_not_render|rotate_nested_must_not_render|rotate_unknown_must_not_render/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration app rotate-secret JSON emits only the fixed private-sink receipt", async () => {
  const { io, stdout } = memoryIo();
  const dir = mkdtempSync(join(tmpdir(), "raft-app-secret-json-"));
  const output = join(dir, "client-secret");
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          clientId: "client-uuid-1",
          clientKey: "demo-app",
          clientName: "Demo App",
          clientSecret: "raft_secret_rotated123",
          client_secret: "rotate_json_alias_must_not_render",
          credentials: { clientSecret: "rotate_json_nested_must_not_render" },
          unknownTopLevel: "rotate_json_unknown_must_not_render",
        },
      }),
    }) as any,
  });

  try {
    await integrationAppRotateSecretCommand.handler(ctx, { client: "demo-app", output, json: true });

    const wire = stdout.join("");
    assert.doesNotMatch(wire, /raft_secret_rotated123|rotate_json_alias_must_not_render|rotate_json_nested_must_not_render|rotate_json_unknown_must_not_render/);
    assert.deepEqual(JSON.parse(wire), {
      ok: true,
      data: {
        clientId: "client-uuid-1",
        clientKey: "demo-app",
        clientName: "Demo App",
        secretSink: {
          path: output,
          mode: "0600",
          created: true,
          containsSecret: true,
          selection: "agent-selected",
          binding: "caller-managed-after-return",
        },
        secretDisclosure: "none",
        next: "keep this path out of Web/static/shared surfaces, pass the file directly to the authorized runtime secret-store command, then securely remove it",
      },
    });
    assert.equal(readFileSync(output, "utf8"), "raft_secret_rotated123");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration app rotate-secret rejects an existing sink before POST without changing bytes or mode", async () => {
  const { io } = memoryIo();
  const dir = mkdtempSync(join(tmpdir(), "raft-app-secret-existing-"));
  const output = join(dir, "client-secret");
  writeFileSync(output, "sentinel-bytes", { mode: 0o640 });
  chmodSync(output, 0o640);
  let postCount = 0;
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => {
        postCount += 1;
        return { ok: false, status: 500, error: "must not be called", data: null };
      },
    }) as any,
  });

  try {
    await assert.rejects(
      async () => integrationAppRotateSecretCommand.handler(ctx, { client: "demo-app", output }),
      /could not prepare a new private secret sink/,
    );
    assert.equal(postCount, 0);
    assert.equal(readFileSync(output, "utf8"), "sentinel-bytes");
    assert.equal(statSync(output).mode & 0o777, 0o640);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration app rotate-secret creates no sink when agent context bootstrap fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "raft-app-secret-context-failure-"));
  const output = join(dir, "client-secret");
  let clientCreateCount = 0;
  let postCount = 0;
  const ctx = createCommandContext({
    io: memoryIo().io,
    loadAgentContext: () => {
      throw new Error("agent bootstrap unavailable");
    },
    createApiClient: () => {
      clientCreateCount += 1;
      return {
        request: async (): Promise<ApiResponse<unknown>> => {
          postCount += 1;
          return { ok: false, status: 500, error: "must not be called", data: null };
        },
      } as any;
    },
  });

  try {
    await assert.rejects(
      async () => integrationAppRotateSecretCommand.handler(ctx, { client: "demo-app", output }),
      /agent bootstrap unavailable/,
    );
    assert.equal(clientCreateCount, 0);
    assert.equal(postCount, 0);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration app rotate-secret creates no sink when API client construction fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "raft-app-secret-client-failure-"));
  const output = join(dir, "client-secret");
  let clientCreateCount = 0;
  const ctx = createCommandContext({
    io: memoryIo().io,
    loadAgentContext: () => agentContext,
    createApiClient: () => {
      clientCreateCount += 1;
      throw new Error("API client unavailable");
    },
  });

  try {
    await assert.rejects(
      async () => integrationAppRotateSecretCommand.handler(ctx, { client: "demo-app", output }),
      /API client unavailable/,
    );
    assert.equal(clientCreateCount, 1);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration app rotate-secret retains a private empty sink with cleanup guidance when the API fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "raft-app-secret-api-failure-"));
  const output = join(dir, "client-secret");
  let postCount = 0;
  const ctx = createCommandContext({
    io: memoryIo().io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => {
        postCount += 1;
        assert.equal(existsSync(output), true);
        return { ok: false, status: 503, error: "rotation unavailable", data: null };
      },
    }) as any,
  });

  try {
    await assert.rejects(
      async () => integrationAppRotateSecretCommand.handler(ctx, { client: "demo-app", output }),
      /app secret rotation failed \(HTTP 503\); no secret was written, but the empty private sink remains.*remove it before retrying/,
    );
    assert.equal(postCount, 1);
    assert.equal(readFileSync(output, "utf8"), "");
    assert.equal(statSync(output).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration app rotate-secret does not replay credential-shaped transport errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "raft-app-secret-transport-failure-"));
  const output = join(dir, "client-secret");
  const ctx = createCommandContext({
    io: memoryIo().io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => {
        throw new Error("transport failed with raft_secret_must_not_render");
      },
    }) as any,
  });

  try {
    await assert.rejects(
      async () => integrationAppRotateSecretCommand.handler(ctx, { client: "demo-app", output }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /rotation request failed before any secret was written/);
        assert.doesNotMatch(message, /raft_secret_must_not_render/);
        return true;
      },
    );
    assert.equal(readFileSync(output, "utf8"), "");
    assert.equal(statSync(output).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration app rotate-secret rejects a swapped success path without touching the replacement or emitting a receipt", async () => {
  const { io, stdout } = memoryIo();
  const dir = mkdtempSync(join(tmpdir(), "raft-app-secret-success-swap-"));
  const output = join(dir, "client-secret");
  const moved = join(dir, "moved-secret-sink");
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => {
        renameSync(output, moved);
        writeFileSync(output, "replacement-bytes", { mode: 0o640 });
        chmodSync(output, 0o640);
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            clientId: "client-uuid-1",
            clientKey: "demo-app",
            clientName: "Demo App",
            clientSecret: "raft_secret_rotated123",
          },
        };
      },
    }) as any,
  });

  try {
    await assert.rejects(
      async () => integrationAppRotateSecretCommand.handler(ctx, { client: "demo-app", output }),
      /private sink path changed before commit/,
    );
    assert.equal(stdout.join(""), "");
    assert.equal(readFileSync(output, "utf8"), "replacement-bytes");
    assert.equal(statSync(output).mode & 0o777, 0o640);
    assert.equal(readFileSync(moved, "utf8"), "raft_secret_rotated123");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration app rotate-secret API cleanup leaves a swapped replacement untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "raft-app-secret-cleanup-swap-"));
  const output = join(dir, "client-secret");
  const moved = join(dir, "moved-empty-sink");
  const ctx = createCommandContext({
    io: memoryIo().io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => {
        renameSync(output, moved);
        writeFileSync(output, "replacement-bytes", { mode: 0o640 });
        chmodSync(output, 0o640);
        return { ok: false, status: 503, error: "rotation unavailable", data: null };
      },
    }) as any,
  });

  try {
    await assert.rejects(
      async () => integrationAppRotateSecretCommand.handler(ctx, { client: "demo-app", output }),
      /app secret rotation failed \(HTTP 503\)/,
    );
    assert.equal(readFileSync(output, "utf8"), "replacement-bytes");
    assert.equal(statSync(output).mode & 0o777, 0o640);
    assert.equal(readFileSync(moved, "utf8"), "");
    assert.equal(statSync(moved).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("private secret sink close never unlinks its selected path or a replacement", () => {
  const dir = mkdtempSync(join(tmpdir(), "raft-app-secret-discard-swap-"));
  const output = join(dir, "client-secret");
  const moved = join(dir, "moved-empty-sink");

  try {
    const sink = preparePrivateSecretSink(output);
    renameSync(output, moved);
    writeFileSync(output, "replacement-bytes", { mode: 0o640 });
    chmodSync(output, 0o640);

    closePrivateSecretSink(sink);
    assert.equal(readFileSync(output, "utf8"), "replacement-bytes");
    assert.equal(statSync(output).mode & 0o777, 0o640);
    assert.equal(readFileSync(moved, "utf8"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("private secret sink reports a post-rotation write failure without disclosing the secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "raft-app-secret-write-failure-"));
  const output = join(dir, "client-secret");
  const secret = "raft_secret_must_not_reach_error_output";

  try {
    const sink = preparePrivateSecretSink(output);
    closeSync(sink.fd);

    assert.throws(
      () => writePrivateSecretSink(sink, secret),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /secret was rotated but the local write or commit failed/);
        assert.match(message, /no pathname cleanup was attempted/);
        assert.match(message, /sensitive private artifact may remain/);
        assert.doesNotMatch(message, new RegExp(secret));
        return true;
      },
    );
    assert.equal(readFileSync(output, "utf8"), "");
    assert.equal(statSync(output).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration app rotate-secret requires an output before POST and private sinks fail closed on win32", async () => {
  let postCount = 0;
  const ctx = createCommandContext({
    io: memoryIo().io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => {
        postCount += 1;
        return { ok: false, status: 500, error: "must not be called", data: null };
      },
    }) as any,
  });

  await assert.rejects(
    async () => integrationAppRotateSecretCommand.handler(ctx, { client: "demo-app" }),
    /--output <new-private-path> is required/,
  );
  assert.equal(postCount, 0);
  assert.throws(
    () => preparePrivateSecretSink("unused-secret-path", "win32"),
    /private app-secret file permissions are not supported on win32/,
  );
});

test("integration app update and transfer-owner call owner-or-admin direct routes", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        if (path.endsWith("/update")) {
          return {
            ok: true,
            status: 200,
            error: null,
            data: {
              clientId: "client-1",
              clientKey: "demo-app",
              clientName: "Demo App 2",
              updatedFields: ["name", "category"],
              client_secret: "update_text_alias_must_not_render",
              credentials: { clientSecret: "update_text_nested_must_not_render" },
              unknownTopLevel: "update_text_unknown_must_not_render",
            },
          };
        }
        return { ok: true, status: 200, error: null, data: { clientId: "client-1", clientKey: "demo-app", clientName: "Demo App 2", ownerAgentId: "agent-2", ownerAgentName: "box", ownershipOutcome: "transferred", auditEventId: "11111111-1111-4111-8111-111111111112" } };
      },
    }) as any,
  });

  await integrationAppUpdateCommand.handler(ctx, { client: "demo-app", name: "Demo App 2", category: "Storage" });
  await integrationAppTransferOwnerCommand.handler(ctx, { client: "demo-app", toAgent: "box" });
  await assert.rejects(
    async () => integrationAppUpdateCommand.handler(ctx, { client: "demo-app", redirectUrl: "" }),
    /OAuth apps must keep a registered callback URL/,
  );
  await assert.rejects(
    async () => integrationAppUpdateCommand.handler(ctx, { client: "demo-app", category: "Automation" }),
    /--category must be one of: AI & Automation/,
  );

  assert.deepEqual(requests, [
    {
      method: "POST",
      path: "/internal/agent-api/integrations/app/update",
      body: {
        clientKey: "demo-app",
        name: "Demo App 2",
        description: undefined,
        category: "Infrastructure",
        homepageUrl: undefined,
        returnUrl: undefined,
        agentManifestUrl: undefined,
        scopes: undefined,
        unsafeDemoUrlOverride: false,
      },
    },
    {
      method: "POST",
      path: "/internal/agent-api/integrations/app/transfer-owner",
      body: { clientKey: "demo-app", targetAgent: "box" },
    },
  ]);
  assert.match(stdout.join(""), /audit event: 11111111-1111-4111-8111-111111111112/);
  assert.match(stdout.join(""), /updated: name, category/);
  assert.match(stdout.join(""), /transferred to @box/);
  assert.doesNotMatch(stdout.join(""), /update_text_alias_must_not_render|update_text_nested_must_not_render|update_text_unknown_must_not_render/);
});

test("integration app update JSON emits only the fixed mutation receipt", async () => {
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          clientId: "client-1",
          clientKey: "demo-app",
          clientName: "Demo App 2",
          updatedFields: ["returnUrl"],
          client_secret: "update_json_alias_must_not_render",
          credentials: { clientSecret: "update_json_nested_must_not_render" },
          unknownTopLevel: "update_json_unknown_must_not_render",
        },
      }),
    }) as any,
  });

  await integrationAppUpdateCommand.handler(ctx, {
    client: "demo-app",
    redirectUrl: "https://demo.example/auth/raft/callback",
    json: true,
  });

  const wire = stdout.join("");
  assert.doesNotMatch(wire, /update_json_alias_must_not_render|update_json_nested_must_not_render|update_json_unknown_must_not_render/);
  assert.deepEqual(JSON.parse(wire), {
    ok: true,
    data: {
      clientId: "client-1",
      clientKey: "demo-app",
      clientName: "Demo App 2",
      updatedFields: ["returnUrl"],
    },
  });
});

test("integration app transfer-owner JSON emits a fixed audited no-op receipt", async () => {
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          clientId: "client-1",
          clientKey: "demo-app",
          clientName: "Demo App",
          ownerAgentId: "agent-2",
          ownerAgentName: "box",
          ownershipOutcome: "already_owner",
          auditEventId: "11111111-1111-4111-8111-111111111112",
          unknownTopLevel: "must-not-enter-transfer-receipt",
          credentials: { clientSecret: "must-not-enter-transfer-receipt" },
        },
      }),
    }) as any,
  });

  await integrationAppTransferOwnerCommand.handler(ctx, { client: "demo-app", toAgent: "box", json: true });
  const wire = stdout.join("");
  assert.doesNotMatch(wire, /must-not-enter-transfer-receipt/);
  assert.deepEqual(JSON.parse(wire), {
    ok: true,
    data: {
      clientId: "client-1",
      clientKey: "demo-app",
      clientName: "Demo App",
      ownerAgentId: "agent-2",
      ownerAgentName: "box",
      ownershipOutcome: "already_owner",
      auditEventId: "11111111-1111-4111-8111-111111111112",
    },
  });
});

test("integration app distribution commands use the shared manage route without replaying share tokens", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        const action = (body as { action: string }).action;
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            action,
            clientId: "client-1",
            clientKey: "demo-app",
            clientName: "Demo App",
            publishStatus: action === "request_publish"
              ? "publish_requested"
              : action === "request_unpublish" ? "unpublish_requested" : undefined,
            logoUrl: action === "clear_logo" ? null : undefined,
            shareUrl: action === "share_link_create"
              ? "https://raft.example/integration-invite/raft_share_show_once"
              : undefined,
            link: action.startsWith("share_link")
              ? {
                id: "link-1",
                expiresAt: "2026-08-01T00:00:00.000Z",
                revokedAt: action === "share_link_revoke" ? "2026-07-23T00:00:00.000Z" : null,
                lastUsedAt: null,
                createdAt: "2026-07-23T00:00:00.000Z",
                updatedAt: "2026-07-23T00:00:00.000Z",
              }
              : undefined,
          },
        };
      },
    }) as any,
  });

  await integrationAppShareLinkCreateCommand.handler(ctx, { client: "demo-app", expiresDays: "7" });
  await integrationAppShareLinkStatusCommand.handler(ctx, { client: "demo-app" });
  await integrationAppShareLinkRevokeCommand.handler(ctx, { client: "demo-app" });
  await integrationAppRequestPublishCommand.handler(ctx, { client: "demo-app" });
  await integrationAppRequestUnpublishCommand.handler(ctx, { client: "demo-app" });
  await integrationAppClearLogoCommand.handler(ctx, { client: "demo-app" });
  await integrationAppDeleteCommand.handler(ctx, { client: "demo-app" });

  assert.deepEqual(requests.map((request) => request.path), Array(7).fill("/internal/agent-api/integrations/app/manage"));
  assert.deepEqual(requests.map((request) => request.body), [
    { clientKey: "demo-app", action: "share_link_create", expiresInDays: 7 },
    { clientKey: "demo-app", action: "share_link_get", expiresInDays: undefined },
    { clientKey: "demo-app", action: "share_link_revoke", expiresInDays: undefined },
    { clientKey: "demo-app", action: "request_publish", expiresInDays: undefined },
    { clientKey: "demo-app", action: "request_unpublish", expiresInDays: undefined },
    { clientKey: "demo-app", action: "clear_logo", expiresInDays: undefined },
    { clientKey: "demo-app", action: "delete", expiresInDays: undefined },
  ]);
  const rendered = stdout.join("");
  assert.match(rendered, /credential-like token/);
  assert.match(rendered, /https:\/\/raft\.example\/integration-invite\/raft_share_show_once/);
  assert.match(rendered, /regenerate it to receive a usable URL/);
  assert.match(rendered, /Marketplace review requested/);
  assert.match(rendered, /Marketplace removal requested/);
});

test("integration app share-link fails closed when the one-time URL is missing", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          action: "share_link_create",
          clientId: "client-1",
          clientKey: "demo-app",
          clientName: "Demo App",
          link: null,
        },
      }),
    }) as any,
  });

  await assert.rejects(
    async () => integrationAppShareLinkCreateCommand.handler(ctx, { client: "demo-app" }),
    /one-time private share URL/,
  );
});

test("integration app logo uploads multipart bytes to the dedicated route", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raft-app-logo-"));
  const filePath = join(directory, "logo.gif");
  writeFileSync(filePath, Buffer.from(
    "R0lGODdhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=",
    "base64",
  ));
  try {
    const { io, stdout } = memoryIo();
    const multipartRequests: Array<{
      method: string;
      path: string;
      clientKey: FormDataEntryValue | null;
      hasAvatar: boolean;
    }> = [];
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => agentContext,
      createApiClient: () => ({
        requestMultipart: async <T>(method: string, path: string, form: FormData): Promise<ApiResponse<T>> => {
          multipartRequests.push({
            method,
            path,
            clientKey: form.get("clientKey"),
            hasAvatar: form.get("avatar") instanceof Blob,
          });
          return {
            ok: true,
            status: 200,
            error: null,
            data: {
              clientId: "client-1",
              clientKey: "demo-app",
              clientName: "Demo App",
              logoUrl: "/api/integration-logos/client-1/logo.webp",
            } as T,
          };
        },
      }) as any,
    });

    await integrationAppLogoCommand.handler(ctx, { client: "demo-app", file: filePath });

    assert.deepEqual(multipartRequests, [{
      method: "POST",
      path: "/internal/agent-api/integrations/app/logo",
      clientKey: "demo-app",
      hasAvatar: true,
    }]);
    assert.match(stdout.join(""), /App logo updated for Demo App/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("integration app prepare recover-owner creates an admin-only recovery card", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        return { ok: true, status: 201, error: null, data: { messageId: "recovery-card-1", metadata: { kind: "action-card", state: "prepared" } } };
      },
    }) as any,
  });

  await integrationAppPrepareRecoverOwnerCommand.handler(ctx, {
    client: "demo-app",
    toAgent: "box",
    target: "#proj-auth",
  });

  assert.equal(requests[0]?.path, "/internal/agent-api/prepare-action");
  assert.deepEqual(requests[0]?.body, {
    target: "#proj-auth",
    action: {
      type: "integration:recover_app_owner",
      clientKey: "demo-app",
      targetAgent: "box",
      draftHint: "Admin recovery for orphaned or retired-owner app demo-app. Execution must fail while an active owner exists.",
    },
  });
  assert.match(stdout.join(""), /Admin recovery card prepared/);
});
