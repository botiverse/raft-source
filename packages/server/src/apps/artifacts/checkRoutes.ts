// What the check Worker asks Raft, `/internal/artifacts-check/*` (task
// #proj-workspace:#130; docs/development/workspace-artifacts.md, "The check
// Worker's API"; contract packages/shared artifactCheckContract.ts). mount.ts
// mounts it beside the content Worker's (core's internal mount, ahead of its
// machine-auth `/internal`). First-party only: the check Worker's own bearer,
// never a user's, an agent's or the content Worker's credential.
//
// - Auth: `Authorization: Bearer <ARTIFACTS_CHECK_WORKER_TOKEN>`, compared in
//   constant time (a sha256 digest, contentWorker.ts matchContentCaller).
//   Unset, shorter than 32 bytes, or the same as one of the content Worker's
//   tokens (ARTIFACTS_CONTENT_WORKER_TOKEN signs tickets,
//   ARTIFACTS_CONTENT_RAFT_TOKENS are the content Worker's: each caller its
//   own), every route answers 503 and nothing is leased; a wrong or missing
//   token 401, logged with the route and the source address only.
// - `POST /lease` → 200 ArtifactCheckLease (`no-store`: it carries a ticket),
//   204 with nothing to run, 503 with no content origin to sign for
//   (checkTask.ts leaseCheck).
// - `POST /:checkId/result`, multipart/form-data: `report` (JSON, at most
//   ARTIFACT_CHECK_REPORT_MAX_BYTES), and a PNG per viewport (`desktop`,
//   `phone`, each at most ARTIFACT_CHECK_SHOT_MAX_BYTES), parsed after the
//   token (multer, in memory) → 200 { status }, 400 for a body that isn't
//   one (or a report naming another check), 413 past a cap, 404 for no
//   such check, 409 for a lease that isn't current (nothing written), 503
//   without the bucket (checkTask.ts finishCheck).
// - Rate limit per caller and replica: 600 a minute for the Worker, 30 for
//   anyone refused (by address).
//
// The lease's url is never logged; logs carry ids and codes only.
import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import multer from "multer";
import { ARTIFACT_CHECK_REPORT_MAX_BYTES, ARTIFACT_CHECK_SHOT_MAX_BYTES, ARTIFACT_CHECK_SHOTS, type ArtifactCheckResultAnswer, type ArtifactCheckShot, type ArtifactCheckTiming, type TraceAttributes } from "@botiverse/raft-shared";
import type { InternalMount } from "../../platform/apps";
import { rateLimitRefusal, refuse, type RefusalInput } from "../../platform/refusals";
import { withAppSpan } from "../../platform/tracing";
import { finishCheck, isCheckShot, leaseCheck, parseCheckReport, type ArtifactCheckFinishOutcome, type ArtifactCheckLeaseOutcome } from "./checkTask";
import { byteSize } from "./apiCommon";
import { checkWorkerTokens } from "./checkWorkerToken";
import { matchContentCaller } from "./contentWorker";

const WORKER_REQUESTS_PER_MINUTE = 600;
const REFUSED_REQUESTS_PER_MINUTE = 30;
const CALLER = "artifactsCheckCaller";
const isCaller = (res: Response): boolean => res.locals[CALLER] === true;

/**
 * An internal route asked for with no Worker configured, or one that isn't
 * there: one 404, so nothing tells a caller which routes exist. The content
 * Worker's routes answer it too (mount.ts).
 */
export const INTERNAL_ROUTE_NOT_FOUND: RefusalInput = { code: "not_found", error: "Nothing is served at this address: check the address and send the request again." };

/**
 * A Worker route asked without the Worker's token (or with a wrong one): one
 * answer for every route and reason, so nothing tells a caller which token
 * would do. The content Worker's routes answer it too (mount.ts).
 */
export const WORKER_UNAUTHORIZED: RefusalInput = { code: "UNAUTHORIZED", error: "This internal route needs its Worker's token, and none that it accepts was sent: send the Worker's own bearer token." };

