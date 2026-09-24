#!/usr/bin/env tsx
/**
 * Backfill shared message translation cache rows.
 *
 * Required env:
 *   DATABASE_URL=<target database branch URL>
 *   TRANSLATION_SSM_ENVIRONMENT=<staging|production> (deployed mode), or the
 *   explicit local provider environment used by tests/development.
 *
 * The script never logs message content or translated content. It defaults to
 * dry-run mode; pass --write to insert/update message_translations rows.
 */
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { normalizeTranslationLanguageCode } from "@botiverse/raft-shared";
import pg from "pg";
import {
  detectMessageTranslationLanguage,
  hashMessageContent,
  isMessageTranslationCodeOrLinkOnly,
  providerInfoFromResolved,
  resolveProviderFromRuntimeConfig,
  type ResolvedTranslationProvider,
  type Detection,
  type LedgerProviderInfo,
} from "../src/services/messageTranslationService.js";
import {
  TranslationPlaceholderValidationError,
  TranslationProviderError,
  type TranslationBatchItem,
} from "../src/services/translation/index.js";

type MessageRow = {
  id: string;
  seq: string | number;
  server_id: string;
  content: string;
  message_type: string;
  created_at: Date | string;
};

type Candidate = {
  row: MessageRow;
  contentHash: string;
  detection: Detection;
  requestedChars: number;
};

type ProviderBatchItem = Candidate & {
  key: string;
};

type Options = {
  targetLanguages: string[];
  languagePairs: Array<{ sourceLanguage: string; targetLanguage: string }>;
  since: Date;
  until: Date;
  serverId: string | null;
  limit: number | null;
  pageSize: number;
  maxBatchItems: number;
  maxBatchChars: number;
  maxCharsPerMinute: number | null;
  maxBurstChars: number;
  write: boolean;
  force: boolean;
  output: string | null;
  progressEvery: number;
};

type Stats = {
  startedAt: string;
  finishedAt?: string;
  provider: string;
  providerVersion: string;
  placeholderPolicyVersion: string;
  write: boolean;
  force: boolean;
  targetLanguages: string[];
  since: string;
  until: string;
  scanned: number;
  eligible: number;
  skipped: Record<string, number>;
  cached: number;
  wouldTranslate: number;
  pendingInserted: number;
  translated: number;
  failed: Record<string, number>;
  providerBatches: number;
  providerBatchFailures: number;
  requestedChars: number;
  translatedChars: number;
  rateLimitWaitMs: number;
  providerLatenciesMs: number[];
};

type RateLimiter = {
  waitFor: (characters: number) => Promise<void>;
} | null;

function usage(code = 1): never {
  console.error(`Usage:
  pnpm --filter @botiverse/raft-server translations:backfill -- --target-language <lang> [options]

Options:
  --target-language <lang>   Target language to backfill. Repeatable; comma-separated values accepted.
  --language-pair <a:b>      Only translate detected source a to target b. Repeatable; comma-separated values accepted.
                              Example: --language-pair zh-CN:en,en:zh-CN.
  --since <iso>              Inclusive lower created_at bound. Default: now - 3 days.
  --since-days <n>           Alternative to --since. Default: 3.
  --until <iso>              Exclusive upper created_at bound. Default: now.
  --server-id <uuid>         Restrict to one server.
  --limit <n>                Max messages scanned per target language.
  --page-size <n>            DB page size. Default: 1000.
  --max-batch-items <n>      Provider batch item cap. Default: 16.
  --max-batch-chars <n>      Provider batch char cap. Default: 5000.
  --max-chars-per-minute <n> Provider char/min limiter. Default: provider-aware safe value. Use 0 to disable.
  --max-burst-chars <n>      Token bucket burst. Default: --max-batch-chars.
  --write                    Insert/update message_translations. Default is dry-run.
  --force                    Delete matching cache rows before translating.
  --output <path>            Write JSON summary to this path, mode 600.
  --progress-every <n>       Log progress every n scanned messages. Default: 10000.

Safety:
  - Defaults to dry-run; --write is required for DB writes.
  - Dry-run does not call the provider; it only reports what would be translated.
  - Logs aggregate counts only, never source or translated text.
  - Uses the configured provider env exactly like the server runtime.`);
  process.exit(code);
}

