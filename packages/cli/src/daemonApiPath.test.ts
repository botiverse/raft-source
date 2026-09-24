import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "./client.js";
import { CliError } from "./core/errors.js";
import { createDaemonApiSurfaceClient } from "./daemonApiPath.js";

test("daemon API CLI errors include sanitized contract rejection localization", async () => {
  const client = createDaemonApiSurfaceClient({
    async request<T>(): Promise<ApiResponse<T>> {
      return {
        ok: true,
        status: 200,
        data: {
          rows: [{
            target: "#proj-runtime",
            pendingCount: "two",
            flags: [],
            summary: "sk_daemon_should_not_escape",
          }],
        } as T,
        error: null,
      };
    },
  });

  await assert.rejects(
    () => client.inbox.check(),
    (error) => {
      assert.equal(error instanceof CliError, true);
      const err = error as CliError;
      assert.equal(err.code, "INVALID_JSON_RESPONSE");
      assert.match(err.message, /cause=wrong_type/);
      assert.match(err.message, /path=rows\[\*\]\.pendingCount/);
      assert.match(err.message, /expected_kind=number/);
      assert.match(err.message, /actual_kind=string/);
      assert.deepEqual(err.details, {
        daemon_api_contract_rejection: {
          cause: "wrong_type",
          path: "rows[*].pendingCount",
          expected_kind: "number",
          actual_kind: "string",
        },
      });
      assert.doesNotMatch(err.message, /sk_daemon_should_not_escape/);
      assert.doesNotMatch(JSON.stringify(err.details), /sk_daemon_should_not_escape/);
      return true;
    },
  );
});

test("daemon API CLI errors classify invalid JSON syntax without raw body", async () => {
  const client = createDaemonApiSurfaceClient({
    async request<T>(): Promise<ApiResponse<T>> {
      return {
        ok: false,
        status: 200,
        data: null,
        error: "Invalid JSON response from server/proxy (HTTP 200)",
        errorCode: "INVALID_JSON_RESPONSE",
      };
    },
  });

  await assert.rejects(
    () => client.runtime.version(),
    (error) => {
      assert.equal(error instanceof CliError, true);
      const err = error as CliError;
      assert.equal(err.code, "INVALID_JSON_RESPONSE");
      assert.match(err.message, /cause=invalid_json_syntax/);
      assert.match(err.message, /path=<unavailable>/);
      assert.match(err.message, /expected_kind=unavailable/);
      assert.match(err.message, /actual_kind=unavailable/);
      assert.deepEqual(err.details, {
        daemon_api_contract_rejection: {
          cause: "invalid_json_syntax",
          path: "<unavailable>",
          expected_kind: "unavailable",
          actual_kind: "unavailable",
        },
      });
      return true;
    },
  );
});

test("daemon API CLI treats unparsed successful daemon responses as syntax diagnostics", async () => {
  const client = createDaemonApiSurfaceClient({
    async request<T>(): Promise<ApiResponse<T>> {
      return {
        ok: true,
        status: 200,
        data: null,
        error: null,
      };
    },
  });

  await assert.rejects(
    () => client.runtime.version(),
    (error) => {
      assert.equal(error instanceof CliError, true);
      const err = error as CliError;
      assert.equal(err.code, "INVALID_JSON_RESPONSE");
      assert.match(err.message, /cause=invalid_json_syntax/);
      assert.match(err.message, /path=<unavailable>/);
      assert.match(err.message, /expected_kind=unavailable/);
      assert.match(err.message, /actual_kind=unavailable/);
      assert.deepEqual(err.details, {
        daemon_api_contract_rejection: {
          cause: "invalid_json_syntax",
          path: "<unavailable>",
          expected_kind: "unavailable",
          actual_kind: "unavailable",
        },
      });
      return true;
    },
  );
});
