export const RAFT_PWA_APP_NAME = "Raft";
export const RAFT_STAGING_PWA_APP_NAME = "Raft Staging";

type WebManifest = Record<string, unknown> & {
  name?: unknown;
  short_name?: unknown;
};

export function getPwaAppName(deploymentEnv: string | undefined): string {
  return deploymentEnv?.trim().toLowerCase() === "staging"
    ? RAFT_STAGING_PWA_APP_NAME
    : RAFT_PWA_APP_NAME;
}

export function applyPwaAppName(manifest: WebManifest, deploymentEnv: string | undefined): WebManifest {
  const appName = getPwaAppName(deploymentEnv);
  return {
    ...manifest,
    name: appName,
    short_name: appName,
  };
}
