// Puts an agent on a machine (or none) for a test's setup. Production has no
// such write: an agent changes Computer only through /migrate.
import { and, eq, isNull } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agents } from "../db/schema";
import { revokeRunnerCredentialsOffMachine } from "../services/agentCredentialService";

export async function placeAgentOnMachine(
  agentId: string,
  machineId: string | null,
  options: { executor?: DatabaseExecutor } = {},
): Promise<void> {
  const db = options.executor ?? getDb();
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx.update(agents)
      .set({ machineId, updatedAt: now, ...(machineId !== null ? { machineReleaseReason: null, machineReleasedAt: null } : {}) })
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)));
    // As every real bind does: runner keys another Machine minted stop working.
    await revokeRunnerCredentialsOffMachine(tx, { agentIds: [agentId], machineId, now });
  });
}
