import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { currentDate } from "@botiverse/raft-shared";

import type { AgentContext } from "../../auth/env.js";
import type { AgentManifestActionV1 } from "./manifestV1.js";

export type InvocationTerminalStateV1 =
  | "dispatching"
  | "accepted_unverified"
  | "verified"
  | "failed"
  | "indeterminate";

export interface InvocationBindingV1 {
  actorId: string;
  serverId: string;
  integrationId: string;
  serviceId: string;
  action: string;
  effect: AgentManifestActionV1["effect"];
  effectiveContractSha256: string;
  requestBindingSha256: string;
  idempotencyMode: AgentManifestActionV1["idempotency"]["mode"];
  idempotencyScope?: "actor_action";
}

export interface InvocationRecordV1 extends InvocationBindingV1 {
  schema: "raft-integration-invocation.v1";
  invocationId: string;
  attempt: number;
  rawIdempotencyKey?: string;
  keySha256?: string;
  lastReceiptId: string | null;
  state: InvocationTerminalStateV1;
  createdAt: string;
  updatedAt: string;
}

export class InvocationStoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INTEGRATION_RETRY_PERSISTENCE_REQUIRED"
      | "INTEGRATION_RETRY_BINDING_MISMATCH",
  ) {
    super(message);
    this.name = "InvocationStoreError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TERMINAL_STATES = new Set<InvocationTerminalStateV1>([
  "dispatching",
  "accepted_unverified",
  "verified",
  "failed",
  "indeterminate",
]);
const EFFECTS = new Set<AgentManifestActionV1["effect"]>([
  "read",
  "create",
  "update",
  "delete",
  "external_side_effect",
]);
const IDEMPOTENCY_MODES = new Set<AgentManifestActionV1["idempotency"]["mode"]>([
  "safe",
  "idempotent",
  "key_required",
  "non_idempotent",
]);

function resolveStateRoot(env: NodeJS.ProcessEnv): string {
  const configured = env.RAFT_HOME?.trim() || env.SLOCK_HOME?.trim();
  if (configured) return configured;
  return path.join(env.HOME ?? os.homedir(), ".slock");
}

function invocationRoot(input: {
  agentContext: AgentContext;
  env: NodeJS.ProcessEnv;
}): string {
  const root = input.agentContext.profileCredentialPath
    ? path.dirname(input.agentContext.profileCredentialPath)
    : path.join(resolveStateRoot(input.env), "integration-invocations", input.agentContext.agentId);
  return path.join(root, "integration-invocations-v1");
}

export function invocationRecordPath(input: {
  agentContext: AgentContext;
  env: NodeJS.ProcessEnv;
  invocationId: string;
}): string {
  if (!UUID_PATTERN.test(input.invocationId)) {
    throw new InvocationStoreError(
      "retry invocation id must be a canonical UUID",
      "INTEGRATION_RETRY_BINDING_MISMATCH",
    );
  }
  return path.join(invocationRoot(input), `${input.invocationId.toLowerCase()}.json`);
}

function writeAtomic(filePath: string, record: InvocationRecordV1, exclusive: boolean): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (exclusive && fs.existsSync(filePath)) {
      throw new Error("invocation record already exists");
    }
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
    const directoryFd = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The temporary file may already have been atomically renamed.
    }
    throw new InvocationStoreError(
      `could not durably persist the invocation binding: ${(error as Error).message}`,
      "INTEGRATION_RETRY_PERSISTENCE_REQUIRED",
    );
  }
}

