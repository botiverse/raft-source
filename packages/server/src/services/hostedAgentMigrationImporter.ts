/**
 * The server-side "target" of a migration to Raft hosted (task #16, R4).
 *
 * Runs in the background worker, never on an API request path (RFC 042's
 * intent; Tenny 2026-10-18). For one claimed migration it:
 *
 * 1. reads the uploaded bundle from object storage through the shared bundle
 *    reader (chunk and whole-bundle digests, archive safety checks), twice:
 *    first entry metadata only, to choose files by priority within the
 *    provider's limits; then only the chosen files' bytes;
 * 2. asks the provider which of them it would refuse (`import-check`), drops
 *    those, and checks again until nothing is refused;
 * 3. persists the import body to object storage, so a post-switch retry does
 *    not depend on the transfer lease, and holds at most one import's worth
 *    (≤ the provider's 16 MiB request) in memory;
 * 4. records the review and tells the person who started the migration.
 *
 * All of this is before the switch: any failure ends the migration and the
 * agent stays on its Computer.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { currentDate, formatNotificationCopy } from "@botiverse/raft-shared";
import { readAgentMigrationBundle, readVerifiedAgentMigrationChunks } from "@botiverse/raft-shared/src/agentMigrationBundleReader";
import { resumableChunkStorageKey } from "./agentMigrationService";
import { resolveProviderConfig } from "./agentRuntimeProviderService";
import {
  buildProvisionImportBody,
  checkProvisionImport,
  ProvisionImportSourceError,
  onProvisionImported,
  registerProvisionImportSource,
  type ProvisionImportBody,
  type ProvisionImportFile,
} from "./agentRuntimeProvisionImport";
import {
  HOSTED_MIGRATION_IMPORT_SOURCE,
  claimHostedAgentMigrationImport,
  failHostedAgentMigrationBeforeSwitch,
  renewHostedAgentMigrationImportLease,
  recordHostedAgentMigrationFileSet,
  type HostedImportClaim,
} from "./hostedAgentMigrationService";
import {
  classifyHostedImportEntry,
  isHostedImportText,
  selectHostedImportFiles,
  summarizeHostedImport,
  type HostedImportCandidate,
  type HostedImportSkip,
} from "./hostedMigrationFileSelection";
import { getDirectUploadStorage, getStorage, type StorageBackend } from "./storageService";
import { hostedMigrationFileSetKey, hostedMigrationFileSetStorage } from "./hostedMigrationFileSet";
import { hostname } from "node:os";
import type { Server as SocketServer } from "socket.io";
import { and, eq } from "drizzle-orm";
import { setClockInterval } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentMigrationHostedTargets, agentMigrations, agents } from "../db/schema";
import type { AgentMigrationRow } from "./agentMigrationService";
import { emitAgentMigrationUpdated } from "./agentMigrationRealtime";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { onHostedMigrationImported, sweepHostedAgentMigrations } from "./hostedAgentMigrationCompletion";
import { enqueueNotificationRows } from "./notifications/enqueue";
import type { NotificationNoticePayload } from "./notifications/envelope";

/** Rounds of `import-check`: each drops what the provider listed; `more` means it listed only the first 200. */
const MAX_IMPORT_CHECK_ROUNDS = 20;

export class HostedImportBuildError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export { hostedMigrationFileSetKey, hostedMigrationFileSetStorage };

