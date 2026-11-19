import { ReferralSourcePrompt } from "./ReferralSourcePrompt";
import ServerSetupProjectionGate from "./ServerSetupProjectionGate";

/**
 * What MainLayout mounts for onboarding inside a server: the owner setup gate
 * (blocking steps, owner only) and the "How did you hear about Raft?" card for
 * a new account the setup survey never reached. The card decides for itself
 * from the gate's published reading, so it never shows over a setup step.
 */
export function ServerOnboardingSurfaces({ serverId, serverSlug }: { serverId: string; serverSlug: string }) {
  return (
    <>
      <ServerSetupProjectionGate serverId={serverId} serverSlug={serverSlug} />
      <ReferralSourcePrompt />
    </>
  );
}
