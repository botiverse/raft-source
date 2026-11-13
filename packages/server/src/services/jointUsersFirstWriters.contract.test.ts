import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "vitest";
import ts from "typescript";
import { JOINT_USERS_FIRST_ENTRY_POINTS, JOINT_USERS_FIRST_KNOWN_EXCEPTIONS, JOINT_WRITE_TABLES } from "../test/jointUsersFirstEntryPoints";

/**
 * Reverse coverage of the users-first lock rule (lockJointUsersFirst,
 * jointHumanMembershipMirror.ts). The real-PG guard
 * (jointUsersFirstLockOrder.realPg.test.ts) checks the entry points it knows;
 * this test finds every writer it might not know.
 *
 * It reads the TypeScript syntax tree of every production file under src/:
 *   1. A write is `<x>.insert(T)` or `<x>.delete(T)` for a table T in
 *      JOINT_WRITE_TABLES; `<x>.update(T)` when its `.set({...})` may write a
 *      column with a foreign key to users or one that changes membership or a
 *      connection (MEMBERSHIP_COLUMNS), or its keys are not all written out;
 *      or SQL text with `insert into`, `update` or `delete from` and T's name.
 *   2. Its nearest named function (declaration, method, or a const/property
 *      holding a function) is keyed `file#function#table`, and must be in
 *      WRITERS: `covered:<entry point>` (it runs in a transaction of a
 *      JOINT_USERS_FIRST_ENTRY_POINTS scenario, which the guard holds to the
 *      rule), `known:<exception>` (JOINT_USERS_FIRST_KNOWN_EXCEPTIONS, an
 *      expected failure in the guard), or `exempt: <why>` (not a joint
 *      membership or connection transaction acting for a person, or an open
 *      follow-up named as such). A WRITERS entry that matches no write fails,
 *      so the list cannot rot.
 *
 * What it cannot see: whether a covered helper is also reached from another,
 * uncovered transaction (each such caller's own writes are listed only when it
 * writes these tables itself), writes by database functions or FK cascades.
 */

/** Update columns that change membership or a connection without naming a user. */
const MEMBERSHIP_COLUMNS: Partial<Record<keyof typeof JOINT_WRITE_TABLES, readonly string[]>> = {
  jointChannelServers: ["status"],
  serverMembers: ["role", "guestChannelId"],
};

