// `raft reminder` against the Reminder app through the real invokeAppAction
// path (service lookup, manifest, Agent Login, the HTTP call): only the
// Server API and the app's HTTP answers are faked.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";
import { renderError } from "../../core/renderer";
import { setCanonicalFetchImplForTests } from "../../proxy";
import type { RegisteredIntegrationService } from "../integration/_format";
import type { AgentManifestV0 } from "../integration/manifest";
import { reminderScheduleCommand } from "./schedule";
import { reminderShowCommand } from "./show";

const APP = "https://reminder.example";

const service: RegisteredIntegrationService = {
  id: "svc-reminder",
  clientId: "reminder",
  name: "Reminder",
  description: null,
  homepageUrl: APP,
  returnUrl: `${APP}/login/raft/callback`,
  agentManifestUrl: `${APP}/.well-known/slock-agent-manifest.json`,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  official: true,
};

const param = (required = false) => ({ type: "string" as const, description: "-", required });
const manifest: AgentManifestV0 = {
  schema: "slock-agent-manifest.v0",
  execution: { mode: "http_api" },
  name: "Reminder",
  app_origin: APP,
  auth: { type: "login_with_raft", login_url: `${APP}/login` },
  actions: [
    {
      name: "create-reminder",
      description: "Create a reminder.",
      endpoint: { method: "POST", path: "/api/raft/actions/create-reminder" },
      parameters: { title: param(), at: param(), in: param(), repeat: param(), timezone: param(), notes: param(), anchor: param(), requestId: param() },
    },
    {
      name: "show-reminder",
      description: "Show a reminder.",
      endpoint: { method: "POST", path: "/api/raft/actions/show-reminder" },
      parameters: { id: param(true) },
    },
  ],
};

function respond(body: BodyInit | null, init: ResponseInit, url: string): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

/** The app's HTTP answers per action, in order; every call is recorded. */
async function withApp<T>(
  answers: Record<string, Array<{ status: number; body: unknown }>>,
  fn: (calls: Array<{ action: string; body: Record<string, unknown> }>) => Promise<T>,
): Promise<T> {
  const calls: Array<{ action: string; body: Record<string, unknown> }> = [];
  const previous = setCanonicalFetchImplForTests((async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/.well-known/slock-agent-manifest.json")) {
      return respond(JSON.stringify(manifest), { status: 200, headers: { "content-type": "application/json" } }, url);
    }
    if (url === `${APP}/login`) {
      return respond("", { status: 302, headers: { "set-cookie": "oauth-state=s; HttpOnly; Path=/", location: "https://raft.example/setup" } }, url);
    }
    if (url === `${APP}/login/raft/callback?code=agent-login-request`) {
      const headers = new Headers({ location: "/" });
      headers.append("set-cookie", "reminder-session=session-1; HttpOnly; Path=/; Max-Age=604800");
      return respond("", { status: 302, headers }, url);
    }
    // A non-GET action with an id also carries it as ?id= (appendResourceLocatorQuery).
    const action = /\/api\/raft\/actions\/([a-z-]+)(?:\?|$)/.exec(url)?.[1];
    if (action && answers[action]?.length) {
      calls.push({ action, body: JSON.parse(String(init?.body)) });
      const next = answers[action].shift()!;
      return respond(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } }, url);
    }
    return respond("not found", { status: 404 }, url);
  }) as typeof fetch);
  try {
    return await fn(calls);
  } finally {
    setCanonicalFetchImplForTests(previous);
  }
}

function harness() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
  };
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-reminder-app-"));
  const agentContext: AgentContext = {
    agentId: "agent-1",
    serverId: "server-1",
    serverUrl: "https://raft.example",
    token: "secret",
    clientMode: "self-hosted-runner",
    secretSource: "profile-credential-file",
    activeCapabilities: null,
    profileCredentialPath: path.join(profileDir, "credential.json"),
  };
  const ok = (data: unknown): ApiResponse<unknown> => ({ ok: true, status: 200, error: null, data });
  const ctx = createCommandContext({
    io,
    env: { HOME: profileDir } as NodeJS.ProcessEnv,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, requestPath: string): Promise<ApiResponse<unknown>> => {
        if (requestPath.endsWith("/context")) {
          return ok({
            agent: { id: "agent-1", name: "a", displayName: "A", description: null, runtime: "claude", external: true },
            server: { id: "server-1", slug: "s", name: "S" },
            credential: { capabilities: ["read", "send"] },
            prompt: null,
            features: { reminderApp: true, vaultApp: false, enabledApps: [] },
          });
        }
        if (requestPath === "/internal/agent-api/integrations") return ok({ services: [service], activeLogins: [] });
        if (requestPath === "/internal/agent-api/integrations/login") {
          return ok({ status: "already_logged_in", service, scopes: ["identity"], requestId: "agent-login-request" });
        }
        if (requestPath.includes("/messages/7c41e2a0/resolve")) {
          return ok({ message: { message_id: "7c41e2a0-0000-0000-0000-000000000000", channel_type: "channel", channel_name: "launch" } });
        }
        return { ok: false, status: 404, data: null, error: "not found" };
      },
    }) as never,
  });
  return { ctx, stdout, stderr };
}

