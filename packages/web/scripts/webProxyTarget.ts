const DEFAULT_LOCAL_SERVER_PORT = "3001";

export const WEB_PROXY_TARGET_ORIGINS = {
  staging: "https://api-aws-staging.botiverse.dev",
  prod: "https://api.raft.build",
} as const;

export type WebProxyTargetName = keyof typeof WEB_PROXY_TARGET_ORIGINS;

interface WebProxyEnvironment {
  SLOCK_SERVER_PORT?: string;
  SLOCK_WEB_PROXY_TARGET?: string;
  SLOCK_WEB_PROXY_STAGING_ORIGIN?: string;
  SLOCK_WEB_PROXY_PROD_ORIGIN?: string;
}

function normalizeHttpsOrigin(raw: string, variableName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${variableName} must be an absolute HTTPS origin`);
  }

  if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${variableName} must be an HTTPS origin without a path, query, or fragment`);
  }

  return parsed.origin;
}

export function resolveWebProxyTarget(env: WebProxyEnvironment): {
  name: WebProxyTargetName | "local";
  origin: string;
} {
  const requested = env.SLOCK_WEB_PROXY_TARGET?.trim();
  if (!requested) {
    const port = env.SLOCK_SERVER_PORT?.trim() || DEFAULT_LOCAL_SERVER_PORT;
    if (!/^\d{1,5}$/.test(port) || Number(port) > 65535 || Number(port) === 0) {
      throw new Error("SLOCK_SERVER_PORT must be an integer between 1 and 65535");
    }
    return { name: "local", origin: `http://localhost:${port}` };
  }

  if (requested !== "staging" && requested !== "prod") {
    throw new Error("SLOCK_WEB_PROXY_TARGET must be either staging or prod");
  }

  const override = requested === "staging"
    ? env.SLOCK_WEB_PROXY_STAGING_ORIGIN
    : env.SLOCK_WEB_PROXY_PROD_ORIGIN;
  const origin = override?.trim() || WEB_PROXY_TARGET_ORIGINS[requested];
  return {
    name: requested,
    origin: normalizeHttpsOrigin(
      origin,
      requested === "staging" ? "SLOCK_WEB_PROXY_STAGING_ORIGIN" : "SLOCK_WEB_PROXY_PROD_ORIGIN",
    ),
  };
}
