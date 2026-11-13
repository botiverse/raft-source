// Core routes for first-party objects (first-party app mechanism §四), at
// `/api/objects` behind requireAuth, requireVerified and requireServer (the
// reader is req.userId in req.serverId; requireServer checks the membership
// on every request). Contract: packages/shared webObjectsContract.ts.
//
// `POST /summaries { kind, refs }` checks, in order:
// 1. the body: `{ kind, refs }`, a string kind and 1 to
//    OBJECT_SUMMARIES_MAX_REFS objects, each with an `id` string of 1 to
//    OBJECT_SUMMARIES_MAX_ID_CHARS (400 INVALID_REQUEST, with `{ limit }`
//    when there are too many);
// 2. the kind, in the app registry (400 UNKNOWN_OBJECT_KIND naming the kinds
//    there are);
// 3. each reference by the kind's parseRef (400 INVALID_REQUEST): core reads
//    only `id`, the rest is the app's;
// 4. services/objectSummaries.ts: the app's flag for the reader's server and
//    each object's own server (a read needs both: with the reader's off,
//    every reference is `unavailable`, which the client draws as a plain
//    link), core's visibility over the homes the app reports, then the app's
//    summarize for the references whose id is visible.
// Every answer is the reader's own: `private, no-store`, never cached. Step 4
// is the span `server.objects.summaries` (the kind, and counts in buckets).
//
// `GET /:kind/:id/files/:fileId` (services/objectFiles.ts readObjectFile;
// docs/development/first-party-apps.md, "Object files"): a file of an object,
// found by the kind, the object and the file id together, an unclaimed one
// only for its uploader, then only while the reader can see the object fully
// (the same rule as summaries: both servers' flags, the kind's homes, core's
// visibility; never another server's public object, read as its public face
// only). Anything else, an unknown kind or another object's file id
// included, is one 404 NOT_FOUND; 503 STORAGE_UNAVAILABLE without the
// platform's bucket. The bytes go with the type core detected when it stored
// them, inline, nosniff, a sandboxing CSP, and `private, max-age=60` varying
// by the credential and the server (refusals stay `private, no-store`).
//
// Activity rows for objects (S6; shared activityObjectsContract.ts,
// services/objectActivity.ts): `POST /activity/done { kind, objectId,
// throughSeq? }`, `/activity/undone { kind, objectId }`, `/activity/read
// { kind, objectId, throughSeq? }`. Each checks the body (400 INVALID_REQUEST), the kind
// with Activity in the registry (400 UNKNOWN_OBJECT_KIND), the app's flag for
// the reader's server (403 APP_NOT_ENABLED), then that the reader has a row
// for the object in this server and can see the object now (404 NOT_FOUND,
// the same for both); Done and read also that `throughSeq` is not past the
// row's newest event (409 DONE_FRONTIER_BEYOND_LATEST). After the write the
// reader's clients get `activity:changed`.
import { Router, type Response, type Router as RouterType } from "express";
import {
  OBJECT_SUMMARIES_MAX_ID_CHARS,
  OBJECT_SUMMARIES_MAX_REFS,
  type ObjectActivityErrorCode,
  type ObjectWebErrorCode,
  type ServerId,
} from "@botiverse/raft-shared";
import { firstPartyApps, registeredObjectKind } from "../apps/firstPartyApps";
import { setRequestTraceErrorCode } from "../middleware/requestObservability";
import { appEnabled } from "../platform/flags";
import { announceActivityChanged } from "../services/activityRealtime";
import {
  activityObjectKinds,
  markObjectActivityDone,
  markObjectActivityRead,
  markObjectActivityUndone,
  type ActivityObjectKind,
  type ObjectActivityWriteOutcome,
} from "../services/objectActivity";
import { readObjectFile } from "../services/objectFiles";
import { objectSummaries, readObjectRefs } from "../services/objectSummaries";
import { streamStorageResponse } from "../services/storageResponseStream";
import { countBucket } from "../platform/tracing";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { withTraceChildSpan } from "../tracing/semanticTrace";

class Refusal extends Error {
  constructor(readonly status: number, readonly code: ObjectWebErrorCode | ObjectActivityErrorCode, error: string, readonly details?: Record<string, unknown>) {
    super(error);
  }
}

