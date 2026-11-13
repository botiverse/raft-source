// The per-server move from the standalone Raft Artifacts app
// (raft-artifacts.com) into Raft: an operator's job, run by
// `scripts/artifacts-legacy-import.ts` (`pnpm db:artifacts-legacy-import`),
// never by a request of a person or agent. Agreed with Tenny (CTO) and
// xxchan (product); the runbook is this module's README ("Moving a server
// from raft-artifacts.com").
//
// - plan: read only. Pages through the standalone app's `list` for the
//   server and counts what a run would do (imports, skips with reasons, and
//   of the imports, those whose author falls back to the ops actor: no
//   creator, or one Raft doesn't confirm as a live agent or member of the
//   server of that type, import.ts legacyAuthor); asks nothing else and writes nothing, here or there.
// - run: 1) freezes the server in the standalone app (every write to its
//   Artifacts there is refused from then on), and only then 2) pages through
//   `list` in its stable id order and, one at a time, imports each private
//   Artifact with a current version that no earlier import stands for,
//   through the same steps as the on-demand import (import.ts
//   importLegacyArtifactAsOps: the old creator as the author when Raft
//   confirms it in the server, else the ops actor, the whole server as the home,
//   the manifest's sha256s verified, the cap, cleanup of a failed import's
//   bytes, idempotency by `importedTo` and the audit). Skipped, with the
//   reason: public Artifacts (unless `--public`, below), Artifacts with no
//   version, ones with no name, and ones imported before. One that fails is
//   reported and the run goes on.
// - `--public` (opt-in, plan and run alike): Artifacts public on
//   raft-artifacts.com are imported too, into the server's public home
//   (anyone with the link), staying public, through the same steps
//   (importLegacyArtifactAsOps `home: "public"`), where Raft's rule for who
//   may turn on an Artifact's link sharing lets their author make them public
//   (import.ts publicImportRefusal: a person of the server who may widen it;
//   `system_author`, `agent_author` and `may_not_make_public` are refused).
//   The plan lists each public one (old link, name and title, size, author,
//   its new home and visibility, or why it is refused); the run skips the
//   refused ones (`public_refused`, with the reason), checked again by the
//   import itself. A pass keeps the choice it started with (resuming with
//   the other one is refused). A run with `--public` that would import any
//   public one refuses to start (before the freeze) while the server's
//   workspace_artifacts_v0 flag is off: signed-out visitors see a public
//   Artifact only then.
// - An approval (`--approved-by`, Tenny 2026-10-30: it keeps pages already
//   public there public; it widens nothing. xxchan and Tenny 2026-10-30,
//   #proj-workspace:e7b3e687: the move doesn't change who can see a page,
//   and one approval of the whole plan by a Raft platform owner stands for
//   every server in it): `plan --public` prints a digest of each server's
//   public entries as a run with an approval would take them, and over
//   several servers one digest of them all (legacyMoveSetDigest);
//   `run --servers a,b,c --public --approved-by <who> --plan-digest <d>
//   --approval-ref <message>` resolves the approver (a Raft platform owner
//   or admin: a human owner or admin of Botiverse, actors.ts
//   isPlatformOwnerOrAdmin; else the whole run is refused) and recomputes
//   the digest from a fresh plan of every server (a mismatch is refused),
//   both before anything is frozen, and each server's digest again once it
//   is frozen. Then the entries the approved plan imports on the approval
//   (an agent's or the system identity's, of a page the standalone app
//   lists public) are imported public too, the approver's `made_public` row
//   naming the operator and the message (import.ts). A guest author's stays
//   refused. A pass keeps its approval (the approved ids, and the server's
//   own digest in the approved plan, are saved); the servers are moved one
//   after the other, each with its own state.
// - Resumable: the state (the cursor, the last artifactId done, and what
//   was done) is saved after every Artifact; a run that stops (`max`,
//   `stopAt`, a signal, a crash) resumes after its cursor. A run that
//   finished starts a new pass, where everything imported is skipped (and
//   what failed is tried again).
// - Old comments (legacyComments.ts): right after each page a run imports
//   (the server is frozen by then), its comments on raft-artifacts.com are
//   copied onto the new Artifact, no one notified; a failure there doesn't
//   fail the page (it is counted and reported, `comments` in the report). A
//   page imported otherwise (before, on demand, or a run that stopped between
//   the two) has them copied by the `comments` mode (below).
// - comments plan / comments run: the old comments of the pages of moved
//   servers that stand imported in Raft (standingImport: `importedTo` or the
//   `import` audit), read only and then written, bound to one approval of the
//   plan as `--public` is (a Raft platform owner or admin, the plan's digest
//   recomputed before anything is written, legacyMoveSetDigest over several
//   servers). Resumable by the copies' deterministic ids.
// - The workspace_artifacts_v0 flag is not required (the move runs before
//   it is switched on; `--public` importing public ones excepted, above) and the import's bytes don't count against the
//   monthly file upload quota (a migration, not an upload).
//
// Only the configured standalone app (ARTIFACTS_LEGACY_IMPORT_URL) is ever
// requested.
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { ServerId } from "@botiverse/raft-shared";
import { platformOwnerOrAdminByRef, PLATFORM_SERVER_ID } from "../../platform/actors";
import { artifactsEnabled } from "./apiCommon";
import {
  importLegacyArtifactAsOps,
  legacyAuthor,
  legacyLinkOf,
  publicImportAssessment,
  standingImport,
  type PublicImportRefusal,
} from "./import";
import { copyLegacyComments, legacyCommentRows, presentLegacyComments, writeLegacyComments, type LegacyCommentRow, type LegacyCommentsResult } from "./legacyComments";
import {
  fetchLegacyComments,
  freezeLegacyServer,
  legacyWorkerConfig,
  LegacyWorkerUnavailable,
  listLegacyArtifacts,
  LEGACY_LIST_MAX_LIMIT,
  type LegacyListItem,
  type LegacyWorkerConfig,
} from "./legacyWorker";

/** The Raft server moved: its id (the standalone app's key) and its slug now (old links name it). */
export interface LegacyMoveServer {
  id: ServerId;
  slug: string;
}

/** Why an Artifact is not imported. */
export type LegacyMoveSkipReason =
  /** An earlier import stands in this server (the one `importedTo` names, or the audit's). */
  | "already_imported"
  /** Public on raft-artifacts.com, and the move wasn't asked to import public ones (`--public`). */
  | "public"
  /** Public on raft-artifacts.com, `--public`: Raft's rule doesn't let its author make it public here (import.ts publicImportRefusal). */
  | "public_refused"
  /** No published version: nothing to import. */
  | "no_version"
  /** No name: nothing a link or an import can name. */
  | "no_name";

export const LEGACY_MOVE_SKIP_REASONS: Record<LegacyMoveSkipReason, string> = {
  already_imported: "imported before (it stands in this server)",
  public: "public: imported only with --public",
  public_refused: "public: Raft's rule doesn't let its author make it public",
  no_version: "no version",
  no_name: "no name",
};

/** `list` page size by default. */
export const LEGACY_MOVE_DEFAULT_PAGE_SIZE = 100;

/** Where an imported Artifact goes: the whole server (private there), or its public home (anyone with the link). */
export type LegacyMoveHome = "server" | "public";

/** Whether a plan or run imports the Artifacts public on raft-artifacts.com (`--public`). */
export interface LegacyMovePublicOption {
  public?: boolean;
}

/** On what an import into the public home stands: its author's own right, or the approval (`--approved-by`). */
export type LegacyMovePublicBasis = "author" | "approval";

type Decision =
  | { kind: "import"; home: LegacyMoveHome; basis?: LegacyMovePublicBasis }
  | { kind: "skip"; reason: LegacyMoveSkipReason; importedAs?: { id: string; url: string }; refusal?: PublicImportRefusal; approvable?: boolean };


/**
 * What a run does with one listed Artifact; reads this server's own rows
 * only. `approved`: the approval covers this one (the run's approved plan
 * lists it as imported on the approval).
 */
