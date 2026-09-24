import { PGlite } from "@electric-sql/pglite";
import {
  closeDatabase,
  initDatabase,
  initPgliteDatabase,
  isDatabaseInitialized,
} from "../../db/index.js";
import { measureIntegrationPhase, ownIntegrationResource, poisonIntegrationEnvironment } from "./lifecycle.js";

// File-local immutable snapshot. Vitest retains file isolation; no cache is
// persisted between runs, so changed migrations/bootstrap always build afresh.
let template: Blob | null = null;
let opening = false;
let releaseDatabase: (() => void) | null = null;

export async function openTestDatabase(databaseUrl = "pglite://", searchDatabaseUrl?: string) {
  if (opening || isDatabaseInitialized()) {
    throw new Error("Close the current integration database before opening another");
  }
  opening = true;
  try {
    return await measureIntegrationPhase("database", async () => {
      // Real Postgres and persistent PGlite paths retain their original semantics.
      if (databaseUrl !== "pglite://" && databaseUrl !== "pglite://:memory:") {
        const db = await initDatabase(databaseUrl, searchDatabaseUrl);
        releaseDatabase = ownIntegrationResource(closeTestDatabase);
        return db;
      }
      const client = new PGlite(template ? { loadDataDir: template } : {});
      const db = await initPgliteDatabase(client);
      releaseDatabase = ownIntegrationResource(closeTestDatabase);
      if (!template) {
        try {
          template = await client.dumpDataDir("none");
        } catch (error) {
          await closeTestDatabase();
          throw error;
        }
      }
      return db;
    });
  } finally {
    opening = false;
  }
}

export async function closeTestDatabase(): Promise<void> {
  try {
    if (isDatabaseInitialized()) {
      await measureIntegrationPhase("databaseClose", closeDatabase);
    }
  } catch (error) {
    poisonIntegrationEnvironment(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    releaseDatabase?.();
    releaseDatabase = null;
  }
}
