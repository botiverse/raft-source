export const LOOPBACK_NO_PROXY = "127.0.0.1,localhost";

export function applyLoopbackNoProxyEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const entries = [
    ...LOOPBACK_NO_PROXY.split(","),
    ...(env.NO_PROXY ?? "").split(","),
    ...(env.no_proxy ?? "").split(","),
  ]
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const seen = new Set<string>();
  const merged = entries.filter((entry) => {
    const key = entry.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(",");
  env.NO_PROXY = merged;
  env.no_proxy = merged;
  return env;
}
