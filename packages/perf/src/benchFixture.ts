/**
 * Frozen benchmark channel fixtures: a known server and channel whose messages
 * and thread replies never change, so measurements across commits and days measure
 * the page rather than a moving conversation (#proj-frontend:#71).
 *
 * The digest covers both the ordered `(id, content)` SHA-256 prefix and the
 * message/thread counts: checking the hash alone would miss new thread replies,
 * which live in separate thread channels and only surface on the parent channel's
 * first page through `threadSummariesByParentMessageId`. Pure helpers here,
 * pinned by benchFixture.test.ts.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface BenchFixtureExpected {
  topLevel: number;
  threadSummaries: number;
  repliesPerThread: number;
  contentChars: number;
  /** First 16 lowercase hex chars of SHA-256 over `id + "\n" + content + "\n"` sorted by `createdAt`. */
  sha256: string;
}

export interface BenchFixtureSpec {
  fixture: string;
  server: string;
  channel: string;
  /** Optional second channel for switch benchmarks (`interact`, `ab`). */
  other?: string;
  expected: BenchFixtureExpected;
}

export interface ChannelDigest {
  inFirstPage: number;
  topLevel: number;
  threadSummaries: number;
  summaryReplies: Array<number | null>;
  contentChars: number;
  /** First 16 hex chars of SHA-256 over `id + "\n" + content + "\n"` sorted by `createdAt`. */
  sha256: string;
}

export interface FixtureVerification {
  ok: boolean;
  /** Compact cohort tag when `ok` (and the expected tag otherwise), e.g. `bench-v1@5395d2b0`. */
  tag: string;
  digest: ChannelDigest;
  mismatches: string[];
}

const FIXTURE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SHA16 = /^[0-9a-f]{16}$/;

/** Canonical tag recorded in `cohort.fixture` and `extra.fixture_tag`, e.g. `bench-v1@5395d2b0`. */
export function fixtureTag(spec: Pick<BenchFixtureSpec, "fixture" | "expected">): string {
  return `${spec.fixture}@${spec.expected.sha256.slice(0, 8)}`;
}

/** Validate a parsed fixture JSON object. */
export function parseBenchFixture(raw: unknown, source = "fixture file"): BenchFixtureSpec {
  const bad = (why: string): never => {
    throw new Error(`${source}: ${why}`);
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("not a JSON object");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.fixture !== "string" || !FIXTURE_NAME.test(obj.fixture)) bad(`"fixture" must be a lowercase name like bench-v1`);
  if (typeof obj.server !== "string" || !obj.server.trim()) bad(`"server" must be a non-empty server slug`);
  if (typeof obj.channel !== "string" || !obj.channel.trim()) bad(`"channel" must be a non-empty channel name`);
  if (obj.other !== undefined && (typeof obj.other !== "string" || !obj.other.trim())) bad(`"other" must be a non-empty channel name when given`);
  const exp = obj.expected;
  if (!exp || typeof exp !== "object" || Array.isArray(exp)) return bad(`"expected" must be an object`);
  const e = exp as Record<string, unknown>;
  for (const key of ["topLevel", "threadSummaries", "repliesPerThread", "contentChars"] as const) {
    const val = e[key];
    if (typeof val !== "number" || !Number.isInteger(val) || val < 0) bad(`"expected.${key}" must be a non-negative integer`);
  }
  const sha = typeof e.sha256 === "string" ? e.sha256.toLowerCase() : "";
  if (!SHA16.test(sha)) bad(`"expected.sha256" must be 16 hex characters`);
  return {
    fixture: obj.fixture as string,
    server: (obj.server as string).trim(),
    channel: (obj.channel as string).trim(),
    ...(typeof obj.other === "string" ? { other: obj.other.trim() } : {}),
    expected: {
      topLevel: e.topLevel as number,
      threadSummaries: e.threadSummaries as number,
      repliesPerThread: e.repliesPerThread as number,
      contentChars: e.contentChars as number,
      sha256: sha,
    },
  };
}

/**
 * Resolve `--fixture <name-or-path>`: either a built-in name (`bench-v1` ->
 * `fixtures/raft-web-bench-v1.json`) or a path to a JSON file.
 */
export function loadBenchFixture(nameOrPath: string): BenchFixtureSpec {
  const trimmed = nameOrPath.trim();
  if (!trimmed) throw new Error("--fixture needs a fixture name (e.g. bench-v1) or a JSON file path");
  const builtin = new URL(`../fixtures/raft-web-${trimmed}.json`, import.meta.url);
  if (FIXTURE_NAME.test(trimmed) && existsSync(builtin)) {
    return parseBenchFixture(JSON.parse(readFileSync(builtin, "utf8")), `fixture ${trimmed}`);
  }
  const full = resolve(trimmed);
  if (!existsSync(full)) throw new Error(`--fixture ${trimmed}: no built-in fixture "${trimmed}" and no file at ${full}`);
  return parseBenchFixture(JSON.parse(readFileSync(full, "utf8")), trimmed);
}