function refuse(res: Response, refusal: Refusal): void {
  setRequestTraceErrorCode(res, refusal.code);
  res.status(refusal.status).json(refusal.details ? { error: refusal.message, code: refusal.code, details: refusal.details } : { error: refusal.message, code: refusal.code });
}

type RawRef = { id: string } & Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The summaries body, its references not yet read by their kind (Refusal 400 INVALID_REQUEST for anything else). */
export function parseSummariesInput(body: unknown): { kind: string; refs: RawRef[] } {
  const invalid = new Refusal(400, "INVALID_REQUEST", `the body is { kind, refs: [1 to ${OBJECT_SUMMARIES_MAX_REFS} objects, each { id: a string of 1 to ${OBJECT_SUMMARIES_MAX_ID_CHARS} characters, and what its kind reads }] }`);
  if (!isObject(body)) throw invalid;
  const { kind, refs, ...rest } = body;
  if (Object.keys(rest).length > 0 || typeof kind !== "string" || !Array.isArray(refs) || refs.length === 0) throw invalid;
  if (refs.length > OBJECT_SUMMARIES_MAX_REFS) throw new Refusal(400, "INVALID_REQUEST", "too many refs", { limit: OBJECT_SUMMARIES_MAX_REFS });
  const valid = (ref: unknown): ref is RawRef =>
    isObject(ref) && typeof ref.id === "string" && ref.id.length > 0 && ref.id.length <= OBJECT_SUMMARIES_MAX_ID_CHARS;
  if (!refs.every(valid)) throw invalid;
  return { kind, refs };
}

export const objectsRouter: RouterType = Router();

objectsRouter.post("/summaries", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const input = parseSummariesInput(req.body as unknown);
    const registered = registeredObjectKind(input.kind);
    if (!registered) {
      const kinds = firstPartyApps().flatMap((app) => app.objectKinds.map((objectKind) => objectKind.kind));
      throw new Refusal(400, "UNKNOWN_OBJECT_KIND", `object kind ${JSON.stringify(input.kind)} is not registered; kind is one of: ${kinds.join(", ")}`, { kind: input.kind, kinds });
    }
    const refs = readObjectRefs(registered, input.refs);
    if (!refs) throw new Refusal(400, "INVALID_REQUEST", `a reference is not one kind ${JSON.stringify(input.kind)} reads`);
    const reader = { userId: req.userId!, serverId: req.serverId!, sessionFamilyId: req.sessionFamilyId ?? null };
    // The kind is a registered one (checked above); counts only, never the references.
    const summaries = await withTraceChildSpan(
      "server.objects.summaries",
      { surface: "server", kind: "internal", attrs: { object_kind: registered.objectKind.kind, refs_bucket: countBucket(refs.length) } },
      () => objectSummaries(reader, registered, refs),
      {
        onSuccess: (results) => ({
          ok_bucket: countBucket(results.filter((result) => result.ok).length),
          unavailable_bucket: countBucket(results.filter((result) => !result.ok).length),
        }),
      },
    );
    res.json({ kind: input.kind, summaries });
  } catch (error) {
    if (error instanceof Refusal) {
      refuse(res, error);
      return;
    }
    if (res.headersSent) return;
    console.error("api.objects.summaries failed", serializeErrorForLog(error));
    res.status(500).json({ error: "Failed to read object summaries" });
  }
});

// ---- Object files ----------------------------------------------------------------------

/** How long the reader's browser may keep a file it was given (short: visibility can change). */
const OBJECT_FILE_CACHE_SECONDS = 60;

objectsRouter.get("/:kind/:id/files/:fileId", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const { kind, id, fileId } = req.params;
    const viewer = { type: "user" as const, id: req.userId!, serverId: req.serverId! };
    const file = id.length <= OBJECT_SUMMARIES_MAX_ID_CHARS ? await readObjectFile(viewer, { kind, objectId: id, fileId }) : { kind: "not_found" as const };
    if (file.kind === "not_found") throw new Refusal(404, "NOT_FOUND", "no such file");
    if (file.kind === "unavailable") throw new Refusal(503, "STORAGE_UNAVAILABLE", "object file storage is not configured");
    res.status(200);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Length", String(file.size));
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cache-Control", `private, max-age=${OBJECT_FILE_CACHE_SECONDS}`);
    res.vary("Authorization");
    res.vary("Cookie");
    res.vary("X-Server-Id");
    file.stream.on("error", (err) => {
      console.error("api.objects.file stream failed", serializeErrorForLog(err));
      res.destroy(err);
    });
    // The abort-safe pipeline: a client that goes away destroys the storage stream too.
    await streamStorageResponse(file.stream, res).catch(() => undefined);
  } catch (error) {
    if (error instanceof Refusal) {
      refuse(res, error);
      return;
    }
    if (res.headersSent) return;
    console.error("api.objects.file failed", serializeErrorForLog(error));
    res.status(500).json({ error: "Failed to read the object's file" });
  }
});

