/** Read-only comparison of the staged 081 generation; never switches serving. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import pg from "pg";

export interface ParityRow {
  surface: string;
  receiver_id: string;
  server_id: string;
  target_id: string;
  joint_family: boolean;
  guest_entry: boolean;
  copy_channel_id: string | null;
  copy_cursor_present: boolean;
  old_unread: string | number | null;
  new_unread: string | number | null;
  old_mentions: string | number | null;
  new_mentions: string | number | null;
  old_present: boolean;
  new_present: boolean;
}
export interface Expectation {
  metric: "unread" | "mention";
  receiverId: string;
  serverId: string;
  targetId: string;
}
const count = (value: string | number | null | undefined) => BigInt(value ?? 0);
const rowKey = (row: ParityRow) => `${row.receiver_id}/${row.server_id}/${row.target_id}`;

export function evaluateParity(rows: ParityRow[], expectations: Expectation[]) {
  const changes = rows.filter((row) => row.old_present !== row.new_present
    || count(row.old_unread) !== count(row.new_unread)
    || count(row.old_mentions) !== count(row.new_mentions));
  const entryChanges = changes.filter((row) => !row.surface.startsWith("totals"));
  const nonJointChanges = entryChanges.filter((row) => !row.joint_family);
  const guestChanges = entryChanges.filter((row) => row.guest_entry);
  const totalsMismatches: Array<{ key: string; generation: "old" | "new" }> = [];
  const totals = new Map(rows.filter((row) => row.surface === "totals").map((row) => [rowKey(row), row]));
  const derived = new Map(rows.filter((row) => row.surface === "totals-derived").map((row) => [rowKey(row), row]));
  for (const key of new Set([...totals.keys(), ...derived.keys()])) {
    for (const generation of ["old", "new"] as const) {
      if (count(totals.get(key)?.[`${generation}_unread`]) !== count(derived.get(key)?.[`${generation}_unread`])) {
        totalsMismatches.push({ key, generation });
      }
    }
  }
  const expectationFailures = expectations.filter((expected) =>
    !(expected.metric === "unread" ? ["conversation", "activity"] : ["mention", "activity"]).every((surface) =>
      rows.some((row) => row.surface === surface
        && rowKey(row) === `${expected.receiverId}/${expected.serverId}/${expected.targetId}`
        && row.joint_family && row.new_present
        && count(expected.metric === "unread" ? row.new_unread : row.new_mentions) > 0)));
  return {
    nonJointChanges, guestChanges, totalsMismatches, expectationFailures,
    jointChanges: entryChanges.filter((row) => row.joint_family),
    passed: expectations.length > 0 && nonJointChanges.length === 0 && guestChanges.length === 0
      && totalsMismatches.length === 0 && expectationFailures.length === 0,
  };
}

/** User-visible burst at the switch: sum positive row deltas separately from
 * removed rows, so one lost entry cannot hide a large newly unread entry. */
export function summarizeGrowth(rows: ParityRow[], receiverIds: string[]) {
  const users = [...new Set(receiverIds)].sort().map((receiverId) => {
    let unreadAdded = 0n, unreadRemoved = 0n, mentionsAdded = 0n, mentionsRemoved = 0n;
    const affectedCopies = new Set<string>();
    const copiesWithoutCursor = new Set<string>();
    for (const row of rows) {
      if (row.receiver_id !== receiverId || !row.joint_family) continue;
      const increases = (row.surface === "conversation" && count(row.new_unread) > count(row.old_unread))
        || (row.surface === "mention" && count(row.new_mentions) > count(row.old_mentions));
      if (increases && row.copy_channel_id) {
        affectedCopies.add(row.copy_channel_id);
        if (!row.copy_cursor_present) copiesWithoutCursor.add(row.copy_channel_id);
      }
      if (row.surface === "conversation") {
        const delta = count(row.new_unread) - count(row.old_unread);
        if (delta > 0n) unreadAdded += delta; else unreadRemoved -= delta;
      } else if (row.surface === "mention") {
        const delta = count(row.new_mentions) - count(row.old_mentions);
        if (delta > 0n) mentionsAdded += delta; else mentionsRemoved -= delta;
      }
    }
    return { receiverId, unreadAdded: unreadAdded.toString(), unreadRemoved: unreadRemoved.toString(),
      mentionsAdded: mentionsAdded.toString(), mentionsRemoved: mentionsRemoved.toString(),
      affectedCopyCount: affectedCopies.size, copiesWithoutCursor: [...copiesWithoutCursor].sort() };
  });
  const distribution = (metric: "unreadAdded" | "mentionsAdded") => {
    const values = users.map((user) => BigInt(user[metric]));
    return { maximum: values.reduce((max, n) => n > max ? n : max, 0n).toString(),
      zero: values.filter((n) => n === 0n).length,
      oneToNine: values.filter((n) => n > 0n && n < 10n).length,
      tenToNinetyNine: values.filter((n) => n >= 10n && n < 100n).length,
      hundredTo499: values.filter((n) => n >= 100n && n < 500n).length,
      atLeast500: values.filter((n) => n >= 500n).length };
  };
  return { users, unread: distribution("unreadAdded"), mentions: distribution("mentionsAdded"),
    affectedPeopleWithoutCopyCursor: users.filter((user) => user.copiesWithoutCursor.length > 0).length,
    affectedCopiesWithoutCursor: users.reduce((sum, user) => sum + user.copiesWithoutCursor.length, 0) };
}

