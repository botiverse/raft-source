// Settled's routes (#334; the rule is settle.ts): the agent API's
// `POST /artifacts/:artifact/settle | unsettle` and the web's
// `POST | DELETE /api/artifacts/:id/settle`.
//
// Checked in this order: Artifacts on and the Artifact visible and writable
// (the one 404 NOT_VISIBLE, a closed server's read-only 403), then Settled on
// for the Artifact's own server (else 404 SETTLED_NOT_AVAILABLE: no route, as
// far as the caller can tell), then whoever may comment on it (takes part in
// it: a member or agent of its server or its joint channel; else 403
// FORBIDDEN), then settle.ts changeSettlement.
import { type AgentApiArtifactParams, type AgentApiArtifactSettlement, type ArtifactSettled, type ArtifactWebSettlement } from "@botiverse/raft-shared";
import {
  agentActor,
  answer,
  ArtifactApiFailure,
  fail,
  json,
  mayNotTakePart,
  namer,
  notVisible,
  resolveVisibleItem,
  summarize,
  takePartForbiddenError,
  takesPartIn,
  versionNotFound,
  viewActor,
  type ArtifactAgent,
  type ArtifactApiError,
  type ArtifactApiJson,
  type ArtifactApiResult,
  type ArtifactNoticeOutbox,
} from "./apiCommon";
import { changeSettlement } from "./settle";
import { settledEnabled, settledOf } from "./settledState";
import { answerWeb, profiler, readerActor, readerViewActor, refuse, shownActorOf, visibleItemFor, webNotVisible, webVersionNotFound, type ArtifactWebApiError, type ArtifactWebReader } from "./webCommon";

/** Settled is off for the Artifact's server: as if there were no such route. */
const SETTLED_NOT_AVAILABLE_ERROR = "Settling isn't turned on for this artifact's server, so it can't be marked settled or unsettled here: nothing changed.";

const settledNotAvailable = (): ArtifactApiError => fail(404, { code: "SETTLED_NOT_AVAILABLE", error: SETTLED_NOT_AVAILABLE_ERROR });

async function agentSettlement(agent: ArtifactAgent, params: AgentApiArtifactParams, outbox: ArtifactNoticeOutbox, settle: boolean): Promise<ArtifactApiResult<AgentApiArtifactSettlement>> {
  // resolveVisibleItem checks the caller's flag first.
  const item = await resolveVisibleItem(agent, params.artifact, "write");
  if (!(await settledEnabled(item.serverId))) return settledNotAvailable();
  if (!(await takesPartIn(viewActor(agent), item))) return mayNotTakePart("settle or unsettle it");
  const outcome = await changeSettlement({ outbox, item, by: agentActor(agent), settle });
  if (outcome.kind === "gone") throw new ArtifactApiFailure(notVisible());
  if (outcome.kind === "no_version") throw new ArtifactApiFailure(versionNotFound(item.id, null, null));
  const [[summary], name] = await Promise.all([
    summarize(agent, [outcome.item]),
    namer(outcome.told.map((agentId) => ({ type: "agent" as const, id: agentId }))),
  ]);
  return json<AgentApiArtifactSettlement>({
    artifact: summary!,
    changed: outcome.changed,
    newlySubscribed: outcome.newlySubscribed,
    notified: outcome.told.map((agentId) => ({ actor: name({ type: "agent", id: agentId }), reason: "subscribed" })),
  });
}

export function createSettleOperations() {
  return {
    /** Mark it Settled at its current version (#334). */
    settle: (agent: ArtifactAgent, params: AgentApiArtifactParams, outbox: ArtifactNoticeOutbox): Promise<ArtifactApiResult<AgentApiArtifactSettlement>> => answer(() => agentSettlement(agent, params, outbox, true)),
    /** Take it back to Working (#334). */
    unsettle: (agent: ArtifactAgent, params: AgentApiArtifactParams, outbox: ArtifactNoticeOutbox): Promise<ArtifactApiResult<AgentApiArtifactSettlement>> => answer(() => agentSettlement(agent, params, outbox, false)),
  };
}

async function webSettlement(reader: ArtifactWebReader, id: string, outbox: ArtifactNoticeOutbox, settle: boolean): Promise<ArtifactApiJson<ArtifactWebSettlement> | ArtifactWebApiError> {
  const item = await visibleItemFor(reader, id);
  if (!(await settledEnabled(item.serverId))) refuse(404, { code: "SETTLED_NOT_AVAILABLE", error: SETTLED_NOT_AVAILABLE_ERROR });
  if (!(await takesPartIn(readerViewActor(reader), item))) refuse(403, { code: "FORBIDDEN", error: takePartForbiddenError("settle or unsettle it") });
  const outcome = await changeSettlement({ outbox, item, by: readerActor(reader), settle });
  if (outcome.kind === "gone") return webNotVisible();
  if (outcome.kind === "no_version") return webVersionNotFound(undefined, undefined);
  const standing = settledOf(outcome.item);
  let settled: ArtifactSettled | null = null;
  if (standing) {
    const actorOf = await profiler([standing.by]);
    settled = { by: shownActorOf(reader, outcome.item, actorOf(standing.by)), at: standing.at.toISOString(), version: standing.version };
  }
  return json<ArtifactWebSettlement>({ settled, changed: outcome.changed });
}

export function createWebSettleOperations() {
  return {
    /** POST /:id/settle: mark it Settled at its current version (#334). */
    settle: (reader: ArtifactWebReader, id: string, outbox: ArtifactNoticeOutbox): Promise<ArtifactApiJson<ArtifactWebSettlement> | ArtifactWebApiError> => answerWeb(() => webSettlement(reader, id, outbox, true)),
    /** DELETE /:id/settle: take it back to Working (#334). */
    unsettle: (reader: ArtifactWebReader, id: string, outbox: ArtifactNoticeOutbox): Promise<ArtifactApiJson<ArtifactWebSettlement> | ArtifactWebApiError> => answerWeb(() => webSettlement(reader, id, outbox, false)),
  };
}
