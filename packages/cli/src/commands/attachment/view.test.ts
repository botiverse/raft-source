import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_MESSAGE,
  AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_NEXT_ACTION,
} from "@botiverse/raft-shared";
import type { ApiResponse, BinaryResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import { attachmentViewCommand } from "./view.js";

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
  serverUrl: "https://slock.example",
  serverId: "server-1",
  token: "secret-token",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

test("attachment view command advertises positional id while keeping --id alias", () => {
  assert.deepEqual(attachmentViewCommand.spec.arguments, ["[attachmentId]"]);
  assert.ok(
    attachmentViewCommand.spec.options?.some(
      (option) => option.flags === "--id <attachmentId>",
    ),
  );
});

test("attachment view command uses injected ApiClient and writes file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slock-cli-view-"));
  const outputPath = join(dir, "download.bin");
  const { io, stdout, stderr } = memoryIo();
  const downloads: string[] = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async <T>(): Promise<ApiResponse<T>> => {
        throw new Error("attachment view should use the binary surface method");
      },
      requestBinary: async (method: string, path: string): Promise<BinaryResponse> => {
        downloads.push(`${method} ${path}`);
        return {
          ok: true,
          status: 200,
          body: new Uint8Array([1, 2, 3]),
          error: null,
        };
      },
    }) as any,
  });

  try {
    await attachmentViewCommand.handler(ctx, {
      id: "attachment/with spaces",
      output: outputPath,
    });

    assert.deepEqual(downloads, ["GET /internal/agent-api/attachments/attachment%2Fwith%20spaces"]);
    assert.deepEqual(stderr, []);
    assert.equal(stdout.join(""), `Downloaded to: ${outputPath}\n`);
    assert.deepEqual([...readFileSync(outputPath)], [1, 2, 3]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attachment view command accepts positional attachment id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slock-cli-view-"));
  const outputPath = join(dir, "download.bin");
  const { io, stdout, stderr } = memoryIo();
  const downloads: string[] = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async <T>(): Promise<ApiResponse<T>> => {
        throw new Error("attachment view should use the binary surface method");
      },
      requestBinary: async (method: string, path: string): Promise<BinaryResponse> => {
        downloads.push(`${method} ${path}`);
        return {
          ok: true,
          status: 200,
          body: new Uint8Array([7, 8, 9]),
          error: null,
        };
      },
    }) as any,
  });

  try {
    await attachmentViewCommand.handler(ctx, "attachment/with spaces", {
      output: outputPath,
    });

    assert.deepEqual(downloads, ["GET /internal/agent-api/attachments/attachment%2Fwith%20spaces"]);
    assert.deepEqual(stderr, []);
    assert.equal(stdout.join(""), `Downloaded to: ${outputPath}\n`);
    assert.deepEqual([...readFileSync(outputPath)], [7, 8, 9]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attachment view command maps missing output into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => { await attachmentViewCommand.handler(ctx, { id: "a", output: "" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.equal(err.message, "--output is required");
      return true;
    },
  );
});

test("attachment view command maps missing attachment id into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => { await attachmentViewCommand.handler(ctx, undefined, { output: "unused" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.equal(err.message, "attachment id is required (pass <attachmentId> or --id)");
      return true;
    },
  );
});

test("attachment view command rejects conflicting positional and --id values", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => {
      await attachmentViewCommand.handler(ctx, "positional-id", {
        id: "option-id",
        output: "unused",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.equal(err.message, "pass the attachment id either positionally or with --id, not both");
      return true;
    },
  );
});

