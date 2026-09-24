import { withComputerMutationLock } from "./concurrency.js";
import { retireLegacyOsSupervisor } from "./osSupervisorRuntime.js";
import { listAttachedServerIds } from "./serverState.js";
import { start } from "./services/start.js";
import { stop } from "./services/stop.js";

export interface LegacyOsSupervisorMigrationDeps {
  retire?: typeof retireLegacyOsSupervisor;
  listAttached?: typeof listAttachedServerIds;
  withLock?: typeof withComputerMutationLock;
  stopService?: typeof stop;
  startService?: typeof start;
}

/** Installer-only migration. Cleanup is advisory, while the existing service
 * is deterministically cycled onto Computer's detached owner when attachments
 * exist. A cleanup failure therefore never makes the optional OS manager a
 * prerequisite for normal use. */
export async function migrateLegacyOsSupervisorInstall(
  slockHome: string,
  binaryPath: string,
  deps: LegacyOsSupervisorMigrationDeps = {},
) {
  const attached = await (deps.listAttached ?? listAttachedServerIds)(
    slockHome,
  );
  if (attached.length === 0) {
    const retirement = await (deps.retire ?? retireLegacyOsSupervisor)(
      slockHome,
      binaryPath,
    );
    return { retirement, lifecycle: "not-needed" as const, attachedCount: 0 };
  }

  return (deps.withLock ?? withComputerMutationLock)(
    slockHome,
    async (signal) => {
      const retirement = await (deps.retire ?? retireLegacyOsSupervisor)(
        slockHome,
        binaryPath,
      );
      await (deps.stopService ?? stop)({ slockHome }, { signal });
      await (deps.startService ?? start)(
        { slockHome, serverId: null, foreground: false },
        { signal },
      );
      return {
        retirement,
        lifecycle: "detached-ready" as const,
        attachedCount: attached.length,
      };
    },
  );
}