function intArg(name: string, value: string | undefined, min: number): number {
  if (!value) usage();
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) throw new Error(`--${name} must be an integer >= ${min}`);
  return parsed;
}

function parseDateArg(name: string, value: string | undefined): Date {
  if (!value) usage();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`--${name} must be a valid ISO date`);
  return parsed;
}

function parseTargetLanguages(value: string): string[] {
  return value
    .split(",")
    .map((part) => normalizeTranslationLanguageCode(part) ?? part.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeBackfillLanguage(language: string): string {
  return normalizeTranslationLanguageCode(language) ?? language.trim().toLowerCase();
}

function parseLanguagePairs(value: string): Array<{ sourceLanguage: string; targetLanguage: string }> {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [source, target, extra] = part.split(":");
      if (!source || !target || extra !== undefined) {
        throw new Error(`Invalid --language-pair ${part}; expected source:target`);
      }
      return {
        sourceLanguage: normalizeBackfillLanguage(source),
        targetLanguage: normalizeBackfillLanguage(target),
      };
    });
}

function parseArgs(argv: string[]): Options {
  if (argv[0] === "--") argv = argv.slice(1);
  const now = new Date();
  let since: Date | null = null;
  let sinceDays = 3;
  const opts: Omit<Options, "since" | "maxBurstChars"> & { maxBurstChars: number | null } = {
    targetLanguages: [],
    languagePairs: [],
    until: now,
    serverId: null,
    limit: null,
    pageSize: 1000,
    maxBatchItems: 16,
    maxBatchChars: 5000,
    maxCharsPerMinute: null,
    maxBurstChars: null,
    write: false,
    force: false,
    output: null,
    progressEvery: 10_000,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        usage(0);
        break;
      case "--target-language":
        opts.targetLanguages.push(...parseTargetLanguages(argv[++i] ?? usage()));
        break;
      case "--language-pair":
        opts.languagePairs.push(...parseLanguagePairs(argv[++i] ?? usage()));
        break;
      case "--since":
        since = parseDateArg("since", argv[++i]);
        break;
      case "--since-days":
        sinceDays = intArg("since-days", argv[++i], 1);
        break;
      case "--until":
        opts.until = parseDateArg("until", argv[++i]);
        break;
      case "--server-id":
        opts.serverId = argv[++i] ?? usage();
        break;
      case "--limit":
        opts.limit = intArg("limit", argv[++i], 1);
        break;
      case "--page-size":
        opts.pageSize = intArg("page-size", argv[++i], 1);
        break;
      case "--max-batch-items":
        opts.maxBatchItems = intArg("max-batch-items", argv[++i], 1);
        break;
      case "--max-batch-chars":
        opts.maxBatchChars = intArg("max-batch-chars", argv[++i], 1000);
        break;
      case "--max-chars-per-minute": {
        const value = intArg("max-chars-per-minute", argv[++i], 0);
        opts.maxCharsPerMinute = value === 0 ? null : value;
        break;
      }
      case "--max-burst-chars":
        opts.maxBurstChars = intArg("max-burst-chars", argv[++i], 1);
        break;
      case "--write":
        opts.write = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--output":
        opts.output = argv[++i] ?? usage();
        break;
      case "--progress-every":
        opts.progressEvery = intArg("progress-every", argv[++i], 1);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  const normalizedTargets = [...new Set(opts.targetLanguages)];
  const normalizedPairs = [...new Map(opts.languagePairs.map((pair) => [`${pair.sourceLanguage}:${pair.targetLanguage}`, pair])).values()];
  if (normalizedTargets.length === 0 && normalizedPairs.length === 0) {
    throw new Error("At least one --target-language or --language-pair is required");
  }
  for (const pair of normalizedPairs) {
    if (!normalizedTargets.includes(pair.targetLanguage)) normalizedTargets.push(pair.targetLanguage);
  }
  const resolvedSince = since ?? new Date(opts.until.getTime() - sinceDays * 24 * 60 * 60 * 1000);
  if (resolvedSince >= opts.until) throw new Error("--since must be earlier than --until");

  return {
    ...opts,
    targetLanguages: normalizedTargets,
    languagePairs: normalizedPairs,
    since: resolvedSince,
    maxBurstChars: opts.maxBurstChars ?? opts.maxBatchChars,
  };
}

function defaultLimiterForProvider(providerName: string): number | null {
  if (providerName === "google-cloud-translate") return 2_500_000;
  if (providerName === "azure-translator") return 450_000;
  return null;
}

function addCount(bucket: Record<string, number>, key: string, amount = 1): void {
  bucket[key] = (bucket[key] ?? 0) + amount;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[index]!);
}

