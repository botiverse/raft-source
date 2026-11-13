// The check Worker's token, and with it whether this deployment runs publish
// checks at all. Apart from checkRoutes.ts (which asks it of each call) so
// checks.ts can ask it too without importing the routes.
import { createHash } from "node:crypto";
import { CONTENT_TOKEN_MIN_BYTES } from "./contentWorker";

let tokenMemo: { raw: string; digests: Buffer[] } | null = null;

/**
 * The check Worker's token, `ARTIFACTS_CHECK_WORKER_TOKEN`, as a sha256
 * digest; none (every route 503) when unset, shorter than
 * CONTENT_TOKEN_MIN_BYTES, or one of the content Worker's tokens (with a
 * warning naming what is wrong, never the value, once per configuration).
 */
export function checkWorkerTokens(env: NodeJS.ProcessEnv = process.env): readonly Buffer[] {
  const token = env.ARTIFACTS_CHECK_WORKER_TOKEN?.trim() ?? "";
  const raw = `${token}\n${env.ARTIFACTS_CONTENT_WORKER_TOKEN ?? ""}\n${env.ARTIFACTS_CONTENT_RAFT_TOKENS ?? ""}`;
  if (tokenMemo?.raw === raw) return tokenMemo.digests;
  const contentTokens = [env.ARTIFACTS_CONTENT_WORKER_TOKEN ?? "", ...(env.ARTIFACTS_CONTENT_RAFT_TOKENS ?? "").split(",")].map((each) => each.trim()).filter(Boolean);
  const problem = !token
    ? null
    : Buffer.byteLength(token, "utf8") < CONTENT_TOKEN_MIN_BYTES
      ? `ARTIFACTS_CHECK_WORKER_TOKEN is shorter than ${CONTENT_TOKEN_MIN_BYTES} bytes`
      : contentTokens.includes(token)
        ? "ARTIFACTS_CHECK_WORKER_TOKEN is also a content Worker token: each caller needs its own"
        : null;
  if (problem) console.warn("[artifacts-check] check Worker token is unusable; the check routes answer 503", { problem });
  tokenMemo = { raw, digests: token && !problem ? [createHash("sha256").update(token, "utf8").digest()] : [] };
  return tokenMemo.digests;
}

/**
 * Whether this deployment runs publish checks: it has a usable check Worker
 * token. Where it has none (local development, a self-hosted server without
 * the Worker) nothing could ever run a check, so none is recorded, authorized
 * or served; to turn checks on, deploy the check Worker and set
 * `ARTIFACTS_CHECK_WORKER_TOKEN` (packages/check-worker/README.md).
 */
export const checksConfigured = (env: NodeJS.ProcessEnv = process.env): boolean => checkWorkerTokens(env).length > 0;
