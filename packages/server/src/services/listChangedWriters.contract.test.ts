import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * The web reads three lists only on mount, on their `*:changed` ping, once on
 * reconnect and every 5 minutes while visible (no 60 s timer since PR 3 of
 * cutting web polling). A write that changes a list without pinging leaves it
 * stale for up to 5 minutes, so every write to a table behind a list must be
 * in a function that announces it (services/listChangedRealtime.ts), or be
 * listed below with the reason it needs none. This test is that tie.
 *
 * It reads the TypeScript syntax tree of every production file under src/:
 *   1. A write is `<x>.insert(T)`, `<x>.update(T)` or `<x>.delete(T)` for a
 *      table T below, or SQL text with `insert into`, `update` or
 *      `delete from` and T's name (or `${T}`), or SQL text calling one of
 *      the database functions below that write those tables.
 *   2. An update counts only if it may write a column the list reads: an
 *      `.update(T).set({...})` whose keys are all written out and none listed
 *      is skipped; any other shape (a variable, a spread, raw SQL) counts.
 *   3. Its nearest named function (declaration, method, or a const/property
 *      holding a function) must call one of the list's announce helpers
 *      anywhere in its body, or be in ALLOWED with a reason. An ALLOWED entry
 *      that matches no write fails, so the list cannot rot. A write in an
 *      unnamed callback with no named function around it (a route handler)
 *      is keyed `<module>` and must announce in that callback: ALLOWED
 *      refuses `<module>`, which would let every later handler in the file
 *      through.
 *
 * What it cannot see: whether the announce is reached at run time, writes in
 * database functions not in DB_FUNCTIONS or FK cascades, writers outside this
 * server (as Feature Flag Admin writes flags), and lists that change with no
 * write (an invite expiring, an agent taking a seat). Those are caught by the
 * 5-minute safety poll. Delivery is covered by the route tests that capture
 * the pings. The marketplace review functions announce for themselves: they
 * write permission_updates_changed rows to marketplace_review_outbox, which
 * the server's worker delivers (services/marketplaceReviewOutbox.ts), so App
 * Admin's app_admin_* entries, which run them straight against Postgres, ping
 * too.
 */

type ListName = "permission-updates" | "joint-invites" | "seat-join-blocks";

const HELPERS: Record<ListName, readonly string[]> = {
  "permission-updates": ["announcePermissionUpdatesChanged", "announcePermissionUpdatesForApp"],
  "joint-invites": ["announceJointInvitesChanged", "announceJointInvitesForJoints"],
  "seat-join-blocks": ["announceSeatJoinBlocksChanged", "announceSeatJoinBlocksForSeatChange"],
};

type TableRule = {
  list: ListName;
  sqlName: string;
  /** Columns the list reads; `"all"`: any update counts. */
  listed: ReadonlySet<string> | "all";
  /** An insert cannot change the list (a new App has no installation; a new copy removes no invite). */
  insertsSkipped?: true;
};

const TABLES: Record<string, TableRule> = {
  // GET /integrations/permission-updates: appPermissionUpdateInstallRows + appsNeedingAdminReview.
  oauthClientInstalls: {
    list: "permission-updates",
    sqlName: "oauth_client_installs",
    listed: new Set(["clientId", "serverId", "status", "approvedScopes", "approvedGroups", "confirmedTextRevisionId"]),
  },
  oauthClients: {
    list: "permission-updates",
    sqlName: "oauth_clients",
    listed: new Set(["serverId", "enabled", "appType", "allowedScopes", "outboundCurrentGroups", "textCurrentRevisionId", "localConfirmedTextRevisionId"]),
    insertsSkipped: true,
  },
  // GET /channels/joint-invites: listPendingJointChannelInvites.
  jointChannelInvites: { list: "joint-invites", sqlName: "joint_channel_invites", listed: "all" },
  jointChannelServers: {
    list: "joint-invites",
    sqlName: "joint_channel_servers",
    listed: new Set(["jointChannelId", "serverId", "localChannelId", "status"]),
    insertsSkipped: true,
  },
  jointChannels: { list: "joint-invites", sqlName: "joint_channels", listed: new Set(["status"]), insertsSkipped: true },
  // GET /servers/:id/seat-join-blocks: listSeatJoinBlocks (the blocks, and seats full).
  seatJoinBlocks: { list: "seat-join-blocks", sqlName: "seat_join_blocks", listed: "all" },
  serverMembers: { list: "seat-join-blocks", sqlName: "server_members", listed: new Set(["role"]) },
};

/**
 * Database functions that write a table behind a list (their latest
 * definition in drizzle/): a call from this server is a write of `table`.
 * The server calls neither today (App Admin decides marketplace reviews); a
 * call added back is checked like any write.
 */
