import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// "May this person act on this Computer" has one spelling: canManageComputer
// (or computerActorAllowed / computerRoleAllows, its pieces) in
// services/computerControlAuthorization.ts: the machine's live attacher, or a
// role holding the capability the action maps to. No Computer route or
// service decides "owner or admin" any other way.

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTHORITY_FILE = "services/computerControlAuthorization.ts";

/** The capabilities only the Computer check names (packages/shared/src/serverPermissions.ts). */
const COMPUTER_CAPABILITIES = ["editMachines", "controlComputers", "removeMachines", "rotateMachineKeys"];

/** Other spellings of owner-or-admin, and the retired per-route helper. */
const OWNER_OR_ADMIN_SPELLINGS: Array<[string, RegExp]> = [
  ["isAdminOrOwner(", /\bisAdminOrOwner\s*\(/],
  ["role === \"owner\" || ... \"admin\"", /===\s*["']owner["']\s*\|\|[^;\n]*===\s*["']admin["']|===\s*["']admin["']\s*\|\|[^;\n]*===\s*["']owner["']/],
  ["role in owner/admin set", /\[\s*["']owner["']\s*,\s*["']admin["']\s*\]|\[\s*["']admin["']\s*,\s*["']owner["']\s*\]/],
  ["canManageMachineResource", /\bcanManageMachineResource\b/],
];

/** Computer and machine files: their whole source is held to the rule. */
const COMPUTER_FILE = /^(?:routes|services)\/(?:computer|machine|runtimeAuth|runtimeProvider|internalComputer)[^/]*\.ts$/;
/** servers.ts holds many routes: only its machine route handlers are held to the rule. */
const SERVERS_ROUTES = "routes/servers.ts";

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [fullPath];
  }));
  return files.flat();
}

/** Each `serverRouter.<verb>("…/machines…", …)` handler's text, up to the next route. */
function machineRouteHandlers(source: string): Array<{ route: string; body: string }> {
  const starts = [...source.matchAll(/serverRouter\.(?:get|post|put|patch|delete)\(\s*"([^"]+)"/g)];
  return starts.flatMap((match, index) => {
    if (!match[1]!.includes("/machines")) return [];
    const end = index + 1 < starts.length ? starts[index + 1]!.index : source.length;
    return [{ route: match[1]!, body: source.slice(match.index, end) }];
  });
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

test("only computerControlAuthorization names the Computer capabilities", async () => {
  const violations: string[] = [];
  for (const file of await listSourceFiles(srcRoot)) {
    const relativePath = path.relative(srcRoot, file).split(path.sep).join("/");
    if (relativePath === AUTHORITY_FILE || relativePath.startsWith("test/")) continue;
    const source = stripComments(await readFile(file, "utf8"));
    for (const capability of COMPUTER_CAPABILITIES) {
      if (source.includes(`"${capability}"`) || source.includes(`'${capability}'`)) violations.push(`${relativePath}: "${capability}"`);
    }
  }
  assert.deepEqual(violations, [], "ask canManageComputer (or computerActorAllowed / computerRoleAllows) with a ComputerAction instead");
});

test("no Computer route or service spells owner-or-admin another way", async () => {
  const violations: string[] = [];
  for (const file of await listSourceFiles(srcRoot)) {
    const relativePath = path.relative(srcRoot, file).split(path.sep).join("/");
    if (relativePath === AUTHORITY_FILE) continue;
    const source = stripComments(await readFile(file, "utf8"));
    const scopes = COMPUTER_FILE.test(relativePath)
      ? [{ where: relativePath, body: source }]
      : relativePath === SERVERS_ROUTES
        ? machineRouteHandlers(source).map(({ route, body }) => ({ where: `${relativePath} ${route}`, body }))
        : [];
    for (const { where, body } of scopes) {
      for (const [name, pattern] of OWNER_OR_ADMIN_SPELLINGS) {
        if (pattern.test(body)) violations.push(`${where}: ${name}`);
      }
    }
  }
  assert.deepEqual(violations, [], "ask canManageComputer (services/computerControlAuthorization.ts) instead");
});

test("the guard sees servers.ts's machine routes and catches each spelling", async () => {
  const servers = await readFile(path.join(srcRoot, SERVERS_ROUTES), "utf8");
  const routes = machineRouteHandlers(servers).map(({ route }) => route);
  for (const route of ["/:id/machines/:machineId", "/:id/machines/:machineId/computer/:action", "/:id/machines/:machineId/workspaces/:directoryName"]) {
    assert.ok(routes.includes(route), route);
  }
  for (const sample of ["isAdminOrOwner(role)", "role === \"owner\" || role === \"admin\"", "[\"owner\", \"admin\"].includes(role)", "canManageMachineResource(db)"]) {
    assert.ok(OWNER_OR_ADMIN_SPELLINGS.some(([, pattern]) => pattern.test(sample)), sample);
  }
  assert.ok(!OWNER_OR_ADMIN_SPELLINGS.some(([, pattern]) => pattern.test("member.role === \"owner\"")), "a lone owner recipient filter is not an authority check");
  assert.ok(COMPUTER_FILE.test("routes/runtimeAuthRoutes.ts") && COMPUTER_FILE.test("services/computerOwnerService.ts"));
});
