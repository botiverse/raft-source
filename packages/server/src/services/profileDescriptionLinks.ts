/**
 * #457: when a profile description is saved (an agent's or a person's), which
 * of its links name an object some of the description's readers can't open.
 * The answer is warnings for the writer, never a refusal: the save stands as
 * written, and any failure here is no warnings (best effort; the web still
 * draws such a link as unavailable to whoever can't open it).
 *
 * Who reads a description: everyone who can see its owner's.
 * - An agent's: its server's full members (people and agents) only; guests
 *   and other servers' people in joint channels are never shown an agent's
 *   description (cindyz, #457 aa990e4c), so a server-wide object reaches
 *   every reader.
 * - A person's (account-wide, users.description): in every server they are
 *   in, its members, its guests and the people of other servers in the joint
 *   (shared) channels the person is in; each server is judged on its own,
 *   and a warning names the server whose people can't open the link.
 *
 * The links are the ones the web draws (shared descriptionPieces), each
 * once, the first MAX_LINKS. A registered object kind that reads links
 * (AppObjectKind.linkId) names the object; the kind's `homes` say where it
 * lives; core's own rules decide (as objectSummaries does):
 * - not live (no home: deleted, revoked or never there), its app off for its
 *   server, or one the writer can't see either: `unavailable` (one code: a
 *   reader can't tell these apart, and a writer learns nothing of an object
 *   it can't see: no home, server or channel, only the link it wrote).
 *   The writer is who saved it, not always the owner: an agent's editor in
 *   the web may not see what the agent links;
 * - public: nothing;
 * - another server's than the one judged: `other_server`;
 * - a conversation (an orphan too): `conversation`;
 * - the whole server: `server_partial` only when someone who reads the
 *   description really isn't a member (Tenny, #457 B(ii)): for a person's,
 *   the server has guests or the person is in one of its joint channels;
 *   never for an agent's.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  descriptionLinkFixTexts,
  descriptionPieces,
  descriptionUrls,
  type DescriptionLinkUnreadable,
  type DescriptionLinkWarning,
  type ServerId,
} from "@botiverse/raft-shared";
import { linkedObjectKinds } from "../apps/firstPartyApps";
import { getDb } from "../db/index";
import { channelHumans, channels, jointChannels, jointChannelServers, serverMembers } from "../db/schema";
import type { AppObjectHome } from "../platform/apps";
import { agentConversationRefs } from "../platform/conversations";
import { serverNames, serversOfUser } from "../platform/links";
import { homeOf, objectServersAnswer } from "../platform/visibility";
import { addTraceEvent, errorClassOf } from "../tracing/semanticTrace";
import { canViewHomedObjects, uuidArray, type ViewActor } from "./visibilityService";

/** At most this many distinct links of one description are checked. */
export const MAX_DESCRIPTION_LINKS = 20;
/** At most this many warnings are answered (a person's description warns per server, so links times servers). */
export const MAX_DESCRIPTION_WARNINGS = 20;

/** The servers a person is in, and those of them whose active joint channels they are in. */
interface PersonServers {
  ids: ServerId[];
  joint: ReadonlySet<string>;
}

async function personServers(userId: string): Promise<PersonServers> {
  const ids = (await serversOfUser(userId)).map((server) => server.id);
  return { ids, joint: ids.length === 0 ? new Set() : await jointServersOfPerson(userId, ids) };
}

/** Whose description it is (an agent's `serverId` as its row has it). */
export type DescriptionOwner =
  | { type: "agent"; id: string; serverId: string }
  | { type: "user"; id: string };

/**
 * Who saved it: the agent itself, or a person (an agent's editor in
 * `serverId`, or the owner of their own description: every server they are
 * in when no server is given).
 */
export type DescriptionWriter =
  | { type: "agent"; id: string; serverId: string }
  | { type: "user"; id: string; serverId?: string };

/** One server whose people read the description. */
interface AudienceServer {
  id: ServerId;
  name: string;
  hasGuests: boolean;
  /** The owner is in one of its joint channels: people of other servers read the description too. */
  inJoint: boolean;
}

interface LinkedObject {
  url: string;
  kind: string;
  id: string;
  home: AppObjectHome | null;
}

/** The warnings for a description just saved; [] when there is nothing to say or anything fails. */
export async function descriptionLinkWarnings(input: { description: string | null | undefined; owner: DescriptionOwner; writer: DescriptionWriter }): Promise<DescriptionLinkWarning[]> {
  try {
    const warnings = await warningsOf(input);
    // Counts and codes only: never the description, a link, an id or a title.
    if (warnings.length > 0) addTraceEvent("profile_description.link_warnings", { count: warnings.length, codes: [...new Set(warnings.map((warning) => warning.code))].sort().join(",") });
    return warnings;
  } catch (error) {
    addTraceEvent("profile_description.link_check_failed", { error_class: errorClassOf(error) });
    return [];
  }
}

