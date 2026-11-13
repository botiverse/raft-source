// The copied rule (sameSite.ts) against Porthole's own, which Porthole doesn't export.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { maybeSameSite } from "./sameSite";

describe("maybeSameSite agrees with Porthole's own rule", () => {
  // Porthole doesn't export maybeSameSite; load its module through the web package, which depends on it.
  const loadPorthole = async (): Promise<(a: string, b: string) => boolean> => {
    const { createRequire } = await import("node:module");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath, pathToFileURL } = await import("node:url");
    const fromWeb = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../../web/package.json"));
    const served = join(dirname(fromWeb.resolve("@botiverse/porthole")), "isolation/served.js");
    return (await import(pathToFileURL(served).href)).maybeSameSite;
  };
  const pairs: Array<[string, string]> = [
    ["w.raft.build", "app.raft.build"], ["raft.build", "app.raft.build"], ["app.raft.build", "app.raft.build"],
    ["content.localhost", "localhost"], ["localhost", "localhost"], ["a.localhost", "b.localhost"],
    ["w.raftusercontent.com", "app.raft.build"], ["w-staging.raftusercontent.com", "app.slock.ai"],
    ["127.0.0.1", "127.0.0.2"], ["10.0.0.1", "10.0.0.1"], ["[::1]", "localhost"],
    ["a.co.uk", "b.co.uk"], ["App.Raft.Build.", "app.raft.build"], ["notraft.build", "raft.build"],
  ];

  test("the same answer for every pair, both ways", async () => {
    const porthole = await loadPorthole();
    for (const [a, b] of pairs) {
      assert.equal(maybeSameSite(a, b), porthole(a, b), `${a} / ${b}`);
      assert.equal(maybeSameSite(b, a), porthole(b, a), `${b} / ${a}`);
    }
  });
});
