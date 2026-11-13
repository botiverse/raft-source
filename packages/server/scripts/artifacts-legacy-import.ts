#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * Move a server's Artifacts from the standalone app (raft-artifacts.com) into
 * Raft: the operator's side of the per-server move. The runbook (plan → a
 * person approves → run → verify) is in
 * packages/server/src/apps/artifacts/README.md, "Moving a server from
 * raft-artifacts.com"; the work is src/apps/artifacts/legacyBulkImport.ts.
 *
 *   plan --server <id|slug> [--server …] | --servers a,b,c [--public]   read only, writes nothing
 *   run  --server <id|slug> --yes [--public [--approved-by <id|email|handle> --plan-digest <d> --approval-ref <ref>]]
 *   run  --servers a,b,c --yes --public --approved-by <id|email|handle> --plan-digest <d> --approval-ref <ref>
 *        [--max N] [--stop-at <ISO time>] [--state <file>] [--restart] [--operator <name>] [--page-size N] [--report <file>]
 *        [--max-file-mib N]   a file the page only offers to download (not text; not its entry unless the entry is itself a download, an archive) may be up to N MiB (at most 64)
 *   comments plan --servers a,b,c                                   read only, writes nothing
 *   comments run  --servers a,b,c --approved-by <id|email|handle> --plan-digest <d> --approval-ref <ref>
 *        [--operator <name>] [--page-size N] [--report <file>]
 *
 * `run` copies each page's old comments right after importing it (no one is
 * notified; a failure there doesn't fail the page). `comments` does it for
 * pages imported before (by an earlier run, or on demand once the server was
 * frozen): `comments plan` lists each page that stands imported, its comment
 * count, how many authors Raft confirms and how many it doesn't, how many
 * were copied before, and one digest of the whole plan; `comments run`
 * writes them under one approval of that digest by a Raft platform owner or
 * admin, as `--public`'s (src/apps/artifacts/legacyComments.ts).
 *
 * `--public` (opt-in): Artifacts public on raft-artifacts.com are imported
 * too, into the server's public home (anyone with the link), where Raft's
 * rule for making an Artifact public allows it for their author; the plan
 * lists each one apart, with its digest, and over several servers one
 * digest of them all. `--approved-by` (a Raft platform owner or admin: a
 * human owner or admin of Botiverse), `--plan-digest` (that plan's) and
 * `--approval-ref` (the Raft message that approves it), all three: the
 * public ones only their author keeps from being public (an agent's, the
 * system identity's) are kept public too, on that approval.
 *
 * Servers are always named: there is no "every server". `run` takes one
 * server, or several under one approval of their combined plan (moved one
 * after the other, each with its default state file); without `--yes` it
 * prints the plan and stops. The report is JSON on stdout (and in
 * `--report`); the human summary and per-Artifact lines go to stderr.
 *
 * Needs DATABASE_URL, ARTIFACTS_LEGACY_IMPORT_URL / _TOKEN, the platform's
 * app-content bucket (APP_STORAGE_R2_*) and APP_URL, as the server has them.
 */
import { writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";
import { closeDatabase, getDb, initDatabase } from "../src/db/index";
import { servers } from "../src/db/schema";
import { firstPartyApps } from "../src/apps/firstPartyApps";
import { ARTIFACT_OPS_IMPORT_MAX_FILE_BYTES } from "../src/apps/artifacts/import";
import {
  fileLegacyMoveStateStore,
  formatLegacyCommentsPlan,
  formatLegacyCommentsReport,
  formatLegacyMovePlan,
  formatLegacyMovePublicSet,
  formatLegacyMoveReport,
  legacyMovePublicSet,
  planLegacyComments,
  planLegacyMove,
  runLegacyComments,
  runLegacyMoves,
  type LegacyMovePlan,
  type LegacyMoveServer,
} from "../src/apps/artifacts/legacyBulkImport";

export type LegacyImportCommand =
  | { command: "plan"; servers: string[]; pageSize?: number; public?: true }
  | { command: "comments"; action: "plan"; servers: string[]; pageSize?: number }
  | {
    command: "comments";
    action: "run";
    servers: string[];
    approval: { approvedBy: string; planDigest: string; approvalRef: string };
    operator?: string;
    pageSize?: number;
    report?: string;
  }
  | {
    command: "run";
    /** One, or several under one approval. */
    servers: string[];
    yes: boolean;
    public?: true;
    approval?: { approvedBy: string; planDigest: string; approvalRef: string };
    max?: number;
    stopAt?: Date;
    state?: string;
    restart: boolean;
    operator?: string;
    pageSize?: number;
    report?: string;
    /** --max-file-mib: a download's file limit raised to this many MiB for this run. */
    maxFileMib?: number;
  };

const USAGE = `Usage:
  pnpm --filter @botiverse/raft-server db:artifacts-legacy-import -- plan --server <id|slug> [--server …] | --servers a,b,c [--public] [--page-size N]
  pnpm --filter @botiverse/raft-server db:artifacts-legacy-import -- run --server <id|slug> --yes [--public [--approved-by <id|email|handle> --plan-digest <d> --approval-ref <ref>]] [--max N] [--stop-at <ISO time>]
      [--state <file>] [--restart] [--operator <name>] [--page-size N] [--report <file>] [--max-file-mib N]
  pnpm --filter @botiverse/raft-server db:artifacts-legacy-import -- run --servers a,b,c --yes --public --approved-by <id|email|handle> --plan-digest <d> --approval-ref <ref> [--max N] [--stop-at <ISO time>]
      [--restart] [--operator <name>] [--page-size N] [--report <file>] [--max-file-mib N]
  pnpm --filter @botiverse/raft-server db:artifacts-legacy-import -- comments plan --server <id|slug> [--server …] | --servers a,b,c [--page-size N]
  pnpm --filter @botiverse/raft-server db:artifacts-legacy-import -- comments run --servers a,b,c --approved-by <id|email|handle> --plan-digest <d> --approval-ref <ref>
      [--operator <name>] [--page-size N] [--report <file>]`;

const positiveInteger = (flag: string, value: string | undefined): number => {
  const n = Number(value);
  if (!value || !Number.isSafeInteger(n) || n < 1) throw new Error(`${flag} is a positive integer`);
  return n;
};

/** `comments plan|run`: the old comments of pages already imported. */
function parseCommentsArgs(args: string[]): LegacyImportCommand {
  const action = args.shift();
  if (action !== "plan" && action !== "run") throw new Error(`comments is comments plan or comments run\n${USAGE}`);
  const named: string[] = [];
  let approvedBy: string | undefined;
  let planDigest: string | undefined;
  let approvalRef: string | undefined;
  let operator: string | undefined;
  let pageSize: number | undefined;
  let report: string | undefined;
  const runOnly = (flag: string) => {
    if (action !== "run") throw new Error(`${flag} is for comments run only`);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = () => {
      const next = args[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--server") named.push(value());
    else if (arg === "--servers") named.push(...value().split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg === "--all-servers") throw new Error("--all-servers is not supported: name each server (--server, --servers a,b,c); an approval names the servers it covers");
    else if (arg === "--page-size") pageSize = positiveInteger(arg, value());
    else if (arg === "--approved-by") { runOnly(arg); approvedBy = value(); }
    else if (arg === "--plan-digest") { runOnly(arg); planDigest = value(); }
    else if (arg === "--approval-ref") { runOnly(arg); approvalRef = value(); }
    else if (arg === "--operator") { runOnly(arg); operator = value(); }
    else if (arg === "--report") { runOnly(arg); report = value(); }
    else throw new Error(`unknown argument for comments ${action}: ${arg}\n${USAGE}`);
  }
  const servers = [...new Set(named)];
  if (servers.length === 0) throw new Error(`name the server(s): --server <id|slug> or --servers a,b,c\n${USAGE}`);
  if (action === "plan") return { command: "comments", action, servers, ...(pageSize ? { pageSize } : {}) };
  if (approvedBy === undefined || planDigest === undefined || approvalRef === undefined) {
    throw new Error("comments run needs --approved-by, --plan-digest and --approval-ref (all three): the approval of a comments plan");
  }
  return {
    command: "comments", action, servers, approval: { approvedBy, planDigest, approvalRef },
    ...(operator ? { operator } : {}), ...(pageSize ? { pageSize } : {}), ...(report ? { report } : {}),
  };
}

export function parseLegacyImportArgs(argv: readonly string[]): LegacyImportCommand {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const command = args.shift();
  if (command === "comments") return parseCommentsArgs(args);
  if (command !== "plan" && command !== "run") throw new Error(`the command is plan, run or comments\n${USAGE}`);
  const named: string[] = [];
  let yes = false;
  let restart = false;
  let includePublic = false;
  let approvedBy: string | undefined;
  let planDigest: string | undefined;
  let approvalRef: string | undefined;
  let max: number | undefined;
  let stopAt: Date | undefined;
  let state: string | undefined;
  let operator: string | undefined;
  let pageSize: number | undefined;
  let report: string | undefined;
  let maxFileMib: number | undefined;
  const runOnly = (flag: string) => {
    if (command !== "run") throw new Error(`${flag} is for run only`);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = () => {
      const next = args[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--server") named.push(value());
    else if (arg === "--servers") named.push(...value().split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg === "--all-servers") throw new Error("--all-servers is not supported: name each server (--server, --servers a,b,c); an approval names the servers it covers");
    else if (arg === "--page-size") pageSize = positiveInteger(arg, value());
    else if (arg === "--public") includePublic = true;
    else if (arg === "--approved-by") { runOnly(arg); approvedBy = value(); }
    else if (arg === "--plan-digest") { runOnly(arg); planDigest = value(); }
    else if (arg === "--approval-ref") { runOnly(arg); approvalRef = value(); }
    else if (arg === "--yes") { runOnly(arg); yes = true; }
    else if (arg === "--restart") { runOnly(arg); restart = true; }
    else if (arg === "--max") { runOnly(arg); max = positiveInteger(arg, value()); }
    else if (arg === "--stop-at") {
      runOnly(arg);
      const raw = value();
      stopAt = new Date(raw);
      if (Number.isNaN(stopAt.getTime())) throw new Error("--stop-at is a date and time (ISO 8601, e.g. 2026-10-27T06:00:00Z)");
    } else if (arg === "--state") { runOnly(arg); state = value(); }
    else if (arg === "--operator") { runOnly(arg); operator = value(); }
    else if (arg === "--report") { runOnly(arg); report = value(); }
    else if (arg === "--max-file-mib") {
      runOnly(arg);
      maxFileMib = positiveInteger(arg, value());
      if (maxFileMib * MIB > ARTIFACT_OPS_IMPORT_MAX_FILE_BYTES) throw new Error(`--max-file-mib is at most ${ARTIFACT_OPS_IMPORT_MAX_FILE_BYTES / MIB}`);
    }
    else throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  const unique = [...new Set(named)];
  if (unique.length === 0) throw new Error(`name the server(s): --server <id|slug> or --servers a,b,c\n${USAGE}`);
  const publicFlag = includePublic ? { public: true as const } : {};
  const approvalParts = [approvedBy, planDigest, approvalRef].filter((part) => part !== undefined).length;
  if (approvalParts > 0 && approvalParts < 3) throw new Error("--approved-by, --plan-digest and --approval-ref go together (all three)");
  if (approvalParts === 3 && !includePublic) throw new Error("--approved-by is for --public only");
  const approval = approvalParts === 3 ? { approval: { approvedBy: approvedBy!, planDigest: planDigest!, approvalRef: approvalRef! } } : {};
  if (command === "plan") return { command, servers: unique, ...(pageSize ? { pageSize } : {}), ...publicFlag };
  if (unique.length > 1 && approvalParts !== 3) {
    throw new Error("run moves one server at a time: name exactly one --server, or several (--servers a,b,c) under one approval of their combined plan (--public --approved-by --plan-digest --approval-ref)");
  }
  if (unique.length > 1 && state) throw new Error("--state is one server's state file: with several servers each keeps its default file (artifacts-legacy-import-<server id>.state.json)");
  return {
    command, servers: unique, yes, restart, ...publicFlag, ...approval,
    ...(max ? { max } : {}), ...(stopAt ? { stopAt } : {}), ...(state ? { state } : {}),
    ...(operator ? { operator } : {}), ...(pageSize ? { pageSize } : {}), ...(report ? { report } : {}),
    ...(maxFileMib ? { maxFileMib } : {}),
  };
}

const MIB = 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Raft server by id or slug. */
async function resolveServer(ref: string): Promise<LegacyMoveServer> {
  const column = UUID.test(ref) ? servers.id : servers.slug;
  const [row] = await getDb().select({ id: servers.id, slug: servers.slug }).from(servers).where(eq(column, UUID.test(ref) ? ref : ref.toLowerCase())).limit(1);
  if (!row) throw new Error(`no Raft server ${ref}`);
  return { id: asServerId(row.id), slug: row.slug };
}

async function main(): Promise<void> {
  const parsed = parseLegacyImportArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  await initDatabase(url, undefined, { log: () => {} });
  // Reading the app registry is what hands Artifacts its object storage (the app-content bucket), as in the server.
  firstPartyApps();
  try {
    const includePublic = parsed.command !== "comments" && parsed.public === true;
    const planAll = async (refs: readonly LegacyMoveServer[]) => {
      const plans: LegacyMovePlan[] = [];
      for (const server of refs) {
        const plan = await planLegacyMove(server, { pageSize: parsed.pageSize, public: includePublic });
        console.error(formatLegacyMovePlan(plan));
        plans.push(plan);
      }
      // Several servers' public plans: the one digest an approval of them all names.
      const publicSet = includePublic && plans.length > 1 ? legacyMovePublicSet(plans) : null;
      if (publicSet) console.error(`\n${formatLegacyMovePublicSet(publicSet)}`);
      return { plans, ...(publicSet ? { publicSet } : {}) };
    };
    const resolved: LegacyMoveServer[] = [];
    for (const ref of parsed.servers) resolved.push(await resolveServer(ref));
    if (parsed.command === "comments") {
      if (parsed.action === "plan") {
        const set = await planLegacyComments(resolved, { pageSize: parsed.pageSize });
        console.error(formatLegacyCommentsPlan(set));
        console.log(JSON.stringify({ mode: "comments-plan", ...set }, null, 2));
        return;
      }
      const report = await runLegacyComments(resolved, {
        approval: parsed.approval,
        operator: parsed.operator ?? process.env.USER ?? "",
        pageSize: parsed.pageSize,
        log: (line) => console.error(line),
      });
      const json = JSON.stringify({ mode: "comments-run", report }, null, 2);
      if (parsed.report) await writeFile(parsed.report, `${json}\n`, "utf8");
      console.error(`\n${formatLegacyCommentsReport(report)}`);
      console.log(json);
      if (report.counts.failed > 0) process.exitCode = 1;
      return;
    }
    if (parsed.command === "plan") {
      console.log(JSON.stringify({ mode: "plan", ...(await planAll(resolved)) }, null, 2));
      return;
    }
    if (!parsed.yes) {
      const planned = await planAll(resolved);
      const privateCount = planned.plans.reduce((sum, plan) => sum + plan.toImport.count, 0);
      const publicCount = parsed.public
        ? ` and ${planned.plans.reduce((sum, plan) => sum + plan.public!.toImport.count + (parsed.approval ? plan.public!.withApproval.count : 0), 0)} public one(s) (anyone with the link)`
        : "";
      console.error(`\nnothing done. To freeze ${resolved.map((server) => server.slug).join(", ")} in raft-artifacts.com and import ${privateCount} Artifact(s)${publicCount}, run again with --yes.`);
      console.log(JSON.stringify({ mode: "plan", ...planned }, null, 2));
      return;
    }
    const operator = parsed.operator ?? process.env.USER ?? "";
    let stopRequested = false;
    const onSignal = () => {
      if (stopRequested) process.exit(130);
      stopRequested = true;
      console.error("stopping after the current Artifact (again to quit at once; rerun resumes)");
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    const result = await runLegacyMoves(resolved, {
      operator,
      stateOf: (server) => fileLegacyMoveStateStore(parsed.state ?? `artifacts-legacy-import-${server.id}.state.json`),
      max: parsed.max,
      stopAt: parsed.stopAt,
      restart: parsed.restart,
      public: parsed.public === true,
      ...(parsed.approval ? { approval: parsed.approval } : {}),
      pageSize: parsed.pageSize,
      ...(parsed.maxFileMib ? { maxFileBytes: parsed.maxFileMib * MIB } : {}),
      shouldStop: () => stopRequested,
      log: (line) => console.error(line),
    });
    // One server: its report, as before; several: each one's, and the ones not started.
    const output = resolved.length === 1
      ? { mode: "run", report: result.reports[0]! }
      : { mode: "run", reports: result.reports, notStarted: result.notStarted, stopped: result.stopped };
    const json = JSON.stringify(output, null, 2);
    if (parsed.report) await writeFile(parsed.report, `${json}\n`, "utf8");
    for (const report of result.reports) console.error(`\n${formatLegacyMoveReport(report)}`);
    if (result.notStarted.length > 0) console.error(`\nnot started (stopped: ${result.stopped}): ${result.notStarted.map((server) => server.slug).join(", ")}; rerun the same way to go on`);
    console.log(json);
    // A page that failed, or whose old comments weren't copied (the page stands; `comments run` copies them).
    if (result.reports.some((report) => report.failed.length > 0 || report.comments.failed > 0)) process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