/**
 * descriptionLinkWarnings when the description changed to a non-empty one;
 * [] (no query) otherwise.
 */
export function changedDescriptionLinkWarnings(input: { before: string | null | undefined; after: string | null | undefined; owner: DescriptionOwner; writer: DescriptionWriter }): Promise<DescriptionLinkWarning[]> {
  const after = input.after ?? "";
  if (after.trim() === "" || after === (input.before ?? "")) return Promise.resolve([]);
  return descriptionLinkWarnings({ description: after, owner: input.owner, writer: input.writer });
}

async function warningsOf({ description, owner, writer }: { description: string | null | undefined; owner: DescriptionOwner; writer: DescriptionWriter }): Promise<DescriptionLinkWarning[]> {
  if (!description || description.trim() === "") return [];
  const urls = [...new Set(descriptionUrls(descriptionPieces(description)))].slice(0, MAX_DESCRIPTION_LINKS);
  if (urls.length === 0) return [];
  const kinds = linkedObjectKinds();
  const named = urls.flatMap((url) => {
    for (const registered of kinds) {
      const id = registered.objectKind.linkId(url);
      if (id !== null) return [{ url, id, registered }];
    }
    return [];
  });
  if (named.length === 0) return [];

  // Where each object lives, by its kind's homes; one not live has none.
  const objects: LinkedObject[] = [];
  for (const registered of new Set(named.map((link) => link.registered))) {
    const links = named.filter((link) => link.registered === registered);
    const homes = await registered.objectKind.homes([...new Set(links.map((link) => link.id))]);
    const located = links.map((link) => ({ link, home: homes.get(link.id) ?? null }));
    // An object of a server with the app off (or deleted) is seen by no one, unless kept in a joint its closed server is still in (read-only).
    const homed = located.flatMap(({ home }) => (home ? [home] : []));
    const answered = await objectServersAnswer(homed, registered.app.flag, { access: "read" });
    const readable = new Set(homed.filter((_, index) => answered[index]));
    for (const { link, home } of located) {
      objects.push({ url: link.url, kind: registered.objectKind.kind, id: link.id, home: home && readable.has(home) ? home : null });
    }
  }

  // A person's servers and the ones they are in a joint channel of, read once for both the writer's check and the audience.
  let person: PersonServers | null;
  let personal: boolean;
  switch (owner.type) {
    case "user": person = await personServers(owner.id); personal = true; break;
    case "agent": person = null; personal = false; break;
    default: return assertNeverDescriptionParty(owner);
  }
  const seen = await writerSees(writer, objects, person);
  const audience = await audienceOf(owner, person);
  let agentChannels: Map<string, string>;
  let fixWriter: "agent" | "person";
  switch (writer.type) {
    case "agent": agentChannels = await channelTargets(writer, objects); fixWriter = "agent"; break;
    case "user": agentChannels = new Map<string, string>(); fixWriter = "person"; break;
    default: return assertNeverDescriptionParty(writer);
  }

  const warnings: DescriptionLinkWarning[] = [];
  const push = (object: LinkedObject, code: DescriptionLinkWarning["code"], server: AudienceServer | null, unreadable?: DescriptionLinkUnreadable[]) => {
    const channel = object.home?.homeChannelId ? agentChannels.get(object.home.homeChannelId) ?? null : null;
    warnings.push({
      code,
      url: object.url,
      object: { kind: object.kind, id: object.id },
      ...(personal && server ? { server: { id: server.id, name: server.name } } : {}),
      ...(unreadable ? { unreadable } : {}),
      fixes: descriptionLinkFixTexts(code, { kind: object.kind, id: object.id }, { writer: fixWriter, subject: personal ? "person" : "agent", channel }),
    });
  };
  objects.forEach((object, index) => {
    const home = object.home;
    if (!home || !seen[index]) {
      push(object, "unavailable", null);
      return;
    }
    if (home.homeKind === "public") return;
    for (const server of audience) {
      if (home.serverId !== server.id) {
        push(object, "other_server", server);
        continue;
      }
      if (home.homeKind === "conversation") {
        push(object, "conversation", server);
        continue;
      }
      const unreadable: DescriptionLinkUnreadable[] = [
        ...(server.hasGuests ? ["guests" as const] : []),
        ...(server.inJoint ? ["other_servers" as const] : []),
      ];
      if (unreadable.length > 0) push(object, "server_partial", server, unreadable);
    }
  });
  return warnings.slice(0, MAX_DESCRIPTION_WARNINGS);
}

/**
 * Whether the writer can see each object now (canViewHomedObjects); false
 * without a home. A person writing their own description is asked from the
 * servers they are in that could show one (an object's own server, or one
 * whose joint channels they are in), until every object is seen.
 */
