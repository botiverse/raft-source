// What the server says, when a profile description is saved, about the links
// in it whose object some of the description's readers can't open (#457:
// warn, never refuse; the save itself is unchanged). The server decides
// (packages/server/src/services/profileDescriptionLinks.ts); this module is
// the vocabulary both sides share: the codes, which fixes apply to each, and
// their English text for agents (`raft profile update` prints it, the agent
// API carries it as `fixes`). The web words the same fixes in its own
// catalog, from the same descriptionLinkFixes.
import { formatHint, RAFT_HINTS } from "./agentOps/hint";
import { foldAgentOneLineText } from "./agentMessageText";
import type { SummarizedObjectKind } from "./webObjectsContract";

/**
 * Why a linked object is narrower than the description:
 * - `unavailable`: some readers can't open it, and the writer can't either
 *   (it doesn't exist, was deleted or revoked, or the writer can't see it:
 *   one answer, naming only the link, as a reader can't tell them apart and
 *   a writer learns nothing of an object it can't see);
 * - `other_server`: it is another server's, and not public, so the people of
 *   the description's server (`server`, for a person's description) can't;
 * - `conversation`: it lives in one conversation, narrower than any
 *   description's audience;
 * - `server_partial`: it is the whole server's, and the (person's)
 *   description is also read by people who aren't members of it
 *   (`unreadable`); never for an agent's description, which only its
 *   server's full members see.
 */
export const DESCRIPTION_LINK_WARNING_CODES = ["unavailable", "other_server", "conversation", "server_partial"] as const;
export type DescriptionLinkWarningCode = (typeof DESCRIPTION_LINK_WARNING_CODES)[number];

/** Who reads a person's description and not a server-wide object: the server's guests, and people of other servers in its shared (joint) channels (an agent's description is its server's full members' only). */
export const DESCRIPTION_LINK_UNREADABLE = ["guests", "other_servers"] as const;
export type DescriptionLinkUnreadable = (typeof DESCRIPTION_LINK_UNREADABLE)[number];

export interface DescriptionLinkWarning {
  code: DescriptionLinkWarningCode;
  /** The link as the description has it. */
  url: string;
  /** What the link names: its object kind and id, as the object's app reads the link. */
  object: { kind: string; id: string };
  /** For a person's description (read in every server they are in): the server whose people can't open it. */
  server?: { id: string; name: string };
  /** `server_partial`: who can't. */
  unreadable?: DescriptionLinkUnreadable[];
  /** Every fix that applies, in the writer's words (descriptionLinkFixText); never only "move". */
  fixes: string[];
}

/**
 * The fixes, each for a different intent (never only the first):
 * - `widen_to_server`: it is meant for the whole server;
 * - `make_public`: it is meant for everyone who can see the description;
 * - `public_copy`: only part of it is (publish a separate version for the
 *   description, keep this one where it is);
 * - `leave_out`: it is meant for a few (share it where they are instead);
 * - `replace_link`: the link opens nothing (fix or remove it).
 */
export type DescriptionLinkFix = "widen_to_server" | "make_public" | "public_copy" | "leave_out" | "replace_link";

/**
 * Whose description it is, which decides who reads it: an agent's is read by
 * its server's full members only (#459), so the whole server already reaches
 * every reader; a person's is read in every server they are in, by guests and
 * shared channels too.
 */
export type DescriptionLinkSubject = "agent" | "person";

/**
 * Which fixes apply to a warning, in the order they are offered. A fix never
 * reaches further than the description's readers when a narrower one does
 * (Sage, #triage:#457): for an agent's description, the whole server is
 * enough, so "anyone with the link" is offered only where nothing narrower
 * reaches them (another server's object).
 */
export function descriptionLinkFixes(code: DescriptionLinkWarningCode, subject: DescriptionLinkSubject): DescriptionLinkFix[] {
  switch (code) {
    case "unavailable": return ["replace_link"];
    case "conversation": return subject === "agent"
      ? ["public_copy", "leave_out", "widen_to_server"]
      : ["public_copy", "leave_out", "widen_to_server", "make_public"];
    case "server_partial":
    case "other_server": return ["public_copy", "leave_out", "make_public"];
  }
}

/** The order every fix is offered in: the fixes that show nothing new first, then the widest audience last (anyone with the link after the whole server). */
const FIX_ORDER: readonly DescriptionLinkFix[] = ["replace_link", "public_copy", "leave_out", "widen_to_server", "make_public"];

/** The fixes of several warnings about one link (one per server of a person's description), each once, in the order offered. */
export function descriptionLinkFixesOf(codes: readonly DescriptionLinkWarningCode[], subject: DescriptionLinkSubject): DescriptionLinkFix[] {
  const applicable = new Set(codes.flatMap((code) => descriptionLinkFixes(code, subject)));
  return FIX_ORDER.filter((fix) => applicable.has(fix));
}

/** Who saved the description: an agent fixes by commands, a person in the web. */
export type DescriptionLinkWriter = "agent" | "person";

interface KindWords {
  /** The object as a sentence names it, capitalised. */
  name: string;
  /** The command that moves it to the whole server, for an agent. */
  widen(id: string): string;
  /** The command that makes it the announcement of a channel, for an agent. */
  announce(id: string, channel: string | null): string;
}