function summarize(stats: Stats): Record<string, unknown> {
  const sorted = [...stats.providerLatenciesMs].sort((a, b) => a - b);
  const latencyTotal = sorted.reduce((sum, value) => sum + value, 0);
  const startedMs = new Date(stats.startedAt).getTime();
  const finishedMs = stats.finishedAt ? new Date(stats.finishedAt).getTime() : Date.now();
  const elapsedMs = Math.max(1, finishedMs - startedMs);
  return {
    ...stats,
    elapsedMs,
    effectiveCharsPerMinute: Math.round((stats.translatedChars / elapsedMs) * 60_000),
    providerLatencyMs: {
      count: sorted.length,
      avg: sorted.length === 0 ? null : Math.round(latencyTotal / sorted.length),
      p50: percentile(sorted, 50),
      p90: percentile(sorted, 90),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted.length === 0 ? null : Math.round(sorted[sorted.length - 1]!),
    },
    providerLatenciesMs: undefined,
  };
}

function createRateLimiter(maxCharsPerMinute: number | null, maxBurstChars: number): RateLimiter {
  if (!maxCharsPerMinute) return null;
  const maxBurstCharacters = Math.min(maxCharsPerMinute, maxBurstChars);
  const refillPerMs = maxCharsPerMinute / 60_000;
  let available = maxBurstCharacters;
  let updatedAt = performance.now();
  let queue = Promise.resolve();

  async function waitForCapacity(characters: number): Promise<void> {
    const requiredCapacity = Math.min(characters, maxBurstCharacters);
    while (true) {
      const now = performance.now();
      available = Math.min(maxBurstCharacters, available + (now - updatedAt) * refillPerMs);
      updatedAt = now;
      if (available >= requiredCapacity) {
        available -= characters;
        return;
      }
      await sleep(Math.ceil((requiredCapacity - available) / refillPerMs));
    }
  }

  return {
    waitFor(characters: number) {
      const work = queue.then(() => waitForCapacity(characters));
      queue = work.catch(() => {});
      return work;
    },
  };
}

function targetLanguageMatchesSource(detection: Detection, targetLanguage: string): boolean {
  const normalizedSource = normalizeTranslationLanguageCode(detection.sourceLanguage) ?? detection.sourceLanguage;
  return normalizedSource === targetLanguage;
}

function normalizedDetectedSourceLanguage(detection: Detection): string {
  return normalizeTranslationLanguageCode(detection.sourceLanguage) ?? detection.sourceLanguage;
}

function languagePairAllows(options: Options, detection: Detection, targetLanguage: string): boolean {
  if (options.languagePairs.length === 0) return true;
  const sourceLanguage = normalizedDetectedSourceLanguage(detection);
  return options.languagePairs.some((pair) => pair.sourceLanguage === sourceLanguage && pair.targetLanguage === targetLanguage);
}