test("attachment view command preserves output path literally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slock-cli-view-"));
  const outputPath = join(dir, " spaced file ");
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async <T>(): Promise<ApiResponse<T>> => {
        throw new Error("attachment view should use the binary surface method");
      },
      requestBinary: async (): Promise<BinaryResponse> => ({
        ok: true,
        status: 200,
        body: new Uint8Array([4, 5, 6]),
        error: null,
      }),
    }) as any,
  });

  try {
    await attachmentViewCommand.handler(ctx, {
      id: "attachment-id",
      output: outputPath,
    });

    assert.equal(stdout.join(""), `Downloaded to: ${outputPath}\n`);
    assert.deepEqual([...readFileSync(outputPath)], [4, 5, 6]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attachment view command cloaks all 404 causes and points feedback artifacts to reportId", async () => {
  const cases = [
    { id: "feedback-artifact-id", upstreamError: "Feedback artifact exists" },
    { id: "missing-attachment-id", upstreamError: "Attachment not found" },
    { id: "private-attachment-id", upstreamError: "Attachment exists but is forbidden" },
  ];
  const observed: Array<{ code: string; message: string; nextAction: string | undefined }> = [];

  for (const fixture of cases) {
    const { io } = memoryIo();
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => agentContext,
      createApiClient: () => ({
        request: async <T>(): Promise<ApiResponse<T>> => {
          throw new Error("attachment view should use the binary surface method");
        },
        requestBinary: async (): Promise<BinaryResponse> => ({
          ok: false,
          status: 404,
          body: new Uint8Array(),
          error: fixture.upstreamError,
        }),
      }) as any,
    });

    await assert.rejects(
      async () => { await attachmentViewCommand.handler(ctx, { id: fixture.id, output: "unused" }); },
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "VIEW_FAILED");
        assert.equal(err.message, AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_MESSAGE);
        assert.equal(
          err.suggestedNextAction,
          AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_NEXT_ACTION,
        );
        assert.match(err.suggestedNextAction ?? "", /--service "Raft Feedback Admin"/);
        assert.doesNotMatch(err.suggestedNextAction ?? "", /--service feedback-admin(?:\s|$)/);
        assert.match(err.suggestedNextAction ?? "", /--action download_feedback_transcript/);
        assert.match(err.suggestedNextAction ?? "", /--param id=REPORT_ID/);
        assert.match(err.suggestedNextAction ?? "", /reportId/);
        observed.push({ code: err.code, message: err.message, nextAction: err.suggestedNextAction });
        return true;
      },
    );
  }

  assert.deepEqual(observed, [observed[0], observed[0], observed[0]]);
});

test("attachment view command keeps non-404 auth and server failures distinct", async () => {
  const cases = [
    { status: 401, upstreamError: "Agent credential is invalid", expectedCode: "VIEW_FAILED" },
    { status: 403, upstreamError: "Attachment capability is disabled", expectedCode: "VIEW_FAILED" },
    { status: 500, upstreamError: "Attachment storage failed", expectedCode: "SERVER_5XX" },
  ] as const;

  for (const fixture of cases) {
    const { io } = memoryIo();
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => agentContext,
      createApiClient: () => ({
        request: async <T>(): Promise<ApiResponse<T>> => {
          throw new Error("attachment view should use the binary surface method");
        },
        requestBinary: async (): Promise<BinaryResponse> => ({
          ok: false,
          status: fixture.status,
          body: new Uint8Array(),
          error: fixture.upstreamError,
        }),
      }) as any,
    });

    await assert.rejects(
      async () => { await attachmentViewCommand.handler(ctx, { id: "attachment-id", output: "unused" }); },
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, fixture.expectedCode);
        assert.equal(err.message, fixture.upstreamError);
        assert.equal(err.suggestedNextAction, undefined);
        return true;
      },
    );
  }
});

test("attachment view command does not write a file or signed URL on an expired object response", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slock-cli-view-expired-"));
  const outputPath = join(dir, "must-not-exist.bin");
  const { io, stdout, stderr } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async <T>(): Promise<ApiResponse<T>> => {
        throw new Error("attachment view should use the binary surface method");
      },
      requestBinary: async (): Promise<BinaryResponse> => ({
        ok: false,
        status: 403,
        body: new Uint8Array(),
        error: "HTTP 403",
      }),
    }) as any,
  });

  try {
    await assert.rejects(
      async () => {
        await attachmentViewCommand.handler(ctx, { id: "expired", output: outputPath });
      },
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "VIEW_FAILED");
        assert.equal(err.message, "HTTP 403");
        return true;
      },
    );
    assert.equal(existsSync(outputPath), false);
    assert.equal(stdout.join(""), "");
    assert.equal(stderr.join(""), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
