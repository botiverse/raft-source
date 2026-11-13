import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LegacyCredentialExposureReport } from "@botiverse/raft-shared";

/**
 * #proj-raft-computer task #38: the legacy chat-bridge cleanup found this
 * machine's CURRENT key in a file an agent could read. Removing the file
 * cannot undo a read, so the owner is told to move the machine to a Computer
 * credential (that retires the old key). The daemon keeps the finding in its
 * own Raft home until the key it was about is no longer the key it runs with,
 * and every `ready` reports it, so a restart before the server stored it does
 * not lose it. Only legacy `sk_machine_*` keys are reported: a Computer key
 * has no owner path to replace it, so that case stays a trace.
 */
const FILE_NAME = "legacy-credential-exposure.json";

/** First 16 hex characters of sha256(key): the server's `apiKeyFingerprint`. */
export function machineKeyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

export function isLegacyMachineKey(apiKey: string | null | undefined): apiKey is string {
  return typeof apiKey === "string" && apiKey.startsWith("sk_machine_");
}

function file(raftHome: string): string {
  return path.join(raftHome, FILE_NAME);
}

/** Keep the first finding for this key; a finding about another key is replaced. */
export function recordLegacyCredentialExposure(raftHome: string, apiKey: string, nowMs: number): LegacyCredentialExposureReport {
  const keyFingerprint = machineKeyFingerprint(apiKey);
  const existing = readReport(raftHome);
  if (existing && existing.keyFingerprint === keyFingerprint) return existing;
  const report: LegacyCredentialExposureReport = { foundAt: new Date(nowMs).toISOString(), keyFingerprint };
  mkdirSync(raftHome, { recursive: true, mode: 0o700 });
  const temp = `${file(raftHome)}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(report), { mode: 0o600, flag: "wx" });
    renameSync(temp, file(raftHome));
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return report;
}

/** What `ready` reports: the finding while it is about the key this daemon runs with; a stale one is removed. */
export function legacyCredentialExposureForReady(raftHome: string, apiKey: string | null | undefined): LegacyCredentialExposureReport | null {
  const report = readReport(raftHome);
  if (!report) return null;
  if (!isLegacyMachineKey(apiKey) || report.keyFingerprint !== machineKeyFingerprint(apiKey)) {
    rmSync(file(raftHome), { force: true });
    return null;
  }
  return report;
}

function readReport(raftHome: string): LegacyCredentialExposureReport | null {
  try {
    const value = JSON.parse(readFileSync(file(raftHome), "utf8")) as Partial<LegacyCredentialExposureReport>;
    if (typeof value.foundAt !== "string" || Number.isNaN(Date.parse(value.foundAt))) return null;
    if (typeof value.keyFingerprint !== "string" || !/^[0-9a-f]{16}$/.test(value.keyFingerprint)) return null;
    return { foundAt: value.foundAt, keyFingerprint: value.keyFingerprint };
  } catch {
    return null;
  }
}