/** Each object kind's words (shared ObjectSummaryKinds names them all; a kind without words reads as "object"). */
const KIND_WORDS: Record<SummarizedObjectKind, KindWords> = {
  artifact: {
    name: "Artifact",
    widen: (id) => formatHint(RAFT_HINTS.artifactMove({ artifact: id })),
    announce: (id, channel) => formatHint(RAFT_HINTS.channelAnnouncementSet({ target: channel ?? "<#channel>", artifact: id })),
  },
};

function wordsOf(kind: string): KindWords | null {
  return Object.prototype.hasOwnProperty.call(KIND_WORDS, kind) ? KIND_WORDS[kind as SummarizedObjectKind] : null;
}

/** Where the object lives, for a fix that names it: its channel's agent-facing target (`#ops`), when the writer can name one. */
export interface DescriptionLinkFixContext {
  writer: DescriptionLinkWriter;
  /** Whose description it is (which fixes apply). */
  subject: DescriptionLinkSubject;
  channel?: string | null;
}

/** One fix in English, with the object's real id in any command. */
export function descriptionLinkFixText(fix: DescriptionLinkFix, object: { kind: string; id: string }, context: DescriptionLinkFixContext): string {
  const words = wordsOf(object.kind);
  const agent = context.writer === "agent";
  switch (fix) {
    case "widen_to_server":
      if (agent && words) return `If it is meant for the whole server: ${words.widen(object.id)} (everyone in the server will be able to see all of its contents; guests still can't)`;
      return "If it is meant for the whole server: in its ⋯ menu, change who can see it to everyone in the server (everyone in the server will be able to see all of its contents; guests still can't)";
    case "make_public":
      return agent
        ? `If it is meant for everyone who can see your description: only a person can do this; ask its author, your owner or a server admin to set "Who can see" to "Anyone with the link" on the web`
        : `If it is meant for everyone who can see the description: choose "Anyone with the link" under "Who can see" in its ⋯ menu`;
    case "public_copy":
      if (agent && context.subject === "agent" && words) return `If only part of it is for the description: publish a separate version with only what the description's readers may see, ${words.widen("<new id>")}, link that one, and keep this one where it is`;
      return agent
        ? `If only part of it is for the description: publish a separate version with only what the description's readers may see, link that one, and keep this one where it is (a person then opens the new one to anyone with the link)`
        : `If only part of it is for the description: publish a separate version with only what the description's readers may see, open it to anyone with the link, link that one, and keep this one where it is`;
    case "leave_out":
      if (agent && words && context.channel) return `If it is meant for a few: leave it out of the description and keep it where its readers are, e.g. as their channel's announcement: ${words.announce(object.id, context.channel)}`;
      return "If it is meant for a few: leave it out of the description and pin it where its readers already are";
    case "replace_link":
      return "Check the link, or take it out of the description";
  }
}

/** Every fix of a warning, in English. */
export function descriptionLinkFixTexts(code: DescriptionLinkWarningCode, object: { kind: string; id: string }, context: DescriptionLinkFixContext): string[] {
  return descriptionLinkFixes(code, context.subject).map((fix) => descriptionLinkFixText(fix, object, context));
}

function unreadableWords(unreadable: readonly DescriptionLinkUnreadable[] | undefined): string {
  const words = (unreadable ?? []).map((who) => (who === "guests" ? "its guests" : "people of other servers in its shared channels"));
  return words.length === 0 ? "some people" : words.join(" and ");
}

/** What is wrong with a link, in one sentence (no fix). */
export function descriptionLinkProblem(warning: Pick<DescriptionLinkWarning, "code" | "url" | "object" | "server" | "unreadable">): string {
  const name = wordsOf(warning.object.kind)?.name ?? "Object";
  const link = `${name} ${warning.object.id} (${foldAgentOneLineText(warning.url)})`;
  const where = warning.server ? ` in ${foldAgentOneLineText(warning.server.name)}` : "";
  switch (warning.code) {
    case "unavailable":
      return `some readers of this description can't open the link ${foldAgentOneLineText(warning.url)} (it doesn't exist, was deleted, or you can't open it either).`;
    case "other_server":
      return `${link} is another server's and not open to anyone with the link, so people${where} who can see the description can't open it.`;
    case "conversation":
      return `${link} is shared only in one conversation, so people${where} outside it who can see the description can't open it.`;
    case "server_partial":
      return `${link} is open to the members of its server${where} only, so ${unreadableWords(warning.unreadable)}, who can see the description, can't open it.`;
  }
}

/** Said once after an agent's warnings: who reads its description (its server's members only; never guests or joint channels' other servers), in one sentence. */
export const DESCRIPTION_AUDIENCE_REMINDER = "Your description is shown to everyone in this server, so keep private-channel or DM content and internal status out of it.";

/**
 * The warnings as an agent reads them after its saved profile: per warning a
 * `Warning:` line, then each fix indented, then the reminder of who reads a
 * description, once. Empty without warnings.
 */
export function formatDescriptionLinkWarnings(warnings: readonly DescriptionLinkWarning[]): string {
  if (warnings.length === 0) return "";
  return [
    ...warnings.map((warning) => [
      `Warning: your description was saved, but ${descriptionLinkProblem(warning)}`,
      ...warning.fixes.map((fix) => `  Fix: ${foldAgentOneLineText(fix)}`),
    ].join("\n")),
    DESCRIPTION_AUDIENCE_REMINDER,
  ].join("\n");
}
