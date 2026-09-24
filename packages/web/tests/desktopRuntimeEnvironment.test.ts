import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INVALID_DESKTOP_RUNTIME_ENVIRONMENT,
  applyDesktopEnvironmentGeneration,
  assertValidDesktopRuntimeEnvironment,
  deriveRuntimeEndpoints,
  hasDesktopBridge,
  readDesktopRuntimeEnvironment,
} from "../src/desktopRuntimeEnvironment";

const production = {
  environmentId: "production",
  generation: 4,
  frontendOrigin: "https://app.raft.build",
  apiOrigin: "https://api.raft.build",
  socketOrigin: "https://api.raft.build",
  updateAuthority: "productionHands",
} as const;

const staging = {
  environmentId: "staging",
  generation: 4,
  frontendOrigin: "https://raft-app-staging.botiverse.dev",
  apiOrigin: "https://api-aws-staging.botiverse.dev",
  socketOrigin: "https://api-aws-staging.botiverse.dev",
  updateAuthority: "none",
} as const;

function withoutKey<T extends Record<string, unknown>>(value: T, key: keyof T): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function maskCommentsAndStrings(source: string): string {
  let masked = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      masked += "  ";
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        masked += " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      masked += "  ";
      index += 2;
      while (index < source.length) {
        const current = source[index]!;
        const following = source[index + 1];
        masked += current === "\n" ? "\n" : " ";
        index += 1;
        if (current === "*" && following === "/") {
          masked += " ";
          index += 1;
          break;
        }
      }
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      const quote = char;
      masked += " ";
      index += 1;
      while (index < source.length) {
        const current = source[index]!;
        masked += current === "\n" ? "\n" : " ";
        index += 1;
        if (current === "\\") {
          if (index < source.length) {
            masked += source[index] === "\n" ? "\n" : " ";
            index += 1;
          }
          continue;
        }
        if (current === quote) break;
      }
      continue;
    }
    masked += char;
    index += 1;
  }
  return masked;
}

function realGuardCallIndexes(source: string): number[] {
  const masked = maskCommentsAndStrings(source);
  return Array.from(masked.matchAll(/(?<![.$\w])assertValidDesktopRuntimeEnvironment\s*\(\s*\)/g)).map((match) => match.index ?? -1);
}

function literalIndexes(source: string, literal: string): number[] {
  const indexes: number[] = [];
  let index = source.indexOf(literal);
  while (index >= 0) {
    indexes.push(index);
    index = source.indexOf(literal, index + literal.length);
  }
  return indexes;
}

function assertGuardBeforeSinks(file: string, sinks: string[], expectedCallCount: number, options?: { pairCallsWithSinks?: boolean }): void {
  const root = resolve(import.meta.dirname, "..");
  const source = readFileSync(resolve(root, file), "utf8");
  const masked = maskCommentsAndStrings(source);
  const callIndexes = realGuardCallIndexes(source);

  assert.match(source, /desktopRuntimeEnvironment/, `${file} must import the runtime module`);
  assert.equal(callIndexes.length, expectedCallCount, `${file} must contain real guard calls only`);
  assert.doesNotMatch(source, /VITE_API_URL/, `${file} must not read VITE_API_URL directly`);

  for (const sink of sinks) {
    const sinkIndexes = literalIndexes(masked, sink);
    assert.ok(sinkIndexes.length > 0, `${file} must contain sink ${sink}`);
    for (const sinkIndex of sinkIndexes) {
      assert.ok(
        callIndexes.some((callIndex) => callIndex >= 0 && callIndex < sinkIndex),
        `${file} must call assertValidDesktopRuntimeEnvironment() before ${sink}`,
      );
    }
    if (options?.pairCallsWithSinks) {
      assert.equal(sinkIndexes.length, callIndexes.length, `${file} must pair every ${sink} sink with a guard call`);
      for (let index = 0; index < sinkIndexes.length; index += 1) {
        assert.ok(callIndexes[index]! < sinkIndexes[index]!, `${file} guard call ${index + 1} must precede ${sink} ${index + 1}`);
        if (index > 0) {
          assert.ok(callIndexes[index]! > sinkIndexes[index - 1]!, `${file} guard call ${index + 1} must be local to ${sink} ${index + 1}`);
        }
      }
    }
  }
}