/** Each Worker's limit per caller and minute, past it (checkRoutes and the content Worker's in mount.ts). */
export const workerRateLimited = () => rateLimitRefusal("ARTIFACTS_WORKER_RATE_LIMITED", "Too many requests from this caller in a minute: wait for the window to pass, then send the request again.");

const INVALID_FORM: RefusalInput = {
  code: "INVALID_REQUEST",
  error: `A check result is multipart/form-data with one report field and at most one PNG per viewport (${ARTIFACT_CHECK_SHOTS.join(", ")}): send it in that shape.`,
};

/** The result's form, in memory, after the token: the report and one PNG per shot, nothing else. */
const resultForm = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ARTIFACT_CHECK_SHOT_MAX_BYTES, files: ARTIFACT_CHECK_SHOTS.length, fields: 1, fieldSize: ARTIFACT_CHECK_REPORT_MAX_BYTES, parts: ARTIFACT_CHECK_SHOTS.length + 1 },
}).fields(ARTIFACT_CHECK_SHOTS.map((name) => ({ name, maxCount: 1 })));

function parseResultForm(req: Request, res: Response, next: NextFunction): void {
  resultForm(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE" || err.code === "LIMIT_FIELD_VALUE") {
        refuse(res, 413, {
          code: "CHECK_RESULT_TOO_LARGE",
          error: `A screenshot is over ${byteSize(ARTIFACT_CHECK_SHOT_MAX_BYTES)} or the report over ${byteSize(ARTIFACT_CHECK_REPORT_MAX_BYTES)}: send them within those caps, or the report without that screenshot.`,
        });
        return;
      }
      refuse(res, 400, INVALID_FORM);
      return;
    }
    if (err) {
      refuse(res, 400, INVALID_FORM);
      return;
    }
    next();
  });
}

const leaseOutcome = (outcome: ArtifactCheckLeaseOutcome) => ({ outcome: outcome.kind });
// A finished check's span also says how long the whole check took (trace.ts), which the result request's own `duration_ms` doesn't.
const finishOutcome = (outcome: ArtifactCheckFinishOutcome): TraceAttributes => (outcome.kind === "finished"
  ? { outcome: outcome.status, kind: outcome.artifactKind, check_ms: outcome.checkMs, run_ms: outcome.runMs, ...stageTimes(outcome.timing) }
  : { outcome: outcome.kind });
// Where the Worker says the run's time went (trace.ts): one attribute a stage, none when it said nothing.
const stageTimes = (timing: ArtifactCheckTiming | null): TraceAttributes => (timing === null ? {} : {
  browser_ms: timing.browserMs,
  prepare_ms: timing.prepareMs,
  load_ms: timing.loadMs,
  settle_ms: timing.settleMs,
  shots_ms: timing.shotsMs,
});