function chunkStream(storage: StorageBackend, migration: AgentMigrationRow) {
  return (chunk: { index: number }): AsyncIterable<Uint8Array> => {
    const key = resumableChunkStorageKey(migration.transportSessionId!, migration.transportGeneration!, chunk.index);
    return (async function* () {
      const stream = await storage.get(key);
      for await (const part of stream as AsyncIterable<Uint8Array>) yield part;
    })();
  };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

export interface HostedImportFileSet {
  body: ProvisionImportBody;
  imported: HostedImportCandidate[];
  skipped: HostedImportSkip[];
}

/** Steps 1–2: choose and check the files. Exported for tests. */
export async function buildHostedImportFileSet(input: {
  claim: HostedImportClaim;
  storage: StorageBackend;
  config: { baseUrl: string; token: string };
  /** Extend the importer lease between the long steps, so a big bundle is not taken over mid-build. */
  renewLease?: () => Promise<void>;
}): Promise<HostedImportFileSet> {
  const { migration, hosted } = input.claim;
  const control = migration.transportControlManifest;
  if (!control || !migration.transportSessionId || !migration.transportGeneration) {
    throw new HostedImportBuildError("MIGRATION_CONTROL_MANIFEST_MISSING", "The uploaded bundle has no control manifest");
  }
  const limits = hosted.importLimits;
  if (!limits) throw new HostedImportBuildError("HOSTED_TARGET_UNAVAILABLE", "No import limits were fixed for this migration");
  const openChunk = chunkStream(input.storage, migration);

  // Pass 1: metadata only.
  const candidates: HostedImportCandidate[] = [];
  const skipped: HostedImportSkip[] = [];
  let memoryPresent = false;
  await readAgentMigrationBundle({
    control,
    chunks: readVerifiedAgentMigrationChunks(control, openChunk),
    onEntry: async (entry) => {
      const meta = entry.type === "file"
        ? { type: "file" as const, path: entry.relativePath, sizeBytes: entry.sizeBytes }
        : { type: "symlink" as const, path: entry.relativePath };
      if (entry.relativePath === "MEMORY.md") memoryPresent = true;
      const reason = classifyHostedImportEntry(meta, limits);
      const sizeBytes = entry.type === "file" ? entry.sizeBytes : 0;
      if (reason) skipped.push({ path: entry.relativePath, sizeBytes, reason });
      else candidates.push({ path: entry.relativePath, sizeBytes });
    },
  });
  await input.renewLease?.();
  const { selected, overBudget } = selectHostedImportFiles(candidates, limits);
  for (const file of overBudget) skipped.push({ ...file, reason: "over_budget" });
  if (memoryPresent && !selected.some((file) => file.path === "MEMORY.md")) {
    throw new HostedImportBuildError("HOSTED_IMPORT_MEMORY_UNIMPORTABLE", "The workspace's MEMORY.md cannot be brought to the cloud");
  }

  // Pass 2: bytes of the chosen files only.
  const wanted = new Set(selected.map((file) => file.path));
  const contents = new Map<string, Buffer>();
  await readAgentMigrationBundle({
    control,
    chunks: readVerifiedAgentMigrationChunks(control, openChunk),
    onEntry: async (entry) => {
      if (entry.type !== "file" || !wanted.has(entry.relativePath)) return;
      const bytes = await readAll(entry.stream);
      if (isHostedImportText(bytes)) contents.set(entry.relativePath, bytes);
      else skipped.push({ path: entry.relativePath, sizeBytes: bytes.byteLength, reason: "not_text" });
    },
  });

  await input.renewLease?.();
  // Same order as the selection, so the body is the same for the same bundle.
  let files: ProvisionImportFile[] = selected
    .filter((file) => contents.has(file.path))
    .map((file) => ({ path: file.path, content: contents.get(file.path)! }));
  for (let round = 0; round < MAX_IMPORT_CHECK_ROUNDS; round += 1) {
    const body = buildProvisionImportBody(migration.supportRef, { files });
    const result = await checkProvisionImport(input.config, migration.serverId, body);
    if (!result.ok) {
      throw new HostedImportBuildError("HOSTED_TARGET_UNAVAILABLE", `Raft hosted could not check the import (${result.reason})`);
    }
    if (result.check.rejected.length === 0) {
      if (memoryPresent && !files.some((file) => file.path === "MEMORY.md")) {
        throw new HostedImportBuildError("HOSTED_IMPORT_MEMORY_UNIMPORTABLE", "The cloud refused the workspace's MEMORY.md");
      }
      const imported = files.map((file) => ({ path: file.path, sizeBytes: Buffer.byteLength(file.content as Buffer) }));
      return { body, imported, skipped };
    }
    // Map refusals back by index: the provider hides paths that look like credentials.
    const refused = new Set(result.check.rejected.map((rejection) => rejection.index));
    files.forEach((file, index) => {
      if (refused.has(index)) {
        skipped.push({ path: file.path, sizeBytes: Buffer.byteLength(file.content as Buffer), reason: "provider_rejected" });
      }
    });
    files = files.filter((_file, index) => !refused.has(index));
  }
  throw new HostedImportBuildError("HOSTED_TARGET_UNAVAILABLE", "The cloud kept refusing files after repeated checks");
}

export interface HostedImporterDeps {
  storage?: StorageBackend | null;
  /** Where the import body is written; default the dedicated attachment bucket when there is one. */
  fileSetStorage?: StorageBackend | null;
  /** Tell the person who started the migration that it waits for them. */
  notifyReviewReady?: (migration: AgentMigrationRow) => Promise<void>;
  onMigrationUpdated?: (migration: AgentMigrationRow) => Promise<void>;
}

/** One importer run. Returns false when there was nothing to claim. */
export async function runHostedAgentMigrationImporterOnce(input: { workerId: string; now?: Date } & HostedImporterDeps): Promise<boolean> {
  const claim = await claimHostedAgentMigrationImport({ workerId: input.workerId, now: input.now });
  if (!claim) return false;
  const fail = async (code: string, message: string) => {
    const failed = await failHostedAgentMigrationBeforeSwitch({ claim, code, message, now: input.now });
    if (failed) await input.onMigrationUpdated?.(failed);
  };
  const storage = input.storage ?? getStorage();
  const config = resolveProviderConfig(claim.hosted.provider);
  if (!storage || !config) {
    await fail("HOSTED_TARGET_UNAVAILABLE", "Object storage or the cloud provider is not configured");
    return true;
  }
  let fileSet: HostedImportFileSet;
  try {
    fileSet = await buildHostedImportFileSet({
      claim,
      storage,
      config,
      renewLease: async () => {
        if (!await renewHostedAgentMigrationImportLease(claim)) {
          throw new HostedImportBuildError("MIGRATION_CONCURRENT_UPDATE", "The importer lease was lost");
        }
      },
    });
  } catch (error) {
    const code = error instanceof HostedImportBuildError
      ? error.code
      : (error as { code?: unknown })?.code === "MIGRATION_CHUNK_DIGEST_MISMATCH" || (error as { code?: unknown })?.code === "MIGRATION_WHOLE_BUNDLE_DIGEST_MISMATCH"
        ? String((error as { code: string }).code)
        : error instanceof Error && /^MIGRATION_[A-Z_]+/.test(error.message)
          ? error.message.match(/^MIGRATION_[A-Z_]+/)![0]
          : "MIGRATION_TRANSPORT_LOST";
    await fail(code, error instanceof Error ? error.message : "Failed to build the import for the cloud");
    return true;
  }
  const serialized = Buffer.from(JSON.stringify(fileSet.body), "utf8");
  const dedicated = input.fileSetStorage !== undefined ? input.fileSetStorage : getDirectUploadStorage();
  const key = hostedMigrationFileSetKey(claim.migration.id, dedicated !== null);
  try {
    await (dedicated ?? storage).put(key, serialized, "application/json");
  } catch (error) {
    await fail("MIGRATION_TRANSPORT_LOST", error instanceof Error ? error.message : "Failed to store the import for the cloud");
    return true;
  }
  const migration = await recordHostedAgentMigrationFileSet({
    claim,
    fileSetObjectKey: key,
    fileSetSha256: createHash("sha256").update(serialized).digest("hex"),
    importSummary: summarizeHostedImport({ imported: fileSet.imported, skipped: fileSet.skipped }),
    now: input.now ?? currentDate(),
  });
  if (!migration) return true;
  await input.onMigrationUpdated?.(migration);
  try {
    await input.notifyReviewReady?.(migration);
  } catch (error) {
    // The review is visible in the panel either way; a failed push must not undo it.
    console.warn(`[HostedMigration] Review notification failed for ${migration.id}:`, error instanceof Error ? error.message : error);
  }
  return true;
}

/**
 * `computer_migration` import source: the body the importer persisted, read
 * back by the migration's support ref. Files come back in the stored order,
 * so the provider's one import is retried with the same body.
 */
registerProvisionImportSource(HOSTED_MIGRATION_IMPORT_SOURCE, async ({ agentId, importRef }) => {
  if (!importRef) throw new ProvisionImportSourceError("The import has no migration reference", "import_ref_missing", false);
  const [row] = await getDb().select({ key: agentMigrationHostedTargets.fileSetObjectKey, sha256: agentMigrationHostedTargets.fileSetSha256 })
    .from(agentMigrations)
    .innerJoin(agentMigrationHostedTargets, eq(agentMigrationHostedTargets.migrationId, agentMigrations.id))
    .where(and(eq(agentMigrations.supportRef, importRef), eq(agentMigrations.agentId, agentId)))
    .limit(1);
  if (!row?.key) throw new ProvisionImportSourceError("The migration's file set is missing", "file_set_missing", false);
  const storage = hostedMigrationFileSetStorage(row.key);
  if (!storage) throw new ProvisionImportSourceError("Object storage is not configured", "storage_unavailable", true);
  let stored: Buffer;
  try {
    stored = await readAll(await storage.get(row.key));
  } catch {
    throw new ProvisionImportSourceError("The migration's file set could not be read", "file_set_unreadable", true);
  }
  // The body the user reviewed, exactly: anything else is not imported.
  if (createHash("sha256").update(stored).digest("hex") !== row.sha256) {
    throw new ProvisionImportSourceError("The migration's file set does not match what was reviewed", "file_set_mismatch", false);
  }
  const body = JSON.parse(stored.toString("utf8")) as ProvisionImportBody;
  return {
    files: body.files.map((file) => ({ path: file.path, content: Buffer.from(file.contentBase64, "base64") })),
  };
});

/**
 * Tell the person who started the migration that it waits for their
 * confirmation. The local agent is stopped meanwhile, and the panel alone
 * does not reach someone who closed the page (Tenny, task #16). One
 * `system_notice` outbox row (`migration:<id>`): every device, the person's
 * server level, quiet hours and preview setting apply.
 */
export async function notifyHostedMigrationReviewReady(migration: AgentMigrationRow): Promise<void> {
  if (!migration.initiatedByUserId) return;
  const [row] = await getDb().select({ agentName: agents.name, displayName: agents.displayName, serverId: agents.serverId })
    .from(agents)
    .where(eq(agents.id, migration.agentId))
    .limit(1);
  if (!row) return;
  const name = row.displayName?.trim() || row.agentName;
  const payload: NotificationNoticePayload = {
    title: formatNotificationCopy("push.title.agent_migration_review", [name]),
    titleKey: "push.title.agent_migration_review",
    titleArgs: [name],
    body: formatNotificationCopy("push.body.agent_migration_review", [name]),
    bodyKey: "push.body.agent_migration_review",
    bodyArgs: [name],
    kind: "agent",
    event: "system_notice",
    route: { type: "agent", serverId: row.serverId, agentId: migration.agentId },
    agent: { id: migration.agentId, name },
  };
  await enqueueNotificationRows([{
    receiverId: migration.initiatedByUserId,
    serverId: row.serverId,
    kind: null,
    sourceChannelId: null,
    messageId: null,
    messageSeq: null,
    activityAt: currentDate(),
    personalMention: true,
    eventKey: `migration:${migration.id}`,
    category: "system_notice",
    payload: payload as unknown as Record<string, unknown>,
  }]);
}

const HOSTED_IMPORTER_POLL_MS = 5_000;

/**
 * The importer's own loop: one build can download a large bundle twice, so it
 * runs apart from the remediation drain instead of holding it up.
 */
export function startHostedAgentMigrationImporterWorker(input: {
  io?: SocketServer;
  orchestrator?: Pick<AgentOrchestrator, "archiveAgentMigrationSourceWorkspace">;
  intervalMs?: number;
  workerId?: string;
}): { stop(): void } {
  let stopped = false;
  let running = false;
  const workerId = input.workerId ?? `server:${hostname()}`;
  const onMigrationUpdated = (migration: AgentMigrationRow) => emitAgentMigrationUpdated(input.io, migration);
  // Completion is normally immediate through the import hook; the sweep
  // below catches a lost hook and the outcomes no hook reports.
  const offImported = onProvisionImported(async (event) => {
    if (event.importSource !== HOSTED_MIGRATION_IMPORT_SOURCE) return;
    await onHostedMigrationImported(event.agentId, { orchestrator: input.orchestrator, onMigrationUpdated });
  });
  const drain = async () => {
    if (stopped || running) return;
    running = true;
    try {
      while (!stopped && await runHostedAgentMigrationImporterOnce({
        workerId,
        notifyReviewReady: notifyHostedMigrationReviewReady,
        onMigrationUpdated,
      })) {
        // Keep going while there is work.
      }
      if (!stopped) await sweepHostedAgentMigrations({ orchestrator: input.orchestrator, onMigrationUpdated });
    } catch (error) {
      console.error("[HostedMigration] Importer run failed:", error);
    } finally {
      running = false;
    }
  };
  const timer = setClockInterval(() => void drain(), input.intervalMs ?? HOSTED_IMPORTER_POLL_MS);
  if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") timer.unref();
  void drain();
  return {
    stop() {
      stopped = true;
      offImported();
      clearInterval(timer as ReturnType<typeof setInterval>);
    },
  };
}
