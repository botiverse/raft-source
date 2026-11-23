import { readFile } from "node:fs/promises";
import { setTimeout, clearTimeout } from "node:timers";
import { PGlite } from "@electric-sql/pglite";
import { isCi } from "../../../../../scripts/vitest/localRunLimits";
import {
  attachPgliteDatabase,
  closeDatabase,
  initDatabase,
  initPgliteDatabase,
  isDatabaseInitialized,
  type Database,
} from "../../db/index";
import { measureIntegrationPhase, ownIntegrationResource, poisonIntegrationEnvironment } from "./lifecycle";
import { closePgliteWhenIdle, trackPgliteActivity } from "./pgliteClose";
import { reclaimDatabase, readReuseBaseline, reuseEnabled, reuseSelfCheckEnabled, type ReuseBaseline, type ReuseCounts } from "./reuseProbe";
import {
  decideTemplateSource,
  MISSING_TEMPLATE_WARNING,
  TEMPLATE_PROVIDE_KEY,
  type TemplateSource,
} from "../setup/pgliteTemplate";

// Under Vitest every in-memory database is restored from the run's template
// file (src/test/setup/pgliteTemplate.global.ts). The worker reads that file
// on its first open and keeps one Blob of it: a Blob is immutable, so every
// open still restores a fresh database from the same bytes. Vitest gives each
// test file its own worker, so that is one read and one copy per file, gone
// with the file. Without a template file (Playwright server, scripts, or a
// misconfigured Vitest run) the first open migrates and this process keeps
// that snapshot.
//
// A dbTest / apiTest case's database (openCaseDatabase) is reclaimed when it
// closes (reuseProbe.ts): if the next case may have it, it is detached from the
// db module and parked here, and the file's next case takes it instead of a
// fresh restore. Explicit openTestDatabase calls never get it: they discard it
// and restore a fresh one, as do cases when RAFT_TEST_DB_REUSE=0 or in a file on
// REUSE_OPT_OUT. dbTest.ts closes it with the file.
//
// Every in-memory PGlite opened here closes only once no call is running on it
// (pgliteClose.ts): closing it under a running statement spins PGlite forever.
// A database still busy after CLOSE_IDLE_TIMEOUT_MS is left open instead and
// counted (closeTimeout), so a stuck case costs one database, never the file.
let processTemplate: Blob | null = null;
let fileTemplate: { path: string; blob: Blob } | null = null;
let templateSource: TemplateSource | null = null;
let opening = false;
let releaseDatabase: (() => void) | null = null;
/** The in-memory PGlite behind the open database, for reclaiming it (reuseProbe.ts); null otherwise. */
let openClient: PGlite | null = null;
/**
 * Run when the open database closes, after its background work drained, before its connection
 * closes: the catalog mark to park the database with, or null to close it.
 */
let beforeClose: (() => Promise<string | null>) | null = null;
/** A database the last case left clean, detached from the db module (nothing can reach it) until the next case takes it. */
let parked: { client: PGlite; catalogMark: string } | null = null;
/** The template as this worker's first fresh case database showed it (each file has its own worker); null: unreadable, no reuse. */
let reuseBaseline: Promise<ReuseBaseline | null> | null = null;
/** The open case database's count reporter (openCaseDatabase), for a close that had to give up. */
let reportCaseCounts: ((counts: ReuseCounts) => void) | null = null;
const RECLAIM_TIMEOUT_MS = 5_000;
const CLOSE_IDLE_TIMEOUT_MS = 5_000;

export function openTestPglite(): PGlite | null {
  return openClient;
}

/** Reclaim's seat (openCaseDatabase): once, for the database open now. It must not throw. */
export function onTestDatabaseClose(work: () => Promise<string | null>): void {
  beforeClose = work;
}

/** Close a test PGlite once no call runs on it; still busy after the bound, leave it open and count it. */
async function closeTestPglite(client: PGlite, report: ((counts: ReuseCounts) => void) | null): Promise<void> {
  if (await closePgliteWhenIdle(client, CLOSE_IDLE_TIMEOUT_MS) === "closed") return;
  console.warn(`[test database] still in use ${CLOSE_IDLE_TIMEOUT_MS} ms after its case ended; left open, not closed under a running statement`);
  report?.({ closeTimeout: 1 });
}

/** Close the parked database, if any: at the end of the file (dbTest.ts), and before an explicit open. */
export async function discardParkedTestDatabase(): Promise<void> {
  const database = parked;
  parked = null;
  if (database) await closeTestPglite(database.client, null);
}

