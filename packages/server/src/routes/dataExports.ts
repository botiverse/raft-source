/**
 * Data exports (#triage:#512 design v7, docs/development/data-export.md):
 *
 *   /api/me/data-exports                  a person's own (personal) exports
 *   /api/servers/:id/data-exports         a server's (server) exports, owner only
 *
 * Each mount:
 *   GET    /                    -> { exports: DataExportView[], available, nextAllowedAt } (the caller's own,
 *                                  newest first; `available`: this kind has a producer and may be asked for;
 *                                  `nextAllowedAt`: when the cooldown lets it be asked again, null when now:
 *                                  deleted exports count, and are not in the list); personal mount also
 *                                  `contextServerIds`: the caller's servers whose owner allows context;
 *                                  server mount also `closed` (only a full-history export is accepted)
 *   POST   /                    { scope, password?, emailCode? }
 *                               -> 202 { export } (queued; the archive is written in the background)
 *   POST   /email-code          -> { sent: true, expiresAt } (a person with neither a password nor two-step verification)
 *   GET    /summary             server mount: -> ServerDataExportSummary (what an export would hold now:
 *                                  public channels, messages and files in the window, counts capped)
 *   GET    /:exportId           -> { export }
 *   DELETE /:exportId           -> { deleted: true } (any status: a running export stops, its objects go)
 *   POST   /:exportId/download  { volume } -> S3: { url, expiresAt } (300 s, Content-Disposition attachment);
 *                                  local disk: the volume's bytes, streamed
 *
 * Who: a person's own web (`full`) sign-in only. requireAuth answers 401 to
 * anything that is not a Raft access token and 403 to a device login's
 * session; an agent key (an assistant acting for its owner) has no session
 * family and gets 403 `session_family_required` here: agents, the CLI and the
 * SDK can't ask for or download an export (design §5, §8). Every route:
 * Cache-Control: no-store.
 *
 * Order (POST /):
 *   flag data_export_v0 for the person (and server) -> 404 while off (every route, before any other check);
 *   server mount: X-Server-Id is the path's server -> 400 server_scope_required;
 *   web sign-in -> 403 session_family_required;
 *   server mount: a member -> 404; exportServerData (owner only) -> 403 data_export_owner_only;
 *   a producer for the kind -> 404 data_export_kind_unavailable;
 *   the scope -> 400 data_export_scope_invalid; a closed server's window -> 409;
 *   the producer's own scope check and authorize(`create`);
 *   this sign-in at least 24 hours old -> 403 data_export_session_too_new;
 *   re-authentication: two-step verification on -> step-up (403 second_factor_step_up_required,
 *     stepUpGate `data_export`); otherwise a recent password re-authentication or `password`
 *     (403 reauth_required with details.methods), or the emailed code of this flow
 *     (`emailCode`; never an account deletion code: 400 email_code_invalid);
 *   limits, in the transaction that writes the job: one in flight per person and per server
 *     (409 data_export_in_flight), one personal export per 7 days, one server export per server
 *     per 24 hours (429 data_export_cooldown with retryAfterSeconds); a failed one does not count.
 * Download re-checks, every time, that the caller is the requester on a web sign-in at least 24
 * hours old and, for a server export, still holds exportServerData there (design §8); DELETE needs
 * the same sign-in age. Both go through their own mount only (another mount's export is a 404).
 *
 * The server mount sits before the server-scoped lockdown (routes/servers.ts):
 * an owner may export a closed server's full history until its purge, and
 * the lockdown refuses closed servers. It makes the lockdown's checks itself
 * (X-Server-Id matches :id; a member, closed servers included).
 */
import { Router, type NextFunction, type Request, type Response, type Router as RouterType } from "express";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  asDataExportId,
  asServerId,
  currentDate,
  DATA_EXPORT_DOWNLOAD_URL_TTL_SECONDS,
  DATA_EXPORT_MIN_SESSION_AGE_MS,
  parsePersonalDataExportScope,
  parseServerDataExportScope,
  type DataExportKind,
  type DataExportScope,
  type DataExportScopeOf,
  type DataExportScopeParse,
  type ServerDataExportScope,
  type ServerId,
} from "@botiverse/raft-shared";

