import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CliError, CliExit } from "../../core/errors";
import type { CliIo } from "../../core/io";
import { renderError } from "../../core/renderer";
import { buildRaftProgram } from "../../program";
import {
  AttachmentUploadArgError,
  MAX_ATTACHMENT_UPLOAD_BYTES,
  attachmentUploadCommand,
  inferUploadMimeType,
  normalizeExplicitMimeType,
  putFileToPresignedUrl,
  validateUploadFileSize,
} from "./upload";
import { globalFetchJsonTransport, setJsonTransportForTests } from "../../client";
import { ATTACHMENT_UPLOAD_MAX_SIZE_BYTES, formatAttachmentPreferArtifactHold } from "@botiverse/raft-shared/src/agentCliSurface";
import { afterAll, afterEach, beforeEach } from "vitest";
// These tests stub globalThis.fetch; route the client's JSON transport (node:http
// in production) through it.
let previousJsonTransport: ReturnType<typeof setJsonTransportForTests>;
beforeEach(() => { previousJsonTransport = setJsonTransportForTests(globalFetchJsonTransport); });
afterEach(() => { setJsonTransportForTests(previousJsonTransport); });

test("inferUploadMimeType detects images from magic bytes without an extension", () => {
  const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  assert.equal(inferUploadMimeType("attachment", pngHeader), "image/png");

  const jpegHeader = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
  assert.equal(inferUploadMimeType("tmpfile", jpegHeader), "image/jpeg");
});

test("inferUploadMimeType falls back to filename and then octet-stream", () => {
  assert.equal(inferUploadMimeType("design.webp", Buffer.from("not-webp")), "image/webp");
  assert.equal(inferUploadMimeType("attachment", Buffer.from("unknown")), "application/octet-stream");
});

test("inferUploadMimeType lets explicit MIME override detection", () => {
  const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  assert.equal(inferUploadMimeType("attachment", pngHeader, "image/svg+xml"), "image/svg+xml");
});

test("normalizeExplicitMimeType validates type/subtype shape", () => {
  assert.equal(normalizeExplicitMimeType(" IMAGE/PNG "), "image/png");
  assert.throws(
    () => normalizeExplicitMimeType("image"),
    (err) => err instanceof AttachmentUploadArgError && err.code === "INVALID_ARG",
  );
});

test("validateUploadFileSize rejects empty attachments before upload", () => {
  assert.throws(
    () => validateUploadFileSize(0),
    (err) => (
      err instanceof AttachmentUploadArgError
      && err.code === "INVALID_ARG"
      && err.message.includes("0-byte")
    ),
  );
});

test("validateUploadFileSize rejects files over 50MB before upload", () => {
  assert.throws(
    () => validateUploadFileSize(MAX_ATTACHMENT_UPLOAD_BYTES + 1),
    (err) => (
      err instanceof AttachmentUploadArgError
      && err.code === "INVALID_ARG"
      && err.message.includes("max upload size is 50.0MB")
    ),
  );
});