/** `file#function#table` -> `covered:<entry point>`, `known:<exception>` or `exempt: <why>`. */
const WRITERS: Record<string, string> = {
  // ── covered: these run inside a guarded entry point's transaction (40) ──
  "services/externalInviteConnectService.ts#connectJointChannel#channelExternalInvites": "covered:yourServersJoint",
  "services/externalInviteConnectService.ts#reserveConnection#channelExternalInvites": "covered:yourServersPrivate",
  // Also run by yourServersPrivate (reserveConnection), users-first too.
  "services/channelConversionService.ts#startChannelToJointConversion#channelConversionJobs": "covered:convertToJoint",
  "services/externalInviteConnectService.ts#selfConnectInTransaction#channelExternalInvites": "covered:selfConnect",
  "services/externalInviteConnectService.ts#reopenEndedOwnSource#jointChannelAdmissions": "covered:yourServersJoint",
  "services/externalInviteConnectService.ts#createApprovalRequests#channelServerConnectRequests": "covered:requestApproval",
  // Also run by createDirectConnectInvite, createSelfConnectInvite and resendExternalInvite (resendExternalInvite), users-first too.
  "services/externalInviteService.ts#insertExternalInvites#channelExternalInvites": "covered:sendExternalInvites",
  // Also run by createDirectConnectInvite and createSelfConnectInvite (users-first).
  "services/externalInviteService.ts#revokeLockedInvite#channelExternalInvites": "covered:revokeExternalInvite",
  "services/externalInviteService.ts#acceptExternalInviteAsGuest#channelExternalInvites": "covered:guestAccept",
  // The joint invite and its accept, as connectJointChannel writes them (createExternalConnectJointInvite, acceptJointChannelInviteInCallerTransaction).
  "services/channelService.ts#insertJointChannelInvite#jointChannelInvites": "covered:yourServersJoint",
  "services/channelService.ts#acceptJointChannelInviteWithEntitlements#channelHumans": "covered:yourServersJoint",
  "services/channelService.ts#acceptJointChannelInviteWithEntitlements#jointChannelInvites": "covered:yourServersJoint",
  "services/channelService.ts#acceptJointChannelInviteWithEntitlements#jointChannelServers": "covered:yourServersJoint",
  "services/jointAdmissionKind.ts#recordOrdinaryJointAdmissions#jointChannelAdmissions": "covered:yourServersJoint",
  // The membership mirror's writes (prepareJointHumanMembershipMirror's apply), in every guarded entry point.
  "services/jointHumanMembershipMirror.ts#apply#jointChannelAdmissions": "covered:yourServersJoint",
  "services/jointHumanMembershipMirror.ts#apply#jointChannelServers": "covered:hostDisconnect",
  "services/jointHumanMembershipMirror.ts#apply#channelHumans": "covered:removeMemberByAdmin",
  "services/jointHumanMembershipMirror.ts#upsertJointMemberEpisodes#jointChannelMembers": "covered:yourServersJoint",
  "services/jointMembershipDeparture.ts#beginJointMembershipDeparture#jointChannelAdmissions": "covered:hostDisconnect",
  "services/jointMembershipDeparture.ts#beginJointMembershipDeparture#jointMembershipDepartures": "covered:hostDisconnect",
  "services/jointMembershipDeparture.ts#removeJointHumansInTransaction#channelHumans": "covered:removeMemberByAdmin",
  "services/jointMembershipDeparture.ts#removeJointHumansInTransaction#jointChannelMembers": "covered:removeMemberByAdmin",
  "services/channelService.ts#disconnectJointProjectionInTransaction#jointChannelServers": "covered:hostDisconnect",
  "services/serverService.ts#executeMemberRemoval#channelHumans": "covered:removeMemberByAdmin",
  "services/serverService.ts#executeMemberRemoval#serverMembershipDepartures": "covered:removeMemberByAdmin",
  "services/serverService.ts#executeMemberRemoval#serverMembers": "covered:removeMemberByAdmin",
  // addMember's insert (its inner `run`): the Guest accept's seat. Server joins (invite, join link) write no joint row.
  "services/serverService.ts#run#serverMembers": "covered:guestAccept",
  "services/serverService.ts#run#serverMembershipDepartures": "covered:guestAccept",
  "services/channelService.ts#createJointChannelInTransaction#channelHumans": "covered:createJointChannel",
  "services/channelService.ts#createJointChannelInTransaction#jointChannelServers": "covered:createJointChannel",
  "services/channelService.ts#resendPendingJointChannelInvites#jointChannelInvites": "covered:resendJointInvites",
  "services/channelService.ts#deleteChannelInTransaction#channelHumans": "covered:deleteChannel",
  // Also run by a Guest's promotion through a server invite (admitByInvite, users-first) and by account
  // deletion's own retirement (promoteToOwner; lockRetirementUsers already holds the actor FOR UPDATE and the
  // successor FOR KEY SHARE, before any server row: re-entrant here).
  "services/serverService.ts#transitionMemberRoleInTransaction#serverMembers": "covered:roleTransition",
  "services/mentionActionService.ts#executeMentionActionForRow#channelHumans": "covered:mentionAdd",
  // The worker's audience cutover, finalize in one transaction: the source channel's people locked (no acting person).
  "services/channelConversionAudience.ts#audienceCutover#channelHumans": "covered:conversionFinalize",
  "services/channelConversionAudience.ts#resolveJointCreationSources#channelExternalInvites": "covered:conversionFinalize",
  // Under withLockedChannelActorCapability (the actor and humanSubjectIds first). Also run in its own
  // transaction (a self-join, onboarding, the lounge: the person and the adder locked first) and by the
  // Guest accept (guestAccept), users-first too.
  "services/channelService.ts#addHuman#channelHumans": "covered:channelAddHuman",
  // Also run in its own transaction (a self-leave: channelLeave) and by the agent API under the same wrapper.
  "services/channelService.ts#removeHuman#channelHumans": "covered:channelRemoveHuman",
  // The archiver and the bound Guests (guessed, re-read under the channel lock, restart on a new one). Also
  // run by the agent's archive (the same wrapper) and the joint host-side archive task (no actor: only locked).
  "services/externalInviteService.ts#revokeOpenInvitesForArchivedChannel#channelExternalInvites": "covered:archiveChannel",

  // ── known exceptions: expected failures in the guard (0) ──

  // ── open follow-ups: joint membership changes that do not take the users rows first yet (0) ──
  // Listed as `exempt: open follow-up, not users-first yet: <what>`.

  // ── exempt: not a joint membership or connection change acting for a person (35) ──
  "services/accountDeletion/cleanup.ts#promoteToOwner#serverMembers": "exempt: account deletion's own retirement, which holds the person's users row FOR UPDATE first",
  "services/accountDeletion/cleanup.ts#expire_pending_invites#jointChannelInvites": "exempt: account deletion's cleanup of an already retired account; status only",
  "services/accountDeletion/cleanup.ts#cancel_pending_connect_requests#channelServerConnectRequests": "exempt: account deletion's cleanup of an already retired account; status only",
  "services/closedServerPurgeDelete.ts#finishChannel#channelServerConnectRequests": "exempt: closed-server purge deletes a non-joint channel of a server closed 30+ days; joint channels and projections are kept, so no live joint connection changes; a DELETE that locks no users row, so users-first ordering does not apply",
  "services/closedServerPurgeDelete.ts#finishChannel#channelExternalInvites": "exempt: closed-server purge deletes a non-joint channel of a server closed 30+ days; joint channels and projections are kept, so no live joint connection changes; a DELETE that locks no users row, so users-first ordering does not apply",
  "services/allChannelMembership.ts#ensureAllChannelHumanRows#channelHumans": "exempt: #all rows, never a joint channel",
  "services/channelService.ts#apply#channelHumans": "exempt: createChannel's creator row; a joint channel is created by createJointChannel",
  "services/channelService.ts#applyUpdate#channelHumans": "exempt: #all made private (updateChannel); never a joint channel",
  "services/channelService.ts#changeChannelMembershipRole#channelHumans": "exempt: a channel role change; membership unchanged, no new user named",
  "services/channelService.ts#restoreDmHumanParticipants#channelHumans": "exempt: DMs, never joint",
  "services/channelService.ts#findOrCreateDM#channelHumans": "exempt: DMs, never joint",
  "services/channelService.ts#findOrCreateUserDM#channelHumans": "exempt: DMs, never joint",
  "services/channelService.ts#ensureJointThreadProjectionForLocalParent#jointChannelServers": "exempt: a thread's structural copy (system); names no user",
  "services/taskConversationService.ts#ensureLocalTaskConversationProjection#jointChannelServers": "exempt: a task conversation's structural copy (system); names no user",
  "services/externalInboundWorkerService.ts#resolveTargetChannel#jointChannelServers": "exempt: an external thread's structural copy (inbound worker); names no user",
  "services/channelConversionPhaseContext.ts#advance#channelConversionJobs": "exempt: the conversion worker's progress; names no user",
  "services/channelConversionPreparation.ts#prepare#jointChannelServers": "exempt: the conversion worker's structural copies; names no user",
  "services/channelConversionPreparation.ts#prepareThreads#jointChannelServers": "exempt: the conversion worker's structural copies; names no user",
  "services/channelConversionPreparation.ts#prepareTaskConversationProjections#jointChannelServers": "exempt: the conversion worker's structural copies; names no user",
  "services/channelConversionService.ts#rollbackConversionToSource#jointChannelServers": "exempt: the conversion worker's rollback; names no user",
  "services/channelConversionService.ts#markJobFailed#channelConversionJobs": "exempt: the conversion worker's job state; names no user",
  // Invite and request state: status and connection state only (lapsed, rested, settled, retried, withdrawn, expired, revoked by an admin); clearing a connect user column to null checks no key.
  "services/externalInviteConnectService.ts#lapseInvite#channelExternalInvites": "exempt: invite state only",
  "services/externalInviteConnectService.ts#initializeInviteSources#channelExternalInvites": "exempt: invite source state only",
  "services/externalInviteConnectService.ts#settleAfterChoice#channelExternalInvites": "exempt: invite state only",
  "services/externalInviteConnectService.ts#withdrawUnusedDirectConnectInvite#channelExternalInvites": "exempt: invite state only",
  "services/externalInviteConnectService.ts#restAfterRequest#channelExternalInvites": "exempt: invite state only",
  "services/externalInviteConnectService.ts#settleConnecting#channelExternalInvites": "exempt: invite state only",
  "services/externalInviteConnectService.ts#scheduleRetry#channelExternalInvites": "exempt: invite state only",
  "services/externalInviteService.ts#expireLapsedInvites#channelExternalInvites": "exempt: invite state only",
  "services/notifications/settings.ts#bumpPrefsVersion#serverMembers": "exempt: notification preferences",
  "services/serverService.ts#updateMemberAppearance#serverMembers": "exempt: member preferences",
  "services/serverService.ts#updateMemberOnboardingPreferences#serverMembers": "exempt: member preferences",
  "services/serverService.ts#updateMemberSidebarOrder#serverMembers": "exempt: member preferences",
  "services/serverService.ts#createServer#serverMembers": "exempt: a new server's owner; no joint yet",
  "services/serverService.ts#createServer#channelHumans": "exempt: a new server's channels; no joint yet",
};