async function decide(server: LegacyMoveServer, item: LegacyListItem, opts: LegacyMovePublicOption & { approved?: boolean }): Promise<Decision> {
  // An earlier import stands first: a public one a member imported on demand is imported too.
  const standing = await standingImport(server.id, item);
  if (standing) return { kind: "skip", reason: "already_imported", importedAs: standing };
  if (item.name === null || item.name === "") return { kind: "skip", reason: "no_name" };
  if (item.visibility === "public" && !opts.public) return { kind: "skip", reason: "public" };
  if (item.currentVersion === null) return { kind: "skip", reason: "no_version" };
  if (item.visibility === "public") {
    const { refusal, approvable } = await publicImportAssessment(server.id, item.creator);
    if (!refusal) return { kind: "import", home: "public", basis: "author" };
    // An approval lifts only what publicImportAssessment says it may (never a guest's), of a page the standalone app lists public.
    if (opts.approved && approvable) return { kind: "import", home: "public", basis: "approval" };
    return { kind: "skip", reason: "public_refused", refusal, approvable };
  }
  return { kind: "import", home: "server" };
}

const emptySkips = (): Record<LegacyMoveSkipReason, number> => ({ already_imported: 0, public: 0, public_refused: 0, no_version: 0, no_name: 0 });

function requireConfig(): LegacyWorkerConfig {
  const config = legacyWorkerConfig();
  if (!config) throw new Error("importing from the standalone app is not configured: set ARTIFACTS_LEGACY_IMPORT_URL and ARTIFACTS_LEGACY_IMPORT_TOKEN");
  return config;
}

const pageSizeOf = (value: number | undefined): number => {
  const size = value ?? LEGACY_MOVE_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(size) || size < 1 || size > LEGACY_LIST_MAX_LIMIT) throw new Error(`the page size is an integer from 1 to ${LEGACY_LIST_MAX_LIMIT}`);
  return size;
};

const listOrFail = async (config: LegacyWorkerConfig, input: { serverId: ServerId; cursor: string | null; limit: number }) => {
  try {
    return await listLegacyArtifacts(config, input);
  } catch (error) {
    if (error instanceof LegacyWorkerUnavailable) throw new Error(`the standalone app's list failed (${error.reason})`);
    throw error;
  }
};

// ---- plan ----------------------------------------------------------------------

export interface LegacyMovePlan {
  server: LegacyMoveServer;
  /** workspace_artifacts_v0 on this server now (information only: a run doesn't need it). */
  artifactsEnabled: boolean;
  /** Every live Artifact the standalone app lists for the server, and their bytes. */
  total: number;
  totalBytes: number;
  /** What a run would import now. */
  toImport: { count: number; bytes: number };
  /**
   * Of those, the ones whose author would be the system identity (the ops
   * actor; the server's owners and admins manage them) rather than the agent
   * or person who published it there: no creator known (`noCreator`), or one
   * Raft doesn't confirm (`notInServer`: no live principal of that type in
   * this server: a deleted agent, a person who left, another server's, a
   * type that doesn't match the id).
   */
  systemAuthor: { count: number; noCreator: number; notInServer: number };
  /** What a run would skip, by reason (`already_imported`, `public`, `public_refused`, `no_version`, `no_name`). */
  skipped: Record<LegacyMoveSkipReason, number>;
  /**
   * The Artifacts public on raft-artifacts.com, listed apart (`--public`
   * only; null without it, when they are skipped as `public`): those a run
   * would import into the public home (not in `toImport`, which is the
   * private ones), those Raft's rule refuses, by reason, and each one.
   */
  public: LegacyMovePublicPlan | null;
}

export interface LegacyMovePublicPlan {
  toImport: { count: number; bytes: number };
  refused: { count: number } & Record<PublicImportRefusal, number>;
  /** Of the refused, those an approval (`run --approved-by`) would import public too: an agent or system-identity author's. */
  withApproval: { count: number; bytes: number };
  /**
   * sha256 over the server and each public entry as a run with an approval
   * would take it (legacy id, name, version, home, visibility, author, decision and
   * its basis or refusal), in id order: what an approval names
   * (`run --plan-digest`); any changed entry changes it.
   */
  digest: string;
  artifacts: LegacyMovePublicEntry[];
}

/** One Artifact public on raft-artifacts.com, as the plan shows it. */
export interface LegacyMovePublicEntry {
  artifactId: string;
  /** Its link on raft-artifacts.com (null: no name a link can carry). */
  link: string | null;
  name: string | null;
  title: string | null;
  sizeBytes: number;
  /** Its current version's number there (the one imported); null: none. */
  version: number | null;
  /** Its author here: the old creator Raft confirms, or the system identity (the ops actor), with why. */
  author: { kind: "creator"; type: "agent" | "user"; id: string } | { kind: "system"; reason: "noCreator" | "notInServer" };
  /** What a run would do: import it, or skip it for that reason. */
  decision: "import" | LegacyMoveSkipReason;
  /** `import`: its new home and who sees it there. */
  to: { home: "public"; visibility: "anyone_with_the_link" } | null;
  /** `public_refused`: why. */
  refusal?: PublicImportRefusal;
  /** `public_refused`: an approval (`run --approved-by`) would import it public. */
  withApproval?: true;
  /** `already_imported`: the Artifact it stands as (its home is whatever that import gave it). */
  importedAs?: { id: string; url: string };
}

/** The plan's digest (LegacyMovePublicPlan.digest): each entry as a run with an approval would take it. */
function publicPlanDigest(server: LegacyMoveServer, entries: readonly LegacyMovePublicEntry[]): string {
  const rows = [...entries].sort((a, b) => (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0)).map((entry) => {
    const approved = entry.withApproval === true;
    const imports = entry.decision === "import" || approved;
    return [
      entry.artifactId,
      entry.name,
      entry.version,
      imports ? "public" : null,
      "public",
      entry.author.kind === "creator" ? `${entry.author.type}:${entry.author.id}` : `system:${entry.author.reason}`,
      imports ? "import" : entry.decision,
      entry.decision === "import" ? "author" : approved ? "approval" : entry.refusal ?? null,
    ];
  });
  return createHash("sha256").update(JSON.stringify(["raft-artifacts-legacy-move-public/v1", server.id, rows])).digest("hex");
}

/**
 * The digest one approval names for several servers: sha256 over each
 * server's id and its plan's digest (LegacyMovePublicPlan.digest, itself
 * over the server and each of its public entries), by server id, so the
 * order they are named in doesn't matter; any changed entry of any of them,
 * or another set of servers, changes it. One server's is that server's own
 * digest (as before there were sets).
 */
export function legacyMoveSetDigest(servers: ReadonlyArray<{ serverId: string; digest: string }>): string {
  if (servers.length === 1) return servers[0]!.digest;
  const rows = [...servers].sort((a, b) => (a.serverId < b.serverId ? -1 : a.serverId > b.serverId ? 1 : 0)).map((entry) => [entry.serverId, entry.digest]);
  return createHash("sha256").update(JSON.stringify(["raft-artifacts-legacy-move-public-set/v1", rows])).digest("hex");
}

/** Several servers' `--public` plans as one approval takes them: the digest it names and the counts to post with it. */
export interface LegacyMovePublicSet {
  servers: Array<{ id: string; slug: string; digest: string }>;
  /** legacyMoveSetDigest over them (`run --servers … --plan-digest`). */
  digest: string;
  /** Public on raft-artifacts.com, over every server: listed; kept public on their author's right; kept public on the approval; still refused with it (a guest's, a creator Raft can't confirm). */
  public: { listed: number; toImport: number; withApproval: number; stillRefused: number };
  /** Private there: imported into the whole server. */
  toImport: number;
}

export function legacyMovePublicSet(plans: readonly LegacyMovePlan[]): LegacyMovePublicSet {
  const servers = plans.map((plan) => {
    if (!plan.public) throw new Error("a set of plans for one approval is of --public plans");
    return { id: plan.server.id, slug: plan.server.slug, digest: plan.public.digest };
  });
  const sum = (of: (plan: LegacyMovePlan) => number) => plans.reduce((total, plan) => total + of(plan), 0);
  return {
    servers,
    digest: legacyMoveSetDigest(servers.map((server) => ({ serverId: server.id, digest: server.digest }))),
    public: {
      listed: sum((plan) => plan.public!.artifacts.length),
      toImport: sum((plan) => plan.public!.toImport.count),
      withApproval: sum((plan) => plan.public!.withApproval.count),
      stillRefused: sum((plan) => plan.public!.refused.count - plan.public!.withApproval.count),
    },
    toImport: sum((plan) => plan.toImport.count),
  };
}

/**
 * The dry run: what a run would do for the server now. Read only: asks the
 * standalone app's `list` (nothing else: no freeze, no manifest) and reads
 * this server's Artifacts; writes nothing anywhere.
 */