const DB_FUNCTIONS: Record<string, keyof typeof TABLES> = {
  marketplace_approve_permission_review: "oauthClients",
  marketplace_decide_publish_review: "oauthClientInstalls",
};

/** `file#function#table` -> why this write needs no ping. */
const ALLOWED: Record<string, string> = {
  // permission-updates
  "services/appPromptTextService.ts#ensureCurrentTextRevision#oauthClients":
    "lazily gives an App with no text revision (rows from before migration 0382) its first one; the backfill must find none before app_prompt_text_consent is on anywhere, and with it off text is on no list",
  "services/appPromptTextService.ts#advanceConfirmationsOfUnchangedAgentText#oauthClientInstalls":
    "both callers (recordPromptTextEdit, reviewPendingPromptText) announce after it, in the same transaction",
  "services/appPromptTextService.ts#advanceConfirmationsOfUnchangedAgentText#oauthClients":
    "both callers (recordPromptTextEdit, reviewPendingPromptText) announce after it, in the same transaction",
  "services/appPromptTextService.ts#advanceConfirmationsWhereConsentOff#oauthClientInstalls":
    "confirms only on servers where app_prompt_text_consent is off, where text is on no list; its callers announce the App's servers anyway",
  "services/appPromptTextService.ts#advanceConfirmationsWhereConsentOff#oauthClients":
    "the source server's local confirmation, only where app_prompt_text_consent is off: text is on no list there",
  "services/appPromptTextService.ts#backfillAppPromptTextRevisions#oauthClientInstalls":
    "operator backfill (scripts/backfill-app-prompt-text-revisions.ts): runs with no socket server, before app_prompt_text_consent is on anywhere",
  "services/appSourceInstallationService.ts#ensureLocalAppSourceInstallation#oauthClientInstalls":
    "server_local Apps only: the count reads third_party_global installs, and a server_local App's text confirmation is oauth_clients.localConfirmedTextRevisionId",
  "services/slackBridgeProvisioningControlPlane.ts#connect#oauthClientInstalls":
    "the Slack Bridge's OAuth client is platform-managed (external_app_registrations): never user-managed, so on neither list",
  "services/slackBridgeProvisioningControlPlane.ts#disconnect#oauthClientInstalls":
    "the Slack Bridge's OAuth client is platform-managed (external_app_registrations): never user-managed, so on neither list",
  "services/slackBridgeProvisioningControlPlane.ts#reconcileSlackBridgeOAuthIdentityAppType#oauthClients":
    "the Slack Bridge's OAuth client is platform-managed (external_app_registrations): never user-managed, so on neither list",
  // joint-invites
  "services/accountDeletion/cleanup.ts#expire_pending_invites#jointChannelInvites":
    "the invitee's own account is being deleted: their sessions end, and an invite is listed only to its invitee",
  // seat-join-blocks (server_members: seats taken or freed)
  "services/serverService.ts#createServer#serverMembers": "a new server's owner: the server can have no seat notice yet",
  "services/serverService.ts#updateMemberAppearance#serverMembers": "its payload is built in the function from theme fields only, never role",
  "services/serverService.ts#updateMemberOnboardingPreferences#serverMembers": "its payload is built in the function from onboarding fields only, never role",
  "services/serverService.ts#updateMemberSidebarOrder#serverMembers": "its payload is built in the function from sidebar order fields only, never role",
  "services/notifications/settings.ts#bumpPrefsVersion#serverMembers": "its callers pass serverPushMode or nothing, never role",
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

type NamedFunction = { name: string; body: ts.Node };

/** The nearest named function, else `<module>` with the outermost unnamed function around the write (a route handler), if any. */
function nearestNamedFunction(node: ts.Node, tree: ts.SourceFile): NamedFunction | null {
  let unnamed: ts.Node | null = null;
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) {
      return { name: current.name.getText(tree), body: current };
    }
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current))
      && (ts.isVariableDeclaration(current.parent) || ts.isPropertyAssignment(current.parent))) {
      return { name: current.parent.name.getText(tree), body: current };
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) unnamed = current;
  }
  return unnamed ? { name: "<module>", body: unnamed } : null;
}