function parseRecord(raw: string): InvocationRecordV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvocationStoreError(
      "stored invocation binding is not valid JSON",
      "INTEGRATION_RETRY_BINDING_MISMATCH",
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new InvocationStoreError(
      "stored invocation binding is invalid",
      "INTEGRATION_RETRY_BINDING_MISMATCH",
    );
  }
  const record = parsed as Partial<InvocationRecordV1>;
  if (
    record.schema !== "raft-integration-invocation.v1"
    || typeof record.invocationId !== "string"
    || !UUID_PATTERN.test(record.invocationId)
    || !Number.isSafeInteger(record.attempt)
    || Number(record.attempt) < 1
    || typeof record.actorId !== "string"
    || !record.actorId
    || typeof record.serverId !== "string"
    || !record.serverId
    || typeof record.integrationId !== "string"
    || !record.integrationId
    || typeof record.serviceId !== "string"
    || !record.serviceId
    || typeof record.action !== "string"
    || !record.action
    || typeof record.effect !== "string"
    || !EFFECTS.has(record.effect as AgentManifestActionV1["effect"])
    || typeof record.effectiveContractSha256 !== "string"
    || !SHA256_PATTERN.test(record.effectiveContractSha256)
    || typeof record.requestBindingSha256 !== "string"
    || !SHA256_PATTERN.test(record.requestBindingSha256)
    || typeof record.idempotencyMode !== "string"
    || !IDEMPOTENCY_MODES.has(record.idempotencyMode as AgentManifestActionV1["idempotency"]["mode"])
    || typeof record.state !== "string"
    || !TERMINAL_STATES.has(record.state as InvocationTerminalStateV1)
    || (record.lastReceiptId !== null
      && (typeof record.lastReceiptId !== "string" || !UUID_PATTERN.test(record.lastReceiptId)))
    || typeof record.createdAt !== "string"
    || !Number.isFinite(Date.parse(record.createdAt))
    || typeof record.updatedAt !== "string"
    || !Number.isFinite(Date.parse(record.updatedAt))
  ) {
    throw new InvocationStoreError(
      "stored invocation binding has an invalid shape",
      "INTEGRATION_RETRY_BINDING_MISMATCH",
    );
  }
  if (record.idempotencyMode === "key_required") {
    if (
      record.idempotencyScope !== "actor_action"
      || typeof record.rawIdempotencyKey !== "string"
      || record.rawIdempotencyKey.length < 32
      || record.rawIdempotencyKey.length > 256
      || typeof record.keySha256 !== "string"
      || !SHA256_PATTERN.test(record.keySha256)
      || createKeyDigest(record.rawIdempotencyKey) !== record.keySha256
    ) {
      throw new InvocationStoreError(
        "stored key_required invocation binding is invalid",
        "INTEGRATION_RETRY_BINDING_MISMATCH",
      );
    }
  } else if (
    record.idempotencyScope !== undefined
    || record.rawIdempotencyKey !== undefined
    || record.keySha256 !== undefined
  ) {
    throw new InvocationStoreError(
      "stored invocation binding carries unexpected idempotency-key material",
      "INTEGRATION_RETRY_BINDING_MISMATCH",
    );
  }
  return record as InvocationRecordV1;
}

function loadRecord(filePath: string): InvocationRecordV1 {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new InvocationStoreError(
        "the requested invocation binding is not a private regular file",
        "INTEGRATION_RETRY_BINDING_MISMATCH",
      );
    }
    return parseRecord(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error instanceof InvocationStoreError) throw error;
    throw new InvocationStoreError(
      "the requested invocation binding does not exist or is unreadable",
      "INTEGRATION_RETRY_BINDING_MISMATCH",
    );
  }
}

function assertBindingMatches(record: InvocationRecordV1, binding: InvocationBindingV1): void {
  const fields: Array<keyof InvocationBindingV1> = [
    "actorId",
    "serverId",
    "integrationId",
    "serviceId",
    "action",
    "effect",
    "effectiveContractSha256",
    "requestBindingSha256",
    "idempotencyMode",
    "idempotencyScope",
  ];
  for (const field of fields) {
    if (record[field] !== binding[field]) {
      throw new InvocationStoreError(
        `retry binding mismatch at ${field}`,
        "INTEGRATION_RETRY_BINDING_MISMATCH",
      );
    }
  }
}

function withRecordLock<T>(filePath: string, fn: () => T): T {
  const lockPath = `${filePath}.lock`;
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "wx", 0o600);
  } catch {
    throw new InvocationStoreError(
      "the invocation binding is already being used by another process",
      "INTEGRATION_RETRY_PERSISTENCE_REQUIRED",
    );
  }
  try {
    fs.writeFileSync(fd, `${process.pid}\n`, "utf8");
    fs.fsyncSync(fd);
    return fn();
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Leaving a stale lock fails later retries closed.
    }
  }
}

