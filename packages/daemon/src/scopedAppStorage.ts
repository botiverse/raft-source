import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export type ScopedAppStorage = {
  assertActive(): void;
  readText(): string | null;
  writeTextAtomic(contents: string): void;
  reportDataFailure(reason: "invalid_payload" | "internal_error"): void;
};

export type ScopedAppStorageScope = {
  appId: string;
  agentId?: string;
};

export type ScopedAppStorageFactory = {
  open(scope: ScopedAppStorageScope): ScopedAppStorage;
  quarantineLegacyFile(relativePath: string, appId: string): "absent" | "quarantined";
  revoke(): void;
};

export type ScopedAppStorageFailureEvent = {
  operation: "access" | "read" | "write" | "decode" | "legacy_quarantine";
  store: "app_state" | "legacy_unscoped";
  appId: string;
  serverId: string;
  writerEpoch: string;
  outcome: "denied" | "failed";
  reason:
    | "capability_revoked"
    | "permission_denied"
    | "path_missing"
    | "invalid_payload"
    | "internal_error"
    | "lock_contention"
    | "storage_io"
    | "unknown";
  /** Opaque file-generation identity; never a path, payload, or Agent id. */
  failureInstanceId?: string;
  /** First observation of a generation is EDGE; repeats are LEVEL. */
  observation?: "edge" | "level";
};

export type ScopedAppStorageOwner = {
  machineId: string;
  serverId: string;
};

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function requireSafeSegment(kind: string, value: string): string {
  if (!SAFE_SEGMENT.test(value) || value === "." || value === "..") {
    throw new Error(`scoped app storage ${kind} is invalid`);
  }
  return value;
}

function requireSafeRelativePath(value: string): string {
  if (!value || path.isAbsolute(value)) {
    throw new Error("scoped app storage legacy path is invalid");
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("scoped app storage legacy path escapes root");
  }
  return normalized;
}

function readTextWithGeneration(filePath: string): {
  text: string | null;
  generation: string | null;
} {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { text: null, generation: null };
    }
    throw error;
  }
  try {
    const stats = fstatSync(fd, { bigint: true });
    const generation = createHash("sha256")
      .update([
        stats.dev,
        stats.ino,
        stats.size,
        stats.mtimeNs,
        stats.ctimeNs,
      ].map(String).join(":"))
      .digest("hex");
    return { text: readFileSync(fd, "utf8"), generation };
  } finally {
    closeSync(fd);
  }
}

function writeTextAtomic(filePath: string, contents: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(tempPath, contents, { mode: 0o600 });
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function classifyScopedAppStorageFailureReason(
  error: unknown,
): ScopedAppStorageFailureEvent["reason"] {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  if (code === "ENOENT") return "path_missing";
  if (code === "EAGAIN" || code === "EBUSY" || code === "EEXIST") return "lock_contention";
  if (typeof code === "string" && code.startsWith("E")) return "storage_io";
  return "unknown";
}

/**
 * Platform-owned durable storage for one authenticated Computer/Server pair.
 * Apps receive only the returned read/write capability; they never receive the
 * root, an absolute path, or authority to construct a sibling scope.
 */
export function createScopedAppStorageFactory(options: {
  slockHome: string;
  owner: ScopedAppStorageOwner;
  writerEpoch?: string;
  onFailure?: (event: ScopedAppStorageFailureEvent) => void;
}): ScopedAppStorageFactory {
  const slockHome = path.resolve(options.slockHome);
  const machineId = requireSafeSegment("machine id", options.owner.machineId);
  const serverId = requireSafeSegment("server id", options.owner.serverId);
  const writerEpoch = requireSafeSegment(
    "writer epoch",
    options.writerEpoch ?? randomUUID(),
  );
  const ownerRoot = path.join(slockHome, "app-storage", "v1", machineId, serverId);
  let revoked = false;
  const emitFailure = (
    input: Omit<ScopedAppStorageFailureEvent, "serverId" | "writerEpoch">,
  ) => options.onFailure?.({ ...input, serverId, writerEpoch });
  const requireActive = (appId: string) => {
    if (revoked) {
      emitFailure({
        operation: "access",
        store: "app_state",
        appId,
        outcome: "denied",
        reason: "capability_revoked",
      });
      throw new Error("scoped app storage capability is revoked");
    }
  };

  return {
    open(scope) {
      const appId = requireSafeSegment("app id", scope.appId);
      requireActive(appId);
      const agentId = scope.agentId === undefined
        ? null
        : requireSafeSegment("agent id", scope.agentId);
      const filePath = agentId === null
        ? path.join(ownerRoot, appId, "computer", "state.json")
        : path.join(ownerRoot, appId, "agents", agentId, "state.json");
      let lastReadGeneration: string | null = null;
      const lastReportedGeneration = new Map<"invalid_payload" | "internal_error", string>();
      return {
        assertActive: () => requireActive(appId),
        readText: () => {
          requireActive(appId);
          try {
            const read = readTextWithGeneration(filePath);
            lastReadGeneration = read.generation;
            return read.text;
          } catch (error) {
            emitFailure({
              operation: "read",
              store: "app_state",
              appId,
              outcome: "failed",
              reason: classifyScopedAppStorageFailureReason(error),
            });
            throw error;
          }
        },
        writeTextAtomic: (contents) => {
          requireActive(appId);
          try {
            writeTextAtomic(filePath, contents);
            lastReadGeneration = null;
          } catch (error) {
            emitFailure({
              operation: "write",
              store: "app_state",
              appId,
              outcome: "failed",
              reason: classifyScopedAppStorageFailureReason(error),
            });
            throw error;
          }
        },
        reportDataFailure: (reason) => {
          requireActive(appId);
          const failureInstanceId = lastReadGeneration
            ?? createHash("sha256").update(`unread:${randomUUID()}`).digest("hex");
          lastReadGeneration = failureInstanceId;
          const observation = lastReportedGeneration.get(reason) === failureInstanceId
            ? "level"
            : "edge";
          lastReportedGeneration.set(reason, failureInstanceId);
          emitFailure({
            operation: "decode",
            store: "app_state",
            appId,
            outcome: "failed",
            reason,
            failureInstanceId,
            observation,
          });
        },
      };
    },

    quarantineLegacyFile(relativePath, rawAppId) {
      const appId = requireSafeSegment("app id", rawAppId);
      requireActive(appId);
      const safeRelativePath = requireSafeRelativePath(relativePath);
      const sourcePath = path.join(slockHome, safeRelativePath);
      try {
        statSync(sourcePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
        emitFailure({
          operation: "legacy_quarantine",
          store: "legacy_unscoped",
          appId,
          outcome: "failed",
          reason: classifyScopedAppStorageFailureReason(error),
        });
        throw error;
      }

      const quarantineRoot = path.join(slockHome, "app-storage-quarantine", "v1", "unscoped");
      const leaf = path.basename(safeRelativePath);
      const destinationPath = path.join(
        quarantineRoot,
        `${randomUUID()}-${leaf}`,
      );
      try {
        mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
        renameSync(sourcePath, destinationPath);
        return "quarantined";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
        emitFailure({
          operation: "legacy_quarantine",
          store: "legacy_unscoped",
          appId,
          outcome: "failed",
          reason: classifyScopedAppStorageFailureReason(error),
        });
        throw error;
      }
    },

    revoke() {
      revoked = true;
    },
  };
}