function callsAny(node: ts.Node, names: readonly string[]): boolean {
  let found = false;
  const visit = (child: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(child)) {
      const callee = unwrap(child.expression);
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name && names.includes(name)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
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

type Write = { at: string; key: string; list: ListName; announces: boolean };

function findWrites(path: string, source: string): Write[] {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const file = relative(SERVER_SRC, path);
  const writes: Write[] = [];
  const record = (node: ts.Node, table: string) => {
    const rule = TABLES[table]!;
    const fn = nearestNamedFunction(node, tree);
    writes.push({
      at: `${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`,
      key: `${file}#${fn?.name ?? "<module>"}#${table}`,
      list: rule.list,
      announces: fn !== null && callsAny(fn.body, HELPERS[rule.list]),
    });
  };
  const sqlWrite = (text: string): string | null => {
    for (const [table, rule] of Object.entries(TABLES)) {
      const target = `(?:"?${rule.sqlName}"?|\\$\\{${table}\\})`;
      const verbs = rule.insertsSkipped ? "update|delete\\s+from" : "insert\\s+into|update|delete\\s+from";
      if (new RegExp(`\\b(?:${verbs})\\s+${target}(?![\\w])`, "i").test(text)) return table;
    }
    for (const [fn, table] of Object.entries(DB_FUNCTIONS)) {
      if (new RegExp(`\\b${fn}\\s*\\(`, "i").test(text)) return table;
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
        const skipped = (verb === "insert" && rule.insertsSkipped)
          || (keys !== null && rule.listed !== "all" && !keys.some((key) => (rule.listed as ReadonlySet<string>).has(key)));
        if (!skipped) record(node, table);
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

test("every write behind a polled list announces its *:changed ping, or says why it needs none", () => {
  const writes = productionFiles(SERVER_SRC).flatMap((path) => {
    const source = readFileSync(path, "utf8");
    const mayWrite = /insert|update|delete/i.test(source) || Object.keys(DB_FUNCTIONS).some((fn) => source.includes(fn));
    return mayWrite ? findWrites(path, source) : [];
  });
  const perList = (list: ListName) => writes.filter((write) => write.list === list).length;
  // The scan sees the known writers (a broken scan finding nothing must fail).
  assert.ok(perList("permission-updates") >= 25, `permission-updates writes found: ${perList("permission-updates")}`);
  assert.ok(perList("joint-invites") >= 10, `joint-invites writes found: ${perList("joint-invites")}`);
  assert.ok(perList("seat-join-blocks") >= 7, `seat-join-blocks writes found: ${perList("seat-join-blocks")}`);

  const offenders = writes
    .filter((write) => !write.announces && !(write.key in ALLOWED))
    .map((write) => `${write.at} ${write.key}: call ${HELPERS[write.list].join(" or ")} in this function, or add it to ALLOWED with the reason`);
  assert.deepEqual(offenders, []);

  assert.deepEqual(Object.keys(ALLOWED).filter((key) => key.includes("#<module>#")), [], "ALLOWED cannot name <module>: announce in the handler");
  const used = new Set(writes.filter((write) => !write.announces).map((write) => write.key));
  const stale = Object.keys(ALLOWED).filter((key) => !used.has(key));
  assert.deepEqual(stale, [], "ALLOWED entries that match no unannounced write: remove them");
});

test("the scan recognizes each write shape, and a listed column", () => {
  const source = `
    async function announced(tx) { await tx.insert(seatJoinBlocks).values({}); announceSeatJoinBlocksChanged(["s"]); }
    async function silentInsert(tx) { await tx.insert(oauthClientInstalls).values({}); }
    async function silentListedUpdate(tx) { await tx.update(oauthClientInstalls).set({ status: "suspended", updatedAt: now }); }
    async function unlistedUpdate(tx) { await tx.update(oauthClientInstalls).set({ botGrant: "granted", updatedAt: now }); }
    async function opaqueUpdate(tx, updates) { await tx.update(oauthClientInstalls).set(updates); }
    const viaSql = async (tx) => { await tx.execute(sql\`UPDATE joint_channel_servers SET status='disconnected'\`); };
    async function viaInterpolatedSql(tx) { await tx.execute(sql\`delete from \${seatJoinBlocks} where true\`); }
    async function skippedInsert(tx) { await tx.insert(oauthClients).values({}); }
    async function nestedAnnounce(tx) { await tx.delete(jointChannels); const later = () => announceJointInvitesForJoints(tx, ["j"]); await later(); }
    async function viaDbFunction(tx) { await tx.execute(sql\`SELECT public.marketplace_decide_publish_review(\${id}::uuid) AS result\`); }
    router.post("/silent", async (req) => { await getDb().delete(seatJoinBlocks); });
    router.post("/announced", async (req) => { await getDb().delete(seatJoinBlocks); announceSeatJoinBlocksChanged([req.serverId]); });
  `;
  const writes = findWrites(join(SERVER_SRC, "services/example.ts"), source)
    .map((write) => `${write.key.split("#")[1]} ${write.list} ${write.announces ? "announces" : "silent"}`);
  assert.deepEqual(writes, [
    "announced seat-join-blocks announces",
    "silentInsert permission-updates silent",
    "silentListedUpdate permission-updates silent",
    "opaqueUpdate permission-updates silent",
    "viaSql joint-invites silent",
    "viaInterpolatedSql seat-join-blocks silent",
    "nestedAnnounce joint-invites announces",
    "viaDbFunction permission-updates silent",
    "<module> seat-join-blocks silent",
    "<module> seat-join-blocks announces",
  ]);
});
