// The comment limits of Artifacts, shared by the web contract
// (webArtifactsContract.ts, ARTIFACT_COMMENT_MAX_CHARS) and the agent API's
// (agentApiArtifactsContract.ts, AGENT_API_ARTIFACT_MAX_COMMENT_CHARS).

/** Characters (Unicode code points) of a comment's stored text, each mention as its `@handle`, after trimming. */
export const ARTIFACT_COMMENT_MAX_CHARS = 8000;

/** The most images one comment (or review draft) may carry. */
export const ARTIFACT_COMMENT_MAX_IMAGES = 4;

/** The largest image a comment may carry, in bytes (the Server's object file cap; the bytes it keeps, after removing metadata). */
export const ARTIFACT_COMMENT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The image types a comment may carry. The Server decides by the bytes
 * alone (never the name or the declared type), and never takes SVG.
 */
export const ARTIFACT_COMMENT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ArtifactCommentImageType = (typeof ARTIFACT_COMMENT_IMAGE_TYPES)[number];

/**
 * Comment images a person may upload a minute (the web's `commentImages`
 * limit), and the most one review of an agent's may carry (the CLI uploads
 * them all in one go).
 */
export const ARTIFACT_COMMENT_IMAGE_UPLOADS_PER_MINUTE = 30;

// The Server's agent write budgets live in packages/server/src/services/
// agentApiWriteLimits.ts (AGENT_API_WRITE_BUDGETS.artifactWrites).
/**
 * Artifact writes one agent may make a minute (the Server's per-agent
 * budget): a review spends one per comment and each of its images one more
 * (their uploads), so a client that sends them in one go keeps a review's
 * comments and images together within this, or the review is refused on
 * every run.
 */
export const ARTIFACT_AGENT_WRITES_PER_MINUTE = 60;

/** How many of a file's first bytes artifactCommentImageTypeOf reads (WebP's header is the longest). */
export const ARTIFACT_COMMENT_IMAGE_TYPE_BYTES = 12;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * The comment image type of these bytes, by their first bytes alone, as the
 * Server decides it (core's object files: PNG, JPEG, GIF, WebP); null for
 * anything else, SVG and HTML included. A client checks a file with it before
 * sending it; the Server's answer is still the one that counts.
 */
export function artifactCommentImageTypeOf(bytes: Uint8Array): ArtifactCommentImageType | null {
  const startsWith = (signature: readonly number[], at = 0) => bytes.length >= at + signature.length && signature.every((byte, i) => bytes[at + i] === byte);
  const ascii = (text: string, at = 0) => startsWith([...text].map((c) => c.charCodeAt(0)), at);
  if (startsWith(PNG_SIGNATURE)) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii("GIF87a") || ascii("GIF89a")) return "image/gif";
  if (ascii("RIFF") && ascii("WEBP", 8)) return "image/webp";
  return null;
}
