import type { CreateUpgraderOptions } from "@botiverse/k-carrier";

import { connectService } from "./lib/ipc-client.js";
import { kSlotBinaryPath } from "./kPaths.js";

type ReadbackSurface = NonNullable<CreateUpgraderOptions["lifecycleSurfaces"]>[number];

/**
 * Same-source K lifecycle evidence: the live service itself reports the exact
 * executable path the OS used for this incarnation. Version metadata, slot
 * files and coordinator intent cannot satisfy this surface.
 */
export function createKServiceExecutableSurface(
  slockHome: string,
  connect: typeof connectService = connectService,
  platform: NodeJS.Platform = process.platform,
): ReadbackSurface {
  const id = "computer.machine-attestation.serviceExecutablePath";
  return {
    id,
    async read() {
      const client = await connect(slockHome);
      try {
        const attestation = await client.request("machine-attestation", undefined);
        if (
          typeof attestation.serviceExecutablePath !== "string"
          || attestation.serviceExecutablePath.length === 0
        ) {
          throw new Error("K_LIFECYCLE_SURFACE_UNAVAILABLE: live service did not attest its executable path");
        }
        const expectedExperiment = kSlotBinaryPath(slockHome, "experiment");
        // Windows path identity is case-insensitive. K's lifecycle predicate
        // compares the declared slot spelling, so normalize only a live path
        // that is already the same Windows path; never project another file.
        const value = platform === "win32"
          && attestation.serviceExecutablePath.toLowerCase() === expectedExperiment.toLowerCase()
          ? expectedExperiment
          : attestation.serviceExecutablePath;
        return { value, source: id };
      } finally {
        await client.close();
      }
    },
  };
}
