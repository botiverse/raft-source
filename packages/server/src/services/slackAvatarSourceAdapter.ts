import type { ExternalAvatarSourceAdapter } from "./externalAvatarMaterializerService.js";
import { EXTERNAL_AVATAR_MAX_SOURCE_BYTES } from "./externalAvatarMaterializerService.js";

const SLACK_AVATAR_HOSTS = new Set([
  "avatars.slack-edge.com",
  "secure.gravatar.com",
]);
const RASTER_CONTENT_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function exactSlackAvatarUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("avatar_source_locator_invalid");
  }
  if (
    parsed.protocol !== "https:"
    || !SLACK_AVATAR_HOSTS.has(parsed.hostname)
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.hash
  ) throw new Error("avatar_source_locator_invalid");
  return parsed.toString();
}

export function createSlackAvatarSourceAdapter(input: {
  fetch?: typeof fetch;
  timeoutMs?: number;
} = {}): ExternalAvatarSourceAdapter {
  const fetcher = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error("Slack avatar timeout is invalid");
  }
  return {
    provider: "slack",
    async readSource({ locator, signal }) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(exactSlackAvatarUrl(locator), {
          method: "GET",
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error("avatar_source_unavailable");
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (contentType && !RASTER_CONTENT_TYPES.has(contentType)) {
          throw new Error("avatar_source_mime_invalid");
        }
        const declared = response.headers.get("content-length");
        if (declared) {
          const byteSize = /^\d+$/u.test(declared) ? Number(declared) : Number.NaN;
          if (!Number.isSafeInteger(byteSize) || byteSize <= 0 || byteSize > EXTERNAL_AVATAR_MAX_SOURCE_BYTES) {
            throw new Error("avatar_source_size_invalid");
          }
        }
        const chunks: Buffer[] = [];
        let byteSize = 0;
        for await (const raw of response.body as unknown as AsyncIterable<Uint8Array>) {
          const chunk = Buffer.from(raw);
          byteSize += chunk.length;
          if (byteSize > EXTERNAL_AVATAR_MAX_SOURCE_BYTES) throw new Error("avatar_source_size_invalid");
          chunks.push(chunk);
        }
        if (byteSize <= 0) throw new Error("avatar_source_size_invalid");
        return Buffer.concat(chunks, byteSize);
      } catch (error) {
        if (error instanceof Error && /^avatar_[a-z_]+$/u.test(error.message)) throw error;
        throw new Error(controller.signal.aborted ? "avatar_source_timeout" : "avatar_source_unavailable");
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