function shouldSkip(row: MessageRow, detection: Detection, targetLanguage: string): string | null {
  if (row.message_type === "system") return "system_message";
  if (isMessageTranslationCodeOrLinkOnly(row.content)) return "code_or_link_only";
  if (detection.sourceConfidence < 50) return "low_confidence";
  if (targetLanguageMatchesSource(detection, targetLanguage)) return "same_language";
  return null;
}

function chunkCandidates(candidates: Candidate[], options: Options): Candidate[][] {
  const chunks: Candidate[][] = [];
  let current: Candidate[] = [];
  let currentChars = 0;
  let currentSourceLanguage: string | null = null;
  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current);
    current = [];
    currentChars = 0;
    currentSourceLanguage = null;
  };

  for (const candidate of candidates) {
    const sourceLanguage = candidate.detection.sourceLanguage || null;
    const tooManyItems = current.length >= options.maxBatchItems;
    const tooManyChars = current.length > 0 && currentChars + candidate.requestedChars > options.maxBatchChars;
    const mixedSource = current.length > 0 && currentSourceLanguage !== sourceLanguage;
    if (tooManyItems || tooManyChars || mixedSource) flush();
    current.push(candidate);
    currentChars += candidate.requestedChars;
    currentSourceLanguage = sourceLanguage;
  }
  flush();
  return chunks;
}

function cacheKeyWhereSql(startIndex: number): string {
  return `
    message_id = $${startIndex}
    AND content_hash = $${startIndex + 1}
    AND source_lang = $${startIndex + 2}
    AND target_lang = $${startIndex + 3}
    AND provider_version = $${startIndex + 4}
    AND placeholder_policy_version = $${startIndex + 5}
  `;
}

function cacheKeyParams(candidate: Candidate, targetLanguage: string, providerInfo: LedgerProviderInfo): unknown[] {
  return [
    candidate.row.id,
    candidate.contentHash,
    candidate.detection.sourceLanguage,
    targetLanguage,
    providerInfo.providerVersion,
    providerInfo.placeholderPolicyVersion,
  ];
}

async function deleteCacheRow(
  pool: pg.Pool,
  candidate: Candidate,
  targetLanguage: string,
  providerInfo: LedgerProviderInfo,
): Promise<void> {
  await pool.query(
    `DELETE FROM message_translations WHERE ${cacheKeyWhereSql(1)}`,
    cacheKeyParams(candidate, targetLanguage, providerInfo),
  );
}

async function insertLedgerRow(input: {
  pool: pg.Pool;
  candidate: Candidate;
  targetLanguage: string;
  status: "pending" | "translated" | "skipped" | "failed";
  translatedContent?: string | null;
  skipReason?: string | null;
  providerInfo: LedgerProviderInfo;
  providerBilledChars: number;
  updateOnConflict: boolean;
}): Promise<boolean> {
  const params = [
    randomUUID(),
    input.candidate.row.server_id,
    input.candidate.row.id,
    input.candidate.contentHash,
    input.candidate.detection.sourceLanguage,
    input.candidate.detection.sourceConfidence,
    input.targetLanguage,
    input.providerInfo.providerName,
    input.providerInfo.providerVersion,
    input.providerInfo.placeholderPolicyVersion,
    input.status,
    input.skipReason ?? null,
    input.translatedContent ?? null,
    input.candidate.requestedChars,
    input.providerBilledChars,
  ];
  const conflictAction = input.updateOnConflict
    ? `DO UPDATE SET
        provider = EXCLUDED.provider,
        status = EXCLUDED.status,
        skip_reason = EXCLUDED.skip_reason,
        translated_content = EXCLUDED.translated_content,
        requested_chars = EXCLUDED.requested_chars,
        provider_billed_chars = EXCLUDED.provider_billed_chars,
        last_accessed_at = now(),
        updated_at = now()`
    : "DO NOTHING";
  const result = await input.pool.query(
    `
      INSERT INTO message_translations (
        id,
        server_id,
        message_id,
        content_hash,
        source_lang,
        source_confidence,
        target_lang,
        provider,
        provider_version,
        placeholder_policy_version,
        status,
        skip_reason,
        translated_content,
        requested_chars,
        provider_billed_chars,
        last_accessed_at,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, now(), now(), now()
      )
      ON CONFLICT (
        message_id,
        content_hash,
        source_lang,
        target_lang,
        provider_version,
        placeholder_policy_version
      ) ${conflictAction}
    `,
    params,
  );
  return result.rowCount > 0;
}