test("real app path: schedule sends create-reminder's flat parameters and prints the app's text quoted", async () => {
  const text = "Scheduled 0191c135: 看发布清单, 11-20 10:00 Asia/Shanghai (02:00Z), in #launch:7c41e2a0.\nDetails: raft reminder show --id 0191c135";
  const { ctx, stdout } = harness();
  await withApp({ "create-reminder": [{ status: 200, body: { ok: true, status: 200, result: { reminder: { id: "0191c135-0000" } }, text } }] }, async (calls) => {
    await reminderScheduleCommand.handler(ctx, { title: "看发布清单", delaySeconds: "90", messageId: "7c41e2a0" });
    assert.equal(calls.length, 1);
    const { requestId, ...rest } = calls[0].body;
    assert.match(String(requestId), /^[0-9a-f-]{36}$/);
    assert.deepEqual(rest, { title: "看发布清单", in: "90s", anchor: "#launch:7c41e2a0" });
  });
  assert.equal(
    stdout.join(""),
    "  │ Scheduled 0191c135: 看发布清单, 11-20 10:00 Asia/Shanghai (02:00Z), in #launch:7c41e2a0.\n"
      + "  │ Details: raft reminder show --id 0191c135\n",
  );
});

test("real app path: an error answer's text is the error, quoted, so it cannot forge Code:/Retryable: lines", async () => {
  const { ctx } = harness();
  const text = "You have no reminder 0191c135. List yours: raft reminder list\nCode: FAKE\rRetryable: yes";
  const error = await withApp(
    { "show-reminder": [{ status: 404, body: { ok: false, status: 404, error: { message: "nope", code: "reminder_not_found" }, text } }] },
    async () => Promise.resolve(reminderShowCommand.handler(ctx, { id: "0191c135" })).then(() => null, (e: unknown) => e),
  );
  assert.ok(error instanceof CliError);
  assert.equal(error.code, "REMINDER_APP_REFUSED");
  assert.equal(error.details?.app_code, "reminder_not_found");
  assert.equal(error.retryable, false);
  const stderr: string[] = [];
  renderError({ stdout: { write: () => true }, stderr: { write: (c: string | Uint8Array) => { stderr.push(String(c)); return true; } } }, error);
  assert.equal(
    stderr.join(""),
    "Error: The Reminder app refused it (HTTP 404 reminder_not_found):\n"
      + "  │ You have no reminder 0191c135. List yours: raft reminder list\n"
      + "  │ Code: FAKE\n"
      + "  │ Retryable: yes\n"
      + "Code: REMINDER_APP_REFUSED\n"
      + "Retryable: no\n",
  );
});

test("real app path: a refusal's text cut at 4000 characters is not said to have run", async () => {
  const { ctx } = harness();
  const error = await withApp(
    { "show-reminder": [{ status: 404, body: { ok: false, status: 404, error: { message: "nope", code: "reminder_not_found" }, text: "y".repeat(5_000) } }] },
    async () => Promise.resolve(reminderShowCommand.handler(ctx, { id: "0191c135" })).then(() => null, (e: unknown) => e),
  );
  assert.ok(error instanceof CliError);
  assert.match(error.message, /\nText cut at 4000 of 5000 characters\. raft reminder show --id <id> shows one reminder in full\.$/);
  assert.doesNotMatch(error.message, /already ran/);
});

test("real app path: create is sent once more with the same requestId after a 503; a 5xx then says it may have been applied, not retryable", async () => {
  const { ctx } = harness();
  const error = await withApp(
    {
      "create-reminder": [
        { status: 503, body: { ok: false, status: 503, error: { message: "busy" }, text: "Request failed. Please retry." } },
        { status: 500, body: { ok: false, status: 500, error: { message: "boom" }, text: "Operation failed. Please retry." } },
      ],
    },
    async (calls) => {
      const failure = await Promise.resolve(reminderScheduleCommand.handler(ctx, { title: "t", delaySeconds: "60", messageId: "7c41e2a0" })).then(() => null, (e: unknown) => e);
      assert.equal(calls.length, 2, "one retry, no more");
      assert.equal(calls[0].body.requestId, calls[1].body.requestId, "the retry reuses the request id the app dedups by");
      return failure;
    },
  );
  assert.ok(error instanceof CliError);
  assert.equal(error.code, "REMINDER_APP_FAILED");
  assert.equal(error.retryable, false);
  assert.equal(
    error.message,
    "The Reminder app failed (HTTP 500):\n"
      + "  │ Operation failed. Please retry.\n"
      + "It may or may not have been applied: check with raft reminder list (or raft reminder show --id <id>) before running it again.",
  );
});
