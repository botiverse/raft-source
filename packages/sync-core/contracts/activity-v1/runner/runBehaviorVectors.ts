import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSyncCore } from "../../../src/core.js";
import type { SyncSeq } from "../../../src/types.js";
import {
  ACTIVITY_DOMAIN,
  createActivityDomain,
  encodeActivityScopeId,
} from "../../../src/domains/activity.js";
import type { SyncDomainConfig } from "../../../src/types.js";

/**
 * Web (TypeScript) behavior-vector runner — milestone ① acceptance.
 *
 * Reads the immutable `activity-sync.behavior.jsonl` bytes, drives the REAL
 * production core + Activity reducer, and emits one canonical result per case.
 * The KMP runner consumes the same bytes and must produce the same digest.
 *
 * The point of this file is the comparison, so the only thing that matters is
 * that identical behavior serialises identically on both platforms. Two honest
 * implementations disagreeing purely because `JSON.stringify` and kotlinx emit
 * keys in different orders would be a false RED, and — worse — the reverse can
 * hide a real divergence behind a coincidentally equal string. Hence
 * `canonicalJson` below, which is a contract, not a formatting preference.
 */

/**
 * Ingress branches runnerProtocol 1 drives through the core.
 *
 * `commandReceipt` / `commandRejected` are deliberately absent: the contract
 * defines them without a `seq`, and the two `done` routes still return bare
 * `{ok:true}` server-side, so there is no authoritative receipt to sequence
 * yet. They are declared vocabulary, not executable reducer input.
 */
export const SEQUENCED_INGRESS_BRANCHES = [
  "snapshot",
  "notModified",
  "difference",
  "frame",
  "readStateUpdated",
] as const;

export interface BehaviorCaseResult {
  caseId: string;
  steps: Array<{ stepId: string; outcome: unknown }>;
  pending: unknown;
  violations: unknown;
  finalState: Record<string, unknown>;
}

/**
 * Canonical JSON for cross-platform digests.
 *
 * Rules (must match the KMP side exactly):
 *   - object keys sorted by UTF-16 code unit, ascending
 *   - no insignificant whitespace
 *   - arrays keep semantic order (never sorted — order IS behavior here)
 *   - `undefined` is dropped from objects and encoded as null in arrays
 *   - numbers are emitted by the platform's shortest round-trip form; every
 *     uint64 in this contract is already a decimal STRING, so no 2^53 value
 *     ever reaches this function as a number
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") {
    // Sequences are exact positions; they leave the runner as canonical
    // decimal STRINGS so the KMP side compares the same bytes rather than a
    // platform-dependent numeric rendering.
    return JSON.stringify(value.toString());
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number is not canonicalisable");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new Error(`unsupported value in canonical JSON: ${typeof value}`);
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Parse a contract `UInt64String` into an exact sequence.
 *
 * `Number()` is a defect here, not a shortcut: 9007199254740992 and
 * 9007199254740993 collapse to the same double, so two adjacent positions
 * become one and the core reports a false duplicate/conflict. The wire type is
 * a decimal string precisely to prevent that, and this is the boundary where
 * the guarantee is either kept or thrown away.
 */
