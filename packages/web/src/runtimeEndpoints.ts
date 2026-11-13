// The API and socket origins this build talks to. The only reader of
// VITE_API_URL: consumers import these constants instead of reading the env.
// The Electron desktop compiles VITE_API_URL in, like the Web build; without
// it (local dev, self-hosted) the API is on the page's own origin.
const compiledApiOrigin = typeof import.meta.env?.VITE_API_URL === "string"
  ? import.meta.env.VITE_API_URL.replace(/\/$/, "")
  : "";

export function deriveRuntimeEndpoints(
  compiledOrigin = compiledApiOrigin,
  pageOrigin = globalThis.location?.origin || "",
) {
  const apiOrigin = compiledOrigin || pageOrigin;
  return Object.freeze({
    apiOrigin,
    apiBase: apiOrigin ? `${apiOrigin.replace(/\/$/, "")}/api` : "/api",
    socketOrigin: compiledOrigin || "/",
  });
}

const runtimeEndpoints = deriveRuntimeEndpoints();
export const RUNTIME_API_BASE = runtimeEndpoints.apiBase;
export const RUNTIME_API_ORIGIN = runtimeEndpoints.apiOrigin;
export const RUNTIME_SOCKET_ORIGIN = runtimeEndpoints.socketOrigin;
