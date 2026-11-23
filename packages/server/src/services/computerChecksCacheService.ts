import {
  COMPUTER_CHECK_TEXT_MAX,
  COMPUTER_CHECKS_REFRESH_INTERVAL_MS,
  COMPUTER_CHECKS_REPORT_KEEP_SECONDS,
  currentTimeMs,
  parseComputerChecksReport,
  plainActionCardText,
  redactDiagnosticCredentials,
  type ComputerChecksWireReport,
} from "@botiverse/raft-shared";

import { getRedis, isRedisAvailable } from "../redis";
import type { RuntimeAccountUsageCacheBackend } from "./runtimeAccountUsageCacheService";

/**
 * The last "On this computer" checks report of each Computer
 * (docs/contracts/computer-checks.md), one per machine row (a machine row
 * belongs to one server, so this is per server and Computer). Kept 7 days,
 * then `unknown`; no database row. Every string in it went through the
 * credential scrubber before it was written.
 */
const REPORT_KEY_PREFIX = "slock:computer-checks:v1";
const REFRESH_KEY_PREFIX = "slock:computer-checks:refresh:v1";
const REFRESH_CLAIM_SECONDS = Math.ceil(COMPUTER_CHECKS_REFRESH_INTERVAL_MS / 1000);
const SCRUB_MASK = "***REDACTED***";

/** The usage cache's storage operations, and a delete (a refresh claim given back). */
export interface ComputerChecksCacheBackend extends RuntimeAccountUsageCacheBackend {
  delete(key: string): Promise<void>;
}

type LocalEntry = { value: string; expiresAtMs: number };
const localEntries = new Map<string, LocalEntry>();

const localBackend: ComputerChecksCacheBackend = {
  async get(key) {
    const entry = localEntries.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= currentTimeMs()) {
      localEntries.delete(key);
      return null;
    }
    return entry.value;
  },
  async set(key, value, ttlSeconds) {
    localEntries.set(key, { value, expiresAtMs: currentTimeMs() + ttlSeconds * 1_000 });
  },
  async setIfAbsent(key, value, ttlSeconds) {
    if (await this.get(key)) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  },
  async delete(key) {
    localEntries.delete(key);
  },
};

const redisBackend: ComputerChecksCacheBackend = {
  async get(key) {
    return getRedis().get(key);
  },
  async set(key, value, ttlSeconds) {
    await getRedis().set(key, value, "EX", ttlSeconds);
  },
  async setIfAbsent(key, value, ttlSeconds) {
    return (await getRedis().set(key, value, "EX", ttlSeconds, "NX")) === "OK";
  },
  async delete(key) {
    await getRedis().del(key);
  },
};

/** Redis when it is up (every replica reads one copy), this replica's memory otherwise; the usage cache's routing. */
function defaultBackend(): ComputerChecksCacheBackend {
  const current = () => (isRedisAvailable() ? redisBackend : localBackend);
  return {
    get: (key) => current().get(key),
    set: (key, value, ttlSeconds) => current().set(key, value, ttlSeconds),
    setIfAbsent: (key, value, ttlSeconds) => current().setIfAbsent(key, value, ttlSeconds),
    delete: (key) => current().delete(key),
  };
}

export function computerChecksReportKey(machineId: string): string {
  return `${REPORT_KEY_PREFIX}:${machineId}`;
}

export function computerChecksRefreshKey(machineId: string): string {
  return `${REFRESH_KEY_PREFIX}:${machineId}`;
}

/**
 * Credentials masked, then control, bidi and invisible characters removed
 * (the shared plain-text rule, `plainActionCardText`, as the Computer applies
 * to display names), then cut to 120 characters.
 */
export function scrubComputerCheckText(text: string): string {
  const clean = plainActionCardText(redactDiagnosticCredentials(text, { mask: SCRUB_MASK }), Number.MAX_SAFE_INTEGER);
  return clean.length <= COMPUTER_CHECK_TEXT_MAX ? clean : `${clean.slice(0, COMPUTER_CHECK_TEXT_MAX - 1)}…`;
}

/**
 * The last line of defense (the Computer scrubs too): every key, label and
 * value through the shared credential rules. Text is kept as plain data,
 * never interpreted (`displayText` rows included).
 */
export function scrubComputerChecksReport(report: ComputerChecksWireReport): ComputerChecksWireReport {
  return {
    ...report,
    plugins: report.plugins.map((plugin) => ({
      ...plugin,
      items: plugin.items.map((item) => ({
        ...item,
        key: scrubComputerCheckText(item.key),
        label: scrubComputerCheckText(item.label),
        ...(item.value !== undefined ? { value: scrubComputerCheckText(item.value) } : {}),
      })),
    })),
  };
}

export interface StoredComputerChecksReport {
  report: ComputerChecksWireReport;
  /** When this server received it. */
  receivedAt: string;
}

export class ComputerChecksCacheService {
  constructor(private readonly backend: ComputerChecksCacheBackend = defaultBackend()) {}

  /** Re-read and scrubbed on write: what is not a report is not kept. Replaces the last one. */
  async write(machineId: string, value: unknown, receivedAtMs: number = currentTimeMs()): Promise<StoredComputerChecksReport | null> {
    const parsed = parseComputerChecksReport(value);
    if (!parsed) return null;
    const scrubbed = parseComputerChecksReport(scrubComputerChecksReport(parsed));
    if (!scrubbed) return null;
    const stored: StoredComputerChecksReport = { report: scrubbed, receivedAt: new Date(receivedAtMs).toISOString() };
    await this.backend.set(computerChecksReportKey(machineId), JSON.stringify(stored), COMPUTER_CHECKS_REPORT_KEEP_SECONDS);
    return stored;
  }

  /** Null: no report within 7 days, or one that no longer reads (unknown). */
  async read(machineId: string): Promise<StoredComputerChecksReport | null> {
    const raw = await this.backend.get(computerChecksReportKey(machineId));
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as { report?: unknown; receivedAt?: unknown };
      const report = parseComputerChecksReport(value.report);
      if (!report || typeof value.receivedAt !== "string" || Number.isNaN(Date.parse(value.receivedAt))) return null;
      return { report, receivedAt: value.receivedAt };
    } catch {
      return null;
    }
  }

  /** Claims this Computer's refresh for 30 s, shared by every replica (SET NX EX). False: one was asked for within 30 s. */
  async tryClaimRefresh(machineId: string, nowMs: number = currentTimeMs()): Promise<boolean> {
    return this.backend.setIfAbsent(computerChecksRefreshKey(machineId), String(nowMs), REFRESH_CLAIM_SECONDS);
  }

  /**
   * Gives a claim back when its refresh was not sent (the Computer went
   * offline, the flag went off): only the claim made at `claimedAtMs`, never
   * a later one.
   */
  async releaseRefresh(machineId: string, claimedAtMs: number): Promise<void> {
    if (await this.refreshRequestedAtMs(machineId) === claimedAtMs) await this.backend.delete(computerChecksRefreshKey(machineId));
  }

  /** When the refresh claimed within the last 30 s was asked for; null when none was. */
  async refreshRequestedAtMs(machineId: string): Promise<number | null> {
    const raw = await this.backend.get(computerChecksRefreshKey(machineId));
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  }
}

export const computerChecksCacheService = new ComputerChecksCacheService();
