// The Artifacts app as core knows it (first-party app mechanism §一): its one
// registration, which core's registry (apps/firstPartyApps.ts, the only core file
// that imports it) collects at startup. Everything core does for Artifacts
// comes from here: the object kind `artifact`, its events (object_events),
// summaries (where each lives, for core's visibility, and its card) and
// people's Activity rows (activity.ts),
// `system.artifacts` and its notices' schema and delivery guard, its search
// (webSearch.ts), where its routes are mounted (mount.ts), its object storage
// (blobStore.ts), and its jobs.
//
// Only functions core calls later, and constants from shared and the leaf
// kinds.ts: nothing below reads another module of this app while it is
// loaded (core's registry is part of an import cycle through this file).
import { artifactAgentNoticeSchema, WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, type ArtifactObjectRef, type ObjectSummaryOf } from "@botiverse/raft-shared";
import type { FirstPartyApp } from "../../platform/apps";
import { artifactActivityDetails, artifactUnreadFor, markArtifactsRead } from "./activity";
import { artifactHeadlines } from "./announcement";
import { pruneUnreferencedArtifactBlobs } from "./blobs";
import { receiveArtifactObjectStorage } from "./blobStore";
import { checkShotReadable } from "./checks";
import { expireStaleChecks } from "./checkTask";
import { ARTIFACT_OBJECT_EVENTS, ARTIFACT_OBJECT_KIND, ARTIFACT_OBJECT_TABLES } from "./kinds";
import { mountArtifactAgentApi, mountArtifactInternals, mountArtifactPublicWebApi, mountArtifactWebApi } from "./mount";
import { mountArtifactPublicPage } from "./publicPage";
import { artifactNoticeDeliveryVerdicts, flushDueArtifactNotices } from "./notices";
import { purgeArtifactsOfServer } from "./purge";
import { publishArtifactAsForCore } from "./publishAs";
import { readArtifactAsUserForCore } from "./readAsUser";
import { artifactHomes, deletedArtifactHomes } from "./visibility";
import { parseArtifactObjectRef, summarizeArtifacts, summarizeDeletedArtifacts } from "./webCards";
import { purgeExpiredArtifactDrafts } from "./webReviews";
import { searchArtifactsForCore } from "./webSearch";

/** How often the legacy pending_notices rows are drained (flushDueArtifactNotices; nothing writes them since #55). */
export const ARTIFACT_NOTICE_FLUSH_INTERVAL_MS = 30_000;
/** How often publish checks that can no longer run are failed (checkTask.ts expireStaleChecks). */
export const ARTIFACT_CHECK_EXPIRY_INTERVAL_MS = 60_000;

