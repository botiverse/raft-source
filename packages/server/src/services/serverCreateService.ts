import { SERVER_NAME_MAX_LENGTH, validateNewServerSlug } from "@botiverse/raft-shared";
import { ensureHostedCindy } from "./hostedCindyService";
import { enforceServerCreateRate } from "./serverCreateLimits";
import { createServer } from "./serverService";

/** The request is not a server that can be created: the status and message POST /api/servers answers with. */
export class ServerCreateInputError extends Error {
  constructor(readonly status: 400 | 409, message: string) {
    super(message);
    this.name = "ServerCreateInputError";
  }
}

/**
 * Creating a server for the caller, who becomes its owner: POST /api/servers
 * and an external invite's "create a server and connect it" (#wg-rbac:#16)
 * share it. The server commits in createServer's own transaction (owner
 * member, #all, the owner's onboarding channel, default apps); the hosted
 * Cindy follows it, best effort.
 */
export async function createServerAsOwner(body: unknown, ownerUserId: string): Promise<Awaited<ReturnType<typeof createServer>>> {
  const { name, slug } = (body ?? {}) as { name?: unknown; slug?: unknown };
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (!trimmedName || !slug) throw new ServerCreateInputError(400, "Name and slug are required");
  // The same bound as a rename (PATCH /api/servers/:id).
  if (trimmedName.length > SERVER_NAME_MAX_LENGTH) {
    throw new ServerCreateInputError(400, `Name must be ${SERVER_NAME_MAX_LENGTH} characters or fewer`);
  }
  const slugError = validateNewServerSlug(slug);
  if (slugError) throw new ServerCreateInputError(400, slugError);
  // Per person (serverCreateLimits.ts): a 429 RefusalError past the budget.
  await enforceServerCreateRate(ownerUserId);
  let server: Awaited<ReturnType<typeof createServer>>;
  try {
    server = await createServer(trimmedName, slug as string, ownerUserId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("already taken")) throw new ServerCreateInputError(409, message);
    // Two creates with one slug at once: the second passes the pre-check and
    // meets servers_slug_unique on insert. Same answer as the pre-check.
    if (isServerSlugUniqueViolation(err)) throw new ServerCreateInputError(409, `Server slug "${slug as string}" is already taken`);
    throw err;
  }
  // antiproton_cindy: the onboarding agent is a hosted Cindy, created right after the
  // server commits (no computer needed). Best effort; the setup projection backstops it.
  await ensureHostedCindy({ serverId: server.id, ownerUserId, site: "server_create" });
  return server;
}

function isServerSlugUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; constraint_name?: unknown; cause?: unknown };
    if (candidate.code === "23505" && (candidate.constraint === "servers_slug_unique" || candidate.constraint_name === "servers_slug_unique")) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
