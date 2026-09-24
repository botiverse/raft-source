import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentContext } from "../../auth/env.js";
import {
  AgentManifestFetchError,
  buildLocalCliProfileEnv,
  fetchAgentManifest,
  fetchAgentManifestWithWellKnownAliases,
  formatShellExports,
  validateAgentManifestV0,
} from "./manifest.js";

const agentContext: AgentContext = {
  agentId: "agent-123",
  serverId: "server-456",
  serverUrl: "https://slock.example",
  token: "secret",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

function responseWithUrl(body: BodyInit | null, init: ResponseInit, url: string): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

test("validateAgentManifestV0 accepts minimal local CLI per-agent HOME manifest", () => {
  const manifest = validateAgentManifestV0({
    schema: "slock-agent-manifest.v0",
    service: "drive9",
    docs_url: "https://drive9.ai/skill.md",
    execution: {
      mode: "local_cli",
      command: "drive9",
    },
    credential_boundary: {
      storage: "per_agent_home",
      forbid_user_home: true,
    },
    context_check: {
      command: ["drive9", "whoami", "--json"],
      expect: ["server_id", "agent_sub"],
    },
  });

  assert.equal(manifest.execution.mode, "local_cli");
  assert.equal(manifest.execution.command, "drive9");
  assert.ok(manifest.credential_boundary);
  assert.equal(manifest.credential_boundary.storage, "per_agent_home");
});

test("validateAgentManifestV0 accepts manifests without local credential boundary", () => {
  const manifest = validateAgentManifestV0({
    schema: "slock-agent-manifest.v0",
    docs_url: "https://example.com/skill.md",
    execution: {
      mode: "local_cli",
      command: "stateless-cli",
    },
  });

  assert.equal(manifest.execution.mode, "local_cli");
  assert.equal(manifest.execution.command, "stateless-cli");
  assert.equal(manifest.credential_boundary, undefined);
  assert.equal(manifest.context_check, undefined);
});

test("validateAgentManifestV0 ignores unrelated extension fields for backward compatibility", () => {
  const manifest = validateAgentManifestV0({
    schema: "slock-agent-manifest.v0",
    docs_url: "https://example.com/skill.md",
    execution: {
      mode: "local_cli",
      command: "stateless-cli",
    },
    "x-example-extension": {
      owner: "third-party",
      note: "older CLIs ignored unknown extension fields",
    },
  });

  assert.equal(manifest.execution.mode, "local_cli");
  assert.equal(manifest.execution.command, "stateless-cli");
  assert.equal("x-example-extension" in manifest, false);
});

test("validateAgentManifestV0 accepts canonical URL schema for v0 manifests", () => {
  const manifest = validateAgentManifestV0({
    schema: "https://app.slock.ai/schemas/agent-manifest.v0.json",
    docs_url: "https://example.com/skill.md",
    execution: {
      mode: "local_cli",
      command: "stateless-cli",
    },
  });

  assert.equal(manifest.schema, "slock-agent-manifest.v0");
  assert.equal(manifest.execution.mode, "local_cli");
  assert.equal(manifest.execution.command, "stateless-cli");
});

test("validateAgentManifestV0 accepts Raft-branded schema alias for v0 manifests", () => {
  const manifest = validateAgentManifestV0({
    schema: "raft-agent-manifest.v0",
    docs_url: "https://example.com/skill.md",
    execution: {
      mode: "local_cli",
      command: "stateless-cli",
    },
  });

  assert.equal(manifest.schema, "slock-agent-manifest.v0");
  assert.equal(manifest.execution.mode, "local_cli");
  assert.equal(manifest.execution.command, "stateless-cli");
});

test("validateAgentManifestV0 accepts manifests without docs_url", () => {
  const manifest = validateAgentManifestV0({
    schema: "slock-agent-manifest.v0",
    execution: {
      mode: "http_api",
      base_url: "https://api.example.com",
    },
  });

  assert.equal(manifest.docs_url, undefined);
  assert.equal(manifest.execution.mode, "http_api");
  assert.equal(manifest.execution.base_url, "https://api.example.com/");
});

test("validateAgentManifestV0 accepts login_with_raft HTTP API actions", () => {
  const manifest = validateAgentManifestV0({
    schema: "slock-agent-manifest.v0",
    name: "Botiverse PR Diff Viewer",
    app_origin: "https://pr-diff-viewer.botiverse.workers.dev",
    execution: { mode: "http_api" },
    auth: {
      type: "login_with_raft",
      login_url: "https://pr-diff-viewer.botiverse.workers.dev/login",
    },
    actions: [{
      name: "render-patch",
      description: "Upload a raw unified diff patch and return a shareable viewer URL.",
      endpoint: { method: "post", path: "/api/render-patch" },
      parameters: {
        patchText: { type: "string", description: "Raw unified diff text to render", required: true },
        author: { type: "string", description: "Agent or user author" },
      },
      returns: {
        viewerUrl: { type: "string", description: "Shareable URL" },
      },
    }],
  });

  assert.equal(manifest.execution.mode, "http_api");
  assert.equal(manifest.app_origin, "https://pr-diff-viewer.botiverse.workers.dev/");
  assert.equal(manifest.auth?.type, "login_with_raft");
  assert.equal(manifest.actions?.[0]?.name, "render-patch");
  assert.equal(manifest.actions?.[0]?.endpoint.method, "POST");
  assert.equal(manifest.actions?.[0]?.parameters?.patchText.required, true);
});

test("validateAgentManifestV0 accepts file response declarations on HTTP API actions", () => {
  const manifest = validateAgentManifestV0({
    schema: "slock-agent-manifest.v0",
    execution: { mode: "http_api" },
    actions: [{
      name: "download_feedback_transcript",
      endpoint: { method: "GET", path: "/api/feedback/transcript" },
      response: { type: "file", contentType: "application/gzip", description: "gzip transcript" },
    }],
  });

  assert.equal(manifest.actions?.[0]?.response?.type, "file");
  assert.equal(manifest.actions?.[0]?.response?.contentType, "application/gzip");
});

test("validateAgentManifestV0 rejects unknown response types", () => {
  assert.throws(
    () => validateAgentManifestV0({
      schema: "slock-agent-manifest.v0",
      execution: { mode: "http_api" },
      actions: [{
        name: "bad",
        endpoint: { method: "GET", path: "/api/bad" },
        response: { type: "stream" },
      }],
    }),
    /response.type must be file/,
  );
});

test("validateAgentManifestV0 accepts file response maxBytes", () => {
  const manifest = validateAgentManifestV0({
    schema: "slock-agent-manifest.v0",
    execution: { mode: "http_api" },
    actions: [{
      name: "download_feedback_transcript",
      endpoint: { method: "GET", path: "/api/feedback/transcript" },
      response: { type: "file", maxBytes: 1024 },
    }],
  });

  assert.equal(manifest.actions?.[0]?.response?.maxBytes, 1024);
});

test("validateAgentManifestV0 rejects invalid file response maxBytes", () => {
  assert.throws(
    () => validateAgentManifestV0({
      schema: "slock-agent-manifest.v0",
      execution: { mode: "http_api" },
      actions: [{
        name: "bad",
        endpoint: { method: "GET", path: "/api/bad" },
        response: { type: "file", maxBytes: -1 },
      }],
    }),
    /actions\[\]\.response\.maxBytes must be a positive integer/,
  );

  assert.throws(
    () => validateAgentManifestV0({
      schema: "slock-agent-manifest.v0",
      execution: { mode: "http_api" },
      actions: [{
        name: "bad",
        endpoint: { method: "GET", path: "/api/bad" },
        response: { type: "file", maxBytes: "1024" },
      }],
    }),
    /actions\[\]\.response\.maxBytes must be a positive integer/,
  );
});

test("validateAgentManifestV0 rejects file response declarations on local_cli actions", () => {
  assert.throws(
    () => validateAgentManifestV0({
      schema: "slock-agent-manifest.v0",
      execution: { mode: "local_cli", command: "drive9" },
      actions: [{
        name: "download",
        endpoint: { method: "GET", path: "/api/download" },
        response: { type: "file" },
      }],
    }),
    /actions\[\]\.response is only supported for execution\.mode=http_api/,
  );
});

test("fetchAgentManifestWithWellKnownAliases falls back from Raft to legacy Slock well-known path", async () => {
  const calls: string[] = [];
  const manifest = await fetchAgentManifestWithWellKnownAliases(
    "https://example.com/.well-known/raft-agent-manifest.json",
    async (url) => {
      calls.push(url);
      if (url.endsWith("/.well-known/raft-agent-manifest.json")) {
        throw new AgentManifestFetchError("manifest fetch failed with HTTP 404", 404);
      }
      return validateAgentManifestV0({
        schema: "slock-agent-manifest.v0",
        execution: { mode: "http_api" },
      });
    },
  );

  assert.deepEqual(calls, [
    "https://example.com/.well-known/raft-agent-manifest.json",
    "https://example.com/.well-known/slock-agent-manifest.json",
  ]);
  assert.equal(manifest.execution.mode, "http_api");
});

test("fetchAgentManifest attaches the canonical dispatcher for an HTTPS proxy route", async () => {
  const previousFetch = globalThis.fetch;
  let dispatcherObserved = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    dispatcherObserved = Boolean((init as RequestInit & { dispatcher?: unknown } | undefined)?.dispatcher);
    const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    return responseWithUrl(JSON.stringify({
      schema: "slock-agent-manifest.v0",
      execution: { mode: "http_api" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }, url);
  }) as typeof fetch;
  try {
    const result = await fetchAgentManifest(
      "https://proxy-only.example/.well-known/raft-agent-manifest.json",
      { HTTPS_PROXY: "http://127.0.0.1:43191" },
    );
    assert.equal(result.execution.mode, "http_api");
    assert.equal(dispatcherObserved, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("fetchAgentManifest preserves the actual credential-free URL and bounded HTTP cause", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    return responseWithUrl("temporarily unavailable", {
      status: 503,
      headers: {
        "content-type": "text/plain",
        "retry-after": "30",
      },
    }, url);
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => fetchAgentManifest("https://manifest.example/.well-known/raft-agent-manifest.json", {}),
      (error: unknown) => {
        assert.ok(error instanceof AgentManifestFetchError);
        assert.equal(error.status, 503);
        assert.deepEqual(error.details, {
          contentType: "text/plain",
          retryAfter: "30",
          url: "https://manifest.example/.well-known/raft-agent-manifest.json",
          causeClass: "http",
          causeCode: "HTTP_503",
        });
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("validateAgentManifestV0 rejects unsafe or duplicate HTTP API actions", () => {
  assert.throws(
    () => validateAgentManifestV0({
      schema: "slock-agent-manifest.v0",
      execution: { mode: "http_api" },
      actions: [{
        name: "render-patch",
        endpoint: { method: "POST", path: "https://evil.example/api" },
      }],
    }),
    /must start with \//,
  );

  assert.throws(
    () => validateAgentManifestV0({
      schema: "slock-agent-manifest.v0",
      execution: { mode: "http_api" },
      actions: [
        { name: "render-patch", endpoint: { method: "POST", path: "/api/render-patch" } },
        { name: "render-patch", endpoint: { method: "POST", path: "/api/other" } },
      ],
    }),
    /duplicate action name/,
  );
});

test("validateAgentManifestV0 validates docs_url when present", () => {
  assert.throws(
    () => validateAgentManifestV0({
      schema: "slock-agent-manifest.v0",
      docs_url: "https://user:pass@example.com/docs",
      execution: { mode: "http_api" },
    }),
    /docs_url must not include credentials/,
  );
});

test("validateAgentManifestV0 rejects command paths and shell fragments", () => {
  for (const command of ["/usr/bin/drive9", "drive9 --danger"]) {
    assert.throws(
      () => validateAgentManifestV0({
        schema: "slock-agent-manifest.v0",
        docs_url: "https://drive9.ai/skill.md",
        execution: { mode: "local_cli", command },
        credential_boundary: { storage: "per_agent_home", forbid_user_home: true },
        context_check: {},
      }),
      /bare command name/,
    );
  }
});

test("buildLocalCliProfileEnv derives per-agent HOME and XDG state under SLOCK_HOME", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-env-"));
  const manifest = validateAgentManifestV0({
    schema: "slock-agent-manifest.v0",
    docs_url: "https://drive9.ai/skill.md",
    execution: { mode: "local_cli", command: "drive9" },
    credential_boundary: { storage: "per_agent_home", forbid_user_home: true },
    context_check: {},
  });

  const profile = buildLocalCliProfileEnv({
    ctx: agentContext,
    serviceId: "drive9",
    manifest,
    env: { SLOCK_HOME: tmp } as NodeJS.ProcessEnv,
  });

  assert.equal(profile.command, "drive9");
  assert.equal(
    profile.profileHome,
    path.join(tmp, "integration-profiles", "server-456", "agent-123", "drive9"),
  );
  assert.equal(profile.env.HOME, profile.profileHome);
  assert.equal(profile.env.SLOCK_INTEGRATION_PROFILE_HOME, profile.profileHome);
  assert.equal(profile.env.XDG_CONFIG_HOME, path.join(profile.profileHome, ".config"));
  assert.equal(fs.statSync(profile.profileHome).isDirectory(), true);

  const shell = formatShellExports(profile);
  assert.match(shell, /export HOME='/);
  assert.match(shell, /export XDG_CONFIG_HOME='/);
  assert.match(shell, /Raft does not execute manifest commands/);
});

test("buildLocalCliProfileEnv keeps integration profiles under the canonical Raft home", () => {
  const raftHome = fs.mkdtempSync(path.join(os.tmpdir(), "raft-integration-home-"));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "raft-integration-user-home-"));
  const manifest = validateAgentManifestV0({
    schema: "slock-agent-manifest.v0",
    docs_url: "https://drive9.ai/skill.md",
    execution: { mode: "local_cli", command: "drive9" },
    credential_boundary: { storage: "per_agent_home", forbid_user_home: true },
    context_check: {},
  });

  const viaRaftHome = buildLocalCliProfileEnv({
    ctx: agentContext,
    serviceId: "drive9",
    manifest,
    env: { SLOCK_HOME: "   ", RAFT_HOME: raftHome, HOME: fakeHome } as NodeJS.ProcessEnv,
  });
  assert.equal(
    viaRaftHome.profileHome,
    path.join(raftHome, "integration-profiles", "server-456", "agent-123", "drive9"),
  );

  const viaExpandedHome = buildLocalCliProfileEnv({
    ctx: agentContext,
    serviceId: "drive9",
    manifest,
    env: { SLOCK_HOME: "~/raft-app-state", HOME: fakeHome } as NodeJS.ProcessEnv,
    homeDir: fakeHome,
  });
  assert.equal(
    viaExpandedHome.profileHome,
    path.join(fakeHome, "raft-app-state", "integration-profiles", "server-456", "agent-123", "drive9"),
  );
});

test("buildLocalCliProfileEnv fails closed unless manifest explicitly forbids user HOME", () => {
  const manifest = validateAgentManifestV0({
    schema: "slock-agent-manifest.v0",
    docs_url: "https://drive9.ai/skill.md",
    execution: { mode: "local_cli", command: "drive9" },
    credential_boundary: { storage: "per_agent_home" },
    context_check: {},
  });

  assert.throws(
    () => buildLocalCliProfileEnv({ ctx: agentContext, serviceId: "drive9", manifest }),
    /forbid_user_home=true/,
  );
});

test("buildLocalCliProfileEnv fails closed without per-agent HOME storage", () => {
  const tokenManifest = validateAgentManifestV0({
    schema: "slock-agent-manifest.v0",
    docs_url: "https://api.example/docs",
    execution: { mode: "local_cli", command: "example" },
    credential_boundary: { storage: "slock_managed_token", forbid_user_home: true },
    context_check: {},
  });

  assert.throws(
    () => buildLocalCliProfileEnv({ ctx: agentContext, serviceId: "example", manifest: tokenManifest }),
    /per_agent_home credential storage/,
  );

  const noBoundaryManifest = validateAgentManifestV0({
    schema: "slock-agent-manifest.v0",
    docs_url: "https://drive9.ai/skill.md",
    execution: { mode: "local_cli", command: "drive9" },
    context_check: {},
  });

  assert.throws(
    () => buildLocalCliProfileEnv({ ctx: agentContext, serviceId: "drive9", manifest: noBoundaryManifest }),
    /per_agent_home credential storage/,
  );
});