// Layer 2 of the mechanism, not registered yet: prompt (§七).
export const artifactsApp: FirstPartyApp = {
  id: "artifacts",
  flag: WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY,
  objectKinds: [{
    kind: ARTIFACT_OBJECT_KIND,
    events: ARTIFACT_OBJECT_EVENTS,
    objectTables: ARTIFACT_OBJECT_TABLES,
    // Core decides who sees which Artifact from these (live items only), then asks for the cards of the visible ones.
    homes: (ids) => artifactHomes(ids),
    // A reference is `{ id, version? }`; core reads its id, the version is ours.
    parseRef: (value) => parseArtifactObjectRef(value),
    // Core hands back the references parseRef made, so they are ArtifactObjectRefs.
    summarize: (viewer, refs): Promise<ReadonlyArray<ObjectSummaryOf<typeof ARTIFACT_OBJECT_KIND> | undefined>> =>
      summarizeArtifacts(viewer, refs as readonly ArtifactObjectRef[]),
    // A deleted (never a revoked) Artifact: where it lived, for core's same rule, then its deleted card for who could have seen it.
    deleted: {
      homes: (ids) => deletedArtifactHomes(ids),
      summarize: (viewer, ids) => summarizeDeletedArtifacts(viewer, ids),
    },
    // People's Activity rows (activity.ts): the numbers and details of one page's rows, and Done / mark read.
    unreadFor: (reader, ids) => artifactUnreadFor(reader, ids),
    activityDetails: (reader, rows) => artifactActivityDetails(reader, rows),
    markRead: (reader, targets, executor) => markArtifactsRead(reader, targets, executor),
    // Core's object files: a publish check's screenshots only while the deployment has a check Worker.
    fileReadable: async (_objectId, parent) => checkShotReadable(parent),
    // A channel's announcement (channel_announcement_v0): one Artifact homed in the channel; core shows its title, version and last change.
    channelAnnouncement: { headlines: (ids, reader) => artifactHeadlines(ids, reader) },
  }],
  systemApp: "system.artifacts",
  agentNotice: {
    schema: artifactAgentNoticeSchema,
    // An agent that can no longer see the Artifact (or whose server has the flag off) gets nothing.
    deliverable: (events) => artifactNoticeDeliveryVerdicts(events),
  },
  // Core's search (§五): titles only, the same search as the agent list's `query` (search.ts).
  search: (input) => searchArtifactsForCore(input),
  // A personal assistant reads as its owner (#proj-assistant:#31): the web's checks, the owner as reader; core adds its own limits.
  actingFor: {
    readAsUser: (input) => readArtifactAsUserForCore(input),
    publishAs: (input) => publishArtifactAsForCore(input),
  },
  routes: {
    agentApi: (mount) => mountArtifactAgentApi(mount),
    webApi: (mount) => mountArtifactWebApi(mount),
    // Signed-out viewing of public Artifacts (`/api/public/artifacts/*`).
    publicWebApi: (mount) => mountArtifactPublicWebApi(mount),
    // The content Worker's `/internal/artifacts-content/*` and the publish check Worker's `/internal/artifacts-check/*`.
    internal: (mount) => mountArtifactInternals(mount),
    // The public page, `/artifacts/*`, when app.raft.build's CloudFront sends it here (publicPage.ts).
    publicPage: (mount) => mountArtifactPublicPage(mount),
  },
  // Files' bytes: Artifacts' keys under apps/artifacts/ of the platform's app-content bucket (blobStore.ts).
  receiveObjectStorage: (storage) => receiveArtifactObjectStorage(storage),
  // A closed server's Artifacts, batch by batch, for core's closed-server purge (purge.ts).
  purgeServer: (serverId, options) => purgeArtifactsOfServer(serverId, options),
  jobs: {
    // Uploaded bytes no version uses, a day after their upload (bounded batch per tick; a no-op without the app-content bucket).
    maintenance: [
      { site: "prune_artifact_blobs", run: () => pruneUnreferencedArtifactBlobs() },
      // Review drafts not changed for 30 days (S8; bounded batch per tick; already left out of every read).
      { site: "purge_artifact_drafts", run: () => purgeExpiredArtifactDrafts() },
      // No sweep of publish checks' screenshots: they are core's object files, and a soft-deleted
      // server's go in core's own sweep (services/objectFiles.ts).
    ],
    // Legacy (#55): drains followers' comment batches queued before followers were told at once; remove with the
    // pending_notices table once none can remain (a no-op with nothing due; concurrent replicas split the rows, SKIP LOCKED).
    every: [
      { name: "notice_flush", everyMs: ARTIFACT_NOTICE_FLUSH_INTERVAL_MS, run: ({ noticeOutbox }) => flushDueArtifactNotices(noticeOutbox) },
      // Publish checks past their run window (task #130): pending ones `expired`, running ones whose lease ran out
      // `lease_expired` (one bounded update each, over a day of the created index; concurrent replicas update a row once).
      { name: "check_expiry", everyMs: ARTIFACT_CHECK_EXPIRY_INTERVAL_MS, run: () => expireStaleChecks() },
    ],
  },
};
