import { dbTest } from "./dbTest.js";
import type { TestAppOptions, createTestApp } from "./app.js";

import type { createHttpClient } from "./http.js";

interface ApiFixtures {
  appOptions: TestAppOptions;
  http: ReturnType<typeof createHttpClient>;
  app: Awaited<ReturnType<typeof createTestApp>>;
}

// Vitest 2 resolves fixture dependencies when extend() is called. Bind options
// in the same extension as app; overriding appOptions in a later extend would
// leave app depending on the original options fixture.
export function createApiTest(options: TestAppOptions = {}) {
  return dbTest.extend<ApiFixtures>({
    appOptions: options,
    http: async ({ app }, use) => {
      const { createHttpClient } = await import("./http.js");
      await use(createHttpClient(app.baseUrl));
    },
    app: async ({ db, appOptions, lifecycle }, use) => {
      void db;
      // DB-only tests do not import the entire Express/Socket.io dependency graph.
      const app = await lifecycle.measure("app", async () => {
        const { createTestApp } = await import("./app.js");
        return createTestApp(0, appOptions);
      });
      await use(app);
    },
  });
}

export const apiTest = createApiTest();