import { getDb, type DatabaseExecutor } from "../db/index";
import { dataExports, sessionFamilies } from "../db/schema";
import { refuse, type RefusalStatus } from "../lib/refusal";
import { guardUuidPathParams } from "../lib/uuidPathParams";
import { DATA_EXPORT_EMAIL_CODE_FLOW, sendEmailCode } from "../services/accountDeletion/emailCode";
import {
  canExportServer,
  createDataExport,
  dataExportEnabledFor,
  dataExportFileName,
  dataExportJobOf,
  dataExportNextAllowedAt,
  dataExportView,
  deleteDataExport,
  getOwnDataExport,
  listDataExports,
  serverExportAccessOf,
  serverExportWindowRefusal,
  type DataExportRow,
  type ServerExportAccess,
} from "../services/dataExport/jobs";
import { dataExportProducers, type DataExportJob } from "../services/dataExport/producer";
import { dataExportTaskDefinition, startDataExportRun } from "../services/dataExport/runner";
import { serverExportSummary } from "../services/dataExport/serverProducer";
import { memberServerIds } from "../services/dataExport/personalProducer";
import { contextAllowedServerIds } from "../services/dataExport/serverSettings";
import { SecondFactorError } from "../services/secondFactor/management";
import { firstFactorReauth, sensitiveReauthFor, type SensitiveReauth } from "../services/sensitiveReauth";
import { webSessionFamilyOf } from "../services/sessionService";
import { getStorage } from "../services/storageService";
import { streamStorageResponse } from "../services/storageResponseStream";
import { sendJsonServerError } from "./errorResponse";
import { refuseWithoutRecentSecondFactor } from "./secondFactor";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = { code: "data_export_not_found", error: "That export was not found." } as const;

/** Where a request is: the kind, and for a server export the server and the caller's access to it. */
interface Mount {
  kind: DataExportKind;
  userId: string;
  familyId: string;
  serverId: ServerId | null;
  access: ServerExportAccess | null;
}

function routeParam(req: Request, name: string): string | null {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  return typeof value === "string" ? value : null;
}

function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  next();
}

/**
 * One body for every "not here" on the server mount: a malformed id, a server
 * the caller is not in, and a flag that is off for it all read the same, so
 * the mount never tells which server ids exist or are in the rollout.
 */
export const SERVER_NOT_FOUND = { code: "not_found", error: "That server was not found." } as const;

/**
 * The mount's checks, before every route. A server mount answers who may see
 * it first (id, membership, flag: one 404), then the request's shape
 * (X-Server-Id), then the sign-in; a personal mount checks the flag, then the sign-in.
 */
function resolveMount(kind: DataExportKind) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.userId!;
      let serverId: ServerId | null = null;
      let access: ServerExportAccess | null = null;
      if (kind === "server") {
        const param = routeParam(req, "id");
        if (!param || !UUID_RE.test(param)) { refuse(res, 404, SERVER_NOT_FOUND); return; }
        serverId = asServerId(param);
        access = await serverExportAccessOf(serverId, userId);
        if (!access || !(await dataExportEnabledFor({ userId, serverId }))) { refuse(res, 404, SERVER_NOT_FOUND); return; }
        if (req.headers["x-server-id"] !== serverId) {
          refuse(res, 400, { code: "server_scope_required", error: "Send the X-Server-Id header with this server's id." });
          return;
        }
      } else if (!(await dataExportEnabledFor({ userId, serverId: null }))) {
        refuse(res, 404, { code: "not_found", error: "Data export is not available here." });
        return;
      }
      const familyId = webSessionFamilyOf(req);
      if (!familyId) {
        refuse(res, 403, { code: "session_family_required", error: "Sign in on the web or in the Raft app to export data." });
        return;
      }
      res.locals.dataExportMount = { kind, userId, familyId, serverId, access } satisfies Mount;
      next();
    } catch (err) {
      sendJsonServerError(req, res, { error: "Failed to load data exports", logPrefix: "[data-export] mount:", err });
    }
  };
}

const mountOf = (res: Response): Mount => res.locals.dataExportMount as Mount;

/** Server mount: the caller still holds exportServerData (owner) and the purge hasn't begun. True when refused. */
function refuseWithoutExportPermission(res: Response, mount: Mount): boolean {
  if (mount.kind !== "server" || canExportServer(mount.access)) return false;
  if (mount.access?.purgeStarted) {
    refuse(res, 409, { code: "data_export_window_over", error: "This server's data is being deleted, so it can no longer be exported or downloaded." });
  } else {
    refuse(res, 403, { code: "data_export_owner_only", error: "Only the server's owner can export its data." });
  }
  return true;
}

