import { useSyncExternalStore } from "react";

/**
 * Where a public Artifact's embed page is served on this deployment: the
 * server's `artifactsEmbedOrigin` (its ARTIFACTS_EMBED_ORIGIN, the content
 * Worker's embed host), from the per-deploy client config (GET
 * /api/public/client-config, read once per page load: store/clientConfig.ts).
 * An Artifact `pt_<uuid>` embeds as `<origin>/pt_<uuid>`. Null until that
 * answer arrives, when it fails, or when the deployment has embeds off: then
 * no Embed item is offered anywhere.
 *
 * Only an origin is taken: https, or http on `localhost` / `*.localhost`
 * (local development), with no credentials, path, query or fragment.
 * Anything else is null.
 */
let origin: string | null = null;
const listeners = new Set<() => void>();

/** An embed origin exactly as `URL.origin` spells it, else null. */
export function embedOriginOf(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  if (value !== url.origin && value !== `${url.origin}/`) return null;
  return url.origin;
}

export function readArtifactsEmbedOrigin(): string | null {
  return origin;
}

/** Takes the server's `artifactsEmbedOrigin` from the client config's answer: anything not an origin is null. */
export function setArtifactsEmbedOrigin(value: unknown): void {
  const next = embedOriginOf(value);
  if (next === origin) return;
  origin = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** readArtifactsEmbedOrigin for a component: it renders again when the answer arrives. */
export function useArtifactsEmbedOrigin(): string | null {
  return useSyncExternalStore(subscribe, readArtifactsEmbedOrigin, readArtifactsEmbedOrigin);
}

export function resetArtifactsEmbedOriginForTests(): void {
  setArtifactsEmbedOrigin(null);
}