export async function planLegacyMove(server: LegacyMoveServer, opts: { pageSize?: number } & LegacyMovePublicOption = {}): Promise<LegacyMovePlan> {
  const config = requireConfig();
  const limit = pageSizeOf(opts.pageSize);
  const plan: LegacyMovePlan = {
    server,
    artifactsEnabled: await artifactsEnabled(server.id),
    total: 0,
    totalBytes: 0,
    toImport: { count: 0, bytes: 0 },
    systemAuthor: { count: 0, noCreator: 0, notInServer: 0 },
    skipped: emptySkips(),
    public: opts.public
      ? { toImport: { count: 0, bytes: 0 }, refused: { count: 0, system_author: 0, agent_author: 0, may_not_make_public: 0 }, withApproval: { count: 0, bytes: 0 }, digest: "", artifacts: [] }
      : null,
  };
  let cursor: string | null = null;
  for (;;) {
    const page = await listOrFail(config, { serverId: server.id, cursor, limit });
    for (const item of page.items) {
      plan.total += 1;
      plan.totalBytes += item.sizeBytes;
      const decision = await decide(server, item, opts);
      const author = await legacyAuthor(server.id, item.creator);
      if (plan.public && item.visibility === "public") {
        plan.public.artifacts.push({
          artifactId: item.artifactId,
          link: item.name ? legacyLinkOf(server.slug, item.name) : null,
          name: item.name,
          title: item.title,
          sizeBytes: item.sizeBytes,
          version: item.currentVersion,
          author: author ? { kind: "creator", type: author.type, id: author.id } : { kind: "system", reason: item.creator ? "notInServer" : "noCreator" },
          decision: decision.kind === "import" ? "import" : decision.reason,
          to: decision.kind === "import" ? { home: "public", visibility: "anyone_with_the_link" } : null,
          ...(decision.kind === "skip" && decision.refusal ? { refusal: decision.refusal } : {}),
          ...(decision.kind === "skip" && decision.approvable ? { withApproval: true as const } : {}),
          ...(decision.kind === "skip" && decision.importedAs ? { importedAs: decision.importedAs } : {}),
        });
      }
      if (decision.kind === "import" && decision.home === "public") {
        plan.public!.toImport.count += 1;
        plan.public!.toImport.bytes += item.sizeBytes;
      } else if (decision.kind === "import") {
        plan.toImport.count += 1;
        plan.toImport.bytes += item.sizeBytes;
        if (!author) {
          plan.systemAuthor.count += 1;
          plan.systemAuthor[item.creator ? "notInServer" : "noCreator"] += 1;
        }
      } else {
        plan.skipped[decision.reason] += 1;
        if (decision.refusal) {
          plan.public!.refused.count += 1;
          plan.public!.refused[decision.refusal] += 1;
        }
        if (decision.approvable) {
          plan.public!.withApproval.count += 1;
          plan.public!.withApproval.bytes += item.sizeBytes;
        }
      }
    }
    if (page.nextCursor === null || page.items.length === 0) {
      if (plan.public) plan.public.digest = publicPlanDigest(server, plan.public.artifacts);
      return plan;
    }
    cursor = page.nextCursor;
  }
}

// ---- run -----------------------------------------------------------------------

