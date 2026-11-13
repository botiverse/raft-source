/**
 * Core read side of first-party objects (first-party app mechanism §四): which
 * objects of a registered kind a viewer can see, and their summaries. Core
 * decides visibility itself, before the app is asked for anything to show:
 *
 * 1. the app reports where each object lives (AppObjectKind.homes: server,
 *    standard home columns, author; anything it leaves out is unavailable);
 * 2. only while the app's flag is on for the reader's server and for the
 *    object's own server, and that server isn't soft-deleted (one batched
 *    evaluation and one query however many servers): a reader whose server
 *    has the app off gets every reference unavailable;
 * 3. the home, by the platform's rule (visibilityService.canViewHomedObjects:
 *    standing in the server, top-level conversations of the object's server,
 *    a joint's canonical channel through the reader's server's projection,
 *    another server's object otherwise only when public, orphans for their
 *    author, the author agent's manager and the server's owners and admins);
 * 4. only then AppObjectKind.summarize, with the references whose id is left.
 *
 * A kind that shows deleted objects (AppObjectKind.deleted, an Artifact's
 * deleted card) is asked, for the ids its `homes` left out, where each
 * deleted one lived; steps 2 and 3 decide on those homes exactly as on a live
 * one, and only the ids left get the kind's deleted summary: `{ ok: false,
 * reason: "deleted", deleted }`. Anything else, a deleted object the reader
 * couldn't have seen included, is the plain `unavailable`, in the same shape.
 *
 * Objects are named by references (AppObjectKind.parseRef): core reads only
 * their `id`; the rest (an Artifact's version) is the app's, for summarize.
 * Every requested reference gets one answer, in order, echoing it: `ok` with
 * the summary, else `unavailable`, the same for every reason. The route is
 * routes/objects.ts.
 */
import type { ObjectSummary, ServerId } from "@botiverse/raft-shared";
import type { AppObjectDeleted, AppObjectHome, AppObjectKind, AppObjectRef, AppWebReader, FirstPartyApp } from "../platform/apps";
import { appEnabledOnLiveServers } from "../platform/flags";
import { homeOf } from "../platform/visibility";
import { canViewHomedObjects, type ViewActor } from "./visibilityService";

/** A registered object kind and the app that owns it (apps/firstPartyApps.ts registeredObjectKind). */
export interface RegisteredObjectKind {
  app: Pick<FirstPartyApp, "id" | "flag">;
  objectKind: Pick<AppObjectKind, "kind" | "homes" | "parseRef" | "summarize" | "deleted">;
}

/**
 * A request's references as the kind reads them (AppObjectKind.parseRef), each
 * `raw` an object whose `id` is a string: null when the kind refuses one, or
 * returns another id (core decides visibility on the id the request named).
 */
export function readObjectRefs(registered: RegisteredObjectKind, raws: ReadonlyArray<{ id: string } & Record<string, unknown>>): AppObjectRef[] | null {
  const refs: AppObjectRef[] = [];
  for (const raw of raws) {
    const ref = registered.objectKind.parseRef(raw);
    if (!ref || ref.id !== raw.id) return null;
    refs.push(ref);
  }
  return refs;
}

export type ObjectSummaryResult =
  | { ref: AppObjectRef; ok: true; summary: ObjectSummary }
  | { ref: AppObjectRef; ok: false; reason: "unavailable" }
  | { ref: AppObjectRef; ok: false; reason: "deleted"; deleted: AppObjectDeleted };

/**
 * Which of these objects the viewer can see (steps 1 to 3 above): the
 * visible ids, each once. A constant number of queries however many ids.
 */
export async function visibleObjectsOf(viewer: ViewActor, registered: RegisteredObjectKind, ids: readonly string[]): Promise<ReadonlySet<string>> {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) return new Set();
  return visibleAmong(viewer, registered, distinct, await registered.objectKind.homes(distinct));
}

/**
 * Whether the viewer reads this object only as its public face: the object
 * is another server's and public (docs/development/first-party-apps.md,
 * "Objects, parts and files"). Such a reader sees what the app publishes, not
 * the object's parts (Artifacts' readsAsOutsider is the same rule).
 */
export const readsPublicFaceOnly = (viewer: { serverId: ServerId }, home: Pick<AppObjectHome, "serverId" | "homeKind">): boolean =>
  home.serverId !== viewer.serverId && home.homeKind === "public";