async function refuseYoungSession(res: Response, familyId: string, now: Date): Promise<boolean> {
  const [family] = await getDb().select({ createdAt: sessionFamilies.createdAt }).from(sessionFamilies).where(eq(sessionFamilies.id, familyId));
  if (family && family.createdAt.getTime() <= now.getTime() - DATA_EXPORT_MIN_SESSION_AGE_MS) return false;
  refuse(res, 403, {
    code: "data_export_session_too_new",
    error: "This sign-in is less than a day old. Export from a device you have been signed in on for at least a day.",
  });
  return true;
}

function sendSecondFactorError(res: Response, err: SecondFactorError): void {
  refuse(res, err.status as RefusalStatus, { code: err.code, error: err.message, ...(Object.keys(err.extra).length > 0 ? { details: err.extra } : {}) });
}

function sendError(req: Request, res: Response, err: unknown, failure: string): void {
  if (err instanceof SecondFactorError) { sendSecondFactorError(res, err); return; }
  sendJsonServerError(req, res, { error: failure, logPrefix: `[data-export] ${failure}:`, err });
}

type ConfirmResult = { ok: true; inTransaction: ((tx: DatabaseExecutor) => Promise<boolean>) | null } | { ok: false };

/** The password or emailed-code rung (services/sensitiveReauth.ts); a refusal sent when not ok. */
async function confirmWithFirstFactor(res: Response, mount: Mount, reauth: Exclude<SensitiveReauth, { kind: "second_factor" }>, body: { password?: unknown; emailCode?: unknown }, now: Date): Promise<ConfirmResult> {
  const result = await firstFactorReauth({ reauth, userId: mount.userId, familyId: mount.familyId, now, password: body.password, emailCode: body.emailCode, flow: DATA_EXPORT_EMAIL_CODE_FLOW });
  if (result.ok) return { ok: true, inTransaction: result.useInTransaction };
  if (result.reason === "reauth_required") {
    refuse(res, 403, { code: "reauth_required", error: "Confirm it's you before exporting data.", details: { methods: result.methods } });
  } else if (result.reason === "second_factor_locked") {
    refuse(res, 429, { code: "second_factor_locked", error: "Too many wrong codes. Try again later.", details: { lockedUntil: result.lockedUntil.toISOString() } });
  } else {
    refuse(res, 400, { code: "email_code_invalid", error: "That code didn't work. Check the email or ask for a new code." });
  }
  return { ok: false };
}

const SCOPE_PARSERS: { [K in DataExportKind]: (raw: unknown) => DataExportScopeParse<DataExportScopeOf<K>> } = {
  personal: parsePersonalDataExportScope,
  server: parseServerDataExportScope,
};

/** A server export's scope, or null for a personal one. */
function serverScopeOf(scope: DataExportScope): ServerDataExportScope | null {
  return "fullHistoryAfterClose" in scope ? scope : null;
}

