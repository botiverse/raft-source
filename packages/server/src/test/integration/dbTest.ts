import { test as base } from "vitest";
import { setTimeout, clearTimeout } from "node:timers";
import type { Database } from "../../db/index.js";
import { openTestDatabase } from "./database.js";
import { enterIntegrationCase, IntegrationLifecycle, poisonIntegrationEnvironment } from "./lifecycle.js";

import type { createSeed } from "./seed.js";

interface DatabaseFixtures {
  lifecycle: IntegrationLifecycle;
  db: Database;
  seed: ReturnType<typeof createSeed>;
}

export const dbTest = base.extend<DatabaseFixtures>({
  lifecycle: [async ({ task }, use) => {
    const started = performance.now();
    const lifecycle = new IntegrationLifecycle();
    const leave = enterIntegrationCase(lifecycle);
    // Vitest 2 skips *all* teardown on context.skip(). Fail normally instead;
    // declare conditional cases with test.skipIf() before acquiring resources.
    const skip = task.context.skip;
    task.context.skip = () => { throw new Error("Use test.skipIf before acquiring integration fixtures; Vitest 2 skips teardown on context.skip()"); };
    // Vitest's onFinished hook also runs if another afterEach/fixture throws.
    task.context.onTestFinished(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          lifecycle.measure("cleanup", () => lifecycle.close()),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Integration cleanup did not finish within 30 seconds")), 30_000);
          }),
        ]);
      } catch (error) {
        poisonIntegrationEnvironment(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        clearTimeout(timer);
        leave();
        task.context.skip = skip;
        // Vitest 2 retains task.context after a case; release closed WASM/HTTP
        // fixtures instead of keeping every database alive until the file ends.
        for (const key of ["db", "app", "seed", "http", "lifecycle"]) {
          Reflect.deleteProperty(task.context, key);
        }
        if (process.env.RAFT_TEST_PROFILE === "1" || task.result?.state === "fail") {
          console.log(JSON.stringify({ integrationTest: task.name, durationMs: performance.now() - started, phasesMs: lifecycle.timings, memoryBytes: process.memoryUsage() }));
        }
      }
    });
    await use(lifecycle);
  }, { auto: true }],
  seed: async ({ db }, use) => {
    const { createSeed } = await import("./seed.js");
    await use(createSeed(db));
  },
  db: async ({ lifecycle }, use) => {
    void lifecycle;
    const db = await openTestDatabase();
    await use(db);
  },
});