const SERVER_SRC = resolve(import.meta.dirname, "..");

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return path === join(SERVER_SRC, "test") || entry.name === "migrations" ? [] : productionFiles(path);
    if (!entry.name.endsWith(".ts") || /\.(test|testkit|fixtures?)\.ts$/.test(entry.name) || entry.name.endsWith(".d.ts")) return [];
    return [path];
  });
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
  return current;
}

/** The nearest named function, else `<module>`. */
function nearestNamedFunction(node: ts.Node, tree: ts.SourceFile): string {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) return current.name.getText(tree);
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current))
      && (ts.isVariableDeclaration(current.parent) || ts.isPropertyAssignment(current.parent))) {
      return current.parent.name.getText(tree);
    }
  }
  return "<module>";
}

/** Keys of `.set({...})` when every one is written out, else null. */
function setKeys(updateCall: ts.CallExpression): string[] | null {
  const access = updateCall.parent;
  const setCall = access?.parent;
  if (!access || !ts.isPropertyAccessExpression(access) || access.name.text !== "set") return null;
  if (!setCall || !ts.isCallExpression(setCall) || setCall.arguments.length !== 1) return null;
  const literal = unwrap(setCall.arguments[0]!);
  if (!ts.isObjectLiteralExpression(literal)) return null;
  const keys: string[] = [];
  for (const property of literal.properties) {
    if (ts.isShorthandPropertyAssignment(property)) keys.push(property.name.text);
    else if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) keys.push(property.name.text);
    else return null;
  }
  return keys;
}