test("direct PUT treats a write-once 412 as an already uploaded object", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-attachment-put-412-"));
  const filePath = path.join(dir, "already-uploaded.txt");
  fs.writeFileSync(filePath, "hello");
  try {
    let calls = 0;
    const result = await putFileToPresignedUrl(
      filePath,
      5,
      "https://r2.example.test/presigned-secret",
      { "Content-Type": "text/plain", "If-None-Match": "*" },
      (async () => {
        calls += 1;
        return new Response(null, { status: 412 });
      }) as typeof fetch,
    );
    assert.equal(result, "already_exists");
    assert.equal(calls, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("direct PUT retries a lost response and recovers through write-once 412", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-attachment-put-lost-response-"));
  const filePath = path.join(dir, "lost-response.txt");
  fs.writeFileSync(filePath, "hello");
  try {
    let calls = 0;
    const result = await putFileToPresignedUrl(
      filePath,
      5,
      "https://r2.example.test/presigned-secret",
      { "Content-Type": "text/plain", "If-None-Match": "*" },
      (async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("response lost after write");
        return new Response(null, { status: 412 });
      }) as typeof fetch,
    );
    assert.equal(result, "already_exists");
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attachment upload preserves server quota error code and next action", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-attachment-upload-"));
  const filePath = path.join(dir, "quota.txt");
  fs.writeFileSync(filePath, "hello");
  try {
    const ctx = {
      io: {
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
      loadAgentContext: () => ({
        agentId: "agent-1",
        token: "sk_agent_test",
        serverUrl: "https://api.example.test",
        clientMode: "self-hosted-runner",
        secretSource: "profile-credential-file",
        activeCapabilities: null,
      }),
      createApiClient: () => ({
        request: async (method: string, pathname: string, body?: unknown) => {
          if (method === "GET" && pathname === "/internal/agent-api/attachment-upload-capabilities") {
            return { ok: true, status: 200, data: { directUploadEnabled: false, directUploadThresholdBytes: null, maxBytes: MAX_ATTACHMENT_UPLOAD_BYTES, sessionExpiresInSeconds: null }, error: null };
          }
          assert.equal(method, "POST");
          assert.equal(pathname, "/internal/agent-api/resolve-channel");
          assert.deepEqual(body, { target: "#general" });
          return {
            ok: true,
            status: 200,
            data: { channelId: "channel-1" },
            error: null,
          };
        },
        requestMultipart: async (_method: string, pathname: string, form: FormData) => {
          assert.equal(_method, "POST");
          assert.equal(pathname, "/internal/agent-api/upload");
          assert.ok(form.get("file") instanceof Blob);
          assert.equal(form.get("channelId"), "channel-1");
          return {
            ok: false,
            status: 403,
            data: null,
            error: "Monthly file upload quota exceeded. Free includes 100 MB of file uploads per month; Pro has no monthly upload limit.",
            errorCode: "FILE_UPLOAD_QUOTA_EXCEEDED",
            suggestedNextAction: "Say in the conversation that the file wasn't uploaded and why. If upgrading to Pro would help the person here, you can suggest that a server owner look at Settings > Plan & billing: https://app.example.test/s/team/settings/billing",
          };
        },
      }),
    };

    await assert.rejects(
      async () => {
        await attachmentUploadCommand.handler(ctx as any, { path: filePath, target: "#general" });
      },
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "FILE_UPLOAD_QUOTA_EXCEEDED");
        assert.match(err.message, /Monthly file upload quota exceeded/);
        assert.equal(
          err.suggestedNextAction,
          "Say in the conversation that the file wasn't uploaded and why. If upgrading to Pro would help the person here, you can suggest that a server owner look at Settings > Plan & billing: https://app.example.test/s/team/settings/billing",
        );
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attachment upload preserves typed proxy timeout diagnostics", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-attachment-upload-timeout-"));
  const filePath = path.join(dir, "slow.apk");
  fs.writeFileSync(filePath, "fixture");
  try {
    const ctx = {
      io: {
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
      loadAgentContext: () => ({
        agentId: "agent-1",
        token: "sk_agent_test",
        serverUrl: "https://api.example.test",
        clientMode: "managed-runner",
        secretSource: "env",
        activeCapabilities: null,
      }),
      createApiClient: () => ({
        request: async (method: string, pathname: string) => method === "GET" && pathname === "/internal/agent-api/attachment-upload-capabilities"
          ? { ok: true, status: 200, data: { directUploadEnabled: false, directUploadThresholdBytes: null, maxBytes: MAX_ATTACHMENT_UPLOAD_BYTES, sessionExpiresInSeconds: null }, error: null }
          : { ok: true, status: 200, data: { channelId: "channel-1" }, error: null },
        requestMultipart: async () => ({
          ok: false,
          status: 502,
          data: null,
          error: "Attachment upload timed out before the server responded",
          errorCode: "ATTACHMENT_UPLOAD_TIMEOUT",
          suggestedNextAction: "Wait briefly, then retry once if needed.",
          proxy: {
            layer: "local_daemon_proxy",
            correlationId: "537b4c407ac1d7ff",
          },
        }),
      }),
    };

    await assert.rejects(
      async () => attachmentUploadCommand.handler(ctx as any, { path: filePath, target: "#general" }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "ATTACHMENT_UPLOAD_TIMEOUT");
        assert.equal(err.layer, "local_daemon_proxy");
        assert.equal(err.correlationId, "537b4c407ac1d7ff");
        assert.equal(err.suggestedNextAction, "Wait briefly, then retry once if needed.");
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attachment upload accepts legacy --channel alias during target transition", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-attachment-upload-alias-"));
  const filePath = path.join(dir, "alias.txt");
  fs.writeFileSync(filePath, "hello");
  try {
    const resolvedTargets: string[] = [];
    const ctx = {
      io: {
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
      loadAgentContext: () => ({
        agentId: "agent-1",
        token: "sk_agent_test",
        serverUrl: "https://api.example.test",
        clientMode: "self-hosted-runner",
        secretSource: "profile-credential-file",
        activeCapabilities: null,
      }),
      createApiClient: () => ({
        request: async (_method: string, _pathname: string, body?: unknown) => {
          if (_method === "GET" && _pathname === "/internal/agent-api/attachment-upload-capabilities") {
            return { ok: true, status: 200, data: { directUploadEnabled: false, directUploadThresholdBytes: null, maxBytes: MAX_ATTACHMENT_UPLOAD_BYTES, sessionExpiresInSeconds: null }, error: null };
          }
          resolvedTargets.push((body as { target: string }).target);
          return {
            ok: true,
            status: 200,
            data: { channelId: "channel-1" },
            error: null,
          };
        },
        requestMultipart: async () => ({
          ok: true,
          status: 200,
          data: { id: "attachment-1", filename: "alias.txt", mimeType: "text/plain", sizeBytes: 5, thumbnailUrl: null },
          error: null,
        }),
      }),
    };

    await attachmentUploadCommand.handler(ctx as any, { path: filePath, channel: "#general" });

    assert.deepEqual(resolvedTargets, ["#general"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attachment upload falls back to legacy multipart when capabilities are unavailable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-attachment-upload-legacy-capability-"));
  const filePath = path.join(dir, "legacy.txt");
  fs.writeFileSync(filePath, "hello");
  const requests: string[] = [];
  let multipartCalled = false;
  let output = "";
  try {
    const ctx = {
      io: {
        stdout: { write: (value: string) => { output += value; return true; } },
        stderr: { write: () => true },
      },
      loadAgentContext: () => ({
        agentId: "agent-1",
        token: "sk_agent_test",
        serverUrl: "https://legacy.example.test",
        clientMode: "self-hosted-runner",
        secretSource: "profile-credential-file",
        activeCapabilities: null,
      }),
      createApiClient: () => ({
        request: async (method: string, pathname: string, body?: unknown) => {
          requests.push(`${method} ${pathname}`);
          if (method === "GET" && pathname === "/internal/agent-api/attachment-upload-capabilities") {
            return { ok: false, status: 404, data: null, error: "Not found" };
          }
          assert.equal(method, "POST");
          assert.equal(pathname, "/internal/agent-api/resolve-channel");
          assert.deepEqual(body, { target: "#general" });
          return { ok: true, status: 200, data: { channelId: "channel-1" }, error: null };
        },
        requestMultipart: async (method: string, pathname: string, form: FormData) => {
          multipartCalled = true;
          assert.equal(method, "POST");
          assert.equal(pathname, "/internal/agent-api/upload");
          assert.ok(form.get("file") instanceof Blob);
          assert.equal(form.get("channelId"), "channel-1");
          return {
            ok: true,
            status: 200,
            data: { id: "attachment-legacy", filename: "legacy.txt", mimeType: "text/plain", sizeBytes: 5, thumbnailUrl: null },
            error: null,
          };
        },
      }),
    };

    await attachmentUploadCommand.handler(ctx as never, { path: filePath, target: "#general" });

    assert.equal(multipartCalled, true);
    assert.deepEqual(requests, [
      "GET /internal/agent-api/attachment-upload-capabilities",
      "POST /internal/agent-api/resolve-channel",
    ]);
    assert.match(output, /Attachment ID: attachment-legacy/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attachment upload fails closed on non-404 capability errors", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-attachment-upload-capability-error-"));
  const filePath = path.join(dir, "blocked.txt");
  fs.writeFileSync(filePath, "hello");
  const requests: string[] = [];
  let multipartCalled = false;
  try {
    const ctx = {
      io: {
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
      loadAgentContext: () => ({
        agentId: "agent-1",
        token: "sk_agent_test",
        serverUrl: "https://api.example.test",
        clientMode: "self-hosted-runner",
        secretSource: "profile-credential-file",
        activeCapabilities: null,
      }),
      createApiClient: () => ({
        request: async (method: string, pathname: string) => {
          requests.push(`${method} ${pathname}`);
          assert.equal(method, "GET");
          assert.equal(pathname, "/internal/agent-api/attachment-upload-capabilities");
          return { ok: false, status: 400, data: null, error: "Capability request rejected" };
        },
        requestMultipart: async () => {
          multipartCalled = true;
          throw new Error("multipart fallback must not run");
        },
      }),
    };

    await assert.rejects(
      async () => attachmentUploadCommand.handler(ctx as never, { path: filePath, target: "#general" }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "UPLOAD_CAPABILITY_FAILED");
        assert.match(err.message, /Capability request rejected/);
        return true;
      },
    );
    assert.deepEqual(requests, ["GET /internal/agent-api/attachment-upload-capabilities"]);
    assert.equal(multipartCalled, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attachment upload completes once after a lost PUT response recovers as 412", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-attachment-upload-direct-"));
  const filePath = path.join(dir, "large.txt");
  fs.writeFileSync(filePath, "hello");
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; pathname: string; body: unknown }> = [];
  let multipartCalled = false;
  let putAttempts = 0;
  let output = "";
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      putAttempts += 1;
      assert.equal(String(input), "https://r2.example.test/presigned-secret");
      assert.equal(init?.method, "PUT");
      assert.deepEqual(init?.headers, {
        "Content-Type": "text/plain",
        "If-None-Match": "*",
        "Content-Length": "5",
      });
      assert.ok(init?.body);
      if (putAttempts === 1) throw new TypeError("response lost after object storage committed the PUT");
      return new Response(null, { status: 412 });
    }) as typeof fetch;

    const ctx = {
      io: {
        stdout: { write: (value: string) => { output += value; return true; } },
        stderr: { write: () => true },
      },
      loadAgentContext: () => ({
        agentId: "agent-1",
        token: "sk_agent_test",
        serverUrl: "https://api.example.test",
        clientMode: "self-hosted-runner",
        secretSource: "profile-credential-file",
        activeCapabilities: null,
      }),
      createApiClient: () => ({
        request: async (method: string, pathname: string, body?: unknown) => {
          requests.push({ method, pathname, body });
          if (pathname === "/internal/agent-api/attachment-upload-capabilities") {
            return { ok: true, status: 200, data: { directUploadEnabled: true, directUploadThresholdBytes: 1, maxBytes: 200 * 1024 * 1024, sessionExpiresInSeconds: 900 }, error: null };
          }
          if (pathname === "/internal/agent-api/resolve-channel") {
            return { ok: true, status: 200, data: { channelId: "11111111-1111-4111-8111-111111111111" }, error: null };
          }
          if (pathname === "/internal/agent-api/attachment-upload-sessions") {
            return { ok: true, status: 201, data: { uploadId: "33333333-3333-4333-8333-333333333333", attachmentId: "44444444-4444-4444-8444-444444444444", state: "pending", expiresAt: "2026-07-27T08:00:00.000Z", upload: { method: "PUT", url: "https://r2.example.test/presigned-secret", headers: { "Content-Type": "text/plain", "If-None-Match": "*" } } }, error: null };
          }
          if (pathname.endsWith("/complete")) {
            return { ok: true, status: 200, data: { uploadId: "33333333-3333-4333-8333-333333333333", state: "completed", attachment: { id: "44444444-4444-4444-8444-444444444444", filename: "large.txt", mimeType: "text/plain", sizeBytes: 5, thumbnailUrl: null } }, error: null };
          }
          throw new Error(`Unexpected request ${method} ${pathname}`);
        },
        requestMultipart: async () => {
          multipartCalled = true;
          throw new Error("multipart fallback must not run");
        },
      }),
    };

    await attachmentUploadCommand.handler(ctx as never, { path: filePath, target: "#general" });
    assert.equal(multipartCalled, false);
    assert.equal(putAttempts, 2);
    assert.deepEqual(requests.map(({ method, pathname }) => `${method} ${pathname}`), [
      "GET /internal/agent-api/attachment-upload-capabilities",
      "POST /internal/agent-api/resolve-channel",
      "POST /internal/agent-api/attachment-upload-sessions",
      "POST /internal/agent-api/attachment-upload-sessions/33333333-3333-4333-8333-333333333333/complete",
    ]);
    assert.match(output, /Attachment ID: 44444444-4444-4444-8444-444444444444/);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A file over the plan's limit that an upload session can still declare is
// declared, so the server can say why it is refused (on Free: how to offer an
// upgrade card); the refusal keeps the CLI's own wording.
function overLimitUploadCtx(sessionResponse: Record<string, unknown> | null, requests: string[]) {
  return {
    io: {
      stdout: { write: (_value: string) => true },
      stderr: { write: () => true },
    },
    loadAgentContext: () => ({
      agentId: "agent-1",
      token: "sk_agent_test",
      serverUrl: "https://api.example.test",
      clientMode: "self-hosted-runner",
      secretSource: "profile-credential-file",
      activeCapabilities: null,
    }),
    createApiClient: () => ({
      request: async (method: string, pathname: string, body?: unknown) => {
        requests.push(`${method} ${pathname}`);
        if (pathname === "/internal/agent-api/attachment-upload-capabilities") {
          return { ok: true, status: 200, data: { directUploadEnabled: false, directUploadThresholdBytes: null, maxBytes: 4, sessionExpiresInSeconds: null }, error: null };
        }
        if (pathname === "/internal/agent-api/resolve-channel") {
          return { ok: true, status: 200, data: { channelId: "11111111-1111-4111-8111-111111111111" }, error: null };
        }
        if (pathname === "/internal/agent-api/attachment-upload-sessions" && sessionResponse) {
          assert.equal((body as { sizeBytes: number }).sizeBytes, 5, "declares the file's size, uploads nothing");
          return sessionResponse;
        }
        if (pathname.endsWith("/complete")) {
          return { ok: true, status: 200, data: { uploadId: "33333333-3333-4333-8333-333333333333", state: "completed", attachment: { id: "44444444-4444-4444-8444-444444444444", filename: "report.txt", mimeType: "text/plain", sizeBytes: 5, thumbnailUrl: null } }, error: null };
        }
        throw new Error(`Unexpected request ${method} ${pathname}`);
      },
      requestMultipart: async () => {
        throw new Error("an over-limit file is never sent");
      },
    }),
  };
}

test("attachment upload declares a file over the plan limit and keeps the server's next action for it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-attachment-upload-over-limit-"));
  const filePath = path.join(dir, "report.txt");
  fs.writeFileSync(filePath, "hello");
  // The server's next action on Free (agentUpgradeCardHint): a sentence, then a heredoc to run as it is.
  const hint = [
    "The file was not uploaded: this server is on the Free plan and the file is over the Free plan's per-file limit. Pro would take it. Say in the conversation that the file wasn't uploaded and why, then offer an upgrade card unless that is clearly out of place here (put what the file is for in place of the <…>):",
    "raft action prepare --target \"#general\" <<'RAFTACTION'",
    "{\"type\":\"plan:upgrade\",\"gate\":\"upload_file_size\",\"reason\":\"<one sentence: what the file is for>\"}",
    "RAFTACTION",
  ].join("\n");
  const requests: string[] = [];
  const stderr: string[] = [];
  try {
    const ctx = overLimitUploadCtx({
      ok: false,
      status: 413,
      data: null,
      error: "Max 50MB per file",
      errorCode: "ATTACHMENT_TOO_LARGE",
      suggestedNextAction: hint,
    }, requests);
    await assert.rejects(
      async () => { await attachmentUploadCommand.handler(ctx as never, { path: filePath, target: "#general" }); },
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "INVALID_ARG");
        assert.equal(err.message, "--path is 5B; max upload size is 4B");
        assert.equal(err.suggestedNextAction, hint);
        renderError({ stdout: { write: () => true }, stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } } }, err);
        return true;
      },
    );
    assert.deepEqual(requests, [
      "GET /internal/agent-api/attachment-upload-capabilities",
      "POST /internal/agent-api/resolve-channel",
      "POST /internal/agent-api/attachment-upload-sessions",
    ]);
    // Printed under "Next action:" with the heredoc's lines unindented, so its delimiter closes it when run.
    assert.equal(stderr.join(""), [
      "Error: --path is 5B; max upload size is 4B",
      "Code: INVALID_ARG",
      "Next action: The file was not uploaded: this server is on the Free plan and the file is over the Free plan's per-file limit. Pro would take it. Say in the conversation that the file wasn't uploaded and why, then offer an upgrade card unless that is clearly out of place here (put what the file is for in place of the <…>):",
      "raft action prepare --target \"#general\" <<'RAFTACTION'",
      "{\"type\":\"plan:upgrade\",\"gate\":\"upload_file_size\",\"reason\":\"<one sentence: what the file is for>\"}",
      "RAFTACTION",
      "",
    ].join("\n"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attachment upload refuses an over-limit file as before when the server does not explain it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-attachment-upload-over-limit-old-"));
  const filePath = path.join(dir, "report.txt");
  fs.writeFileSync(filePath, "hello");
  try {
    // An older server (direct uploads off answer 404 before any size check),
    // or a proxy failure: the local refusal, and only a 413's next action is the file's.
    for (const answer of [
      { ok: false, status: 404, data: null, error: "HTTP 404", errorCode: "UPLOAD_SESSION_NOT_FOUND", suggestedNextAction: "not about this file" },
      { ok: false, status: 502, data: null, error: "proxy failed", errorCode: "agent_proxy_failed" },
    ]) {
      const ctx = overLimitUploadCtx(answer, []);
      await assert.rejects(
        async () => { await attachmentUploadCommand.handler(ctx as never, { path: filePath, target: "#general" }); },
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "INVALID_ARG", `status ${answer.status}`);
          assert.equal(err.message, "--path is 5B; max upload size is 4B");
          assert.equal(err.suggestedNextAction, undefined);
          return true;
        },
      );
    }

    // Larger than any upload session can declare: refused before any request names the conversation.
    fs.truncateSync(filePath, ATTACHMENT_UPLOAD_MAX_SIZE_BYTES + 1);
    const tooLargeForAnyPlan: string[] = [];
    await assert.rejects(
      async () => {
        await attachmentUploadCommand.handler(overLimitUploadCtx(null, tooLargeForAnyPlan) as never, { path: filePath, target: "#general" });
      },
      (err: unknown) => err instanceof CliError && err.code === "INVALID_ARG" && /max upload size is 4B$/.test(err.message),
    );
    assert.deepEqual(tooLargeForAnyPlan, ["GET /internal/agent-api/attachment-upload-capabilities"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attachment upload sends a declared over-limit file through the session the server took", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-attachment-upload-over-limit-taken-"));
  const filePath = path.join(dir, "report.txt");
  fs.writeFileSync(filePath, "hello");
  const originalFetch = globalThis.fetch;
  let puts = 0;
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      puts += 1;
      assert.equal(String(input), "https://r2.example.test/presigned-secret");
      assert.equal(init?.method, "PUT");
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    // The plan changed since the capabilities read (maxBytes 4, direct uploads off): the server takes the file.
    const requests: string[] = [];
    const ctx = overLimitUploadCtx({ ok: true, status: 201, data: { uploadId: "33333333-3333-4333-8333-333333333333", attachmentId: "44444444-4444-4444-8444-444444444444", state: "pending", expiresAt: "2026-07-27T08:00:00.000Z", upload: { method: "PUT", url: "https://r2.example.test/presigned-secret", headers: { "Content-Type": "text/plain", "If-None-Match": "*" } } }, error: null }, requests);
    let output = "";
    ctx.io.stdout.write = (value: string) => { output += value; return true; };
    await attachmentUploadCommand.handler(ctx as never, { path: filePath, target: "#general" });
    assert.equal(puts, 1);
    assert.deepEqual(requests, [
      "GET /internal/agent-api/attachment-upload-capabilities",
      "POST /internal/agent-api/resolve-channel",
      "POST /internal/agent-api/attachment-upload-sessions",
      "POST /internal/agent-api/attachment-upload-sessions/33333333-3333-4333-8333-333333333333/complete",
    ], "one session, never multipart");
    assert.match(output, /Attachment ID: 44444444-4444-4444-8444-444444444444/);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── an HTML or Markdown file uploaded, held once (#347) ──
// Through the real parser, so the held text is the one an agent reads. The
// text itself is asserted once, in shared agentText/artifacts.test.ts
// (formatAttachmentPreferArtifactHold); here, where it lands and what it names.

// The agent ledger these runs keep held uploads in: a temporary one, never the real Raft home.
const UPLOAD_HOLD_LEDGER = fs.mkdtempSync(path.join(os.tmpdir(), "raft-attachment-ledger-"));
afterAll(() => fs.rmSync(UPLOAD_HOLD_LEDGER, { recursive: true, force: true }));

async function runUpload(argv: string[], options: { now?: () => number; stateDir?: string; enabledApps?: string | null } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: string[] = [];
  const io: CliIo = {
    stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
  };
  const program = buildRaftProgram({
    io,
    // Artifacts on, as the daemon says it (RAFT_ENABLED_APPS); null: an older daemon that doesn't say.
    env: { SLOCK_CLI_STATE_DIR: options.stateDir ?? UPLOAD_HOLD_LEDGER, ...(options.enabledApps === null ? {} : { RAFT_ENABLED_APPS: options.enabledApps ?? "artifacts,tasks" }) },
    ...(options.now ? { now: options.now } : {}),
    loadAgentContext: () => ({ agentId: "agent-1", serverUrl: "https://raft.example", serverId: "server-1", token: "secret-token", clientMode: "self-hosted-runner", secretSource: "profile-credential-file", activeCapabilities: null }),
    createApiClient: () => ({
      request: async (method: string, pathname: string) => {
        requests.push(`${method} ${pathname}`);
        if (pathname === "/internal/agent-api/attachment-upload-capabilities") {
          return { ok: true, status: 200, data: { directUploadEnabled: false, directUploadThresholdBytes: null, maxBytes: MAX_ATTACHMENT_UPLOAD_BYTES, sessionExpiresInSeconds: null }, error: null };
        }
        return { ok: true, status: 200, data: { channelId: "channel-1" }, error: null };
      },
      requestMultipart: async (method: string, pathname: string, form: FormData) => {
        requests.push(`${method} ${pathname}`);
        const file = form.get("file") as File;
        return { ok: true, status: 200, data: { id: "attachment-1", filename: file.name, mimeType: file.type, sizeBytes: file.size, thumbnailUrl: null }, error: null };
      },
    }) as any,
  });
  let error: unknown = null;
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (caught) {
    error = caught;
  }
  return { stdout: stdout.join(""), stderr: stderr.join(""), requests, error };
}

const UPLOADED = ["GET /internal/agent-api/attachment-upload-capabilities", "POST /internal/agent-api/resolve-channel", "POST /internal/agent-api/upload"];
const isPreferArtifactHeld = (r: { stderr: string; requests: string[] }) => r.stderr.startsWith("Error: Held — not sent.") && !r.stderr.includes("Code:") && r.requests.length === 0;

test("attachment upload of a Markdown file: held once before any request (exit 1, no code line), copied into a directory of its own and pushed; the same command again uploads it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-attachment-prefer-"));
  const filePath = path.join(dir, "plan.md");
  fs.writeFileSync(filePath, "# Plan\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "other work");
  try {
    const argv = ["attachment", "upload", "--path", filePath, "--target", "#proj-workspace"];
    const held = await runUpload(argv);
    assert.ok(held.error instanceof CliExit && held.error.exitCode === 1, "exits 1");
    assert.deepEqual(held.requests, [], "nothing sent, nothing uploaded");
    assert.equal(held.stdout, "");
    const text = formatAttachmentPreferArtifactHold({ file: "plan.md", target: "#proj-workspace", title: "plan", dir: path.join(dir, "plan"), copyFrom: filePath });
    assert.equal(held.stderr, `Error: ${text.message}\nNext action: ${text.nextAction}\n`);
    assert.ok(held.stderr.includes(`\n  mkdir -p ${dir}/plan && cp ${dir}/plan.md ${dir}/plan/\n  raft artifact push ${dir}/plan --target "#proj-workspace" --title "plan"\n`), held.stderr);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["notes.txt", "plan.md"], "nothing made beside the file");

    const again = await runUpload(argv);
    assert.equal(again.error, null, again.stderr);
    assert.deepEqual(again.requests, UPLOADED, "the same command again uploads it");
    assert.match(again.stdout, /Attachment ID: attachment-1/);

    assert.ok(isPreferArtifactHeld(await runUpload(argv)), "once it went through, the hold is forgotten: held again");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attachment upload of an HTML file alone in its directory: push its directory; with its own <title> no --title; a taken name gets -artifact", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-attachment-prefer-"));
  try {
    const alone = path.join(root, "Q3 plan");
    fs.mkdirSync(alone);
    fs.writeFileSync(path.join(alone, "index.HTML"), "<html><head><title>Q3 plan</title></head><body>x</body></html>");
    fs.writeFileSync(path.join(alone, ".notes"), "hidden files are not pushed");
    const titled = await runUpload(["attachment", "upload", "--path", path.join(alone, "index.HTML"), "--target", "dm:@alice"]);
    assert.ok(isPreferArtifactHeld(titled), titled.stderr);
    const text = formatAttachmentPreferArtifactHold({ file: "index.HTML", target: "dm:@alice", dir: alone });
    assert.equal(titled.stderr, `Error: ${text.message}\nNext action: ${text.nextAction}\n`);
    assert.ok(titled.stderr.includes(`\nNext action: Push its directory:\n  raft artifact push '${alone}' --target "dm:@alice"\nthen post the link it prints.\n`), titled.stderr);

    const shared = path.join(root, "work");
    fs.mkdirSync(path.join(shared, "spec"), { recursive: true });
    fs.writeFileSync(path.join(shared, "spec.htm"), "<p>no title</p>");
    const untitled = await runUpload(["attachment", "upload", "--path", path.join(shared, "spec.htm"), "--target", "#ops"]);
    assert.ok(isPreferArtifactHeld(untitled), untitled.stderr);
    assert.ok(untitled.stderr.includes(`\n  mkdir -p ${shared}/spec-artifact && cp ${shared}/spec.htm ${shared}/spec-artifact/\nCopy the files it loads (images, styles, scripts) into ${shared}/spec-artifact too, then:\n  raft artifact push ${shared}/spec-artifact --target "#ops" --title "spec"\n`), untitled.stderr);

    const pulled = path.join(root, "pulled");
    fs.mkdirSync(pulled);
    fs.writeFileSync(path.join(pulled, "guide.markdown"), "# Guide");
    fs.writeFileSync(path.join(pulled, ".raft-artifact.json"), "{}");
    const inPulled = await runUpload(["attachment", "upload", "--path", path.join(pulled, "guide.markdown"), "--target", "#ops"]);
    assert.ok(inPulled.stderr.includes(`\n  mkdir -p ${pulled}/guide && cp ${pulled}/guide.markdown ${pulled}/guide/\n`), `a pulled artifact's directory is never pushed with --target: ${inPulled.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("attachment upload of an HTML or Markdown file is held again once its content or target changes, or when run again more than 10 minutes later", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-attachment-prefer-"));
  const filePath = path.join(dir, "notes.md");
  let now = Date.parse("2026-11-20T10:00:00.000Z");
  const clock = { now: () => now };
  try {
    fs.writeFileSync(filePath, "# v1");
    const argv = (target = "#ops") => ["attachment", "upload", "--path", filePath, "--target", target];
    assert.ok(isPreferArtifactHeld(await runUpload(argv(), clock)));
    now += 60_000;
    fs.writeFileSync(filePath, "# v2");
    assert.ok(isPreferArtifactHeld(await runUpload(argv(), clock)), "the content changed: held again");
    assert.ok(isPreferArtifactHeld(await runUpload(argv("#other"), clock)), "another target: held");
    now += 10 * 60_000 + 1;
    assert.ok(isPreferArtifactHeld(await runUpload(argv(), clock)), "more than 10 minutes later: held again");
    now += 5 * 60_000;
    const within = await runUpload(argv(), clock);
    assert.equal(within.error, null, within.stderr);
    assert.deepEqual(within.requests, UPLOADED, "the same command within 10 minutes uploads it");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attachment upload never holds a file that is not HTML or Markdown, nor any file when the ledger can't keep the hold", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-attachment-prefer-"));
  try {
    for (const name of ["report.pdf", "chart.png", "log.txt", "data.csv", "page.html.zip", "README"]) {
      fs.writeFileSync(path.join(dir, name), "%PDF-1.4");
      const r = await runUpload(["attachment", "upload", "--path", path.join(dir, name), "--target", "#ops"]);
      assert.equal(r.error, null, `${name}: ${r.stderr}`);
      assert.deepEqual(r.requests, UPLOADED, `${name}: uploaded at once`);
    }
    // The ledger's directory is a file: nothing can be read or written there, so the upload goes through.
    const notADir = path.join(dir, "ledger-is-a-file");
    fs.writeFileSync(notADir, "");
    fs.writeFileSync(path.join(dir, "plan.md"), "# Plan");
    const r = await runUpload(["attachment", "upload", "--path", path.join(dir, "plan.md"), "--target", "#ops"], { stateDir: notADir });
    assert.equal(r.error, null, r.stderr);
    assert.deepEqual(r.requests, UPLOADED, "a store that can't record never holds");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attachment upload holds only where Artifacts is known to be on: off, or unknown (no RAFT_ENABLED_APPS), uploads at once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-attachment-prefer-"));
  try {
    fs.writeFileSync(path.join(dir, "plan.md"), "# Plan");
    const argv = ["attachment", "upload", "--path", path.join(dir, "plan.md"), "--target", "#ops"];
    for (const [enabledApps, why] of [["tasks", "Artifacts off"], ["", "no app on"], [null, "unknown: an older daemon"]] as const) {
      const r = await runUpload(argv, { enabledApps });
      assert.equal(r.error, null, `${why}: ${r.stderr}`);
      assert.deepEqual(r.requests, UPLOADED, `${why}: uploaded at once`);
    }
    assert.ok(isPreferArtifactHeld(await runUpload(argv)), "Artifacts on: held");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attachment upload into a thread pushes into that thread's target; into a task, pushes into the task's conversation and posts the link in the task; a target push can't name is never held", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-attachment-prefer-"));
  try {
    const filePath = path.join(dir, "plan.md");
    fs.writeFileSync(filePath, "# Plan");
    const thread = await runUpload(["attachment", "upload", "--path", filePath, "--target", "#proj-workspace:abcd1234"]);
    assert.ok(isPreferArtifactHeld(thread), thread.stderr);
    const threadText = formatAttachmentPreferArtifactHold({ file: "plan.md", target: "#proj-workspace:abcd1234", title: "plan", dir });
    assert.equal(thread.stderr, `Error: ${threadText.message}\nNext action: ${threadText.nextAction}\n`);
    assert.ok(thread.stderr.includes(`\n  raft artifact push ${dir} --target "#proj-workspace:abcd1234" --title "plan"\nthen post the link it prints.\n`), thread.stderr);

    const task = await runUpload(["attachment", "upload", "--path", filePath, "--target", "#proj-workspace:#7"]);
    assert.ok(isPreferArtifactHeld(task), task.stderr);
    const taskText = formatAttachmentPreferArtifactHold({ file: "plan.md", target: "#proj-workspace", postIn: "#proj-workspace:#7", title: "plan", dir });
    assert.equal(task.stderr, `Error: ${taskText.message}\nNext action: ${taskText.nextAction}\n`);
    assert.ok(task.stderr.includes(`\n  raft artifact push ${dir} --target "#proj-workspace" --title "plan"\nthen post the link it prints in #proj-workspace:#7.\n`), task.stderr);

    const legacyTask = await runUpload(["attachment", "upload", "--path", filePath, "--target", "task #7"]);
    assert.equal(legacyTask.error, null, legacyTask.stderr);
    assert.deepEqual(legacyTask.requests, UPLOADED, "a task ref naming no conversation: uploaded at once");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
