import { Router, type Request, type Response, type Router as RouterType } from "express";
import { getDb, type DatabaseTransaction } from "../db/index.js";
import {
  APP_INSTALLATION_TOKEN_AUDIENCE,
  verifyAppInstallationCredential,
  type VerifiedAppInstallationCredential,
} from "../services/appInstallationCredentialService.js";
import {
  AppOutboundProjectionError,
  getAppServerProjection,
  listAppAgentProjections,
  listAppComputerProjections,
  listAppPublicChannelProjections,
} from "../services/appOutboundProjectionService.js";

export const appInstallationRouter: RouterType = Router();

type InstallationProjection<T> = {
  credential: VerifiedAppInstallationCredential;
  projection: T;
};

async function readInstallationProjection<T>(
  req: Request,
  res: Response,
  read: (credential: VerifiedAppInstallationCredential, tx: DatabaseTransaction) => Promise<T>,
): Promise<InstallationProjection<T> | null> {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Installation bearer token is required" });
    return null;
  }

  const result = await getDb().transaction(async (tx) => {
    const credential = await verifyAppInstallationCredential(
      authorization.slice("Bearer ".length),
      APP_INSTALLATION_TOKEN_AUDIENCE,
      tx,
    );
    if (!credential) return null;
    return { credential, projection: await read(credential, tx) };
  }, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
  if (!result) {
    res.status(401).json({ error: "Invalid, expired, or stale installation credential" });
    return null;
  }
  res.setHeader("Cache-Control", "private, no-store");
  return result;
}

function handleProjectionError(error: unknown, res: Response, operation: string) {
  if (error instanceof AppOutboundProjectionError) {
    res.status(403).json({ error: error.message });
    return;
  }
  console.error(`${operation} error:`, error);
  res.status(500).json({ error: `Failed to ${operation.toLowerCase()}` });
}

appInstallationRouter.get("/server", async (req, res) => {
  try {
    const result = await readInstallationProjection(req, res, getAppServerProjection);
    if (!result) return;
    if (!result.projection) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    res.json({ installation_id: result.credential.installationId, server: result.projection });
  } catch (error) {
    handleProjectionError(error, res, "Read installation server projection");
  }
});

appInstallationRouter.get("/agents", async (req, res) => {
  try {
    const result = await readInstallationProjection(req, res, listAppAgentProjections);
    if (!result) return;
    res.json({ installation_id: result.credential.installationId, agents: result.projection });
  } catch (error) {
    handleProjectionError(error, res, "List installation agent projections");
  }
});

appInstallationRouter.get("/channels", async (req, res) => {
  try {
    const result = await readInstallationProjection(req, res, listAppPublicChannelProjections);
    if (!result) return;
    res.json({ installation_id: result.credential.installationId, channels: result.projection });
  } catch (error) {
    handleProjectionError(error, res, "List installation channel projections");
  }
});

appInstallationRouter.get("/computers", async (req, res) => {
  try {
    const result = await readInstallationProjection(req, res, listAppComputerProjections);
    if (!result) return;
    res.json({ installation_id: result.credential.installationId, computers: result.projection });
  } catch (error) {
    handleProjectionError(error, res, "List installation computer projections");
  }
});
