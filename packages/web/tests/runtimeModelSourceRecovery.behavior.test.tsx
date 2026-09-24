import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import api from "../src/api/client";
import { projectRuntimeModelLabelPresentation, useRuntimeModels } from "../src/hooks/useRuntimeModels";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";

const originalGet = api.get.bind(api);

function makeServer(): Server {
  return {
    id: "server-model-source",
    name: "Model Source Server",
    avatarUrl: null,
    slug: "model-source-server",
    ownerId: "owner-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role: "owner",
    createdAt: new Date(0).toISOString(),
  };
}

afterEach(() => {
  api.get = originalGet as typeof api.get;
  cleanup();
  useServerStore.getState().clearCurrent();
});

test("rescan recovers missing_config to live without a stale process cache", async () => {
  useServerStore.setState({ current: makeServer() });
  let calls = 0;
  api.get = (async () => {
    calls += 1;
    return calls === 1
      ? { data: { kind: "missing_config", recovery: "kimi_login" } }
      : { data: { kind: "live", value: { models: [{ id: "kimi-code/k2.7", label: "K2.7" }], default: "kimi-code/k2.7" } } };
  }) as typeof api.get;

  const { result, rerender } = renderHook(() => useRuntimeModels("machine-1", "kimi-sdk"));
  await waitFor(() => assert.equal(result.current.source.kind, "missing_config"));
  assert.deepEqual(result.current.models, []);
  assert.ok(result.current.suggestions.length > 0, "bundled metadata remains explanatory only");

  act(() => result.current.rescan());
  await waitFor(() => assert.equal(result.current.source.kind, "live"));
  assert.deepEqual(result.current.models, [
    { id: "kimi-code/k2.7", label: "K2.7" },
  ]);
  assert.equal(result.current.default, "kimi-code/k2.7");
  assert.equal(calls, 2);

  const stableResult = result.current;
  rerender();
  assert.equal(result.current, stableResult);
  assert.equal(result.current.source, stableResult.source);
  assert.equal(result.current.models, stableResult.models);
  assert.equal(result.current.suggestions, stableResult.suggestions);
  assert.equal(result.current.rescan, stableResult.rescan);
});

test("a new catalog identity is loading before effects and cannot expose the previous Computer's label", async () => {
  useServerStore.setState({ current: makeServer() });
  const requests: Array<{
    resolve: (value: { data: unknown }) => void;
  }> = [];
  api.get = (() => new Promise((resolve) => {
    requests.push({ resolve });
  })) as typeof api.get;
  let machineId = "machine-1";

  const { result, rerender } = renderHook(() => useRuntimeModels(machineId, "kimi-sdk"));
  assert.equal(result.current.source.kind, "loading");
  await waitFor(() => assert.equal(requests.length, 1));

  await act(async () => {
    requests[0].resolve({
      data: {
        kind: "live",
        value: { models: [{ id: "kimi-code/k3-256k", label: "Machine 1 K3" }] },
      },
    });
  });
  await waitFor(() => assert.equal(result.current.source.kind, "live"));
  assert.deepEqual(result.current.models, [
    { id: "kimi-code/k3-256k", label: "Machine 1 K3" },
  ]);

  machineId = "machine-2";
  rerender();

  assert.equal(result.current.source.kind, "loading");
  assert.deepEqual(result.current.models, []);
  assert.deepEqual(
    projectRuntimeModelLabelPresentation("kimi-sdk", "kimi-code/k3-256k", result.current),
    { kind: "pending" },
  );
  await waitFor(() => assert.equal(requests.length, 2));
});
