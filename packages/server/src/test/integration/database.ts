import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { isCi } from "../../../../../scripts/vitest/localRunLimits";
import {
  closeDatabase,
  initDatabase,
  initPgliteDatabase,
  isDatabaseInitialized,
} from "../../db/index";
import { measureIntegrationPhase, ownIntegrationResource, poisonIntegrationEnvironment } from "./lifecycle";
import {
  decideTemplateSource,
  MISSING_TEMPLATE_WARNING,
  TEMPLATE_PROVIDE_KEY,
  type TemplateSource,
} from "../setup/pgliteTemplate";

// Under Vitest every in-memory database is restored from the run's template
// file (src/test/setup/pgliteTemplate.global.ts), read per open and not kept.
// Without one (Playwright server, scripts, or a misconfigured Vitest run) the
// first open migrates and this process keeps that snapshot.
let processTemplate: Blob | null = null;
let templateSource: TemplateSource | null = null;
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
      const source = templateSource ??= await resolveTemplateSource();
      if (source.kind === "file") {
        // migratePglite still runs after the load and applies anything the key missed.
        const loadDataDir = new Blob([await readFile(source.path)]);
        const db = await initPgliteDatabase(new PGlite({ loadDataDir }));
        releaseDatabase = ownIntegrationResource(closeTestDatabase);
        return db;
      }
      const client = new PGlite(processTemplate ? { loadDataDir: processTemplate } : {});
      const db = await initPgliteDatabase(client);
      releaseDatabase = ownIntegrationResource(closeTestDatabase);
      if (!processTemplate) {
        try {
          processTemplate = await client.dumpDataDir("none");
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

async function resolveTemplateSource(): Promise<TemplateSource> {
  let underVitest = false;
  let templatePath: string | undefined;
  if (process.env.VITEST) {
    try {
      const { inject } = await import("vitest");
      templatePath = inject(TEMPLATE_PROVIDE_KEY);
      underVitest = true;
    } catch {
      // A child process that inherited VITEST but is not a Vitest worker.
    }
  }
  const source = decideTemplateSource({ underVitest, templatePath, ci: isCi() });
  if (source.kind === "processLocal" && source.warn) console.warn(MISSING_TEMPLATE_WARNING);
  return source;
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