async function hasCacheRow(
  pool: pg.Pool,
  candidate: Candidate,
  targetLanguage: string,
  providerInfo: LedgerProviderInfo,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM message_translations WHERE ${cacheKeyWhereSql(1)} LIMIT 1`,
    cacheKeyParams(candidate, targetLanguage, providerInfo),
  );
  return result.rowCount > 0;
}

async function loadMessagesPage(input: {
  pool: pg.Pool;
  options: Options;
  lastSeq: string | null;
  remaining: number;
}): Promise<MessageRow[]> {
  const filters = [
    "m.content <> ''",
  ];
  const params: unknown[] = [];
  if (input.options.serverId) {
    params.push(input.options.serverId);
    filters.push(`c.server_id = $${params.length}`);
  }
  if (input.lastSeq) {
    params.push(input.lastSeq);
    filters.push(`m.seq < $${params.length}`);
  }
  params.push(Math.min(input.options.pageSize, input.remaining));
  const limitRef = `$${params.length}`;
  const result = await input.pool.query<MessageRow>(
    `
      SELECT m.id, m.seq, c.server_id, m.content, m.message_type, m.created_at
      FROM messages m
      INNER JOIN channels c ON c.id = m.channel_id
      WHERE ${filters.join("\n        AND ")}
      ORDER BY m.seq DESC
      LIMIT ${limitRef}
    `,
    params,
  );
  return result.rows;
}

async function processCandidates(input: {
  pool: pg.Pool;
  options: Options;
  providerInfo: LedgerProviderInfo;
  targetLanguage: string;
  candidates: Candidate[];
  stats: Stats;
  rateLimiter: RateLimiter;
  provider: ResolvedTranslationProvider["provider"];
}): Promise<void> {
  for (const chunk of chunkCandidates(input.candidates, input.options)) {
    const ready: ProviderBatchItem[] = [];
    for (const candidate of chunk) {
      if (input.options.write && input.options.force) {
        await deleteCacheRow(input.pool, candidate, input.targetLanguage, input.providerInfo);
      }
      if (input.options.write) {
        const inserted = await insertLedgerRow({
          pool: input.pool,
          candidate,
          targetLanguage: input.targetLanguage,
          status: "pending",
          providerInfo: input.providerInfo,
          providerBilledChars: 0,
          updateOnConflict: false,
        });
        if (!inserted) {
          input.stats.cached += 1;
          continue;
        }
        input.stats.pendingInserted += 1;
      } else if (!input.options.force && await hasCacheRow(input.pool, candidate, input.targetLanguage, input.providerInfo)) {
        input.stats.cached += 1;
        continue;
      }
      ready.push({ ...candidate, key: candidate.row.id });
    }
    if (ready.length === 0) continue;
    if (!input.options.write) {
      input.stats.wouldTranslate += ready.length;
      continue;
    }

    const batchChars = ready.reduce((sum, item) => sum + item.requestedChars, 0);
    if (input.rateLimiter) {
      const waitStarted = performance.now();
      await input.rateLimiter.waitFor(batchChars);
      input.stats.rateLimitWaitMs += performance.now() - waitStarted;
    }

    input.stats.providerBatches += 1;
    const started = performance.now();
    try {
      const result = await input.provider.translateBatch(
        ready.map((item): TranslationBatchItem => ({
          key: item.key,
          sourceText: item.row.content,
          sourceLanguage: item.detection.sourceLanguage,
        })),
        input.targetLanguage,
      );
      input.stats.providerLatenciesMs.push(performance.now() - started);
      const translatedByKey = new Map(result.items.map((item) => [item.key, item]));
      for (const candidate of ready) {
        const translated = translatedByKey.get(candidate.key);
        if (!translated) {
          addCount(input.stats.failed, "missing_provider_result_item");
          continue;
        }
        if (input.options.write) {
          await insertLedgerRow({
            pool: input.pool,
            candidate,
            targetLanguage: input.targetLanguage,
            status: "translated",
            translatedContent: translated.translatedText,
            providerInfo: input.providerInfo,
            providerBilledChars: candidate.requestedChars,
            updateOnConflict: true,
          });
        }
        input.stats.translated += 1;
        input.stats.translatedChars += candidate.requestedChars;
      }
    } catch (error) {
      input.stats.providerLatenciesMs.push(performance.now() - started);
      input.stats.providerBatchFailures += 1;
      const failureKey = error instanceof TranslationProviderError
        ? error instanceof TranslationPlaceholderValidationError
          ? "placeholder_mismatch"
          : error.code
        : error instanceof Error
          ? error.name
          : "unknown_error";
      addCount(input.stats.failed, failureKey, ready.length);
      if (input.options.write) {
        for (const candidate of ready) {
          if (error instanceof TranslationProviderError && error.disposition === "content_driven") {
            await insertLedgerRow({
              pool: input.pool,
              candidate,
              targetLanguage: input.targetLanguage,
              status: "failed",
              skipReason: error instanceof TranslationPlaceholderValidationError ? "placeholder_mismatch" : "content_invalid",
              providerInfo: input.providerInfo,
              providerBilledChars: 0,
              updateOnConflict: true,
            });
          } else {
            await deleteCacheRow(input.pool, candidate, input.targetLanguage, input.providerInfo);
          }
        }
      }
    }
  }
}

async function processTargetLanguage(input: {
  pool: pg.Pool;
  options: Options;
  providerInfo: LedgerProviderInfo;
  provider: ResolvedTranslationProvider["provider"];
  targetLanguage: string;
  stats: Stats;
  rateLimiter: RateLimiter;
}): Promise<void> {
  let lastSeq: string | null = null;
  let scannedForTarget = 0;

  while (input.options.limit === null || scannedForTarget < input.options.limit) {
    const remaining = input.options.limit === null ? input.options.pageSize : input.options.limit - scannedForTarget;
    const rows = await loadMessagesPage({
      pool: input.pool,
      options: input.options,
      lastSeq,
      remaining,
    });
    if (rows.length === 0) break;

    const last = rows[rows.length - 1]!;
    lastSeq = String(last.seq);
    const inWindowRows: MessageRow[] = [];
    let reachedOlderThanSince = false;
    for (const row of rows) {
      const createdAt = new Date(row.created_at);
      if (createdAt >= input.options.until) continue;
      if (createdAt < input.options.since) {
        reachedOlderThanSince = true;
        continue;
      }
      inWindowRows.push(row);
    }
    if (inWindowRows.length === 0 && reachedOlderThanSince) break;

    scannedForTarget += inWindowRows.length;
    input.stats.scanned += inWindowRows.length;

    const candidates: Candidate[] = [];
    for (const row of inWindowRows) {
      const detection = detectMessageTranslationLanguage(row.content);
      const contentHash = hashMessageContent(row.content);
      const requestedChars = row.content.length;
      if (!languagePairAllows(input.options, detection, input.targetLanguage)) {
        continue;
      }
      const skipReason = shouldSkip(row, detection, input.targetLanguage);
      const candidate: Candidate = { row, contentHash, detection, requestedChars };
      input.stats.requestedChars += requestedChars;
      if (skipReason) {
        if (input.options.write && input.options.force) {
          await deleteCacheRow(input.pool, candidate, input.targetLanguage, input.providerInfo);
        }
        if (input.options.write) {
          const inserted = await insertLedgerRow({
            pool: input.pool,
            candidate,
            targetLanguage: input.targetLanguage,
            status: "skipped",
            skipReason,
            providerInfo: input.providerInfo,
            providerBilledChars: 0,
            updateOnConflict: input.options.force,
          });
          if (!inserted) input.stats.cached += 1;
        } else if (!input.options.force && await hasCacheRow(input.pool, candidate, input.targetLanguage, input.providerInfo)) {
          input.stats.cached += 1;
        }
        addCount(input.stats.skipped, skipReason);
        continue;
      }
      input.stats.eligible += 1;
      candidates.push(candidate);
    }

    await processCandidates({
      pool: input.pool,
      options: input.options,
      providerInfo: input.providerInfo,
      provider: input.provider,
      targetLanguage: input.targetLanguage,
      candidates,
      stats: input.stats,
      rateLimiter: input.rateLimiter,
    });
    if (reachedOlderThanSince) break;

    if (input.stats.scanned > 0 && input.stats.scanned % input.options.progressEvery < input.options.pageSize) {
      const summary = summarize(input.stats);
      console.error(
        `[progress] scanned=${summary.scanned} eligible=${summary.eligible} translated=${summary.translated} cached=${summary.cached} providerFailures=${summary.providerBatchFailures}`,
      );
    }
  }
}

async function writeSummary(path: string, summary: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(path, { flags: "w", mode: 0o600 });
    stream.on("error", reject);
    stream.on("finish", resolve);
    stream.end(`${JSON.stringify(summary, null, 2)}\n`);
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const resolved = await resolveProviderFromRuntimeConfig();
  const providerInfo = providerInfoFromResolved(resolved);
  const maxCharsPerMinute = options.maxCharsPerMinute ?? defaultLimiterForProvider(providerInfo.providerName);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const stats: Stats = {
    startedAt: new Date().toISOString(),
    provider: providerInfo.providerName,
    providerVersion: providerInfo.providerVersion,
    placeholderPolicyVersion: providerInfo.placeholderPolicyVersion,
    write: options.write,
    force: options.force,
    targetLanguages: options.targetLanguages,
    since: options.since.toISOString(),
    until: options.until.toISOString(),
    scanned: 0,
    eligible: 0,
    skipped: {},
    cached: 0,
    wouldTranslate: 0,
    pendingInserted: 0,
    translated: 0,
    failed: {},
    providerBatches: 0,
    providerBatchFailures: 0,
    requestedChars: 0,
    translatedChars: 0,
    rateLimitWaitMs: 0,
    providerLatenciesMs: [],
  };
  const rateLimiter = createRateLimiter(maxCharsPerMinute, options.maxBurstChars);

  console.error(`[config] provider=${providerInfo.providerName} write=${options.write} force=${options.force} targetLanguages=${options.targetLanguages.join(",")} maxCharsPerMinute=${maxCharsPerMinute ?? "none"}`);
  if (options.languagePairs.length > 0) {
    console.error(`[config] languagePairs=${options.languagePairs.map((pair) => `${pair.sourceLanguage}:${pair.targetLanguage}`).join(",")}`);
  }
  if (!options.write) {
    console.error("[config] dry-run only; pass --write to modify message_translations");
  }

  try {
    for (const targetLanguage of options.targetLanguages) {
      await processTargetLanguage({
        pool,
        options,
        providerInfo,
        provider: resolved.provider,
        targetLanguage,
        stats,
        rateLimiter,
      });
    }
    stats.finishedAt = new Date().toISOString();
    const summary = summarize(stats);
    console.log(JSON.stringify(summary, null, 2));
    if (options.output) await writeSummary(options.output, summary);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
