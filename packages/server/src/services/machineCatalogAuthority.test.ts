import assert from "node:assert/strict";
import { test } from "vitest";
import { MachineCatalogAuthority } from "./machineCatalogAuthority.js";

const generation = (connectionEpochId: string, replicaGeneration: string) => ({
  connectionEpochId,
  replicaGeneration,
});

test("catalog authority rejects validation from an older connection generation", async () => {
  let current = generation("epoch-new", "replica-new");
  const authority = new MachineCatalogAuthority(() => current);
  await assert.rejects(
    authority.run(
      "machine-a",
      generation("epoch-old", "replica-old"),
      async () => "persisted",
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "builtin_catalog_stale",
  );
});

test("replacement cannot change generation during a catalog-authorized persist", async () => {
  let current = generation("epoch-a", "replica-a");
  const authority = new MachineCatalogAuthority(() => current);
  let finishPersist!: () => void;
  const persistBlocked = new Promise<void>((resolve) => {
    finishPersist = resolve;
  });

  const persist = authority.run("machine-a", { ...current }, async () => {
    await persistBlocked;
    return "persisted";
  });
  const replace = (async () => {
    await authority.beginReplacement("machine-a", current);
    current = generation("epoch-b", "replica-b");
  })();

  await Promise.resolve();
  assert.deepEqual(current, generation("epoch-a", "replica-a"));
  finishPersist();
  assert.equal(await persist, "persisted");
  await replace;
  assert.deepEqual(current, generation("epoch-b", "replica-b"));
});

test("failed authorized action releases the connection handoff", async () => {
  const current = generation("epoch-a", "replica-a");
  const authority = new MachineCatalogAuthority(() => current);
  await assert.rejects(
    authority.run("machine-a", current, async () => {
      throw new Error("db failed");
    }),
    /db failed/,
  );
  await authority.beginReplacement("machine-a", current);
});

test("replacement intent rejects a late catalog reader before connection removal", async () => {
  const current = generation("epoch-a", "replica-a");
  const authority = new MachineCatalogAuthority(() => current);

  await authority.beginReplacement("machine-a", current);
  assert.throws(
    () => authority.acquire("machine-a", current),
    (error: unknown) =>
      (error as { code?: string }).code === "builtin_catalog_stale",
  );
  authority.completeReplacement("machine-a", current);
  const release = authority.acquire("machine-a", current);
  release();
});
