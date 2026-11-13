#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * Take a workspace Artifact down, or restore it, as a Raft operator: the
 * operator's side of src/apps/artifacts/takedown.ts (the same function the
 * server owners' and admins' route calls; here as the moderation ops actor,
 * ARTIFACT_OPS_MODERATION_ACTOR, with `ops: { operator }` in the audit row).
 * `--operator` defaults to $USER, a self-reported name: pass your real name. Runbook:
 * docs/operations/artifact-takedown.md.
 *
 *   show     --artifact <pt_…|short id|link>                       read only
 *   takedown --artifact <pt_…|short id|link> --reason <text> [--operator <name>]
 *   restore  --artifact <pt_…|short id|link> --reason <text> [--operator <name>]
 *   purge    --artifact <pt_…|short id|link> --reason <text>
 *            [--apply --approval-reference <message> --run-id <id> --accountable-user-id <uuid>]
 *
 * Both writes are idempotent (`changed: false` when it already was). The
 * answer is JSON on stdout: the Artifact's state and its audit rows.
 *
 * `purge` removes the Artifact for good (src/apps/artifacts/purge.ts
 * purgeArtifact): every version, file, comment, review, audit row, search
 * row, Activity row and object event, its screenshots and comment images,
 * and the bytes of its blobs no other Artifact of its server uses, in one
 * transaction (no takedown needed first). As the other gated ops scripts
 * (scripts/request-account-deletion.ts): without `--apply` it only plans,
 * saying what would go and writing nothing; `--apply` writes, to the
 * primary only (a replica is refused), and only with `--approval-reference`
 * (the human approval message), `--run-id` and `--accountable-user-id` (the
 * human who approved it: an active user, never an agent, not whoever runs
 * the command). Those three are for `--apply` only. It leaves one record
 * (`app_artifacts.purges`: only the counts and the reason, which must not
 * repeat the content) that `show` prints afterwards; who ran and approved
 * it are in the stdout receipt ([OPS_ARTIFACT_PURGE_START] and _DONE, JSON),
 * which the runbook keeps in the approval thread. Run again, it writes
 * nothing new and retries the storage deletes that failed. `--apply` needs
 * the app-content bucket (APP_STORAGE_R2_*), as the server has it.
 *
 * Needs DATABASE_URL, as the server has it (who may run it: whoever holds
 * the production database credentials, as for db:artifacts-legacy-import).
 */
import { asc, eq, sql } from "drizzle-orm";
import { parseArtifactRef } from "@botiverse/raft-shared";
import { closeDatabase, getDb, initDatabase } from "../src/db/index";
import { users } from "../src/db/schema";
import { firstPartyApps } from "../src/apps/firstPartyApps";
import { artifactR2Store } from "../src/apps/artifacts/blobStore";
import { ARTIFACT_OPS_MODERATION_ACTOR } from "../src/apps/artifacts/import";
import { planArtifactPurge, purgeArtifact } from "../src/apps/artifacts/purge";
import { artifactAudit, artifactItems, artifactPurges } from "../src/apps/artifacts/schema";
import { restoreArtifact, takedownAnswer, takedownArtifact, takedownReason } from "../src/apps/artifacts/takedown";

export type TakedownCommand =
  | { command: "show"; artifact: string }
  | { command: "takedown" | "restore"; artifact: string; reason: string; operator?: string }
  /** `apply`: purge it, with the approval, the run id and the accountable human (all three, only then); without it, only what would go. */
  | { command: "purge"; artifact: string; reason: string; apply: false }
  | { command: "purge"; artifact: string; reason: string; apply: true; approvalReference: string; runId: string; accountableUserId: string };

const USAGE = `Usage:
  pnpm --filter @botiverse/raft-server db:artifacts-takedown -- show --artifact <pt_…|short id|link>
  pnpm --filter @botiverse/raft-server db:artifacts-takedown -- takedown --artifact <pt_…|short id|link> --reason <text> [--operator <name>]
  pnpm --filter @botiverse/raft-server db:artifacts-takedown -- restore --artifact <pt_…|short id|link> --reason <text> [--operator <name>]
  pnpm --filter @botiverse/raft-server db:artifacts-takedown -- purge --artifact <pt_…|short id|link> --reason <text>
    [--apply --approval-reference <the human approval message> --run-id <id> --accountable-user-id <the approver's user id>]`;

const ARTIFACT_ID = /pt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const PURGE_TAG = "OPS_ARTIFACT_PURGE";