describe("native Desktop runtime environment", () => {
  test("accepts only built-in production and staging exact tuples", () => {
    assert.deepEqual(readDesktopRuntimeEnvironment({ __RAFT_DESKTOP_ENVIRONMENT__: production }), production);
    assert.deepEqual(readDesktopRuntimeEnvironment({ __RAFT_DESKTOP_ENVIRONMENT__: staging }), staging);
  });

  test("rejects missing, extra, malformed, wrong-host, and cross-paired tuples", () => {
    for (const invalid of [
      withoutKey(production, "apiOrigin"),
      { ...production, customUrl: "https://evil.test" },
      { ...production, environmentId: "custom" },
      { ...production, apiOrigin: "" },
      { ...production, apiOrigin: "http://api.raft.build" },
      { ...production, apiOrigin: "https://api.raft.build/path" },
      { ...production, apiOrigin: "https://api.raft.build?x=1" },
      { ...production, socketOrigin: "https://api.raft.build#hash" },
      { ...production, frontendOrigin: staging.frontendOrigin },
      { ...production, apiOrigin: staging.apiOrigin },
      { ...production, socketOrigin: staging.socketOrigin },
      { ...staging, frontendOrigin: production.frontendOrigin },
      { ...staging, apiOrigin: "https://raft-app-staging.botiverse.dev" },
      { ...staging, socketOrigin: production.socketOrigin },
      { ...staging, updateAuthority: "productionHands" },
    ]) {
      assert.equal(readDesktopRuntimeEnvironment({ __RAFT_DESKTOP_ENVIRONMENT__: invalid }), null);
    }
  });

  test("generation changes clear auth storage and every cache exactly once", async () => {
    const values = new Map<string, string>([["token", "secret"], ["raft_desktop_environment_generation", "3"]]);
    let clears = 0;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      clear: () => { clears += 1; values.clear(); },
    };
    const deleted: string[] = [];
    const cacheStorage = {
      keys: async () => ["auth", "assets"],
      delete: async (key: string) => { deleted.push(key); return true; },
    };
    assert.equal(applyDesktopEnvironmentGeneration(production, storage, cacheStorage), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(clears, 1);
    assert.deepEqual(deleted.sort(), ["assets", "auth"]);
    assert.equal(values.get("raft_desktop_environment_generation"), "4");
    assert.equal(applyDesktopEnvironmentGeneration(production, storage, cacheStorage), false);
    assert.equal(clears, 1);
  });

  test("browser mode has no destructive side effect", () => {
    let clears = 0;
    const storage = { getItem: () => null, setItem: () => {}, clear: () => { clears += 1; } };
    assert.equal(applyDesktopEnvironmentGeneration(null, storage), false);
    assert.equal(clears, 0);
  });

  test("Desktop bridge detection is pinned to the native invoke function", () => {
    assert.equal(hasDesktopBridge({}), false);
    assert.equal(hasDesktopBridge({ __TAURI_INTERNALS__: {} }), false);
    assert.equal(hasDesktopBridge({ __TAURI_INTERNALS__: { invoke: "not-a-function" } }), false);
    assert.equal(hasDesktopBridge({ __TAURI_INTERNALS__: { invoke: () => undefined } }), true);
  });

  test("ordinary browser preserves compiled API and page-origin fallback", () => {
    assert.deepEqual(
      deriveRuntimeEndpoints(null, "https://compiled.invalid", "https://page.invalid", false),
      {
        apiOrigin: "https://compiled.invalid",
        apiBase: "https://compiled.invalid/api",
        socketOrigin: "https://compiled.invalid",
        desktopRuntimeError: null,
      },
    );

    assert.deepEqual(
      deriveRuntimeEndpoints(null, "", "https://page.invalid", false),
      {
        apiOrigin: "https://page.invalid",
        apiBase: "https://page.invalid/api",
        socketOrigin: "/",
        desktopRuntimeError: null,
      },
    );
  });

  test("valid Desktop tuples override compiled API and remote page origins", () => {
    assert.deepEqual(
      deriveRuntimeEndpoints(production, "https://compiled.invalid", "https://page.invalid", true),
      {
        apiOrigin: "https://api.raft.build",
        apiBase: "https://api.raft.build/api",
        socketOrigin: "https://api.raft.build",
        desktopRuntimeError: null,
      },
    );

    assert.deepEqual(
      deriveRuntimeEndpoints(staging, "https://compiled.invalid", "https://page.invalid", true),
      {
        apiOrigin: "https://api-aws-staging.botiverse.dev",
        apiBase: "https://api-aws-staging.botiverse.dev/api",
        socketOrigin: "https://api-aws-staging.botiverse.dev",
        desktopRuntimeError: null,
      },
    );
  });

  test("Desktop bridge with missing or invalid tuple does not fall back to compiled API or page origin", () => {
    assert.deepEqual(
      deriveRuntimeEndpoints(null, "https://compiled.invalid", "https://page.invalid", true),
      {
        apiOrigin: "",
        apiBase: "/api",
        socketOrigin: "/",
        desktopRuntimeError: INVALID_DESKTOP_RUNTIME_ENVIRONMENT,
      },
    );
  });

  test("invalid Desktop runtime errors are typed before auth/socket requests can run", () => {
    assert.doesNotThrow(() => assertValidDesktopRuntimeEnvironment(null));

    assert.throws(
      () => assertValidDesktopRuntimeEnvironment(INVALID_DESKTOP_RUNTIME_ENVIRONMENT),
      (error) =>
        error instanceof Error &&
        error.name === "InvalidDesktopRuntimeEnvironmentError" &&
        error.message === "Invalid Desktop runtime environment" &&
        "code" in error &&
        error.code === INVALID_DESKTOP_RUNTIME_ENVIRONMENT,
    );
  });

  test("credential-bearing consumers fail closed through the validated runtime tuple", () => {
    assertGuardBeforeSinks("src/api/client.ts", [
      "localStorage.getItem(",
      "attachWebHttpClientTrace(config)",
    ], 1);
    assertGuardBeforeSinks("src/api/socket.ts", [
      "socket = io(",
      "auth: freshAuth()",
    ], 1);
    assertGuardBeforeSinks("src/utils/socialAuth.ts", [
      "return RUNTIME_API_BASE;",
    ], 1);
    assertGuardBeforeSinks("src/utils/refreshCoordinator.ts", [
      "axios.post(",
    ], 1);
    assertGuardBeforeSinks("src/utils/webAuthTrace.ts", [
      "const attestationResponse = await fetchImpl(",
    ], 2, { pairCallsWithSinks: true });
    assertGuardBeforeSinks("src/utils/selectScreenshot.ts", [
      "localStorage.getItem(",
    ], 1);
    assertGuardBeforeSinks("src/utils/server.ts", [
      "RUNTIME_API_ORIGIN.includes(",
    ], 1);
  });
});
