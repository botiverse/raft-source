// Where in a page an Artifact comment is (Porthole 0.17.0, P152): an element
// or text anchor's `context`, the heading chain down to its section and the
// name of the labelled region around it, for a reader (a person or an agent)
// to know which part of the page it is on. The CSS path and quote still find
// the place again; the context is only read. One set of rules for every
// side that takes it: the web API (server webCommon.ts), the agent API
// (server comments.ts), the readers (agentText, the web's anchor line), and
// the anchor's size limit.

import { z } from "zod";
import { lazySchema } from "./lazySchema";
import type { ArtifactAnnotationAnchorContext } from "./workspaceArtifacts";

/**
 * The most of an anchor's `context` Raft keeps: Porthole's ANNOTATION_LIMITS
 * `heading` (each heading), `headings` (how many) and `region`
 * (@botiverse/porthole 0.17.0, P152). Mirrored here because this package (the
 * CLI's and the agent API contract's) doesn't depend on Porthole; the server,
 * which does, checks that they stay equal (web.api.test.ts). Lengths in
 * UTF-16 units, as Porthole counts them.
 */
export const ARTIFACT_ANCHOR_CONTEXT_LIMITS = { heading: 80, headings: 6, region: 80 } as const;

// Porthole's `withoutUnseen` (dist/bridge/unseen.js, 0.17.0), character for
// character: format characters (zero-width ones, the joiners U+200C and U+200D
// among them, bidi controls, tags), private-use characters, lone surrogates,
// every default-ignorable code point (U+034F, the Hangul fillers U+115F and
// U+3164, Mongolian's free variation selectors), the variation selectors
// U+FE00-FE0F and U+E0100-E01EF, and every control but a new line and a tab.
// Each is deleted, not replaced (an emoji may lose its joiners, as on Porthole's side).
const UNSEEN = /[\p{Cf}\p{Co}\p{Cs}\p{Default_Ignorable_Code_Point}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]|[^\P{Cc}\n\t]/gu;

/**
 * A heading or region as shown text, as Porthole cleans an anchor's context
 * (`parseAnchor`'s `shown`): what a person can't see deleted, every run of
 * spaces (new lines and tabs among them) one space, trimmed. Empty when
 * nothing visible is left.
 */
export function cleanArtifactAnchorContextText(text: string): string {
  return text.replace(UNSEEN, "").replace(/\s+/gu, " ").trim();
}

// At most `max` as sent (Porthole checks the length before cleaning), then cleaned.
const contextText = (max: number) => z.string().max(max).transform(cleanArtifactAnchorContextText);

/**
 * An anchor's `context` as sent: headings (at most 6, each at most 80) and a
 * region (at most 80), each cleaned; a heading cleaned to nothing is left out,
 * and a context with nothing left reads as none (`undefined`). Anything else,
 * or more, fails.
 */
export const artifactAnchorContextSchema = lazySchema("artifactAnchorContextSchema", () => z.object({
  headings: z.array(contextText(ARTIFACT_ANCHOR_CONTEXT_LIMITS.heading)).max(ARTIFACT_ANCHOR_CONTEXT_LIMITS.headings).optional(),
  region: contextText(ARTIFACT_ANCHOR_CONTEXT_LIMITS.region).optional(),
}).transform((value): ArtifactAnnotationAnchorContext | undefined => {
  const headings = (value.headings ?? []).filter((heading) => heading !== "");
  const region = value.region ?? "";
  if (headings.length === 0 && region === "") return undefined;
  return { ...(headings.length === 0 ? {} : { headings }), ...(region === "" ? {} : { region }) };
}));

/** An anchor, as either API stores it: the web's ArtifactCommentAnchor, or an agent's `{ type, data }`. */
interface AnyAnchor {
  type: string;
  data: object;
}

const contextOf = (anchor: AnyAnchor): unknown => (anchor.data as { context?: unknown }).context;

function withContext<T extends AnyAnchor>(anchor: T, context: ArtifactAnnotationAnchorContext | undefined): T {
  const { context: _dropped, ...rest } = anchor.data as Record<string, unknown>;
  return { ...anchor, data: context === undefined ? rest : { ...rest, context } } as T;
}

/**
 * An annotation anchor with its `context` as Raft keeps it: cleaned
 * (artifactAnchorContextSchema) when it is well formed, else left out, as is
 * one with nothing left. Never refused for it (an agent's anchor: the agent
 * API never refuses a comment for its context). Any other anchor, and one
 * without a context, as it is.
 */
export function keepArtifactAnchorContext<T extends AnyAnchor>(anchor: T): T {
  if (anchor.type !== "annotation" || contextOf(anchor) === undefined) return anchor;
  const parsed = artifactAnchorContextSchema.safeParse(contextOf(anchor));
  return withContext(anchor, parsed.success ? parsed.data : undefined);
}

/** An anchor's size as kept: its JSON, in UTF-8 bytes (the limit AGENT_API_ARTIFACT_MAX_ANCHOR_BYTES counts). */
export const artifactAnchorJsonBytes = (anchor: unknown): number => new TextEncoder().encode(JSON.stringify(anchor)).length;

/**
 * An anchor within `maxBytes`, as far as its context can make it: a comment
 * is never refused for its context. Over the limit, the region goes first,
 * then the headings one at a time from the top (the outermost: the section's
 * own heading, the last, stays longest), then the context as a whole; an
 * anchor still over it then is the caller's to refuse, as before contexts.
 * An anchor within it, or with no context, comes back as it is.
 */
export function fitArtifactAnchorContext<T extends AnyAnchor>(anchor: T, maxBytes: number): T {
  if (anchor.type !== "annotation" || artifactAnchorJsonBytes(anchor) <= maxBytes) return anchor;
  const context = contextOf(anchor);
  if (typeof context !== "object" || context === null) return anchor;
  const sent = context as { headings?: unknown; region?: unknown };
  let headings: string[] = Array.isArray(sent.headings) ? sent.headings.filter((heading): heading is string => typeof heading === "string") : [];
  const fitted = () => withContext(anchor, headings.length === 0 ? undefined : { headings });
  let candidate = fitted();
  while (headings.length > 0 && artifactAnchorJsonBytes(candidate) > maxBytes) {
    headings = headings.slice(1);
    candidate = fitted();
  }
  return candidate;
}
