export type DesktopRuntimeEnvironment = Readonly<{
  environmentId: "production" | "staging";
  generation: number;
  frontendOrigin: string;
  apiOrigin: string;
  socketOrigin: string;
  updateAuthority: "productionHands" | "none";
}>;

export const INVALID_DESKTOP_RUNTIME_ENVIRONMENT = "INVALID_DESKTOP_RUNTIME_ENVIRONMENT" as const;

export class InvalidDesktopRuntimeEnvironmentError extends Error {
  readonly code = INVALID_DESKTOP_RUNTIME_ENVIRONMENT;

  constructor() {
    super("Invalid Desktop runtime environment");
    this.name = "InvalidDesktopRuntimeEnvironmentError";
  }
}

type DesktopRuntimeEnvironmentPreset = Readonly<Omit<DesktopRuntimeEnvironment, "environmentId" | "generation">>;

export const DESKTOP_RUNTIME_ENVIRONMENT_PRESETS: Readonly<Record<DesktopRuntimeEnvironment["environmentId"], DesktopRuntimeEnvironmentPreset>> = Object.freeze({
  production: Object.freeze({
    frontendOrigin: "https://app.raft.build",
    apiOrigin: "https://api.raft.build",
    socketOrigin: "https://api.raft.build",
    updateAuthority: "productionHands",
  }),
  staging: Object.freeze({
    frontendOrigin: "https://raft-app-staging.botiverse.dev",
    apiOrigin: "https://api-aws-staging.botiverse.dev",
    socketOrigin: "https://api-aws-staging.botiverse.dev",
    updateAuthority: "none",
  }),
});

type EnvironmentHost = {
  __RAFT_DESKTOP_ENVIRONMENT__?: unknown;
  __TAURI_INTERNALS__?: { invoke?: unknown };
};

export function hasDesktopBridge(host: EnvironmentHost = globalThis as EnvironmentHost): boolean {
  return typeof host.__TAURI_INTERNALS__?.invoke === "function";
}

function origin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function readDesktopRuntimeEnvironment(
  host: EnvironmentHost = globalThis as EnvironmentHost,
): DesktopRuntimeEnvironment | null {
  const value = host.__RAFT_DESKTOP_ENVIRONMENT__;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "apiOrigin,environmentId,frontendOrigin,generation,socketOrigin,updateAuthority") return null;
  if (record.environmentId !== "production" && record.environmentId !== "staging") return null;
  if (!Number.isSafeInteger(record.generation) || (record.generation as number) < 1) return null;
  const frontendOrigin = origin(record.frontendOrigin);
  const apiOrigin = origin(record.apiOrigin);
  const socketOrigin = origin(record.socketOrigin);
  if (!frontendOrigin || !apiOrigin || !socketOrigin) return null;
  const expected = DESKTOP_RUNTIME_ENVIRONMENT_PRESETS[record.environmentId];
  if (
    frontendOrigin !== expected.frontendOrigin ||
    apiOrigin !== expected.apiOrigin ||
    socketOrigin !== expected.socketOrigin ||
    record.updateAuthority !== expected.updateAuthority
  ) return null;
  return Object.freeze({
    environmentId: record.environmentId,
    generation: record.generation as number,
    frontendOrigin,
    apiOrigin,
    socketOrigin,
    updateAuthority: expected.updateAuthority,
  });
}

const compiledApiOrigin = typeof import.meta.env?.VITE_API_URL === "string"
  ? import.meta.env.VITE_API_URL.replace(/\/$/, "")
  : "";
export const DESKTOP_RUNTIME_ENVIRONMENT = readDesktopRuntimeEnvironment();
type GenerationStorage = Pick<Storage, "getItem" | "setItem" | "clear">;
type RuntimeCacheStorage = Pick<CacheStorage, "keys" | "delete">;

export function applyDesktopEnvironmentGeneration(
  environment: DesktopRuntimeEnvironment | null,
  storage: GenerationStorage | undefined = typeof localStorage === "undefined" ? undefined : localStorage,
  cacheStorage: RuntimeCacheStorage | undefined = typeof caches === "undefined" ? undefined : caches,
): boolean {
  if (!environment || !storage) return false;
  const generationKey = "raft_desktop_environment_generation";
  const generation = String(environment.generation);
  if (storage.getItem(generationKey) !== generation) {
    // Environment switches are intentionally destructive. Distinct origins
    // isolate prod/staging; the native generation additionally forces fresh
    // auth whenever the user returns to a previously used environment.
    storage.clear();
    storage.setItem(generationKey, generation);
    if (cacheStorage) {
      void cacheStorage.keys().then((keys) => Promise.all(keys.map((key) => cacheStorage.delete(key))));
    }
    return true;
  }
  return false;
}
applyDesktopEnvironmentGeneration(DESKTOP_RUNTIME_ENVIRONMENT);

export function deriveRuntimeEndpoints(
  environment: DesktopRuntimeEnvironment | null,
  compiledOrigin = compiledApiOrigin,
  pageOrigin = globalThis.location?.origin || "",
  desktopBridgePresent = hasDesktopBridge(),
) {
  if (desktopBridgePresent && !environment) {
    return Object.freeze({
      apiOrigin: "",
      apiBase: "/api",
      socketOrigin: "/",
      desktopRuntimeError: INVALID_DESKTOP_RUNTIME_ENVIRONMENT,
    });
  }

  const apiOrigin = environment?.apiOrigin || compiledOrigin || pageOrigin;
  return Object.freeze({
    apiOrigin,
    apiBase: apiOrigin ? `${apiOrigin.replace(/\/$/, "")}/api` : "/api",
    socketOrigin: environment?.socketOrigin || compiledOrigin || "/",
    desktopRuntimeError: null,
  });
}

const runtimeEndpoints = deriveRuntimeEndpoints(DESKTOP_RUNTIME_ENVIRONMENT);
export const RUNTIME_API_BASE = runtimeEndpoints.apiBase;
export const RUNTIME_API_ORIGIN = runtimeEndpoints.apiOrigin;
export const RUNTIME_SOCKET_ORIGIN = runtimeEndpoints.socketOrigin;
export const RUNTIME_DESKTOP_ENVIRONMENT_ERROR = runtimeEndpoints.desktopRuntimeError;

export function assertValidDesktopRuntimeEnvironment(
  error: typeof RUNTIME_DESKTOP_ENVIRONMENT_ERROR = RUNTIME_DESKTOP_ENVIRONMENT_ERROR,
): void {
  if (error) throw new InvalidDesktopRuntimeEnvironmentError();
}