function exactSeq(value: unknown, field: string): SyncSeq {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${field} must be a canonical decimal UInt64String, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

function scopeIdOf(ingress: Record<string, unknown>): string {
  const scope = ingress.scope as Record<string, string> | undefined;
  if (!scope) throw new Error("ingress carries no scope");
  return encodeActivityScopeId({
    serverId: scope.serverId!,
    principalId: scope.principalId!,
    filter: scope.filter!,
    windowId: scope.windowId!,
  });
}

/**
 * Map one contract ingress onto the core's ingest surface.
 *
 * `snapshot` / `difference` / `frame` are core-level plumbing; the remaining
 * branches are domain events delivered as frames. `notModified` is deliberately
 * a no-op with a recorded outcome: it asserts nothing changed, which is itself
 * an observable the KMP side must agree on.
 */
function applyStep(
  core: ReturnType<typeof createSyncCore>,
  ingress: Record<string, unknown>,
): unknown {
  const scopeId = scopeIdOf(ingress);
  const type = ingress.type as string;

  switch (type) {
    case "snapshot":
      return core.ingestSnapshot(ACTIVITY_DOMAIN, {
        scopeId,
        watermark: exactSeq(ingress.watermark, "watermark"),
        epoch: (ingress.epoch as string) ?? null,
        state: ingress,
      });
    case "difference":
      return core.ingestDifference(ACTIVITY_DOMAIN, {
        scopeId,
        epoch: (ingress.epoch as string) ?? null,
        fromSeq: exactSeq(ingress.fromSeq, "fromSeq"),
        toSeq: exactSeq(ingress.toSeq, "toSeq"),
        events: [{ seq: exactSeq(ingress.toSeq, "toSeq"), event: { ...ingress, type: "frame" } }],
      });
    case "notModified":
      // Asserting nothing changed IS an observable both platforms must agree on.
      return { kind: "not_modified", scopeId };
    case "commandReceipt":
    case "commandRejected":
      // These two branches carry NO `seq` in the frozen contract, so they
      // cannot be sequenced frames. The first implementation injected `seq: 0`,
      // which fabricated a position the server never sent and made every
      // receipt look like a replay of the scope's origin. runnerProtocol 1
      // therefore does not sequence them; refusing loudly is honest, inventing
      // a sequence is not. See SEQUENCED_INGRESS_BRANCHES.
      throw new Error(
        `${type} is not sequenced by runnerProtocol 1: the contract gives it no seq`,
      );
    case "frame":
    case "readStateUpdated":
      return core.ingestFrame(ACTIVITY_DOMAIN, {
        scopeId,
        seq: exactSeq(ingress.seq, "seq"),
        epoch: (ingress.epoch as string) ?? null,
        event: ingress,
      });
    default:
      throw new Error(`unknown ingress type ${JSON.stringify(type)}: the union is closed`);
  }
}

export function runCase(envelope: Record<string, unknown>): BehaviorCaseResult {
  const core = createSyncCore({
    domains: [createActivityDomain() as SyncDomainConfig<unknown, unknown>],
  });

  const steps: BehaviorCaseResult["steps"] = [];
  const scopeIds = new Set<string>();

  for (const raw of envelope.steps as Array<Record<string, unknown>>) {
    // Silently skipping a step would let a fixture claim coverage it never
    // exercised. Refuse anything this protocol does not execute.
    if (raw.type !== "ingest") {
      throw new Error(`fixture step type ${JSON.stringify(raw.type)} is not executed by runnerProtocol 1`);
    }
    const ingress = raw.ingress as Record<string, unknown>;
    scopeIds.add(scopeIdOf(ingress));
    steps.push({ stepId: raw.stepId as string, outcome: applyStep(core, ingress) });
  }

  const finalState: Record<string, unknown> = {};
  for (const scopeId of [...scopeIds].sort()) {
    finalState[scopeId] = core.state(ACTIVITY_DOMAIN, scopeId) ?? null;
  }

  const drained = core.violations();
  return {
    caseId: envelope.caseId as string,
    steps,
    pending: core.pendingRequests(),
    // `index` is a ring-buffer counter tied to drain timing, not behavior; it
    // must not force the two platforms to agree on bookkeeping.
    violations: drained.records.map(({ index: _index, ...rest }) => rest),
    finalState,
  };
}

export interface BehaviorRunReport {
  runnerProtocol: 1;
  vectorsSha256: string;
  cases: Array<{ caseId: string; digest: string }>;
  digest: string;
}

export function runBehaviorVectors(jsonlPath: string): BehaviorRunReport {
  const bytes = readFileSync(jsonlPath, "utf8");
  const envelopes = bytes
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  const results = envelopes.map(runCase);
  return {
    runnerProtocol: 1,
    vectorsSha256: sha256Hex(bytes),
    cases: results.map((result) => ({
      caseId: result.caseId,
      digest: sha256Hex(canonicalJson(result)),
    })),
    // The aggregate is a digest over the per-case canonical results in file
    // order, so a divergence localises to one case instead of one opaque number.
    digest: sha256Hex(canonicalJson(results)),
  };
}

export const BEHAVIOR_VECTORS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/activity-sync.behavior.jsonl",
);

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const report = runBehaviorVectors(BEHAVIOR_VECTORS_PATH);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