interface RawMessage {
  id?: unknown;
  content?: unknown;
  createdAt?: unknown;
  parentMessageId?: unknown;
}

/**
 * Compute the digest of a `/api/messages/channel/<id>?limit=200` response.
 * Matches `perfdb/bench/digest.mjs` byte-for-byte: messages sorted by
 * `String(createdAt)` ascending, SHA-256 over `id + "\n" + content + "\n"`.
 */
export function computeChannelDigest(payload: unknown): ChannelDigest {
  const obj = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  const rawList = Array.isArray(payload) ? payload : Array.isArray(obj?.messages) ? (obj!.messages as unknown[]) : null;
  if (!rawList) throw new Error("channel messages response has no messages array");
  const msgs = (rawList as RawMessage[]).slice().sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  const top = msgs.filter((m) => !m.parentMessageId);
  const summariesObj = obj?.threadSummariesByParentMessageId;
  const summaries = summariesObj && typeof summariesObj === "object" && !Array.isArray(summariesObj) ? Object.values(summariesObj as Record<string, Record<string, unknown>>) : [];
  const summaryReplies = summaries.map((s) => {
    const count = s?.replyCount ?? s?.messageCount ?? s?.count;
    return typeof count === "number" && Number.isFinite(count) ? count : null;
  });
  const hash = createHash("sha256");
  let contentChars = 0;
  for (const m of msgs) {
    const id = String(m.id ?? "");
    const content = typeof m.content === "string" ? m.content : "";
    contentChars += content.length;
    hash.update(`${id}\n${content}\n`);
  }
  return {
    inFirstPage: msgs.length,
    topLevel: top.length,
    threadSummaries: summaries.length,
    summaryReplies,
    contentChars,
    sha256: hash.digest("hex").slice(0, 16),
  };
}

/** Check a channel's live digest against a frozen fixture specification. */
export function verifyFixtureDigest(digest: ChannelDigest, spec: BenchFixtureSpec): FixtureVerification {
  const mismatches: string[] = [];
  const exp = spec.expected;
  if (digest.sha256 !== exp.sha256) mismatches.push(`sha256 is ${digest.sha256}, expected ${exp.sha256}`);
  if (digest.topLevel !== exp.topLevel) mismatches.push(`topLevel is ${digest.topLevel}, expected ${exp.topLevel}`);
  if (digest.threadSummaries !== exp.threadSummaries) mismatches.push(`threadSummaries is ${digest.threadSummaries}, expected ${exp.threadSummaries}`);
  const badReplies = digest.summaryReplies.filter((n) => n !== exp.repliesPerThread);
  if (badReplies.length) mismatches.push(`thread reply counts have ${JSON.stringify(digest.summaryReplies)}, expected ${exp.repliesPerThread} each`);
  if (digest.contentChars !== exp.contentChars) mismatches.push(`contentChars is ${digest.contentChars}, expected ${exp.contentChars}`);
  return {
    ok: mismatches.length === 0,
    tag: fixtureTag(spec),
    digest,
    mismatches,
  };
}

/**
 * Resolve server/channel/other options together with an optional `--fixture`,
 * refusing conflicting flags so a typo never measures the wrong channel under a
 * fixture's name.
 */
export function resolveFixtureTargets(
  spec: BenchFixtureSpec | null,
  given: { server?: string; channel?: string; other?: string },
  defaults: { channel: string; other?: string },
): { server: string | undefined; channel: string; other: string | undefined } {
  if (!spec) {
    return { server: given.server, channel: given.channel ?? defaults.channel, other: given.other ?? defaults.other };
  }
  if (given.server && given.server !== spec.server) {
    throw new Error(`--fixture ${spec.fixture} belongs to server "${spec.server}", not --server "${given.server}"`);
  }
  if (given.channel && given.channel !== spec.channel) {
    throw new Error(`--fixture ${spec.fixture} belongs to channel "${spec.channel}", not --channel "${given.channel}"`);
  }
  if (given.other && spec.other && given.other !== spec.other) {
    throw new Error(`--fixture ${spec.fixture} uses --other "${spec.other}", not "${given.other}"`);
  }
  return {
    server: spec.server,
    channel: spec.channel,
    other: given.other ?? spec.other ?? defaults.other,
  };
}