export interface LegacyMoveImported {
  artifactId: string;
  name: string;
  /** The new Artifact in Raft. */
  id: string;
  url: string;
  /** Its author: the old creator, or the ops actor (the system identity) when Raft doesn't confirm that one in the server. */
  author: "creator" | "ops";
  /** Its home: the whole server, or (public there, `--public`) the public home. Absent in a state saved before `--public` existed: the server. */
  home?: LegacyMoveHome;
  /** The public home: on its author's right, or on the approval. */
  publicBasis?: LegacyMovePublicBasis;
  /** Its old comments, copied right after it (legacyComments.ts); absent in a state saved before they were. */
  comments?: LegacyCommentsResult;
}
export interface LegacyMoveSkipped {
  artifactId: string;
  name: string | null;
  reason: LegacyMoveSkipReason;
  /** already_imported: the Artifact it stands as. */
  importedAs?: { id: string; url: string };
  /** public_refused: why. */
  refusal?: PublicImportRefusal;
}
export interface LegacyMoveFailed {
  artifactId: string;
  name: string;
  /** The import's refusal code (the APIs' codes), or ERROR for anything unexpected. */
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** A run's saved state: where it is and what it did, in this pass. */
export interface LegacyMoveState {
  version: 1;
  serverId: string;
  /** This pass's start. */
  startedAt: string;
  /** The standalone app's freeze time (the first freeze's, it keeps it). */
  frozenAt: string | null;
  /** The last artifactId done (`list` returns the ones after it); null: from the start. */
  cursor: string | null;
  /** This pass imports public Artifacts too (`--public`); absent: it doesn't. */
  public?: boolean;
  /** The approval this pass runs under (`--approved-by`), and the ids of the approved plan it covers. */
  approval?: LegacyMoveStateApproval;
  /** Every listed Artifact was looked at: the next run is a new pass. */
  done: boolean;
  imported: LegacyMoveImported[];
  skipped: LegacyMoveSkipped[];
  failed: LegacyMoveFailed[];
}

/** The approval a pass runs under, as its state keeps it. */
export interface LegacyMoveStateApproval {
  approver: { id: string; name: string };
  /** The digest the approval names: this server's, or (several servers) legacyMoveSetDigest of them all. */
  planDigest: string;
  approvalRef: string;
  /** This server's own digest in the approved plan; absent (saved before sets): `planDigest`. */
  serverDigest?: string;
  /** The servers the approval covers (several only), by id. */
  serverIds?: string[];
  /** The public Artifacts the approved plan imports on the approval (and only these). */
  artifactIds: string[];
}

/** Where a run keeps its state between Artifacts (and runs). */
export interface LegacyMoveStateStore {
  load(): Promise<LegacyMoveState | null>;
  save(state: LegacyMoveState): Promise<void>;
}

/** A state file: JSON, replaced whole (written beside it, then renamed) on every save. */
export function fileLegacyMoveStateStore(path: string): LegacyMoveStateStore {
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      const state = JSON.parse(text) as LegacyMoveState;
      if (state?.version !== 1 || typeof state.serverId !== "string") throw new Error(`${path} is not a state file of this script`);
      return state;
    },
    async save(state) {
      const temporary = `${path}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(temporary, path);
    },
  };
}

export interface LegacyMoveCommentCounts {
  pages: number;
  imported: number;
  alreadyImported: number;
  systemAuthor: number;
  notFound: number;
  failed: number;
}

function commentCountsOf(imported: readonly LegacyMoveImported[]): LegacyMoveCommentCounts {
  const counts: LegacyMoveCommentCounts = { pages: 0, imported: 0, alreadyImported: 0, systemAuthor: 0, notFound: 0, failed: 0 };
  for (const { comments } of imported) {
    if (!comments) continue;
    counts.pages += 1;
    if (comments.outcome === "imported") {
      counts.imported += comments.imported;
      counts.alreadyImported += comments.alreadyImported;
      counts.systemAuthor += comments.systemAuthor;
    } else if (comments.outcome === "not_found") counts.notFound += 1;
    else counts.failed += 1;
  }
  return counts;
}

/** Why a run stopped before the end: `max` imports tried, `stop_at` passed, or asked to (a signal). */
export type LegacyMoveStop = "max" | "stop_at" | "signal";

export interface LegacyMoveReport {
  server: LegacyMoveServer;
  operator: string;
  frozenAt: string | null;
  /** Every listed Artifact was looked at in this pass. */
  done: boolean;
  /** Why it stopped before the end; null when done. */
  stopped: LegacyMoveStop | null;
  /** This pass resumed a run's saved state. */
  resumed: boolean;
  cursor: string | null;
  /** This pass imports public Artifacts too (`--public`). */
  public: boolean;
  /** The approval it runs under (`--approved-by`), and how many it imported public on it; null: none. */
  approval: { approver: { id: string; name: string }; planDigest: string; approvalRef: string; imported: number } | null;
  /** `systemAuthor`: of the imported, those the ops actor is the author of; `public`: of the imported, those now in the public home. */
  counts: { imported: number; systemAuthor: number; public: number; skipped: Record<LegacyMoveSkipReason, number>; failed: number };
  /**
   * The imported pages' old comments (each page's in `imported[].comments`):
   * `imported` copied, `alreadyImported` there before, `systemAuthor` of
   * them by the system identity; `notFound` pages the standalone app had none
   * for (404); `failed` pages whose comments weren't copied (the page stands:
   * `comments run` copies them later).
   */
  comments: LegacyMoveCommentCounts;
  imported: LegacyMoveImported[];
  skipped: LegacyMoveSkipped[];
  failed: LegacyMoveFailed[];
}

/**
 * A Raft platform owner's or admin's approval of a `--public` plan (`run
 * --approved-by <id|email|handle> --plan-digest <d> --approval-ref <ref>`):
 * all three, with `public`. The approver is resolved and must be a human
 * owner or admin of Botiverse, the platform's own Server (actors.ts
 * isPlatformOwnerOrAdmin), not of the server moved; the digest must be a
 * fresh plan's (of every server the run names: legacyMoveSetDigest), before
 * anything is frozen (and each server's own again once it is frozen).
 */
export interface LegacyMoveApprovalOption {
  approvedBy: string;
  planDigest: string;
  /** The Raft message that records the approval. */
  approvalRef: string;
}

export interface LegacyMoveRunOptions extends LegacyMovePublicOption {
  approval?: LegacyMoveApprovalOption;
  /** The operator, recorded in each import's audit row. */
  operator: string;
  state: LegacyMoveStateStore;
  /** At most this many imports tried by this invocation (skips don't count). */
  max?: number;
  /** No new Artifact is started at or after this time. */
  stopAt?: Date;
  /** Asked before each Artifact: true stops the run there (a signal). */
  shouldStop?: () => boolean;
  /** Start a new pass, ignoring a saved state that isn't done. */
  restart?: boolean;
  /** A download's file limit raised to this for these imports (importLegacyArtifactAsOps `maxFileBytes`). */
  maxFileBytes?: number;
  pageSize?: number;
  /** A line per Artifact, for the operator. */
  log?: (line: string) => void;
  now?: () => Date;
}

const freshState = (server: LegacyMoveServer, now: Date, includePublic: boolean): LegacyMoveState => ({
  version: 1, serverId: server.id, startedAt: now.toISOString(), frozenAt: null, cursor: null, ...(includePublic ? { public: true } : {}), done: false, imported: [], skipped: [], failed: [],
});

function reportOf(server: LegacyMoveServer, operator: string, state: LegacyMoveState, stopped: LegacyMoveStop | null, resumed: boolean): LegacyMoveReport {
  const skipped = emptySkips();
  for (const entry of state.skipped) skipped[entry.reason] += 1;
  return {
    server, operator, frozenAt: state.frozenAt, done: state.done, stopped, resumed, cursor: state.cursor, public: state.public === true,
    approval: state.approval
      ? {
        approver: state.approval.approver, planDigest: state.approval.planDigest, approvalRef: state.approval.approvalRef,
        imported: state.imported.filter((entry) => entry.publicBasis === "approval").length,
      }
      : null,
    counts: {
      imported: state.imported.length,
      systemAuthor: state.imported.filter((entry) => entry.author === "ops").length,
      public: state.imported.filter((entry) => entry.home === "public").length,
      skipped,
      failed: state.failed.length,
    },
    comments: commentCountsOf(state.imported),
    imported: state.imported, skipped: state.skipped, failed: state.failed,
  };
}

/** The run's operator and limits, checked before anything is asked. */
function checkRunOptions(opts: Pick<LegacyMoveRunOptions, "operator" | "max">): string {
  const operator = opts.operator.trim();
  if (!operator) throw new Error("the operator's name is required (it is recorded in each import's audit row)");
  if (opts.max !== undefined && (!Number.isSafeInteger(opts.max) || opts.max < 1)) throw new Error("max is a positive integer");
  return operator;
}

const flagOffRefusal = (server: LegacyMoveServer, count: number) =>
  new Error(`the Artifacts flag (workspace_artifacts_v0) is off on ${server.slug}: --public would import ${count} public Artifact(s) whose old links would lead to a page that doesn't open yet. Switch the flag on first, or run without --public; nothing frozen or imported`);

/** The approver: a Raft platform owner or admin now (isPlatformOwnerOrAdmin), else the approval is refused. */
async function platformApprover(approvedBy: string): Promise<{ id: string; name: string }> {
  const approver = await platformOwnerOrAdminByRef(approvedBy);
  if (!approver) {
    throw new Error(`${approvedBy} is not a Raft platform owner or admin (a human owner or admin of Botiverse, ${PLATFORM_SERVER_ID}) now: the approval is refused; nothing frozen or imported`);
  }
  return approver;
}

/** How a server of the approved set stands: to start (a fresh plan, now), resuming a pass under this approval, or done under it (not run again). */
type ApprovedServer =
  | { kind: "fresh"; approval: LegacyMoveStateApproval }
  | { kind: "resumed"; approval: LegacyMoveStateApproval }
  | { kind: "done"; state: LegacyMoveState };

/**
 * 0a. The approval of the whole run, before anything is frozen anywhere: whole,
 * its approver a Raft platform owner or admin now, and the plan it names the
 * plan now. The digest is recomputed from each server's own: the one saved
 * by a pass started (or finished) under this same approval (its imports
 * since have changed a fresh plan), else a fresh plan's; and the servers to
 * start that would import a public one while their Artifacts flag is off
 * refuse it too.
 */
async function approveMoves(
  servers: readonly LegacyMoveServer[],
  saved: ReadonlyArray<LegacyMoveState | null>,
  approvalOption: LegacyMoveApprovalOption,
  opts: { includePublic: boolean; restart: boolean; limit: number },
): Promise<ApprovedServer[]> {
  const approvedBy = approvalOption.approvedBy.trim();
  const planDigest = approvalOption.planDigest.trim().toLowerCase();
  const approvalRef = approvalOption.approvalRef.trim();
  if (!opts.includePublic) throw new Error("--approved-by is for --public only");
  if (!approvedBy || !planDigest || !approvalRef) throw new Error("--approved-by needs --plan-digest and --approval-ref (all three); nothing frozen or imported");
  const approver = await platformApprover(approvedBy);
  const serverIds = servers.map((server) => server.id);
  const approved: ApprovedServer[] = [];
  const digests: Array<{ serverId: string; digest: string }> = [];
  const toStart: Array<{ server: LegacyMoveServer; plan: LegacyMovePlan }> = [];
  for (const [index, server] of servers.entries()) {
    const state = saved[index] ?? null;
    const same = state?.approval !== undefined && state.approval.approver.id === approver.id && state.approval.planDigest === planDigest && state.approval.approvalRef === approvalRef;
    if (state && !opts.restart && !state.done) {
      // A pass keeps its approval: the plan it approved is the saved one.
      if (!same) throw new Error(`the saved pass ${servers.length > 1 ? `of ${server.slug} ` : ""}was started under another approval (or none): resume it the same way, or start a new pass (--restart); nothing frozen or imported`);
      approved.push({ kind: "resumed", approval: state.approval! });
      digests.push({ serverId: server.id, digest: state.approval!.serverDigest ?? state.approval!.planDigest });
      continue;
    }
    if (state && !opts.restart && state.done && same) {
      approved.push({ kind: "done", state });
      digests.push({ serverId: server.id, digest: state.approval!.serverDigest ?? state.approval!.planDigest });
      continue;
    }
    const plan = await planLegacyMove(server, { pageSize: opts.limit, public: true });
    toStart.push({ server, plan });
    digests.push({ serverId: server.id, digest: plan.public!.digest });
    approved.push({
      kind: "fresh",
      approval: {
        approver, planDigest, approvalRef, serverDigest: plan.public!.digest, ...(servers.length > 1 ? { serverIds } : {}),
        artifactIds: plan.public!.artifacts.filter((entry) => entry.withApproval).map((entry) => entry.artifactId),
      },
    });
  }
  const digest = legacyMoveSetDigest(digests);
  if (digest !== planDigest) {
    throw new Error(`the plan changed since it was approved (digest ${digest}, approved ${planDigest}): plan --public again and have it approved again; nothing frozen or imported`);
  }
  for (const { server, plan } of toStart) {
    const count = plan.public!.toImport.count + plan.public!.withApproval.count;
    if (!plan.artifactsEnabled && count > 0) throw flagOffRefusal(server, count);
  }
  return approved;
}

/** Several servers moved in one run, one after the other, each with its own state. */
export interface LegacyMoveSetRunOptions extends Omit<LegacyMoveRunOptions, "state"> {
  /** The state of each server's own pass (a file per server). */
  stateOf: (server: LegacyMoveServer) => LegacyMoveStateStore;
}

export interface LegacyMoveSetReport {
  /** Each server this run got to, in the order named (one done under this approval before is reported from its state, not run again). */
  reports: LegacyMoveReport[];
  /** The servers it didn't get to (it stopped before them: rerun to go on). */
  notStarted: LegacyMoveServer[];
  /** Why it stopped before the end; null when every server was moved. */
  stopped: LegacyMoveStop | null;
}

/**
 * Move several servers under one approval of their combined plan (or one
 * server, with or without one): the approval is checked for all of them
 * before anything is frozen (approveMoves), then each is moved as
 * runLegacyMove does, one after the other, `max`, `stopAt` and the signal
 * counting over the whole run (none is started past them). A server done
 * under this approval before is not run again. Several servers need an
 * approval: without one a run moves one server.
 */
export async function runLegacyMoves(servers: readonly LegacyMoveServer[], opts: LegacyMoveSetRunOptions): Promise<LegacyMoveSetReport> {
  requireConfig();
  const limit = pageSizeOf(opts.pageSize);
  const operator = checkRunOptions(opts);
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  if (servers.length === 0) throw new Error("name the server(s)");
  if (new Set(servers.map((server) => server.id)).size !== servers.length) throw new Error("a server is named twice");
  if (servers.length > 1 && !opts.approval) throw new Error("a run moves one server at a time; several only under one approval of their combined plan (--public --approved-by --plan-digest --approval-ref)");
  const stores = servers.map((server) => opts.stateOf(server));
  // fanout-ok: one state-file read per server named on the command line (an operator's run, a few dozen at most), no database or network
  const saved = await Promise.all(stores.map((store) => store.load()));
  for (const [index, state] of saved.entries()) {
    if (state && state.serverId !== servers[index]!.id) throw new Error(`the state is of another server (${state.serverId}), not ${servers[index]!.id}`);
  }
  const approved = opts.approval ? await approveMoves(servers, saved, opts.approval, { includePublic: opts.public === true, restart: opts.restart === true, limit }) : null;

  const reports: LegacyMoveReport[] = [];
  let tried = 0;
  for (const [index, server] of servers.entries()) {
    const standing = approved?.[index];
    if (standing?.kind === "done") {
      log(`${server.slug}: moved under this approval before (done); not run again`);
      reports.push(reportOf(server, operator, standing.state, null, false));
      continue;
    }
    const stop: LegacyMoveStop | null = index === 0 ? null
      : opts.shouldStop?.() ? "signal"
      : opts.max !== undefined && tried >= opts.max ? "max"
      : opts.stopAt && now().getTime() >= opts.stopAt.getTime() ? "stop_at"
      : null;
    if (stop) {
      log(`stopped (${stop}) before ${server.slug}; rerun to go on`);
      return { reports, notStarted: servers.slice(index), stopped: stop };
    }
    if (servers.length > 1) log(`== ${server.slug} (${server.id}), ${index + 1} of ${servers.length}`);
    let result: { report: LegacyMoveReport; tried: number };
    try {
      result = await runOne(server, { ...opts, operator, state: stores[index]!, limit, ...(opts.max !== undefined ? { max: opts.max - tried } : {}) }, standing?.approval);
    } catch (error) {
      if (reports.length === 0 || !(error instanceof Error)) throw error;
      throw new Error(`${server.slug}: ${error.message} (moved before it in this run: ${reports.map((report) => report.server.slug).join(", ")}; their state files keep their reports)`);
    }
    reports.push(result.report);
    tried += result.tried;
    if (result.report.stopped) return { reports, notStarted: servers.slice(index + 1), stopped: result.report.stopped };
  }
  return { reports, notStarted: [], stopped: null };
}

/**
 * Move the server: freeze it in the standalone app, then import its private
 * Artifacts one at a time (see the top of this file). Resumes the state
 * `opts.state` holds. Throws, before importing anything, when importing isn't
 * configured, the state is another server's, the approval is refused or the
 * freeze fails; a failed `list` throws too, its state saved (the next run
 * resumes there). A failed Artifact doesn't stop it. Under an approval, a
 * pass that finished under it is not run again (its report is the saved one).
 */
export async function runLegacyMove(server: LegacyMoveServer, opts: LegacyMoveRunOptions): Promise<LegacyMoveReport> {
  const { state, ...rest } = opts;
  const { reports } = await runLegacyMoves([server], { ...rest, stateOf: () => state });
  return reports[0]!;
}

/** One server's move (runLegacyMoves checked the options and, when there is one, the approval: `approval` is this server's). */
async function runOne(
  server: LegacyMoveServer,
  opts: LegacyMoveRunOptions & { limit: number },
  approval: LegacyMoveStateApproval | undefined,
): Promise<{ report: LegacyMoveReport; tried: number }> {
  const config = requireConfig();
  const { limit, operator } = opts;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});