export function parseTakedownArgs(argv: readonly string[]): TakedownCommand {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const command = args.shift();
  if (command !== "show" && command !== "takedown" && command !== "restore" && command !== "purge") throw new Error(`the command is show, takedown, restore or purge\n${USAGE}`);
  let artifact: string | undefined;
  let reason: string | undefined;
  let operator: string | undefined;
  let apply = false;
  let approvalReference: string | undefined;
  let runId: string | undefined;
  let accountableUserId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    // --apply is purge's only flag without a value.
    if (arg === "--apply" && command === "purge") {
      apply = true;
      continue;
    }
    const next = args[++i];
    if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value\n${USAGE}`);
    if (arg === "--artifact") {
      // `pt_<uuid>` anywhere in it, else what the shared parser reads as an id (a short id, a link with one).
      const parsed = parseArtifactRef(next);
      const id = ARTIFACT_ID.exec(next)?.[0].toLowerCase() ?? (parsed.kind === "id" ? parsed.id : undefined);
      if (!id) throw new Error("--artifact is an Artifact id (pt_<uuid> or its short id) or a link that has one");
      artifact = id;
    } else if (arg === "--reason" && command !== "show") reason = next;
    // A purge's people are the approval's (--accountable-user-id), not a self-reported name.
    else if (arg === "--operator" && command !== "show" && command !== "purge") operator = next;
    else if (arg === "--approval-reference" && command === "purge") approvalReference = next;
    else if (arg === "--run-id" && command === "purge") runId = next;
    else if (arg === "--accountable-user-id" && command === "purge") accountableUserId = next;
    else throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  if (!artifact) throw new Error(`name the Artifact: --artifact <pt_…|short id|link>\n${USAGE}`);
  if (command === "show") return { command, artifact };
  const recorded = takedownReason(reason);
  if (recorded === null) throw new Error(`--reason is required: 1 to 1000 characters (it goes in the ${command === "purge" ? "purge record" : "audit row"})`);
  if (command !== "purge") return { command, artifact, reason: recorded, ...(operator ? { operator } : {}) };
  // A purge can't be undone: it writes only with the approval, the run id and the accountable human, as the other gated ops scripts.
  if (!apply) {
    if (approvalReference !== undefined || runId !== undefined || accountableUserId !== undefined) {
      throw new Error("--approval-reference, --run-id and --accountable-user-id are only for --apply: nothing was purged");
    }
    return { command, artifact, reason: recorded, apply: false };
  }
  if (!approvalReference?.trim()) throw new Error("--apply requires --approval-reference <the human approval message>: nothing was purged");
  if (!RUN_ID.test(runId ?? "")) throw new Error("--apply requires --run-id <id> ([A-Za-z0-9._:-], at most 100): nothing was purged");
  if (!UUID.test(accountableUserId ?? "")) {
    throw new Error("--apply requires --accountable-user-id <the user id of the human who approved it> (never an agent, not whoever runs the command): nothing was purged");
  }
  return { command, artifact, reason: recorded, apply: true, approvalReference: approvalReference.trim(), runId: runId!, accountableUserId: accountableUserId!.toLowerCase() };
}

/** `--apply` writes to the primary only: the refusal for a replica, else null. */
export function checkPurgeEndpoint(apply: boolean, inRecovery: boolean): string | null {
  return apply && inRecovery ? "--apply writes to the primary: DATABASE_URL is a replica; nothing was purged" : null;
}

/** A purged Artifact's record, or null. */
async function purgeRecordOf(artifact: string) {
  const [row] = await getDb().select().from(artifactPurges).where(eq(artifactPurges.itemId, artifact)).limit(1);
  return row
    ? { at: row.createdAt.toISOString(), reason: row.reason, serverId: row.serverId, removed: row.removed, pendingObjectKeys: row.pendingObjectKeys.length }
    : null;
}

async function stateOf(artifact: string) {
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, artifact)).limit(1);
  if (!item) {
    // Purged: only its record is left.
    const purged = await purgeRecordOf(artifact);
    if (purged) return { id: artifact, purged };
    throw new Error(`no Artifact ${artifact}`);
  }
  const audit = await getDb().select().from(artifactAudit).where(eq(artifactAudit.itemId, artifact)).orderBy(asc(artifactAudit.id));
  return {
    id: item.id,
    serverId: item.serverId,
    title: item.title,
    home: item.homeKind,
    takenDown: item.revokedAt !== null,
    revokedAt: item.revokedAt?.toISOString() ?? null,
    deleted: item.deletedAt !== null,
    audit: audit.map((row) => ({
      at: row.createdAt.toISOString(),
      action: row.action,
      // An operator's takedown or restore reads as such; anyone else by type and id.
      actor: row.actorType === ARTIFACT_OPS_MODERATION_ACTOR.type && row.actorId === ARTIFACT_OPS_MODERATION_ACTOR.id ? "ops:moderation" : `${row.actorType}:${row.actorId}`,
      before: row.before,
      after: row.after,
    })),
  };
}

async function main(): Promise<void> {
  const parsed = parseTakedownArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  await initDatabase(url, undefined, { log: () => {} });
  try {
    if (parsed.command === "show") {
      console.log(JSON.stringify(await stateOf(parsed.artifact), null, 2));
      return;
    }
    if (parsed.command === "purge") {
      await purge(parsed);
      return;
    }
    const operator = parsed.operator ?? process.env.USER ?? "";
    if (!operator) throw new Error("name the operator: --operator <name> (recorded in the audit row)");
    const act = parsed.command === "takedown" ? takedownArtifact : restoreArtifact;
    const outcome = await act({ kind: "ops", operator }, parsed.artifact, parsed.reason);
    if (outcome.kind !== "done") throw new Error(outcome.kind === "name_taken"
      ? `another live Artifact of its home is named ${outcome.name}: rename or move one first`
      : `no Artifact ${parsed.artifact}`);
    console.log(JSON.stringify({ result: takedownAnswer(outcome), state: await stateOf(parsed.artifact) }, null, 2));
  } finally {
    await closeDatabase();
  }
}

/**
 * `purge`: what would go (no `--apply`), else, on the primary, with the
 * accountable human checked, the purge and its record, between the
 * receipt's _START and _DONE lines.
 */
async function purge(parsed: Extract<TakedownCommand, { command: "purge" }>): Promise<void> {
  const { rows: [endpoint] } = await getDb().execute<{ replica: boolean }>(sql`SELECT pg_is_in_recovery() AS replica`);
  const refusal = checkPurgeEndpoint(parsed.apply, endpoint?.replica === true);
  if (refusal) throw new Error(refusal);
  if (!parsed.apply) {
    const plan = await planArtifactPurge(parsed.artifact);
    console.log(JSON.stringify(plan ? { wouldPurge: { id: parsed.artifact, ...plan } } : { wouldPurge: null, purged: await purgeRecordOf(parsed.artifact) }, null, 2));
    if (plan) console.error(`\nnothing purged (a plan). To remove ${parsed.artifact} and everything of it for good, run it again on the primary with --apply --approval-reference <message> --run-id <id> --accountable-user-id <approver>`);
    return;
  }
  const [accountable] = await getDb().select({ retiredAt: users.retiredAt }).from(users).where(eq(users.id, parsed.accountableUserId));
  if (!accountable || accountable.retiredAt) throw new Error(`--accountable-user-id ${parsed.accountableUserId} is not an active (human) user: nothing was purged`);
  // Reading the app registry is what hands Artifacts its object storage (the app-content bucket), as in the server.
  firstPartyApps();
  const store = artifactR2Store();
  if (!store) throw new Error("the app-content bucket isn't configured here (APP_STORAGE_R2_*), so the Artifact's files couldn't be deleted: run it with the server's environment; nothing was purged");
  const receipt = { artifact: parsed.artifact, runId: parsed.runId, approvalReference: parsed.approvalReference, accountableUserId: parsed.accountableUserId };
  console.log(`[${PURGE_TAG}_START] ${JSON.stringify({ ...receipt, mode: "apply", replica: endpoint?.replica ?? null, startedAt: new Date().toISOString() })}`);
  const outcome = await purgeArtifact(parsed.artifact, parsed.reason, store);
  if (outcome.kind === "not_found") throw new Error(`no Artifact ${parsed.artifact}, and none was purged`);
  console.log(`[${PURGE_TAG}_DONE] ${JSON.stringify({ ...receipt, changed: outcome.changed, purged: outcome.record })}`);
  if (outcome.record.pendingObjectKeys.length > 0) {
    console.error(`\n${outcome.record.pendingObjectKeys.length} stored file(s) couldn't be deleted yet: run the same command again to retry them`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