/**
 * Which of these objects the viewer can see fully (visibleObjectsOf, less
 * those it reads only as their public face, readsPublicFaceOnly): the
 * readers of their parts.
 */
export async function fullyVisibleObjectsOf(viewer: ViewActor, registered: RegisteredObjectKind, ids: readonly string[]): Promise<ReadonlySet<string>> {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) return new Set();
  const homes = await registered.objectKind.homes(distinct);
  const full = new Map([...homes].filter(([, home]) => !readsPublicFaceOnly(viewer, home)));
  return visibleAmong(viewer, registered, distinct, full);
}

/** Steps 2 and 3 over the homes a kind reported for these distinct ids: the visible ids. */
async function visibleAmong(viewer: ViewActor, registered: RegisteredObjectKind, distinct: readonly string[], homes: ReadonlyMap<string, AppObjectHome>): Promise<ReadonlySet<string>> {
  const located = distinct.flatMap((id) => {
    const home = homes.get(id);
    return home ? [{ id, ...home }] : [];
  });
  const servers = [...new Set([viewer.serverId, ...located.map((object) => object.serverId)])];
  // An object of a soft-deleted server is seen by no one (platform/flags appEnabledOnLiveServers).
  const enabled = await appEnabledOnLiveServers(servers, registered.app.flag);
  const enabledServers = new Set<ServerId>(servers.filter((_, index) => enabled[index]));
  if (!enabledServers.has(viewer.serverId)) return new Set();
  const asked = located.filter((object) => enabledServers.has(object.serverId));
  const answers = await canViewHomedObjects(viewer, asked.map((object) => ({ serverId: object.serverId, home: homeOf(object), author: object.author })));
  return new Set(asked.filter((_, index) => answers[index]).map((object) => object.id));
}

/**
 * The summaries of these references (as the kind's parseRef made them) for a
 * signed-in reader, one answer per reference in order. Each object answers by
 * the reader's server's flag and its own server's (step 2). summarize gets only the
 * references whose id visibleObjectsOf kept; it is not called when none is.
 * A deleted object is answered `deleted` as deletedSummaries finds it.
 */
export async function objectSummaries(reader: AppWebReader, registered: RegisteredObjectKind, refs: readonly AppObjectRef[]): Promise<ObjectSummaryResult[]> {
  if (refs.length === 0) return [];
  const viewer: ViewActor = { type: "user", id: reader.userId, serverId: reader.serverId };
  const distinct = [...new Set(refs.map((ref) => ref.id))];
  const homes = await registered.objectKind.homes(distinct);
  const visible = await visibleAmong(viewer, registered, distinct, homes);
  const deletedOf = await deletedSummaries(reader, viewer, registered, distinct.filter((id) => !homes.has(id)));
  const asked = refs.filter((ref) => visible.has(ref.id));
  const summaries = asked.length > 0 ? await registered.objectKind.summarize(reader, asked) : [];
  // Answers are matched by position: any other length would put one reference's summary on another's.
  if (summaries.length !== asked.length) {
    throw new Error(`${registered.objectKind.kind} summarize answered ${summaries.length} entries for ${asked.length} references`);
  }
  const summaryOf = new Map(asked.map((ref, index) => [ref, summaries[index]] as const));
  return refs.map((ref): ObjectSummaryResult => {
    const summary = summaryOf.get(ref);
    if (summary) return { ref, ok: true, summary };
    const deleted = deletedOf.get(ref.id);
    return deleted ? { ref, ok: false, reason: "deleted", deleted } : { ref, ok: false, reason: "unavailable" };
  });
}

/**
 * The deleted summaries of these ids (ones the kind's `homes` left out) for
 * the reader: of those the kind reports deleted (AppObjectKind.deleted), the
 * ones steps 2 and 3 let through on the home each had. Nothing (and no query)
 * for a kind without it or no such id.
 */
async function deletedSummaries(reader: AppWebReader, viewer: ViewActor, registered: RegisteredObjectKind, ids: readonly string[]): Promise<ReadonlyMap<string, AppObjectDeleted>> {
  const deleted = registered.objectKind.deleted;
  if (!deleted || ids.length === 0) return new Map();
  const homes = await deleted.homes(ids);
  if (homes.size === 0) return new Map();
  const visible = await visibleAmong(viewer, registered, ids, homes);
  if (visible.size === 0) return new Map();
  const summaries = await deleted.summarize(reader, [...visible]);
  // Only for an id core let through, whatever the kind answers.
  return new Map([...summaries].filter(([id]) => visible.has(id)));
}