// ---- Activity rows (S6) ----------------------------------------------------------------

type ActivityInput = { kind: ActivityObjectKind; objectId: string; throughSeq: number | undefined };

/** `{ kind, objectId }` (and with `done` and `read`, an optional `throughSeq`: a decimal string or a whole number). */
export function parseActivityInput(body: unknown, opts: { throughSeq: boolean }): ActivityInput {
  const shape = opts.throughSeq ? "{ kind, objectId, throughSeq? }" : "{ kind, objectId }";
  const invalid = new Refusal(400, "INVALID_REQUEST", `the body is ${shape}: objectId a string of 1 to ${OBJECT_SUMMARIES_MAX_ID_CHARS} characters${opts.throughSeq ? ", throughSeq the row's doneFrontierSeq" : ""}`);
  if (!isObject(body)) throw invalid;
  const { kind, objectId, throughSeq, ...rest } = body;
  if (Object.keys(rest).length > 0 || typeof kind !== "string" || typeof objectId !== "string" || objectId.length === 0 || objectId.length > OBJECT_SUMMARIES_MAX_ID_CHARS) throw invalid;
  let seq: number | undefined;
  if (throughSeq !== undefined) {
    if (!opts.throughSeq) throw invalid;
    seq = typeof throughSeq === "string" && /^\d{1,15}$/.test(throughSeq) ? Number(throughSeq) : typeof throughSeq === "number" && Number.isSafeInteger(throughSeq) && throughSeq >= 0 ? throughSeq : undefined;
    if (seq === undefined) throw invalid;
  }
  const registered = activityObjectKinds().find((entry) => entry.objectKind.kind === kind);
  if (!registered) {
    const kinds = activityObjectKinds().map((entry) => entry.objectKind.kind);
    throw new Refusal(400, "UNKNOWN_OBJECT_KIND", `object kind ${JSON.stringify(kind)} has no Activity; kind is one of: ${kinds.join(", ")}`, { kind, kinds });
  }
  return { kind: registered, objectId, throughSeq: seq };
}

function activityRoute(name: string, opts: { throughSeq: boolean }, write: (reader: { userId: string; serverId: ServerId; sessionFamilyId: string | null }, input: ActivityInput) => Promise<ObjectActivityWriteOutcome>) {
  objectsRouter.post(`/activity/${name}`, async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const input = parseActivityInput(req.body as unknown, opts);
      const reader = { userId: req.userId!, serverId: req.serverId! as ServerId, sessionFamilyId: req.sessionFamilyId ?? null };
      if (!(await appEnabled(reader.serverId, input.kind.app.flag))) {
        throw new Refusal(403, "APP_NOT_ENABLED", `${input.kind.app.id} is not enabled on this server`, { app: input.kind.app.id });
      }
      const outcome = await write(reader, input);
      if (outcome === "not_found") throw new Refusal(404, "NOT_FOUND", "no Activity row for this object");
      if (outcome === "beyond_latest") throw new Refusal(409, "DONE_FRONTIER_BEYOND_LATEST", "throughSeq is past the row's newest event; refresh and retry");
      announceActivityChanged(reader.serverId, [reader.userId]);
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof Refusal) {
        refuse(res, error);
        return;
      }
      if (res.headersSent) return;
      console.error(`api.objects.activity.${name} failed`, serializeErrorForLog(error));
      res.status(500).json({ error: `Failed to mark the object ${name}` });
    }
  });
}

activityRoute("done", { throughSeq: true }, (reader, input) => markObjectActivityDone(reader, input.kind, input.objectId, input.throughSeq));
activityRoute("undone", { throughSeq: false }, (reader, input) => markObjectActivityUndone(reader, input.kind, input.objectId));
activityRoute("read", { throughSeq: true }, (reader, input) => markObjectActivityRead(reader, input.kind, input.objectId, input.throughSeq));
