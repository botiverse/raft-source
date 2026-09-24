#!/usr/bin/env tsx
/** Dry-run by default; use --apply only in an explicitly authorized migration. */
import { initDatabase, closeDatabase, getDb } from "../src/db/index.js";
import { backfillLocalAppSourceInstallations } from "../src/services/appSourceInstallationService.js";

const apply = process.argv.slice(2).includes("--apply");
if (process.argv.slice(2).some((arg) => arg !== "--apply" && arg !== "--help")) {
  throw new Error("Usage: DATABASE_URL=... pnpm --filter @botiverse/raft-server exec tsx scripts/backfill-server-local-app-installations.ts [--apply]");
}
if (process.argv.includes("--help")) {
  console.log("Usage: ...backfill-server-local-app-installations.ts [--apply] (defaults to dry-run)");
} else {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  await initDatabase(url);
  try {
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...(await backfillLocalAppSourceInstallations(getDb(), apply)) }));
  } finally {
    await closeDatabase();
  }
}