export function prepareInvocationAttemptV1(input: {
  agentContext: AgentContext;
  env: NodeJS.ProcessEnv;
  binding: InvocationBindingV1;
  retryInvocationId?: string;
  now?: () => Date;
  randomId?: () => string;
  randomKey?: () => string;
}): InvocationRecordV1 {
  const now = (input.now?.() ?? currentDate()).toISOString();
  if (!input.retryInvocationId) {
    const invocationId = (input.randomId ?? randomUUID)();
    const filePath = invocationRecordPath({
      agentContext: input.agentContext,
      env: input.env,
      invocationId,
    });
    const rawIdempotencyKey = input.binding.idempotencyMode === "key_required"
      ? (input.randomKey ?? (() => randomBytes(32).toString("base64url")))()
      : undefined;
    const record: InvocationRecordV1 = {
      schema: "raft-integration-invocation.v1",
      invocationId,
      ...input.binding,
      ...(rawIdempotencyKey
        ? {
            rawIdempotencyKey,
            keySha256: createKeyDigest(rawIdempotencyKey),
          }
        : {}),
      attempt: 1,
      lastReceiptId: null,
      state: "dispatching",
      createdAt: now,
      updatedAt: now,
    };
    writeAtomic(filePath, record, true);
    return record;
  }

  const filePath = invocationRecordPath({
    agentContext: input.agentContext,
    env: input.env,
    invocationId: input.retryInvocationId,
  });
  return withRecordLock(filePath, () => {
    const existing = loadRecord(filePath);
    if (existing.invocationId.toLowerCase() !== input.retryInvocationId?.toLowerCase()) {
      throw new InvocationStoreError(
        "retry invocation id does not match the stored binding",
        "INTEGRATION_RETRY_BINDING_MISMATCH",
      );
    }
    assertBindingMatches(existing, input.binding);
    if (existing.idempotencyMode === "non_idempotent") {
      throw new InvocationStoreError(
        "non_idempotent invocations cannot be retried",
        "INTEGRATION_RETRY_BINDING_MISMATCH",
      );
    }
    if (existing.state === "verified") {
      throw new InvocationStoreError(
        "a verified invocation cannot be retried",
        "INTEGRATION_RETRY_BINDING_MISMATCH",
      );
    }
    if (existing.state === "dispatching") {
      throw new InvocationStoreError(
        "the prior invocation attempt is still dispatching or was not durably finalized",
        "INTEGRATION_RETRY_PERSISTENCE_REQUIRED",
      );
    }
    if (existing.idempotencyMode === "key_required" && !existing.rawIdempotencyKey) {
      throw new InvocationStoreError(
        "the original idempotency key is unavailable",
        "INTEGRATION_RETRY_PERSISTENCE_REQUIRED",
      );
    }
    const next: InvocationRecordV1 = {
      ...existing,
      attempt: existing.attempt + 1,
      state: "dispatching",
      updatedAt: now,
    };
    writeAtomic(filePath, next, false);
    return next;
  });
}

export function finalizeInvocationAttemptV1(input: {
  agentContext: AgentContext;
  env: NodeJS.ProcessEnv;
  invocationId: string;
  attempt: number;
  receiptId: string;
  state: Exclude<InvocationTerminalStateV1, "dispatching">;
  now?: () => Date;
}): InvocationRecordV1 {
  const filePath = invocationRecordPath(input);
  return withRecordLock(filePath, () => {
    const existing = loadRecord(filePath);
    if (existing.attempt !== input.attempt || existing.state !== "dispatching") {
      throw new InvocationStoreError(
        "invocation attempt state changed before receipt finalization",
        "INTEGRATION_RETRY_BINDING_MISMATCH",
      );
    }
    const next: InvocationRecordV1 = {
      ...existing,
      lastReceiptId: input.receiptId,
      state: input.state,
      updatedAt: (input.now?.() ?? currentDate()).toISOString(),
    };
    writeAtomic(filePath, next, false);
    return next;
  });
}

function createKeyDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
