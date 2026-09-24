import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CliError } from "../../core/errors.js";
import {
  AttachmentUploadArgError,
  MAX_ATTACHMENT_UPLOAD_BYTES,
  attachmentUploadCommand,
  inferUploadMimeType,
  normalizeExplicitMimeType,
  putFileToPresignedUrl,
  validateUploadFileSize,
} from "./upload.js";

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
            error: "Monthly file upload quota exceeded. Free includes 100 MB of file uploads per month; upgrade to Pro for higher file upload limits.",
            errorCode: "FILE_UPLOAD_QUOTA_EXCEEDED",
            suggestedNextAction: "Ask a server owner to open Settings > Billing and upgrade to Pro: https://app.example.test/s/team/settings/billing",
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
          "Ask a server owner to open Settings > Billing and upgrade to Pro: https://app.example.test/s/team/settings/billing",
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