export function mountArtifactCheck(mount: InternalMount): void {
  // Read the token once at startup, so a bad configuration is logged before the first request.
  checkWorkerTokens();
  const router = Router();

  router.use((req: Request, res: Response, next: NextFunction) => {
    res.set("cache-control", "no-store");
    const tokens = checkWorkerTokens();
    if (tokens.length === 0) {
      res.status(503).json({ error: "The check Worker is not configured" });
      return;
    }
    res.locals[CALLER] = matchContentCaller(req.headers.authorization, tokens) !== null;
    next();
  });

  // replica-local: abuse guard, a per-replica budget is acceptable (the Worker asks for one lease at
  // a time, at most ~3 a second, and posts a result per lease: well under 600 a minute).
  router.use(rateLimit({
    windowMs: 60 * 1000,
    limit: (_req, res) => (isCaller(res) ? WORKER_REQUESTS_PER_MINUTE : REFUSED_REQUESTS_PER_MINUTE),
    keyGenerator: (req, res) => (isCaller(res) ? "worker" : `refused:${ipKeyGenerator(mount.clientIp(req))}`),
    standardHeaders: true,
    legacyHeaders: false,
    handler: workerRateLimited(),
  }));

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!isCaller(res)) {
      console.warn("[artifacts-check] refused token", { route: `${req.method} ${req.baseUrl}${req.path}`, source: mount.clientIp(req) });
      refuse(res, 401, WORKER_UNAUTHORIZED);
      return;
    }
    next();
  });

  router.post("/lease", async (_req, res) => {
    try {
      const outcome = await withAppSpan("server.artifacts.check.lease", {}, () => leaseCheck(), { onSuccess: leaseOutcome });
      switch (outcome.kind) {
        case "leased":
          console.info("[artifacts-check] leased", { checkId: outcome.lease.checkId, versionId: outcome.lease.versionId });
          res.status(200).json(outcome.lease);
          return;
        case "none":
          res.status(204).end();
          return;
        case "not_configured":
          res.status(503).json({ error: "No content origin to sign for" });
          return;
        case "failed":
          console.error("[artifacts-check] lease not signed", { errorClass: outcome.errorClass });
          res.status(500).json({ error: "Failed to lease" });
          return;
      }
    } catch (err) {
      if (res.headersSent) return;
      console.error("internal.artifacts-check.lease failed", mount.serializeError(err));
      res.status(500).json({ error: "Failed to lease" });
    }
  });

  router.post("/:checkId/result", parseResultForm, async (req, res) => {
    try {
      const checkId = req.params.checkId!;
      const body = req.body as Record<string, unknown> | undefined;
      let report: ReturnType<typeof parseCheckReport> = null;
      try {
        report = typeof body?.report === "string" ? parseCheckReport(JSON.parse(body.report)) : null;
      } catch {
        report = null;
      }
      if (report === null || report.checkId !== checkId) {
        refuse(res, 400, { code: "INVALID_REPORT", error: "The report field isn't a check report for this check: send the report of the check this result is for." });
        return;
      }
      const files = (req.files ?? {}) as Partial<Record<string, Express.Multer.File[]>>;
      const shots: Partial<Record<ArtifactCheckShot, Buffer>> = {};
      for (const shot of ARTIFACT_CHECK_SHOTS) {
        const file = files[shot]?.[0];
        if (file === undefined) continue;
        if (!isCheckShot(file.buffer)) {
          refuse(res, 400, { code: "INVALID_SCREENSHOT", error: `The ${shot} screenshot isn't a PNG: send a PNG, or leave that screenshot out.` });
          return;
        }
        shots[shot] = file.buffer;
      }
      const parsed = report;
      const outcome = await withAppSpan("server.artifacts.check.result", { load: parsed.load.outcome }, () => finishCheck(checkId, parsed, shots), { onSuccess: finishOutcome });
      switch (outcome.kind) {
        case "finished":
          console.info("[artifacts-check] finished", { checkId, status: outcome.status });
          res.status(200).json({ status: outcome.status } satisfies ArtifactCheckResultAnswer);
          return;
        case "not_found":
          refuse(res, 404, { code: "CHECK_NOT_FOUND", error: "No check by that id is waiting for a result: it may have finished, been dropped, or never existed, so lease a new one." });
          return;
        case "conflict":
          console.info("[artifacts-check] result refused: the lease is not current", { checkId });
          refuse(res, 409, { code: "LEASE_NOT_CURRENT", error: "This result's lease is no longer current, so nothing was recorded: drop the result and lease the next check." });
          return;
        case "invalid":
          refuse(res, 400, { code: "INVALID_SCREENSHOT", error: `A screenshot was refused (${outcome.error}): send a smaller PNG, or leave that screenshot out.` });
          return;
        case "unavailable":
          res.status(503).json({ error: "Screenshots can't be stored now" });
          return;
      }
    } catch (err) {
      if (res.headersSent) return;
      console.error("internal.artifacts-check.result failed", mount.serializeError(err));
      res.status(500).json({ error: "Failed to record the result" });
    }
  });

  router.use((_req: Request, res: Response) => {
    refuse(res, 404, INTERNAL_ROUTE_NOT_FOUND);
  });

  mount.use("artifacts-check", router);
}