async function main() {
  const ids: string[] = [];
  const expectations: Expectation[] = [];
  let output: string | undefined;
  const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
  for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i], value = process.argv[++i];
    if (flag === "--receiver-id" && value && uuid.test(value)) ids.push(value.toLowerCase());
    else if (flag === "--out" && value) output = value;
    else if ((flag === "--expect-unread" || flag === "--expect-mention") && value) {
      const parts = value.toLowerCase().split("/");
      if (parts.length !== 3 || !parts.every((part) => uuid.test(part))) throw new Error("Expectation needs user/server/target UUIDs");
      expectations.push({ metric: flag === "--expect-unread" ? "unread" : "mention", receiverId: parts[0]!, serverId: parts[1]!, targetId: parts[2]! });
    } else throw new Error("Usage: ops:rw-joint-member-parity --receiver-id <uuid> --expect-unread <user/server/target> [--expect-mention <user/server/target>] --out <receipt.json>");
  }
  if (!ids.length || ids.length > 25 || !output || !expectations.length) throw new Error("Provide 1–25 receiver ids, a positive joint-copy expectation and an output file");
  if (expectations.some((expected) => !ids.includes(expected.receiverId))) throw new Error("Every expected user must be in the sample");
  const readQuery = (name: string) => readFileSync(new URL(`../../../infra/risingwave/sql/081-computed-joint-members/${name}.sql`, import.meta.url), "utf8");
  const query = readQuery("parity");
  const diagnosticsQuery = readQuery("membership-diagnostics");
  const url = process.env.RISINGWAVE_DATABASE_URL;
  if (!url) throw new Error("RISINGWAVE_DATABASE_URL is required (never printed)");
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: 30000 });
  try {
    await client.connect();
    const startedAt = new Date().toISOString();
    // One statement observes both generations and their totals. The diagnostics
    // are a separate read: retain timestamps and repeat after CDC settles.
    const result = await client.query<ParityRow>(query, [ids]);
    const diagnostics = await client.query(diagnosticsQuery, [ids]);
    const evaluation = evaluateParity(result.rows, expectations);
    const guestComparison = ["conversation", "activity", "mention"].map((surface) => {
      const guestRows = result.rows.filter((row) => row.surface === surface && row.guest_entry);
      return { surface, oldRows: guestRows.filter((row) => row.old_present).length,
        newRows: guestRows.filter((row) => row.new_present).length,
        oldUnread: guestRows.reduce((sum, row) => sum + count(row.old_unread), 0n).toString(),
        newUnread: guestRows.reduce((sum, row) => sum + count(row.new_unread), 0n).toString(),
        oldMentions: guestRows.reduce((sum, row) => sum + count(row.old_mentions), 0n).toString(),
        newMentions: guestRows.reduce((sum, row) => sum + count(row.new_mentions), 0n).toString() };
    });
    const report = {
      schemaVersion: 1, startedAt, completedAt: new Date().toISOString(),
      gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      querySha256: createHash("sha256").update(query).digest("hex"),
      diagnosticsSha256: createHash("sha256").update(diagnosticsQuery).digest("hex"),
      receiverIds: ids, expectations, evaluation, guestComparison, growth: summarizeGrowth(result.rows, ids), rows: result.rows, membershipDiagnostics: diagnostics.rows,
      // A pass is data evidence only. Operators still inspect current PG flag
      // state for strict_excluded candidates and approve the separate switch PR.
    };
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ receipt: output, receiverCount: ids.length, passed: evaluation.passed,
      nonJointChanges: evaluation.nonJointChanges.length, guestChanges: evaluation.guestChanges.length,
      totalsMismatches: evaluation.totalsMismatches.length, expectationFailures: evaluation.expectationFailures.length,
      strictExcludedEntries: diagnostics.rows.filter((row) => row.strict_excluded).length,
      retainedGuestEntries: diagnostics.rows.filter((row) => row.legacy_guest_retained).length }));
    if (!evaluation.passed) process.exitCode = 1;
  } catch {
    // Database errors can contain connection details. Do not print them.
    console.error("RisingWave parity read failed; no serving state was changed.");
    process.exitCode = 1;
  } finally { await client.end().catch(() => {}); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