  const includePublic = opts.public === true;
  const saved = await opts.state.load();
  if (saved && saved.serverId !== server.id) throw new Error(`the state is of another server (${saved.serverId}), not ${server.id}`);
  const resumed = saved !== null && !saved.done && !opts.restart;
  // A pass keeps its choice: one started without --public skipped the public ones before its cursor.
  if (resumed && (saved.public === true) !== includePublic) {
    throw new Error(`the saved pass was started ${saved.public ? "with" : "without"} --public: resume it the same way, or start a new pass (--restart)`);
  }
  const state = resumed ? saved : freshState(server, now(), includePublic);
  // The approval (approveMoves): a resumed pass keeps the one it saved.
  if (approval && !resumed) state.approval = approval;
  else if (!approval && resumed && saved.approval) {
    throw new Error("the saved pass was started with --approved-by: resume it the same way, or start a new pass (--restart)");
  }

  // 0b. Public ones only into a server whose Artifacts flag is on: signed-out
  // visitors see a public Artifact only then, and their old links would send
  // them to Raft at once. Asked before the freeze (a read-only list), so a
  // refused run changes nothing anywhere.
  if (includePublic && !(await artifactsEnabled(server.id))) {
    const plan = await planLegacyMove(server, { pageSize: limit, public: true });
    const count = plan.public!.toImport.count + (approval ? plan.public!.withApproval.count : 0);
    if (count > 0) throw flagOffRefusal(server, count);
  }
  if (resumed) log(`resuming after ${state.cursor ?? "the start"} (${state.imported.length} imported, ${state.skipped.length} skipped, ${state.failed.length} failed so far)`);

  // 1. Freeze first: from now on nothing changes there while it is copied.
  try {
    state.frozenAt = (await freezeLegacyServer(config, server.id)).frozenAt;
  } catch (error) {
    if (error instanceof LegacyWorkerUnavailable) throw new Error(`the standalone app did not freeze the server (${error.reason}); nothing imported`);
    throw error;
  }
  // This server's part of the approved plan again, now that nothing changes there: a change in between stops here (frozen, nothing imported).
  if (approval && !resumed) {
    const plan = await planLegacyMove(server, { pageSize: limit, public: true });
    const approvedDigest = approval.serverDigest ?? approval.planDigest;
    if (plan.public!.digest !== approvedDigest) {
      throw new Error(`the plan changed while the server was being frozen (digest ${plan.public!.digest}, approved ${approvedDigest}): frozen, nothing imported; plan --public again and have it approved again`);
    }
  }
  await opts.state.save(state);
  log(`frozen in the standalone app since ${state.frozenAt}`);
  const approvedIds = new Set(state.approval?.artifactIds ?? []);
  const runApproval = state.approval;

