#!/usr/bin/env tsx
import { closeDatabase, initDatabase } from "../src/db/index.js";
import { backfillNewsletterAudience } from "../src/services/newsletterService.js";

type CliOptions = {
  batchSize: number;
  limit: number | null;
  dryRun: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    batchSize: 500,
    limit: null,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--batch-size" && argv[i + 1]) {
      options.batchSize = Math.max(1, Number(argv[++i]) || 500);
      continue;
    }
    if (arg === "--limit" && argv[i + 1]) {
      options.limit = Math.max(1, Number(argv[++i]) || 1);
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function usage() {
  console.error(
    [
      "Usage:",
      "  DATABASE_URL=... RESEND_API_KEY=... RESEND_NEWSLETTER_SEGMENT_ID=... tsx scripts/backfill-newsletter-audience.ts [--batch-size 500] [--limit 5000] [--dry-run]",
      "",
      "Options:",
      "  --batch-size <n>  Number of users to scan per batch (default: 500)",
      "  --limit <n>       Max number of users to scan before exiting",
      "  --dry-run         Print candidate counts/sample without writing to Resend or local state",
      "",
      "Resend write calls are rate-limited by RESEND_NEWSLETTER_MIN_INTERVAL_MS",
      "(default 550ms, about 2 requests/second) and retry retryable 429/5xx responses",
      "with RESEND_NEWSLETTER_MAX_RETRIES / RESEND_NEWSLETTER_RETRY_BASE_MS.",
    ].join("\n"),
  );
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    usage();
    throw new Error("DATABASE_URL is required");
  }
  const options = parseArgs(process.argv.slice(2));

  await initDatabase(databaseUrl);
  try {
    const result = await backfillNewsletterAudience(options);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closeDatabase();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