type Table = keyof typeof JOINT_WRITE_TABLES;
const TABLES = JOINT_WRITE_TABLES as Record<string, { sqlName: string; usersFk: readonly string[] }>;
type Write = { at: string; key: string };

function findWrites(path: string, source: string): Write[] {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const file = relative(SERVER_SRC, path);
  const writes: Write[] = [];
  const seen = new Set<string>();
  const record = (node: ts.Node, table: string) => {
    const key = `${file}#${nearestNamedFunction(node, tree)}#${table}`;
    if (seen.has(key)) return;
    seen.add(key);
    writes.push({ at: `${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`, key });
  };
  const sqlWrite = (text: string): string | null => {
    for (const [table, rule] of Object.entries(TABLES)) {
      if (new RegExp(`\\b(?:insert\\s+into|update|delete\\s+from)\\s+(?:"?${rule.sqlName}"?|\\$\\{${table}\\})(?![\\w])`, "i").test(text)) return table;
    }
    return null;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments.length >= 1) {
      const verb = node.expression.name.text;
      const target = unwrap(node.arguments[0]!);
      const rule = ts.isIdentifier(target) ? TABLES[target.text] : undefined;
      if (rule && (verb === "insert" || verb === "update" || verb === "delete")) {
        const table = (target as ts.Identifier).text;
        const keys = verb === "update" ? setKeys(node) : null;
        const counted = [...rule.usersFk, ...(MEMBERSHIP_COLUMNS[table as Table] ?? [])];
        if (verb !== "update" || keys === null || keys.some((key) => counted.includes(key))) record(node, table);
      }
    }
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || ts.isStringLiteral(node)) {
      const table = sqlWrite(node.getText(tree));
      if (table) record(node, table);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return writes;
}