async function writerSees(writer: DescriptionWriter, objects: readonly LinkedObject[], person: PersonServers | null): Promise<boolean[]> {
  const located = objects.flatMap((object, index) => (object.home ? [{ index, home: object.home }] : []));
  const seen = objects.map(() => false);
  if (located.length === 0) return seen;
  let serverIds: ServerId[];
  switch (writer.type) {
    case "agent":
      serverIds = [writer.serverId as ServerId];
      break;
    case "user":
      if (writer.serverId) serverIds = [writer.serverId as ServerId];
      else {
        const own = person ?? await personServers(writer.id);
        const hosting = new Set<string>(located.map(({ home }) => home.serverId));
        serverIds = own.ids.filter((id) => hosting.has(id) || own.joint.has(id));
      }
      break;
    default:
      return assertNeverDescriptionParty(writer);
  }
  const homed = located.map(({ home }) => ({ serverId: home.serverId, home: homeOf(home), author: home.author }));
  for (const serverId of serverIds) {
    const actor: ViewActor = writerActor(writer, serverId);
    const answers = await canViewHomedObjects(actor, homed);
    located.forEach(({ index }, position) => { if (answers[position]) seen[index] = true; });
    if (located.every(({ index }) => seen[index])) break;
  }
  return seen;
}

/** The servers whose people read the description, each with whether non-members read it there: a person's guests and joint channels, never an agent's. */
async function audienceOf(owner: DescriptionOwner, person: PersonServers | null): Promise<AudienceServer[]> {
  if (isAgentParty(owner)) {
    // An agent row's server id is a ServerId (the agents table's foreign key).
    const serverId = owner.serverId as ServerId;
    const name = (await serverNames([serverId])).get(serverId);
    return name === undefined ? [] : [{ id: serverId, name, hasGuests: false, inJoint: false }];
  }
  const { ids: serverIds, joint: jointRows } = person ?? await personServers(owner.id);
  if (serverIds.length === 0) return [];
  const db = getDb();
  const [names, guestRows] = await Promise.all([
    serverNames(serverIds),
    db.selectDistinct({ serverId: serverMembers.serverId }).from(serverMembers)
      .where(and(sql`${serverMembers.serverId} = ANY(${uuidArray(serverIds)})`, eq(serverMembers.role, "guest"))),
  ]);
  const guests = new Set(guestRows.map((row) => row.serverId));
  return serverIds.flatMap((id) => {
    const name = names.get(id);
    return name === undefined ? [] : [{ id, name, hasGuests: guests.has(id), inJoint: jointRows.has(id) }];
  });
}

/** Which of these servers' active joint channels (a live projection of a live joint) the person is a member of. One query. */
async function jointServersOfPerson(userId: string, serverIds: readonly ServerId[]): Promise<Set<string>> {
  const db = getDb();
  const memberChannels = db.select({ channelId: channelHumans.channelId }).from(channelHumans).where(eq(channelHumans.userId, userId));
  const rows = await db
    .selectDistinct({ serverId: channels.serverId })
    .from(channels)
    .innerJoin(jointChannelServers, eq(jointChannelServers.localChannelId, channels.id))
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(
      inArray(channels.id, memberChannels),
      inArray(channels.serverId, [...serverIds]),
      eq(channels.type, "joint"),
      isNull(channels.deletedAt),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
    ));
  return new Set(rows.map((row) => row.serverId));
}

/** The channel targets (`#ops`) an agent writer names its objects' home conversations by, for a fix's command; DMs and the unnamed left out. */
async function channelTargets(agent: { id: string; serverId: string }, objects: readonly LinkedObject[]): Promise<Map<string, string>> {
  const homeChannelIds = [...new Set(objects.flatMap((object) => (object.home?.homeKind === "conversation" && object.home.homeChannelId ? [object.home.homeChannelId] : [])))];
  if (homeChannelIds.length === 0) return new Map();
  const refs = await agentConversationRefs({ agentId: agent.id, serverId: agent.serverId as ServerId }, homeChannelIds);
  return new Map([...refs].flatMap(([home, ref]) => (ref.type !== "dm" && ref.target ? [[home, ref.target] as [string, string]] : [])));
}

/** A description party that isn't an agent or a person: unreachable (an exhaustive switch's last case). */
function assertNeverDescriptionParty(party: never): never {
  throw new Error(`unknown description party: ${JSON.stringify(party)}`);
}

/** Whether the owner is an agent, by an exhaustive switch (viewActorExhaustive.structure.test). */
function isAgentParty(owner: DescriptionOwner): owner is Extract<DescriptionOwner, { type: "agent" }> {
  switch (owner.type) {
    case "agent": return true;
    case "user": return false;
    default: return assertNeverDescriptionParty(owner);
  }
}

/** The writer as core visibility's actor in one of its servers. */
function writerActor(writer: DescriptionWriter, serverId: ServerId): ViewActor {
  switch (writer.type) {
    case "agent": return { type: "agent", id: writer.id, serverId };
    case "user": return { type: "user", id: writer.id, serverId };
    default: return assertNeverDescriptionParty(writer);
  }
}
