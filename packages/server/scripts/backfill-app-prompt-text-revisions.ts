#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * Task #4 (#proj-apps): heal app prompt-text revisions written by the previous
 * release between migration 0382 and the new code. Dry-run by default; use
 * --apply only in an explicitly authorized migration.
 */
import { initDatabase, closeDatabase, getDb } from "../src/db/index";
import { backfillAppPromptTextRevisions } from "../src/services/appPromptTextService";

const apply = process.argv.slice(2).includes("--apply");
if (process.argv.slice(2).some((arg) => arg !== "--apply" && arg !== "--help")) {
  throw new Error("Usage: DATABASE_URL=... pnpm --filter @botiverse/raft-server exec node --import @oxc-node/core/register scripts/backfill-app-prompt-text-revisions.ts [--apply]");
}
if (process.argv.includes("--help")) {
  console.log("Usage: ...backfill-app-prompt-text-revisions.ts [--apply] (defaults to dry-run)");
} else {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  await initDatabase(url);
  try {
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...(await backfillAppPromptTextRevisions(getDb(), apply)) }));
  } finally {
    await closeDatabase();
  }
}