  // 2. Every listed Artifact, in the standalone app's id order.
  let tried = 0;
  for (;;) {
    const page = await listOrFail(config, { serverId: server.id, cursor: state.cursor, limit });
    for (const item of page.items) {
      const stop: LegacyMoveStop | null = opts.shouldStop?.() ? "signal"
        : opts.max !== undefined && tried >= opts.max ? "max"
        : opts.stopAt && now().getTime() >= opts.stopAt.getTime() ? "stop_at"
        : null;
      if (stop) {
        log(`stopped (${stop}) before ${item.artifactId}; rerun to resume`);
        return { report: reportOf(server, operator, state, stop, resumed), tried };
      }
      const decision = await decide(server, item, { public: includePublic, approved: approvedIds.has(item.artifactId) });
      if (decision.kind === "skip") {
        state.skipped.push({
          artifactId: item.artifactId, name: item.name, reason: decision.reason,
          ...(decision.importedAs ? { importedAs: decision.importedAs } : {}), ...(decision.refusal ? { refusal: decision.refusal } : {}),
        });
        log(`skip   ${item.name ?? item.artifactId}: ${LEGACY_MOVE_SKIP_REASONS[decision.reason]}${decision.refusal ? ` (${decision.refusal})` : ""}`);
      } else {
        tried += 1;
        const name = item.name!;
        try {
          const outcome = await importLegacyArtifactAsOps({
            serverId: server.id, serverSlug: server.slug, name, operator, home: decision.home, expectedArtifactId: item.artifactId,
            ...(opts.maxFileBytes !== undefined ? { maxFileBytes: opts.maxFileBytes } : {}),
            // Only for the ones the approved plan imports on it, and only while the standalone app answers it public (its list, in this run, after the freeze).
            ...(runApproval && decision.basis === "approval"
              ? { approval: { approver: runApproval.approver, ref: runApproval.approvalRef, legacyVisibility: item.visibility } }
              : {}),
          });
          if (outcome.kind === "refused_public") {
            // The import's own check (under its lock) refused it: the author's standing changed since `decide`.
            state.skipped.push({ artifactId: item.artifactId, name, reason: "public_refused", refusal: outcome.reason });
            log(`skip   ${name}: ${LEGACY_MOVE_SKIP_REASONS.public_refused} (${outcome.reason})`);
          } else if (outcome.kind === "failed") {
            state.failed.push({ artifactId: item.artifactId, name, code: outcome.code, message: outcome.message, ...(outcome.details ? { details: outcome.details } : {}) });
            log(`FAILED ${name}: ${outcome.code} ${outcome.message}`);
          } else if (outcome.kind === "already_imported") {
            // Found under the import's own check (an earlier run that stopped before saving, or a member's import meanwhile).
            state.skipped.push({ artifactId: item.artifactId, name, reason: "already_imported", importedAs: outcome.item });
            log(`skip   ${name}: ${LEGACY_MOVE_SKIP_REASONS.already_imported}`);
          } else {
            log(`import ${name} → ${outcome.item.url}${decision.home === "public" ? " (anyone with the link)" : ""}${outcome.author === "ops" ? " (author: the system identity)" : ""}`);
            // Its old comments, now (the server is frozen): a failure is reported, the page stands.
            const comments = await copyLegacyComments({ config, serverId: server.id, name, itemId: outcome.item.id, legacyArtifactId: item.artifactId, operator });
            state.imported.push({
              artifactId: item.artifactId, name, id: outcome.item.id, url: outcome.item.url, author: outcome.author, home: decision.home,
              ...(outcome.publicBasis ? { publicBasis: outcome.publicBasis } : {}),
              comments,
            });
            log(`       ${commentsLine(comments)}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          state.failed.push({ artifactId: item.artifactId, name, code: "ERROR", message });
          log(`FAILED ${name}: ERROR ${message}`);
        }
      }
      state.cursor = item.artifactId;
      await opts.state.save(state);
    }
    if (page.nextCursor === null || page.items.length === 0) break;
  }
  state.done = true;
  await opts.state.save(state);
  return { report: reportOf(server, operator, state, null, resumed), tried };
}

// ---- old comments of pages already imported (`comments plan` / `comments run`) ---

/** One page of a moved server whose import stands in Raft, and its old comments, as `comments plan` shows them. */
export interface LegacyCommentsPlanPage {
  /** The old Artifact's id, name and link on raft-artifacts.com. */
  artifactId: string;
  name: string;
  link: string | null;
  /** The Artifact its import made here. */
  artifact: { id: string; url: string };
  /** `comments`: the standalone app answered them; `not_found`: it has no such page (404), nothing to copy. */
  fetch: "comments" | "not_found";
  /** Its comments there. */
  comments: number;
  /** Their authors, distinct: confirmed here (the author of the copy), or not (the system identity, the old name in the body). */
  authors: { matched: number; unmatched: number };
  /** The comments by a confirmed author, and by one that isn't. */
  byAuthor: { matched: number; unmatched: number };
  /** Copied before (their `lc_` id is on this Artifact). */
  alreadyImported: number;
  /** Whose `lc_` id another Artifact has (an earlier import of the page, deleted since): never copied here. */
  elsewhere: number;
  /** What a run would copy now. */
  toImport: number;
}

/** One server's `comments plan`. */
export interface LegacyCommentsPlan {
  server: LegacyMoveServer;
  /** The standalone app serves the server's comments (it is frozen there); false: it answered SERVER_NOT_FROZEN, nothing is copied. */
  frozen: boolean;
  pages: LegacyCommentsPlanPage[];
  totals: { pages: number; comments: number; toImport: number; alreadyImported: number; elsewhere: number; matched: number; unmatched: number };
  /**
   * sha256 over the server and each page as a run would write it (the old
   * id, the Artifact, and each comment's id, author and body), by old id; what
   * is already copied doesn't change it (a run stopped halfway resumes under
   * the same approval).
   */
  digest: string;
}

/** Several servers' `comments plan`s as one approval names them. */
export interface LegacyCommentsPlanSet {
  plans: LegacyCommentsPlan[];
  /** legacyMoveSetDigest over the servers' digests (one server's: its own); `comments run --plan-digest`. */
  digest: string;
  totals: LegacyCommentsPlan["totals"];
}

type PlannedCommentsPage = { entry: LegacyCommentsPlanPage; rows: LegacyCommentRow[] };

const COMMENTS_DIGEST_TAG = "raft-artifacts-legacy-comments/v1";

function commentsPlanDigest(server: LegacyMoveServer, frozen: boolean, pages: readonly PlannedCommentsPage[]): string {
  const rows = [...pages].sort((a, b) => (a.entry.artifactId < b.entry.artifactId ? -1 : a.entry.artifactId > b.entry.artifactId ? 1 : 0)).map(({ entry, rows: comments }) => [
    entry.artifactId,
    entry.artifact.id,
    entry.fetch,
    comments.map((row) => [row.id, `${row.author.type}:${row.author.id}`, createHash("sha256").update(row.body).digest("hex"), row.createdAt.getTime()]),
  ]);
  return createHash("sha256").update(JSON.stringify([COMMENTS_DIGEST_TAG, server.id, frozen, rows])).digest("hex");
}

const sumTotals = (plans: ReadonlyArray<Pick<LegacyCommentsPlan, "totals">>): LegacyCommentsPlan["totals"] => {
  const totals = { pages: 0, comments: 0, toImport: 0, alreadyImported: 0, elsewhere: 0, matched: 0, unmatched: 0 };
  for (const plan of plans) for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += plan.totals[key];
  return totals;
};

/**
 * The server's pages whose import stands, their old comments and what a
 * run would write (read only: the standalone app's `list` and `comments`,
 * and this server's rows). A server not frozen there is `frozen: false`
 * after its first page (nothing more is asked). A page whose comments the
 * standalone app can't give (too many, an unusable answer) throws: a plan
 * leaves nothing out.
 */
async function planCommentsOf(server: LegacyMoveServer, limit: number): Promise<{ plan: LegacyCommentsPlan; pages: PlannedCommentsPage[] }> {
  const config = requireConfig();
  const pages: PlannedCommentsPage[] = [];
  let frozen = true;
  let cursor: string | null = null;
  for (;;) {
    const page = await listOrFail(config, { serverId: server.id, cursor, limit });
    for (const item of page.items) {
      if (!frozen) break;
      if (item.name === null || item.name === "") continue;
      const artifact = await standingImport(server.id, item);
      if (!artifact) continue;
      let answer: Awaited<ReturnType<typeof fetchLegacyComments>>;
      try {
        answer = await fetchLegacyComments(config, server.id, item.name);
      } catch (error) {
        if (error instanceof LegacyWorkerUnavailable) throw new Error(`the standalone app's comments of ${item.name} failed (${error.reason}); nothing written`);
        throw error;
      }
      if (answer.kind === "not_frozen") {
        // The whole server's answer: nothing more is asked, nothing is copied.
        frozen = false;
        pages.length = 0;
        break;
      }
      if (answer.kind === "too_many") throw new Error(`the standalone app has too many comments on ${item.name} to serve (TOO_MANY_COMMENTS); nothing written`);
      const rows = answer.kind === "comments" ? await legacyCommentRows(server.id, answer.comments) : [];
      const present = await presentLegacyComments(artifact.id, rows.map((row) => row.id));
      const distinct = (matched: boolean) => new Set(rows.filter((row) => row.matched === matched).map((row) => row.authorKey)).size;
      pages.push({
        rows,
        entry: {
          artifactId: item.artifactId, name: item.name, link: legacyLinkOf(server.slug, item.name), artifact,
          fetch: answer.kind,
          comments: rows.length,
          authors: { matched: distinct(true), unmatched: distinct(false) },
          byAuthor: { matched: rows.filter((row) => row.matched).length, unmatched: rows.filter((row) => !row.matched).length },
          alreadyImported: present.here.size,
          elsewhere: present.elsewhere.size,
          toImport: rows.length - present.here.size - present.elsewhere.size,
        },
      });
    }
    if (!frozen || page.nextCursor === null || page.items.length === 0) break;
    cursor = page.nextCursor;
  }
  const entries = pages.map((planned) => planned.entry);
  const sum = (of: (entry: LegacyCommentsPlanPage) => number) => entries.reduce((total, entry) => total + of(entry), 0);
  const totals: LegacyCommentsPlan["totals"] = {
    pages: entries.length,
    comments: sum((entry) => entry.comments),
    toImport: sum((entry) => entry.toImport),
    alreadyImported: sum((entry) => entry.alreadyImported),
    elsewhere: sum((entry) => entry.elsewhere),
    matched: sum((entry) => entry.byAuthor.matched),
    unmatched: sum((entry) => entry.byAuthor.unmatched),
  };
  return { plan: { server, frozen, pages: entries, totals, digest: commentsPlanDigest(server, frozen, pages) }, pages };
}

/**
 * `comments plan`: for each server, its pages imported into Raft and their
 * old comments (see LegacyCommentsPlan), and one digest over all of them
 * (legacyMoveSetDigest). Read only, here and there.
 */
export async function planLegacyComments(servers: readonly LegacyMoveServer[], opts: { pageSize?: number } = {}): Promise<LegacyCommentsPlanSet> {
  const limit = pageSizeOf(opts.pageSize);
  if (servers.length === 0) throw new Error("name the server(s)");
  if (new Set(servers.map((server) => server.id)).size !== servers.length) throw new Error("a server is named twice");
  const plans: LegacyCommentsPlan[] = [];
  for (const server of servers) plans.push((await planCommentsOf(server, limit)).plan);
  return { plans, digest: legacyMoveSetDigest(plans.map((plan) => ({ serverId: plan.server.id, digest: plan.digest }))), totals: sumTotals(plans) };
}

/** One page of a `comments run`: what was written, or why not. */
export interface LegacyCommentsRunPage {
  artifactId: string;
  name: string;
  artifact: { id: string; url: string };
  comments: number;
  imported: number;
  alreadyImported: number;
  /** The comments whose id another Artifact has: not copied. */
  elsewhere: number;
  outcome: "written" | "nothing_to_do" | "gone" | "failed";
  message?: string;
}

export interface LegacyCommentsRunServer {
  server: LegacyMoveServer;
  frozen: boolean;
  pages: LegacyCommentsRunPage[];
  counts: { pages: number; comments: number; imported: number; alreadyImported: number; failed: number };
}

export interface LegacyCommentsRunReport {
  operator: string;
  approval: { approver: { id: string; name: string }; planDigest: string; approvalRef: string };
  servers: LegacyCommentsRunServer[];
  counts: LegacyCommentsRunServer["counts"];
}

/**
 * `comments run --servers a,b --approved-by <who> --plan-digest <d>
 * --approval-ref <message>`: the approval as `--public`'s (all three; the
 * approver a Raft platform owner or admin now, else refused; the digest
 * recomputed from a fresh plan of every server, a mismatch refused), both
 * before anything is written; then each page's comments are written
 * (writeLegacyComments, one transaction per Artifact), from that same
 * fresh plan. A rerun writes only what isn't there (the ids). A page that
 * fails is reported and the rest go on.
 */
export async function runLegacyComments(
  servers: readonly LegacyMoveServer[],
  opts: { approval: LegacyMoveApprovalOption; operator: string; pageSize?: number; log?: (line: string) => void },
): Promise<LegacyCommentsRunReport> {
  requireConfig();
  const limit = pageSizeOf(opts.pageSize);
  const operator = checkRunOptions({ operator: opts.operator });
  const log = opts.log ?? (() => {});
  if (servers.length === 0) throw new Error("name the server(s)");
  if (new Set(servers.map((server) => server.id)).size !== servers.length) throw new Error("a server is named twice");
  const approvedBy = opts.approval.approvedBy.trim();
  const planDigest = opts.approval.planDigest.trim().toLowerCase();
  const approvalRef = opts.approval.approvalRef.trim();
  if (!approvedBy || !planDigest || !approvalRef) throw new Error("comments run needs --approved-by, --plan-digest and --approval-ref (all three); nothing written");
  const approver = await platformApprover(approvedBy);
  const planned: Array<{ plan: LegacyCommentsPlan; pages: PlannedCommentsPage[] }> = [];
  for (const server of servers) planned.push(await planCommentsOf(server, limit));
  const digest = legacyMoveSetDigest(planned.map(({ plan }) => ({ serverId: plan.server.id, digest: plan.digest })));
  if (digest !== planDigest) {
    throw new Error(`the comments plan changed since it was approved (digest ${digest}, approved ${planDigest}): comments plan again and have it approved again; nothing written`);
  }

  const reports: LegacyCommentsRunServer[] = [];
  for (const { plan, pages } of planned) {
    if (servers.length > 1) log(`== ${plan.server.slug} (${plan.server.id})`);
    if (!plan.frozen) log(`${plan.server.slug}: not frozen in the standalone app: its comments are not served; nothing written`);
    const results: LegacyCommentsRunPage[] = [];
    for (const { entry, rows } of pages) {
      const base = { artifactId: entry.artifactId, name: entry.name, artifact: entry.artifact, comments: entry.comments, elsewhere: entry.elsewhere };
      if (rows.length === 0) {
        results.push({ ...base, imported: 0, alreadyImported: 0, outcome: "nothing_to_do" });
        continue;
      }
      try {
        const written = await writeLegacyComments({
          itemId: entry.artifact.id, legacyArtifactId: entry.artifactId, rows, operator,
          approval: { approver, approvalRef },
        });
        if (written.kind === "gone") {
          results.push({ ...base, imported: 0, alreadyImported: 0, outcome: "gone" });
          log(`skip   ${entry.name}: its Artifact is deleted or revoked`);
        } else {
          results.push({ ...base, imported: written.inserted, alreadyImported: Math.max(0, written.present - entry.elsewhere), outcome: "written" });
          log(`comments ${entry.name} → ${entry.artifact.url}: ${written.inserted} copied, ${written.present} there before`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ ...base, imported: 0, alreadyImported: 0, outcome: "failed", message });
        log(`FAILED ${entry.name}: ${message}`);
      }
    }
    reports.push({
      server: plan.server,
      frozen: plan.frozen,
      pages: results,
      counts: {
        pages: results.length,
        comments: results.reduce((sum, page) => sum + page.comments, 0),
        imported: results.reduce((sum, page) => sum + page.imported, 0),
        alreadyImported: results.reduce((sum, page) => sum + page.alreadyImported, 0),
        failed: results.filter((page) => page.outcome === "failed" || page.outcome === "gone").length,
      },
    });
  }
  const counts = { pages: 0, comments: 0, imported: 0, alreadyImported: 0, failed: 0 };
  for (const report of reports) for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] += report.counts[key];
  return { operator, approval: { approver, planDigest, approvalRef }, servers: reports, counts };
}

// ---- summaries -----------------------------------------------------------------

const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

const PUBLIC_REFUSALS: Record<PublicImportRefusal, string> = {
  system_author: "no author Raft confirms (the system identity would be it)",
  agent_author: "its author is an agent (only a person turns on link sharing)",
  may_not_make_public: "its author may not make it public (a guest)",
};

function publicLine(entry: LegacyMovePublicEntry): string {
  const author = entry.author.kind === "creator"
    ? `${entry.author.type === "user" ? "person" : "agent"} ${entry.author.id}`
    : `the system identity (${entry.author.reason === "noCreator" ? "no creator" : "creator deleted or not in the server"})`;
  const outcome = entry.decision === "import" ? "→ public home, anyone with the link"
    : entry.decision === "public_refused" ? `skipped: ${PUBLIC_REFUSALS[entry.refusal!]}${entry.withApproval ? "; with approval → public home, anyone with the link" : ""}`
    : entry.decision === "already_imported" ? `already imported: ${entry.importedAs!.url}`
    : `skipped: ${LEGACY_MOVE_SKIP_REASONS[entry.decision]}`;
  return `    ${entry.link ?? entry.artifactId}  "${entry.title ?? ""}" (${entry.name ?? "no name"}, ${mib(entry.sizeBytes)}); author ${author}; ${outcome}`;
}

/** A plan for a person to read and approve. */
export function formatLegacyMovePlan(plan: LegacyMovePlan): string {
  const lines = [
    `server ${plan.server.slug} (${plan.server.id}); Artifacts flag ${plan.artifactsEnabled ? "on" : "off"} (not required)`,
    `  listed:           ${plan.total} (${mib(plan.totalBytes)})`,
    `  to import:        ${plan.toImport.count} (${mib(plan.toImport.bytes)}) into the whole server`,
    `    author falls back to the system identity: ${plan.systemAuthor.count} (no creator ${plan.systemAuthor.noCreator}, creator deleted or not in the server ${plan.systemAuthor.notInServer})`,
    `  already imported: ${plan.skipped.already_imported}`,
    ...(plan.public ? [] : [`  public (skipped; plan --public lists them): ${plan.skipped.public}`]),
    `  no version (skipped): ${plan.skipped.no_version}`,
    ...(plan.skipped.no_name > 0 ? [`  no name (skipped): ${plan.skipped.no_name}`] : []),
  ];
  if (plan.public) {
    const { refused } = plan.public;
    lines.push(
      `  public (--public): ${plan.public.artifacts.length} listed`,
      `    to import, kept public (anyone with the link): ${plan.public.toImport.count} (${mib(plan.public.toImport.bytes)})`,
      `    refused by Raft's rule for making an Artifact public (skipped): ${refused.count} (no author Raft confirms ${refused.system_author}, agent author ${refused.agent_author}, author may not make it public ${refused.may_not_make_public})`,
      `    with approval (run --approved-by, a Raft platform owner or admin): ${plan.public.withApproval.count} more (${mib(plan.public.withApproval.bytes)}), kept public`,
      `    plan digest (run --plan-digest): ${plan.public.digest}`,
      ...plan.public.artifacts.map(publicLine),
    );
    if (!plan.artifactsEnabled && plan.public.toImport.count > 0) {
      lines.push("    note: the Artifacts flag is off: run --public refuses to import them until it is on (their old links would lead to a page that doesn't open yet)");
    }
  }
  return lines.join("\n");
}

/** Several servers' `--public` plans as one approval names them (legacyMovePublicSet), for a person to read and approve. */
export function formatLegacyMovePublicSet(set: LegacyMovePublicSet): string {
  return [
    `${set.servers.length} servers, one approval of them all: ${set.servers.map((server) => server.slug).join(", ")}`,
    `  public on raft-artifacts.com: ${set.public.listed} listed; kept public on their author's right: ${set.public.toImport}; with approval: ${set.public.withApproval} more, kept public; still refused with it (a guest's, a creator Raft can't confirm): ${set.public.stillRefused}`,
    `  private, into the whole server: ${set.toImport}`,
    `  plan digest of these ${set.servers.length} servers (run --servers ${set.servers.map((server) => server.slug).join(",")} --plan-digest): ${set.digest}`,
  ].join("\n");
}

/** One page's old comments, as a run's line says it. */
export function commentsLine(result: LegacyCommentsResult): string {
  switch (result.outcome) {
    case "imported":
      return `comments: ${result.imported} copied${result.alreadyImported > 0 ? `, ${result.alreadyImported} there before` : ""}${result.systemAuthor > 0 ? ` (${result.systemAuthor} by the system identity)` : ""}`;
    case "not_found":
      return "comments: none (the standalone app has no comments for it)";
    case "failed":
      return `comments FAILED (${result.reason}${result.message ? `: ${result.message}` : ""}): the page stands; comments run copies them later`;
  }
}

/** A `comments plan` for a person to read and approve. */
export function formatLegacyCommentsPlan(set: LegacyCommentsPlanSet): string {
  const lines: string[] = [];
  for (const plan of set.plans) {
    lines.push(`server ${plan.server.slug} (${plan.server.id})${plan.frozen ? "" : ": NOT frozen in the standalone app (its comments are not served; nothing to copy)"}`);
    for (const page of plan.pages) {
      lines.push(`    ${page.link ?? page.name} → ${page.artifact.url}: ${page.comments} comment(s)${page.fetch === "not_found" ? " (no such page there)" : ""}; authors confirmed ${page.authors.matched}, not ${page.authors.unmatched} (comments by them ${page.byAuthor.matched} / ${page.byAuthor.unmatched}); copied before ${page.alreadyImported}${page.elsewhere > 0 ? `; on another Artifact ${page.elsewhere}` : ""}; to copy ${page.toImport}`);
    }
    const t = plan.totals;
    lines.push(`  pages ${t.pages}; comments ${t.comments} (by a confirmed author ${t.matched}, by the system identity ${t.unmatched}); copied before ${t.alreadyImported}; to copy ${t.toImport}${t.elsewhere > 0 ? `; on another Artifact ${t.elsewhere}` : ""}`);
  }
  const t = set.totals;
  lines.push(
    `${set.plans.length} server(s): pages ${t.pages}; comments ${t.comments}; to copy ${t.toImport}; copied before ${t.alreadyImported}`,
    `  plan digest (comments run --servers ${set.plans.map((plan) => plan.server.slug).join(",")} --plan-digest): ${set.digest}`,
  );
  return lines.join("\n");
}

/** A `comments run`'s report for a person to read. */
export function formatLegacyCommentsReport(report: LegacyCommentsRunReport): string {
  const lines = [`comments run by ${report.operator}, on the approval of ${report.approval.approver.name} (${report.approval.approvalRef})`];
  for (const server of report.servers) {
    lines.push(`  ${server.server.slug}${server.frozen ? "" : " (not frozen: nothing copied)"}: pages ${server.counts.pages}, comments ${server.counts.comments}, copied ${server.counts.imported}, there before ${server.counts.alreadyImported}, failed ${server.counts.failed}`);
    for (const page of server.pages) if (page.outcome === "failed" || page.outcome === "gone") lines.push(`    ${page.name} (${page.artifactId}): ${page.outcome}${page.message ? ` ${page.message}` : ""}`);
  }
  return lines.join("\n");
}

/** A run's report for a person to read. */
export function formatLegacyMoveReport(report: LegacyMoveReport): string {
  const lines = [
    `server ${report.server.slug} (${report.server.id}), by ${report.operator}; frozen since ${report.frozenAt ?? "?"}`,
    report.done ? "  done: every listed Artifact was looked at" : `  NOT done: stopped (${report.stopped ?? "?"}) after ${report.cursor ?? "the start"}; rerun to resume`,
    `  imported: ${report.counts.imported} (author the system identity: ${report.counts.systemAuthor}${report.public ? `; public, anyone with the link: ${report.counts.public}` : ""}${report.approval ? `; on the approval of ${report.approval.approver.name} (${report.approval.approvalRef}): ${report.approval.imported}` : ""})`,
    `  skipped:  ${Object.values(report.counts.skipped).reduce((sum, n) => sum + n, 0)} (${Object.entries(report.counts.skipped).filter(([, n]) => n > 0).map(([reason, n]) => `${reason} ${n}`).join(", ") || "none"})`,
    `  failed:   ${report.counts.failed}`,
    `  comments: ${report.comments.imported} copied onto ${report.comments.pages} page(s)${report.comments.alreadyImported > 0 ? `, ${report.comments.alreadyImported} there before` : ""} (by the system identity: ${report.comments.systemAuthor}); failed on ${report.comments.failed} page(s)`,
  ];
  for (const failed of report.failed) lines.push(`    ${failed.name} (${failed.artifactId}): ${failed.code} ${failed.message}`);
  for (const page of report.imported) {
    if (page.comments?.outcome === "failed") lines.push(`    comments of ${page.name} (${page.artifactId}): ${commentsLine(page.comments)}`);
  }
  return lines.join("\n");
}