export interface CaseDatabaseOptions {
  /** The case's file is on REUSE_OPT_OUT (reuseProbe.ts): restore a fresh database, reclaim nothing. */
  optedOut?: boolean;
  measure: <T>(phase: string, work: () => Promise<T>) => Promise<T>;
  /** Read when the database closes. */
  caseFailed: () => boolean;
  /** Read when the database closes: true while the case still runs, i.e. it closed the database itself. */
  closedByCase: () => boolean;
  /** The case's reuse counts (reuseProbe.ts), once its database closed through closeTestDatabase. */
  report: (counts: ReuseCounts) => void;
}

/**
 * A dbTest case's database: the one the file's previous case left clean, else a fresh restore.
 * At close it is reclaimed for the next case (reuseProbe.ts) or closed.
 */
export async function openCaseDatabase(options: CaseDatabaseOptions): Promise<Database> {
  // Every report carries everything counted so far for this case (reclaim, then a close that gave up).
  let caseCounts: ReuseCounts = {};
  const report = (counts: ReuseCounts) => {
    caseCounts = { ...caseCounts, ...counts };
    options.report(caseCounts);
  };
  if (!reuseEnabled() || options.optedOut) {
    const db = await openTestDatabase();
    reportCaseCounts = report;
    if (reuseEnabled()) report({ restored: 1, optedOut: 1 });
    return db;
  }
  const handed = parked;
  let db: Database;
  if (handed) {
    if (opening || isDatabaseInitialized()) {
      throw new Error("Close the current integration database before opening another");
    }
    parked = null;
    db = attachPgliteDatabase(handed.client);
    openClient = handed.client;
    releaseDatabase = ownIntegrationResource(closeTestDatabase);
  } else {
    db = await openTestDatabase();
  }
  reportCaseCounts = report;
  const client = openClient;
  if (!client) return db;
  // Read once per file, from its first case's fresh database (a database is only parked once it exists).
  const baseline = await (reuseBaseline ??= options.measure("reuseBaseline", () => readReuseBaseline(client)).catch(() => null));
  const opened: ReuseCounts = handed ? { reused: 1 } : { restored: 1 };
  onTestDatabaseClose(async () => {
    if (options.closedByCase()) {
      report({ ...opened, probed: 1, "drop.closedByCase": 1 });
      return null;
    }
    if (!baseline) {
      report({ ...opened, probed: 1, probeError: 1 });
      return null;
    }
    // Bounded: a transaction the case never settled holds PGlite's lock. The reclaim's own statements
    // then still wait on it, so the close that follows leaves the database open (closeTestPglite).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<{ counts: ReuseCounts; catalogMark: null }>((resolve) => {
      timer = setTimeout(() => resolve({ counts: { probed: 1, probeTimeout: 1 }, catalogMark: null }), RECLAIM_TIMEOUT_MS);
    });
    try {
      const verdict = await Promise.race([reclaimDatabase(client, baseline, {
        caseFailed: options.caseFailed(),
        catalogMark: handed?.catalogMark ?? baseline.catalogMark,
        selfCheck: reuseSelfCheckEnabled(),
        measure: options.measure,
      }), timedOut]);
      report({ ...opened, ...verdict.counts });
      return verdict.catalogMark;
    } finally {
      clearTimeout(timer);
    }
  });
  return db;
}

export async function openTestDatabase(databaseUrl = "pglite://", searchDatabaseUrl?: string) {
  if (opening || isDatabaseInitialized()) {
    throw new Error("Close the current integration database before opening another");
  }
  opening = true;
  try {
    await discardParkedTestDatabase();
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
        const loadDataDir = await templateFileBlob(source.path);
        const client = trackPgliteActivity(new PGlite({ loadDataDir }));
        const db = await initPgliteDatabase(client);
        openClient = client;
        releaseDatabase = ownIntegrationResource(closeTestDatabase);
        return db;
      }
      const client = trackPgliteActivity(new PGlite(processTemplate ? { loadDataDir: processTemplate } : {}));
      const db = await initPgliteDatabase(client);
      openClient = client;
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

async function templateFileBlob(path: string): Promise<Blob> {
  if (fileTemplate?.path !== path) {
    fileTemplate = { path, blob: new Blob([await readFile(path)]) };
  }
  return fileTemplate.blob;
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
      const reclaim = beforeClose;
      beforeClose = null;
      const report = reportCaseCounts;
      const kept: { catalogMark: string | null } = { catalogMark: null };
      const detached = await measureIntegrationPhase("databaseClose", () => closeDatabase({
        afterBackgroundWork: reclaim ? async () => {
          kept.catalogMark = await reclaim();
          return kept.catalogMark === null ? undefined : "detach";
        } : undefined,
        closePglite: (client) => closeTestPglite(client, report),
      }));
      if (detached && kept.catalogMark !== null) parked = { client: detached, catalogMark: kept.catalogMark };
    }
  } catch (error) {
    poisonIntegrationEnvironment(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    openClient = null;
    beforeClose = null;
    reportCaseCounts = null;
    releaseDatabase?.();
    releaseDatabase = null;
  }
}
