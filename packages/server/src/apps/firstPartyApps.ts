// The first-party app registry (first-party app mechanism §一): the one place
// in core that lists first-party apps (Raft's own modules that own objects,
// such as Artifacts, or that only send agents notices about core's, such as
// reaction notices; the built-in RAP apps beside them under apps/, reminder
// and cleaner, are the app platform's, registry.manifest.ts). Each app
// describes itself in its apps/<id>/register.ts (a FirstPartyApp,
// platform/apps.ts); core derives from this list what it would otherwise
// name each app for:
//
// - the object kinds and event kinds object_events accepts
//   (services/objectEvents.ts, recordObjectEvent);
// - the system apps whose agent events need a delivery guard, and the guard
//   (services/systemAppDeliveryGuards.ts);
// - the AgentMessage `app_event` and the schema it is checked by
//   (services/oauthService.ts, buildThirdPartyAgentMessage);
// - the notice outbox of each app (services/firstPartyAppHost.ts);
// - the object storage of each app, its keys under `apps/<id>/` of the
//   platform's app-content bucket (services/appObjectStorage.ts), handed
//   over here when the registry is first read;
// - which of an object kind's objects a reader sees, from the homes the kind
//   reports, and their summaries (services/objectSummaries.ts, the route
//   routes/objects.ts);
// - where the app's routes are mounted (routes/internalAgentApi.ts for the
//   agent API, routes/firstPartyAppRoutes.ts for web and internal routes,
//   wired by app.ts) and the jobs core runs for it
//   (services/firstPartyAppJobs.ts, wired by server.ts);
// - the apps on for a server that agents are told about, AgentConfig and the
//   agent context's `enabledApps` (services/firstPartyAppFlags.ts);
// - the apps told of reactions to messages
//   (services/messageReactionService.ts, FirstPartyApp.messageReactions).
//
// scripts/ci/check-app-module-boundaries.ts: this is the only core file that
// imports an app, and only its register.ts.
//
// Read lazily (`firstPartyApps()`), never at module load: the app modules
// import platform entries whose core services read this registry, so an
// import cycle runs through here; nothing below touches a registration until
// it is called. One exception: routes/internalAgentApi.ts mounts the agent
// API routes at its own load, which is safe while no app module imports it
// or app.ts (the boundary check refuses that import).
import type { AppObjectKind, FirstPartyApp } from "../platform/apps";
import { appObjectStorage } from "../services/appObjectStorage";
import { artifactsApp } from "./artifacts/register";
import { reactionNoticesApp } from "./reaction-notices/register";

let checked: readonly FirstPartyApp[] | null = null;

/** Every first-party app, checked once: unique ids and object kinds, `system.<id>`, events per kind, notice kinds that are no app's object kind. */
export function firstPartyApps(): readonly FirstPartyApp[] {
  if (checked) return checked;
  const apps: readonly FirstPartyApp[] = [artifactsApp, reactionNoticesApp];
  checkRegistrations(apps);
  checked = apps;
  // Each app's object storage, scoped by core to its own id (never one the app names).
  for (const app of apps) app.receiveObjectStorage?.(appObjectStorage(app.id));
  return apps;
}

/** Throws on a registration core could not derive from unambiguously. Exported for the registry's tests. */
export function checkRegistrations(apps: readonly FirstPartyApp[]): void {
  const ids = new Set<string>();
  const kinds = new Set<string>();
  const announcementKinds = apps.flatMap((app) => app.objectKinds.filter((objectKind) => objectKind.channelAnnouncement !== undefined).map((objectKind) => objectKind.kind));
  if (announcementKinds.length > 1) throw new Error(`only one object kind may be a channel's announcement, not ${announcementKinds.join(", ")}`);
  for (const app of apps) {
    if (!/^[a-z][a-z0-9-]*$/.test(app.id)) throw new Error(`first-party app id ${JSON.stringify(app.id)} is not lowercase letters, digits and dashes`);
    if (ids.has(app.id)) throw new Error(`first-party app ${app.id} is registered twice`);
    ids.add(app.id);
    if (app.systemApp !== `system.${app.id}`) throw new Error(`first-party app ${app.id}'s system app must be system.${app.id}, not ${app.systemApp}`);
    for (const objectKind of app.objectKinds) {
      if (kinds.has(objectKind.kind)) throw new Error(`object kind ${objectKind.kind} is registered twice`);
      kinds.add(objectKind.kind);
      if (objectKind.events.length === 0 || new Set(objectKind.events).size !== objectKind.events.length) {
        throw new Error(`object kind ${objectKind.kind} needs distinct event kinds`);
      }
    }
  }
  // A notice kind names something no app owns (agentNotice.kinds): never a registered object kind.
  for (const app of apps) {
    const noticeKinds = app.agentNotice?.kinds ?? [];
    if (new Set(noticeKinds).size !== noticeKinds.length) throw new Error(`first-party app ${app.id} names a notice kind twice`);
    for (const kind of noticeKinds) {
      if (kinds.has(kind)) throw new Error(`notice kind ${kind} of ${app.id} is a registered object kind`);
    }
  }
}

/** The kinds an app's notices may be about: its object kinds, and its agentNotice.kinds. */
export function appNoticeKinds(app: FirstPartyApp): readonly string[] {
  return [...app.objectKinds.map((objectKind) => objectKind.kind), ...(app.agentNotice?.kinds ?? [])];
}

/** The apps core tells of reactions to messages (FirstPartyApp.messageReactions), in registry order. */
export function messageReactionApps(): readonly FirstPartyApp[] {
  return firstPartyApps().filter((app) => app.messageReactions !== undefined);
}

/** The app with this id, if registered. */
export function firstPartyApp(id: string): FirstPartyApp | undefined {
  return firstPartyApps().find((app) => app.id === id);
}

/** The app whose system app this is (`system.<id>`), if registered. */
export function firstPartyAppOfSystemApp(systemApp: string): FirstPartyApp | undefined {
  return firstPartyApps().find((app) => app.systemApp === systemApp);
}

/** A registered object kind and the app that owns it. */
export function registeredObjectKind(kind: string): { app: FirstPartyApp; objectKind: AppObjectKind } | undefined {
  for (const app of firstPartyApps()) {
    const objectKind = app.objectKinds.find((entry) => entry.kind === kind);
    if (objectKind) return { app, objectKind };
  }
  return undefined;
}

/**
 * The one registered object kind whose objects may be a channel's
 * announcement (AppObjectKind.channelAnnouncement), and its app; undefined
 * when none declares it (checkRegistrations refuses two).
 */
export function channelAnnouncementObjectKind(): { app: FirstPartyApp; objectKind: AppObjectKind & Required<Pick<AppObjectKind, "channelAnnouncement">> } | undefined {
  for (const app of firstPartyApps()) {
    const objectKind = app.objectKinds.find((entry) => entry.channelAnnouncement !== undefined);
    if (objectKind?.channelAnnouncement) return { app, objectKind: objectKind as AppObjectKind & Required<Pick<AppObjectKind, "channelAnnouncement">> };
  }
  return undefined;
}

/** The system apps of the apps that send agents notices: each needs its delivery guard (fail closed). */
export function systemAppsWithAgentNotices(): string[] {
  return firstPartyApps().filter((app) => app.agentNotice).map((app) => app.systemApp);
}
