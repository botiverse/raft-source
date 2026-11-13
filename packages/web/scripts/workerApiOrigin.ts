// The API origin public/_worker.js asks for public Artifacts' preview meta
// (its API_ORIGIN): the build's VITE_API_URL, written over the placeholder
// in dist/_worker.js once the build has copied public/. A build without an
// absolute http(s) VITE_API_URL (previews, which drop the Worker, and
// same-origin setups) keeps the placeholder, and the Worker injects nothing.
export const WORKER_API_ORIGIN_PLACEHOLDER = "__RAFT_API_ORIGIN__";

/** VITE_API_URL's origin when it is an absolute http(s) URL, else null. */
export function workerApiOrigin(viteApiUrl: string | undefined): string | null {
  const value = viteApiUrl?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** The Worker's source with its API origin written in (the placeholder must be there exactly once); unchanged with no origin. */
export function applyWorkerApiOrigin(worker: string, origin: string | null): string {
  const quoted = `"${WORKER_API_ORIGIN_PLACEHOLDER}"`;
  if (worker.split(quoted).length !== 2) throw new Error(`_worker.js must hold ${quoted} exactly once`);
  return origin === null ? worker : worker.replace(quoted, JSON.stringify(origin));
}