function createRouter<K extends DataExportKind>(kind: K): RouterType {
  const router = Router({ mergeParams: true });
  router.use(noStore, resolveMount(kind));
  guardUuidPathParams(router, { exportId: { code: NOT_FOUND.code, error: NOT_FOUND.error } });

  router.get("/", async (req, res) => {
    try {
      const mount = mountOf(res);
      const rows = await listDataExports({ requesterUserId: mount.userId, kind, ...(mount.serverId ? { serverId: mount.serverId } : {}) });
      const nextAllowedAt = await dataExportNextAllowedAt({ kind, requesterUserId: mount.userId, serverId: mount.serverId, now: currentDate() });
      res.json({
        exports: rows.map(dataExportView),
        available: dataExportProducers.get(kind) !== undefined && (kind === "personal" || canExportServer(mount.access)),
        nextAllowedAt: nextAllowedAt?.toISOString() ?? null,
        ...(kind === "personal"
          ? { contextServerIds: [...await contextAllowedServerIds(await memberServerIds(mount.userId))].sort() }
          : { closed: mount.access?.closedAt != null }),
      });
    } catch (err) {
      sendError(req, res, err, "Failed to list data exports");
    }
  });

  router.post("/email-code", async (req, res) => {
    try {
      const mount = mountOf(res);
      const now = currentDate();
      if (refuseWithoutExportPermission(res, mount)) return;
      if (await refuseYoungSession(res, mount.familyId, now)) return;
      const reauth = await sensitiveReauthFor(mount.userId);
      if (reauth.kind !== "email_code") {
        refuse(res, 409, { code: "email_code_not_available", error: "Confirm it's you another way: with your password or your second step." });
        return;
      }
      const sent = await sendEmailCode(DATA_EXPORT_EMAIL_CODE_FLOW, { userId: mount.userId, familyId: mount.familyId, now });
      if (!sent.ok) {
        refuse(res, 429, { code: "email_code_recently_sent", error: "A code was just sent. Wait a minute before asking for another.", retryAfterSeconds: sent.retryAfterSeconds });
        return;
      }
      res.json({ sent: true, expiresAt: sent.expiresAt.toISOString() });
    } catch (err) {
      sendError(req, res, err, "Failed to send the code");
    }
  });

  router.post("/", async (req, res) => {
    try {
      const mount = mountOf(res);
      const now = currentDate();
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as { scope?: unknown; password?: unknown; emailCode?: unknown };
      if (refuseWithoutExportPermission(res, mount)) return;
      const producer = dataExportProducers.get(kind);
      if (!producer) {
        refuse(res, 404, { code: "data_export_kind_unavailable", error: "This kind of export is not available yet." });
        return;
      }
      const parsed = SCOPE_PARSERS[kind](body.scope);
      if (!parsed.ok) {
        refuse(res, 400, { code: "data_export_scope_invalid", error: parsed.error, details: { field: parsed.field } });
        return;
      }
      const serverScope = serverScopeOf(parsed.scope);
      if (mount.access && serverScope) {
        const closed = serverExportWindowRefusal(mount.access, serverScope, now);
        if (closed) { refuse(res, 409, closed); return; }
      }
      const serverId = mount.serverId;
      const checked = await producer.validateScope({ requesterUserId: mount.userId, serverId, scope: parsed.scope, now });
      if (!checked.ok) { refuse(res, checked.status, { code: checked.code, error: checked.error }); return; }
      const scope = checked.scope;
      // The job as it will be written: its id is chosen here so authorize sees the real one.
      const exportId = asDataExportId(randomUUID());
      const job: DataExportJob<K> = { id: exportId, kind, requesterUserId: mount.userId, serverId, scope, createdAt: now };
      const allowed = await producer.authorize(job, "create");
      if (!allowed.ok) { refuse(res, 403, { code: allowed.code, error: allowed.error }); return; }
      if (await refuseYoungSession(res, mount.familyId, now)) return;

      // Two-step verification on: step-up on this sign-in; otherwise a password or the emailed code.
      const reauth = await sensitiveReauthFor(mount.userId);
      if (reauth.kind === "second_factor" && await refuseWithoutRecentSecondFactor(res, mount.userId, mount.familyId, "data_export")) return;
      const confirmed: ConfirmResult = reauth.kind === "second_factor" ? { ok: true, inTransaction: null } : await confirmWithFirstFactor(res, mount, reauth, body, now);
      if (!confirmed.ok) return;
      const created = await createDataExport({
        id: exportId,
        kind,
        requesterUserId: mount.userId,
        requesterSessionFamilyId: mount.familyId,
        serverId: mount.serverId,
        scope,
        now,
        taskSpec: dataExportTaskDefinition,
        ...(confirmed.inTransaction ? { inTransaction: confirmed.inTransaction } : {}),
      });
      if (!created.ok) {
        if (created.reason === "refused") {
          refuse(res, 400, { code: "email_code_invalid", error: "That code didn't work. Check the email or ask for a new code." });
        } else if (created.reason === "in_flight") {
          refuse(res, 409, { code: "data_export_in_flight", error: "An export is already being prepared. Wait for it to finish, or delete it." });
        } else {
          refuse(res, 429, {
            code: "data_export_cooldown",
            error: kind === "server" ? "This server was exported in the last 24 hours. Try again later." : "You exported your data in the last 7 days. Try again later.",
            retryAfterSeconds: created.retryAfterSeconds,
          });
        }
        return;
      }
      startDataExportRun(created.claim);
      res.status(202).json({ export: dataExportView(created.row) });
    } catch (err) {
      sendError(req, res, err, "Failed to start the data export");
    }
  });

  async function ownExport(req: Request, res: Response): Promise<DataExportRow | null> {
    const mount = mountOf(res);
    const row = await getOwnDataExport({ requesterUserId: mount.userId, exportId: routeParam(req, "exportId")!, kind, ...(mount.serverId ? { serverId: mount.serverId } : {}) });
    if (!row) refuse(res, 404, NOT_FOUND);
    return row;
  }

  if (kind === "server") {
    router.get("/summary", async (req, res) => {
      try {
        const mount = mountOf(res);
        if (refuseWithoutExportPermission(res, mount)) return;
        // A closed server accepts only its full history (serverExportWindowRefusal): that is what it would hold.
        res.json(await serverExportSummary({ serverId: mount.serverId!, requesterUserId: mount.userId, fullHistory: mount.access?.closedAt != null, now: currentDate() }));
      } catch (err) {
        sendError(req, res, err, "Failed to summarize the server export");
      }
    });
  }

  router.get("/:exportId", async (req, res) => {
    try {
      const row = await ownExport(req, res);
      if (row) res.json({ export: dataExportView(row) });
    } catch (err) {
      sendError(req, res, err, "Failed to load the data export");
    }
  });

  router.delete("/:exportId", async (req, res) => {
    try {
      const mount = mountOf(res);
      const now = currentDate();
      if (await refuseYoungSession(res, mount.familyId, now)) return;
      // Through its own mount only: another mount's export reads as none, as GET.
      const row = await ownExport(req, res);
      if (!row) return;
      if (!(await deleteDataExport({ requesterUserId: mount.userId, exportId: row.id, now }))) {
        refuse(res, 404, NOT_FOUND);
        return;
      }
      res.json({ deleted: true });
    } catch (err) {
      sendError(req, res, err, "Failed to delete the data export");
    }
  });

  router.post("/:exportId/download", async (req, res) => {
    try {
      const mount = mountOf(res);
      const now = currentDate();
      // The caller is the requester on a web sign-in at least a day old (resolveMount, ownExport,
      // refuseYoungSession); a server export also needs exportServerData now, not only when it was
      // asked (design §8).
      if (await refuseYoungSession(res, mount.familyId, now)) return;
      if (refuseWithoutExportPermission(res, mount)) return;
      const row = await ownExport(req, res);
      if (!row) return;
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as { volume?: unknown };
      // Ready and not past its expiry (maintenance marks it expired within the hour).
      if (row.status !== "ready" || !row.expiresAt || row.expiresAt <= now) {
        refuse(res, 409, { code: "data_export_not_ready", error: "This export has no archive to download: it is not ready, or it expired." });
        return;
      }
      const volumeIndex = body.volume === undefined ? 1 : body.volume;
      const volume = row.volumes.find((candidate) => candidate.index === volumeIndex);
      if (!volume) { refuse(res, 404, { code: "data_export_volume_not_found", error: "That volume of the export was not found." }); return; }
      const producer = dataExportProducers.get(row.kind);
      if (producer) {
        const allowed = await producer.authorize(dataExportJobOf(row), "download");
        if (!allowed.ok) { refuse(res, 403, { code: allowed.code, error: allowed.error }); return; }
      }
      const storage = getStorage();
      if (!storage) { refuse(res, 409, { code: "data_export_not_ready", error: "File storage is not available, so the export can't be downloaded now." }); return; }
      await getDb().update(dataExports)
        .set({ downloadedAt: row.downloadedAt ?? now, lastDownloadedAt: now })
        .where(eq(dataExports.id, row.id));
      const disposition = `attachment; filename="${dataExportFileName(row, volume.index, mount.access?.slug)}"`;
      if (storage.getPresignedUrl) {
        const url = await storage.getPresignedUrl(volume.key, {
          expiresIn: DATA_EXPORT_DOWNLOAD_URL_TTL_SECONDS,
          responseContentDisposition: disposition,
          responseContentType: "application/zip",
        });
        res.json({ url, expiresAt: new Date(now.getTime() + DATA_EXPORT_DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString() });
        return;
      }
      // Local disk (development, self-hosted): no presigned URL, so the bytes come through this response.
      const source = await storage.get(volume.key);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", disposition);
      res.setHeader("Content-Length", String(volume.sizeBytes));
      await streamStorageResponse(source, res);
    } catch (err) {
      if (res.headersSent) {
        res.destroy(err instanceof Error ? err : undefined);
        return;
      }
      sendError(req, res, err, "Failed to download the data export");
    }
  });

  return router;
}

/** /api/me/data-exports (app.ts). */
export const myDataExportsRouter: RouterType = createRouter("personal");
/** /api/servers/:id/data-exports (routes/servers.ts, before the lockdown). */
export const serverDataExportsRouter: RouterType = createRouter("server");
