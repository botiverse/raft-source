// An agent reads a version's publish check (task #proj-workspace:#130;
// docs/development/workspace-artifacts.md, "Publish check"; contract: shared
// agentApiArtifactChecksContract.ts). The push recorded it (publish.ts, in
// its transaction: checks.ts recordVersionCheck) and answered its id; the
// check Worker ran it (checkTask.ts).
//
// - artifactCheck (`GET …/:artifact/check?version=`): the version's row as
//   stored, or `check: null`: none recorded, or the deployment has no check
//   Worker now (checkWorkerToken.ts checksConfigured: nothing is served, as
//   the rest of the check stops). Read-only: no read position moves.
// - artifactCheckShot (`GET …/:artifact/check/:shot?version=`): one of its
//   screenshots, through core's readObjectFile for the agent: the file id
//   the row names (only on a `done` check, cleared once the newest three
//   checked versions have theirs), matched with the Artifact and that
//   version's part alone (checkShotPart), the Artifact seen fully now. Any
//   other case is one 404 SCREENSHOT_NOT_FOUND.
//
// Both resolve the Artifact as a write does (resolveVisibleItem: the
// caller's own flag, then the one 404 NOT_VISIBLE), and refuse another
// server's agent reading a public Artifact (accessOf historyLimited: it reads
// the current version only, never the working history, and core's object
// file route doesn't serve it a file either) with that 404. Any version the
// agent may read (published, not revoked), default the current one. Reads
// are not counted per agent (core's agent API limits, as every app read).
import { and, eq } from "drizzle-orm";
import {
  ARTIFACT_CHECK_SHOTS,
  type AgentApiArtifactCheck,
  type AgentApiArtifactCheckQuery,
  type AgentApiArtifactCheckResponse,
  type AgentApiArtifactCheckShotParams,
  type AgentApiArtifactParams,
  RAFT_HINTS,
} from "@botiverse/raft-shared";
import { getDb } from "../../platform/db";
import { readObjectFile } from "../../platform/objectFiles";
import {
  accessOf,
  answer,
  ArtifactApiFailure,
  currentVersionOf,
  fail,
  json,
  notVisible,
  readableVersion,
  resolveVisibleItem,
  storageUnavailable,
  versionNotFound,
  viewActor,
  type ArtifactAgent,
  type ArtifactApiBytes,
  type ArtifactApiError,
  type ArtifactApiResult,
} from "./apiCommon";
import { checkShotPart, versionCheckOf } from "./checks";
import { ARTIFACT_OBJECT_KIND } from "./kinds";
import { artifactVersions, type ArtifactItemRow, type ArtifactVersionCheckRow, type ArtifactVersionRow } from "./schema";

/** The Artifact read from inside, the version asked (default the current one), and its check (null: none, or no check Worker). */
async function checkedVersionOf(agent: ArtifactAgent, ref: string, requested: string | undefined): Promise<{
  item: ArtifactItemRow;
  version: ArtifactVersionRow;
  current: ArtifactVersionRow | null;
  check: ArtifactVersionCheckRow | null;
}> {
  const item = await resolveVisibleItem(agent, ref);
  if (accessOf(agent, item).historyLimited) throw new ArtifactApiFailure(notVisible());
  const current = await currentVersionOf(item);
  const number = requested === undefined ? null : Number(requested);
  const [version] = number === null
    ? [current ?? undefined]
    : await getDb().select().from(artifactVersions).where(and(readableVersion(item.id), eq(artifactVersions.number, number))).limit(1);
  if (!version) throw new ArtifactApiFailure(versionNotFound(item.id, number, current?.number ?? null));
  return { item, version, current, check: await versionCheckOf(version.id) };
}

/** The file id of screenshot `shot` the row keeps: only a done check's, null once let go. */
const shotFileOf = (check: ArtifactVersionCheckRow | null, shot: AgentApiArtifactCheckShotParams["shot"]) =>
  check?.status === "done" ? (shot === "desktop" ? check.desktopFileId : check.phoneFileId) : null;

/** The row as the agent API answers it: as stored, times in ISO, the screenshots it keeps by name (never a file id or a URL). */
function agentCheckOf(check: ArtifactVersionCheckRow): AgentApiArtifactCheck {
  return {
    id: check.id,
    status: check.status,
    skipReason: check.skipReason,
    errorClass: check.errorClass,
    findings: check.status === "done" && check.findings ? { ...check.findings } : null,
    createdAt: check.createdAt.toISOString(),
    finishedAt: check.finishedAt?.toISOString() ?? null,
    screenshots: ARTIFACT_CHECK_SHOTS.filter((shot) => shotFileOf(check, shot) !== null).map((shot) => ({ shot })),
  };
}

export function createCheckReadOperations() {
  return {
    check: (agent: ArtifactAgent, params: AgentApiArtifactParams, query: AgentApiArtifactCheckQuery): Promise<ArtifactApiResult<AgentApiArtifactCheckResponse>> => answer(async () => {
      const { item, version, current, check } = await checkedVersionOf(agent, params.artifact, query.version);
      return json<AgentApiArtifactCheckResponse>({
        artifact: { id: item.id, title: item.title, currentVersion: current?.number ?? null },
        version: version.number,
        check: check && agentCheckOf(check),
      });
    }),

    checkShot: (agent: ArtifactAgent, params: AgentApiArtifactCheckShotParams, query: AgentApiArtifactCheckQuery): Promise<ArtifactApiBytes | ArtifactApiError> => answer(async () => {
      const { item, version, check } = await checkedVersionOf(agent, params.artifact, query.version);
      const notFound = (): ArtifactApiError => fail(404, {
        code: "SCREENSHOT_NOT_FOUND",
        error: `Version ${version.number} of this artifact has no ${params.shot} screenshot: only a finished publish check has screenshots, and only the newest three checked versions keep them, so read the version's check first.`,
        next: RAFT_HINTS.artifactCheck({ artifact: item.id, version: version.number }),
        details: { shot: params.shot, version: version.number },
      });
      const fileId = shotFileOf(check, params.shot);
      if (fileId === null) return notFound();
      const file = await readObjectFile(viewActor(agent), { kind: ARTIFACT_OBJECT_KIND, objectId: item.id, fileId, parts: [checkShotPart(version.id)] });
      switch (file.kind) {
        case "not_found": return notFound();
        case "unavailable": return storageUnavailable();
        case "file": return {
          kind: "bytes" as const,
          stream: file.stream,
          size: file.size,
          contentType: file.contentType,
          contentDisposition: `attachment; filename="check-v${version.number}-${params.shot}.${file.contentType.slice("image/".length)}"`,
        };
      }
    }),
  };
}
