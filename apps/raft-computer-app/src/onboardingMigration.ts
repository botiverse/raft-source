import {
  LegacyMachinesClient,
  detectLegacyMigration,
  ensureUsableUserSession,
  resolveServerUrl,
  resolveServerUrlEnv,
  type LegacyMachineRosterClient,
  type LegacyMachineRosterClientFactory,
  type MigrationDetection,
  type UsableUserSession,
} from "@botiverse/raft-computer/lib";

interface OnboardingLegacyMigrationDeps {
  ensureSession?: (slockHome: string) => Promise<UsableUserSession>;
  detectMigration?: (
    slockHome: string,
    serverSlug: string,
    clientFactory: LegacyMachineRosterClientFactory,
  ) => Promise<MigrationDetection>;
  createRosterClient?: (baseUrl: string, accessToken: string) => LegacyMachineRosterClient;
  resolveServerUrlEnv?: () => string | undefined;
}

function normalizeServerSlug(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
}

function legacyMigrationBlockMessage(serverSlug: string): string {
  return (
    "This workspace has a legacy daemon candidate on this computer. To avoid creating a duplicate Computer identity, run `raft-computer setup /" +
    normalizeServerSlug(serverSlug) +
    "` in a terminal and choose the migration path."
  );
}

export async function getOnboardingLegacyMigrationBlock(
  slockHome: string,
  serverSlug: string,
  deps: OnboardingLegacyMigrationDeps = {},
): Promise<string | null> {
  const ensureSession = deps.ensureSession ?? ensureUsableUserSession;
  const session = await ensureSession(slockHome);
  if (session.status !== "usable") return null;

  const baseUrl = resolveServerUrl(session.serverUrl, (deps.resolveServerUrlEnv ?? resolveServerUrlEnv)());
  const createRosterClient = () =>
    deps.createRosterClient?.(baseUrl, session.accessToken) ?? new LegacyMachinesClient(baseUrl, session.accessToken);
  const detection = await (deps.detectMigration ?? detectLegacyMigration)(
    slockHome,
    normalizeServerSlug(serverSlug),
    createRosterClient,
  );
  if (detection.kind !== "matched" || detection.candidates.length === 0) return null;
  return legacyMigrationBlockMessage(serverSlug);
}

export async function assertNoLegacyMigrationCandidates(
  slockHome: string,
  serverSlug: string,
): Promise<void> {
  const block = await getOnboardingLegacyMigrationBlock(slockHome, serverSlug);
  if (block !== null) throw new Error(block);
}
