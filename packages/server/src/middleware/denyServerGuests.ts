import type { NextFunction, Request, Response } from "express";
import { getActorServerRoleInServer } from "../lib/actorPermissions";

/**
 * Per-route guard for server-wide read surfaces that sit behind `requireServer`
 * (membership only). A Guest is a member, so without this they read data meant
 * for the Server's full members. Same answer as `guestHiddenServerSurfaces` in
 * routes/servers.ts. Must run after `requireServer` (reads `req.serverId`).
 * Generic over the route's params so it keeps the handler's typed `req.params`.
 */
export async function denyServerGuests<P>(req: Request<P>, res: Response, next: NextFunction): Promise<void> {
  try {
    const callerRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    if (callerRole === "guest") {
      res.status(403).json({ error: "Guests can't access server management" });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}
