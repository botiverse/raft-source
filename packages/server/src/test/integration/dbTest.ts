import { test as base } from "vitest";
import { setTimeout, clearTimeout } from "node:timers";
import type { Database } from "../../db/index";
import { discardParkedTestDatabase, openCaseDatabase } from "./database";
import { enterIntegrationCase, IntegrationLifecycle, poisonIntegrationEnvironment } from "./lifecycle";
import { reuseOptedOut } from "./reuseProbe";

import type { createSeed } from "./seed";

declare module "vitest" {
  interface TaskMeta {
    /** Summed per file by scripts/serverShardTimingReporter.ts; read as a plain object there. */
    integrationPhasesMs?: Record<string, number>;
    /** This case's database reuse counts (reuseProbe.ts); summed per file the same way. */
    integrationReuse?: Record<string, number>;
  }
}

interface DatabaseFixtures {
  fileDatabase: void;
  lifecycle: IntegrationLifecycle;
  db: Database;
  seed: ReturnType<typeof createSeed>;
}

export const dbTest = base.extend<DatabaseFixtures>({
  // One database per file (reuseProbe.ts): the one the file's last case left clean closes with the file.
  // oxlint-disable-next-line no-empty-pattern -- Vitest requires a destructuring pattern even without dependencies.
  fileDatabase: [async ({}, use) => {
    await use();
    await discardParkedTestDatabase();
  }, { scope: "file", auto: true }],
  lifecycle: [async ({ task }, use) => {
    const started = performance.now();
    const lifecycle = new IntegrationLifecycle();
    const leave = enterIntegrationCase(lifecycle);
    // context.skip() inside a case skips fixture teardown. Fail normally instead;
    // declare conditional cases with test.skipIf() before acquiring resources.
    // (Vitest types `skip` as read-only; the override is deliberate and restored below.)
    const mutableContext = task.context as { skip: typeof task.context.skip };
    const skip = mutableContext.skip;
    mutableContext.skip = (() => { throw new Error("Use test.skipIf before acquiring integration fixtures; context.skip() skips fixture teardown"); }) as typeof task.context.skip;
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
        mutableContext.skip = skip;
        // Vitest retains task.context after a case; release closed WASM/HTTP
        // fixtures instead of keeping every database alive until the file ends.
        for (const key of ["db", "app", "seed", "http", "lifecycle"]) {
          Reflect.deleteProperty(task.context, key);
        }
        // Every case reports its phases to the shard timing reporter (one line per file, not per case).
        task.meta.integrationPhasesMs = { ...lifecycle.timings };
        if (process.env.RAFT_TEST_PROFILE === "1" || task.result?.state === "fail") {
          console.log(JSON.stringify({ integrationTest: task.name, durationMs: performance.now() - started, phasesMs: lifecycle.timings, memoryBytes: process.memoryUsage() }));
        }
      }
    });
    await use(lifecycle);
  }, { auto: true }],
  seed: async ({ db }, use) => {
    const { createSeed } = await import("./seed");
    await use(createSeed(db));
  },
  db: async ({ lifecycle, task }, use) => {
    await use(await openCaseDatabase({
      optedOut: reuseOptedOut(task.file.name),
      measure: (phase, work) => lifecycle.measure(phase, work),
      caseFailed: () => task.result?.state === "fail",
      closedByCase: () => !lifecycle.closing,
      report: (counts) => { task.meta.integrationReuse = counts; },
    }));
  },
});
