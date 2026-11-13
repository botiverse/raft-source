import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const directPermissionCheckPattern = /\b(?:userHasServerCapability|getServerRole\(|hasServerCapability\(|getMemberRole\(|getAgentMemberRole\()/g;

const canonicalPermissionFiles = new Set([
  "lib/actorPermissions.ts",
  "services/serverService.ts",
]);

// Route/service permission control must route through actorPermissions. The
// only allowed direct role/capability reads live in canonical infra files.
const legacyDirectPermissionCheckBaseline: Record<string, number> = {};

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

test("server permission checks do not bypass actorPermissions beyond the legacy baseline", async () => {
  const observed: Record<string, number> = {};
  for (const file of await listSourceFiles(srcRoot)) {
    const relativePath = path.relative(srcRoot, file);
    if (canonicalPermissionFiles.has(relativePath)) continue;

    const source = await readFile(file, "utf8");
    const matches = source.match(directPermissionCheckPattern);
    if (matches?.length) observed[relativePath] = matches.length;
  }

  assert.deepEqual(
    observed,
    legacyDirectPermissionCheckBaseline,
    "new server-action permission checks must go through lib/actorPermissions.ts; migrate an existing baseline entry down instead of adding direct role/capability checks",
  );
});

test("production server code cannot reintroduce removed coarse capability literals", async () => {
  const removedCapabilities = [
    "manageServer",
    "manageChannels",
    "manageAgents",
    "manageMachines",
    "manageMembers",
  ];
  const violations: string[] = [];

  for (const file of await listSourceFiles(srcRoot)) {
    const source = await readFile(file, "utf8");
    for (const capability of removedCapabilities) {
      if (source.includes(`"${capability}"`) || source.includes(`'${capability}'`)) {
        violations.push(`${path.relative(srcRoot, file)}:${capability}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});
