import {
  createUpgrader,
  fileProvenanceJournal,
  type CreateUpgraderOptions,
  type HostAdapter,
  type NotificationEvent,
  type ReleaseSource,
  type Upgrader,
} from "@botiverse/k-carrier";

import { createKHostAdapter } from "./kHostAdapter.js";
import { createKServiceExecutableSurface } from "./kLifecycleSurface.js";
import { kStateDir } from "./kPaths.js";
import { createComputerReleaseSource } from "./kReleaseSource.js";
import { resolveUpgradeBaseUrl } from "./computerRelease.js";

export interface CreateComputerUpgraderOptions {
  host?: HostAdapter;
  source?: ReleaseSource;
  baseUrl?: string;
  notificationSink?: (event: NotificationEvent) => Promise<void>;
  onProgress?: CreateUpgraderOptions["onProgress"];
  lifecycleSurfaces?: NonNullable<CreateUpgraderOptions["lifecycleSurfaces"]>;
  createUpgraderFn?: typeof createUpgrader;
}

/**
 * The one Computer construction for K. CLI, live-service and recovery
 * coordinators vary only the requested operation/provenance; they never get a
 * second byte-swap path or a differently configured transaction engine.
 */
export function createComputerUpgrader(
  slockHome: string,
  opts: CreateComputerUpgraderOptions = {},
): Upgrader {
  const stateDir = kStateDir(slockHome);
  return (opts.createUpgraderFn ?? createUpgrader)({
    stateDir,
    host: opts.host ?? createKHostAdapter(slockHome),
    source: opts.source ?? createComputerReleaseSource(
      opts.baseUrl ?? resolveUpgradeBaseUrl(),
    ),
    policy: "confirm",
    notificationSink: opts.notificationSink ?? (async () => {}),
    onProgress: opts.onProgress,
    lifecycleSurfaces: opts.lifecycleSurfaces ?? [createKServiceExecutableSurface(slockHome)],
    provenance: fileProvenanceJournal(stateDir),
    provenanceIdentity: { who: "local", carrier: "computer" },
  });
}
