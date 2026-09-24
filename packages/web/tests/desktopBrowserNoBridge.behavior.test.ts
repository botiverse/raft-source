import assert from "node:assert/strict";
import test from "node:test";
import {
  exposeWebBuildIdentity,
} from "../src/buildIdentity";
import type {
  FrontendReleaseIdentity,
} from "../src/buildIdentity";

test("ordinary browser/PWA release bootstrap performs zero native bridge probes or invokes", () => {
  let nativeReads = 0;
  let nativeInvokes = 0;
  const storage = {
    __TAURI_INTERNALS__: {
      invoke() {
        nativeInvokes += 1;
      },
    },
  } as Record<PropertyKey, unknown>;
  const targetWindow = new Proxy(storage, {
    get(target, property, receiver) {
      if (property === "__TAURI_INTERNALS__" || property === "RaftDesktop") {
        nativeReads += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const identity: FrontendReleaseIdentity = Object.freeze({
    releaseId: "release-abc",
    commitSha: "abc",
    builtAt: "2026-07-22T00:00:00Z",
    branch: "staging",
    deploymentEnvironment: "staging",
  });
  const dataset: DOMStringMap = {};

  exposeWebBuildIdentity(
    targetWindow,
    { documentElement: { dataset } } as Pick<Document, "documentElement">,
    identity,
  );

  assert.equal(nativeReads, 0);
  assert.equal(nativeInvokes, 0);
  assert.deepEqual(targetWindow.__RAFT_FRONTEND_RELEASE_IDENTITY__, identity);
  assert.equal(dataset.raftFrontendReleaseId, identity.releaseId);
  assert.equal(dataset.raftBuildSha, identity.commitSha);
});