function allWrites(): Write[] {
  return productionFiles(SERVER_SRC).flatMap((path) => {
    const source = readFileSync(path, "utf8");
    return /insert|update|delete/i.test(source) ? findWrites(path, source) : [];
  });
}

test("every writer of a joint membership or connection table is covered by a users-first entry point, or says why not", () => {
  const writes = allWrites();
  // A broken scan finding nothing must fail.
  assert.ok(writes.length >= 40, `writes found: ${writes.length}`);

  const offenders = writes.filter((write) => !(write.key in WRITERS))
    .map((write) => `${write.at} ${write.key}: run it under a JOINT_USERS_FIRST_ENTRY_POINTS entry point (covered:<id>), or add it to WRITERS with the reason`);
  assert.deepEqual(offenders, []);

  const malformed = Object.entries(WRITERS).filter(([, reason]) => {
    const covered = /^covered:(\w+)$/.exec(reason);
    if (covered) return !(covered[1]! in JOINT_USERS_FIRST_ENTRY_POINTS);
    const known = /^known:(\w+)$/.exec(reason);
    if (known) return !(known[1]! in JOINT_USERS_FIRST_KNOWN_EXCEPTIONS);
    return !/^exempt: \S/.test(reason);
  }).map(([key, reason]) => `${key}: ${reason}`);
  assert.deepEqual(malformed, [], "a reason is covered:<entry point id>, known:<exception id> or exempt: <why>");

  const used = new Set(writes.map((write) => write.key));
  assert.deepEqual(Object.keys(WRITERS).filter((key) => !used.has(key)), [], "WRITERS entries that match no write: remove them");
});

test("the scan recognizes each write shape", () => {
  const source = `
    async function inserts(tx) { await tx.insert(jointChannelMembers).values({}); }
    async function deletes(tx) { await tx.delete(channelHumans).where(x); }
    async function namesUser(tx) { await tx.update(jointChannelServers).set({ disconnectedByUserId: id }); }
    async function changesStatus(tx) { await tx.update(jointChannelServers).set({ status: "disconnected" }); }
    async function preferences(tx) { await tx.update(serverMembers).set({ theme: null }); }
    async function opaque(tx, patch) { await tx.update(serverMembers).set(patch); }
    const viaSql = async (tx) => { await tx.execute(sql\`UPDATE channel_server_connect_requests SET status = 'cancelled'\`); };
    async function otherTable(tx) { await tx.insert(messages).values({}); }
  `;
  const writes = findWrites(join(SERVER_SRC, "services/example.ts"), source).map((write) => write.key.split("#").slice(1).join(" "));
  assert.deepEqual(writes, [
    "inserts jointChannelMembers",
    "deletes channelHumans",
    "namesUser jointChannelServers",
    "changesStatus jointChannelServers",
    "opaque serverMembers",
    "viaSql channelServerConnectRequests",
  ]);
});
