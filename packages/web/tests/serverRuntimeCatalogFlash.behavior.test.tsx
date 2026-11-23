// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
// #proj-raft-computer:db0c2687: a card flipped to the bundled catalog's
// "(deprecated)" each time the minute-long reuse of this server's answer
// expired. A refresh keeps the previous answer on screen until it settles.
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { RUNTIMES, SERVER_RUNTIME_CATALOG_VERSION } from "@botiverse/raft-shared";
import type { ServerRuntimeCatalog } from "@botiverse/raft-shared";

import api from "../src/api/client";
import {
  isRuntimeDeprecatedOnServer,
  resetServerRuntimeCatalogReadsForTests,
  useServerRuntimeCatalogState,
} from "../src/hooks/useServerRuntimeCatalog";
import { sharedCatalogReads } from "../src/store/serverRuntimeCatalogCache";

const originalGet = api.get.bind(api);

afterEach(() => {
  cleanup();
  api.get = originalGet;
  resetServerRuntimeCatalogReadsForTests();
});

/** This server deprecated Cursor CLI, which the bundled catalog does not. */
const deprecatesCursor: ServerRuntimeCatalog = {
  catalogVersion: SERVER_RUNTIME_CATALOG_VERSION,
  runtimes: RUNTIMES.map((runtime) => ({
    id: runtime.id,
    displayName: runtime.displayName,
    abbreviation: runtime.abbreviation,
    binary: runtime.binary,
    supported: runtime.supported,
    deprecated: runtime.id === "cursor" ? true : Boolean(runtime.deprecated),
    experimental: Boolean(runtime.experimental),
    oarOnly: false,
    models: [],
    modelsSource: "fallback",
    forms: [{ kind: "generic" }],
  })),
};

const deprecatedHere = (state: { catalog: ServerRuntimeCatalog | null }, runtimeId = "cursor") =>
  isRuntimeDeprecatedOnServer(runtimeId, state.catalog);

test("before the first answer the bundled catalog labels; the answer then decides", async () => {
  let answer: (value: { data: ServerRuntimeCatalog }) => void = () => {};
  api.get = (() => new Promise((resolve) => { answer = resolve; })) as typeof api.get;
  const { result } = renderHook(() => useServerRuntimeCatalogState("s1"));
  assert.equal(result.current.loading, true);
  assert.equal(deprecatedHere(result.current), false, "bundled: Cursor CLI is not deprecated");
  assert.equal(deprecatedHere(result.current, "kimi"), true, "bundled: Kimi CLI is");
  assert.equal(deprecatedHere(result.current, "antigravity"), false, "bundled: Antigravity is not");
  answer({ data: deprecatesCursor });
  await waitFor(() => assert.equal(result.current.loading, false));
  assert.equal(deprecatedHere(result.current), true);
});

test("an expired answer stays on screen while it refreshes, and through a failed refresh", async () => {
  sharedCatalogReads.set("s1", { promise: Promise.resolve(deprecatesCursor), settledAt: Date.now() - 120_000, catalog: deprecatesCursor });
  let fail: (error: Error) => void = () => {};
  api.get = (() => new Promise((_resolve, reject) => { fail = reject; })) as typeof api.get;
  const { result } = renderHook(() => useServerRuntimeCatalogState("s1"));
  // Refreshing: the previous answer, not the bundled fallback.
  assert.equal(result.current.loading, false);
  assert.equal(result.current.catalog, deprecatesCursor);
  assert.equal(deprecatedHere(result.current), true);
  fail(new Error("network"));
  await waitFor(() => assert.ok(sharedCatalogReads.get("s1")?.settledAt !== undefined));
  assert.equal(result.current.catalog, deprecatesCursor, "a failed refresh keeps the last answer");
  assert.equal(deprecatedHere(result.current), true);
});

test("a server too old to answer still falls back to the bundled label once it has answered", async () => {
  api.get = (async () => { throw new Error("404"); }) as typeof api.get;
  const { result } = renderHook(() => useServerRuntimeCatalogState("s1"));
  await waitFor(() => assert.equal(result.current.loading, false));
  assert.equal(result.current.catalog, null);
  assert.equal(deprecatedHere(result.current), false, "bundled: Cursor CLI is not deprecated there");
});

test("a refresh that succeeds replaces the previous answer", async () => {
  const stale = { ...deprecatesCursor, runtimes: deprecatesCursor.runtimes.map((runtime) => (runtime.id === "cursor" ? { ...runtime, deprecated: false } : runtime)) };
  sharedCatalogReads.set("s1", { promise: Promise.resolve(stale), settledAt: Date.now() - 120_000, catalog: stale });
  api.get = (async () => ({ data: deprecatesCursor })) as unknown as typeof api.get;
  const { result } = renderHook(() => useServerRuntimeCatalogState("s1"));
  assert.equal(result.current.catalog, stale, "the expired answer first");
  await waitFor(() => assert.equal(result.current.catalog, deprecatesCursor));
  assert.equal(deprecatedHere(result.current), true);
});
