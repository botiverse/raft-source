import { Router, type Response, type Router as RouterType } from "express";
import {
  admitReadMutation,
  getReadMutationFrontier,
  ReadMutationError,
  type ReadMutationPayload,
} from "../services/readMutationSequencer.js";

export const readMutationRouter: RouterType = Router();

type ReadMutationRouteService = {
  admit: typeof admitReadMutation;
  frontier: typeof getReadMutationFrontier;
};

const defaultReadMutationRouteService: ReadMutationRouteService = {
  admit: admitReadMutation,
  frontier: getReadMutationFrontier,
};

function resolveService(req: { app: { get(name: string): unknown } }): ReadMutationRouteService {
  return (req.app.get("readMutationRouteService") as ReadMutationRouteService | undefined)
    ?? defaultReadMutationRouteService;
}

function parsePayload(body: unknown): { mutationId: string; mutation: ReadMutationPayload } {
  if (!body || typeof body !== "object") {
    throw new ReadMutationError("INVALID_MUTATION_PAYLOAD", "request body is required");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.mutationId !== "string") {
    throw new ReadMutationError("INVALID_MUTATION_ID", "mutationId must be UUIDv4");
  }
  switch (record.kind) {
    case "row_read":
    case "row_unread":
      return {
        mutationId: record.mutationId,
        mutation: {
          kind: record.kind,
          scopeId: record.scopeId as string,
          throughSeq: record.throughSeq as number,
        },
      };
    case "channel_read_all":
      return {
        mutationId: record.mutationId,
        mutation: { kind: record.kind, scopeId: record.scopeId as string },
      };
    case "global_read_all":
      return { mutationId: record.mutationId, mutation: { kind: record.kind } };
    default:
      throw new ReadMutationError("INVALID_MUTATION_PAYLOAD", "unsupported read mutation kind");
  }
}

function sendReadMutationError(res: Response, error: unknown): boolean {
  if (!(error instanceof ReadMutationError)) return false;
  if (error.code === "MUTATION_ID_PAYLOAD_MISMATCH") {
    res.status(409).json({ error: error.message, code: error.code });
    return true;
  }
  const status = error.code === "SCOPE_NOT_FOUND" ? 404 : 400;
  res.status(status).json({ error: error.message, code: error.code });
  return true;
}

readMutationRouter.post("/", async (req, res) => {
  try {
    const parsed = parsePayload(req.body);
    const receipt = await resolveService(req).admit({
      serverId: req.serverId!,
      principalId: req.userId!,
      mutationId: parsed.mutationId,
      mutation: parsed.mutation,
    });
    res.status(receipt.outcome === "ADMITTED" ? 201 : 200).json(receipt);
  } catch (error) {
    if (sendReadMutationError(res, error)) return;
    console.error("Failed to admit read mutation:", error);
    res.status(500).json({ error: "Failed to admit read mutation", code: "READ_MUTATION_ADMISSION_FAILED" });
  }
});

readMutationRouter.get("/frontier", async (req, res) => {
  try {
    const parseInteger = (value: unknown, field: string): number | undefined => {
      if (value == null || value === "") return undefined;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new ReadMutationError("INVALID_MUTATION_PAYLOAD", `${field} must be a non-negative integer`);
      }
      return parsed;
    };
    const scopeValues = req.query.scopeIds == null
      ? []
      : Array.isArray(req.query.scopeIds)
        ? req.query.scopeIds
        : String(req.query.scopeIds).split(",");
    const frontier = await resolveService(req).frontier({
      serverId: req.serverId!,
      principalId: req.userId!,
      mutationId: typeof req.query.mutationId === "string" ? req.query.mutationId : undefined,
      limit: parseInteger(req.query.limit, "limit"),
      afterAuthoritySeq: parseInteger(req.query.afterAuthoritySeq, "afterAuthoritySeq"),
      snapshotUpperAuthoritySeq: parseInteger(req.query.snapshotUpperAuthoritySeq, "snapshotUpperAuthoritySeq"),
      scopeIds: scopeValues.map(String).filter(Boolean),
    });
    res.json(frontier);
  } catch (error) {
    if (sendReadMutationError(res, error)) return;
    console.error("Failed to load read mutation frontier:", error);
    // A frontier failure is an explicit error, never an empty/no-effect state.
    res.status(503).json({
      error: "Read mutation frontier is temporarily unavailable",
      code: "READ_MUTATION_FRONTIER_UNAVAILABLE",
    });
  }
});
