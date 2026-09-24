import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
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

test("agent authorization responses describe the executable action capabilities", async () => {
  const credentialsRoute = await readFile(path.join(srcRoot, "routes/agentCredentials.ts"), "utf8");
  const agentsRoute = await readFile(path.join(srcRoot, "routes/agents.ts"), "utf8");
  const channelsRoute = await readFile(path.join(srcRoot, "routes/channels.ts"), "utf8");
  const remindersRoute = await readFile(path.join(srcRoot, "routes/reminders.ts"), "utf8");
  const serversRoute = await readFile(path.join(srcRoot, "routes/servers.ts"), "utf8");
  const internalAgentApiRoute = await readFile(path.join(srcRoot, "routes/internalAgentApi.ts"), "utf8");
  const agentActionRoutes = await Promise.all([
    "agentChannelCreate.ts",
    "agentChannelUpdate.ts",
    "agentChannelMembers.ts",
    "agentChannelLifecycle.ts",
    "agentServerManage.ts",
  ].map((file) => readFile(path.join(srcRoot, "routes", file), "utf8")));
  const agentActionSource = agentActionRoutes.join("\n");

  assert.match(credentialsRoute, /`issueAgentCredentials` capability or human creator authority is required to manage agent credentials/);
  assert.match(agentsRoute, /`issueAgentCredentials` capability or human creator authority is required to issue agent bootstrap tokens/);
  assert.match(agentsRoute, /`viewAgents` capability is required to inspect runtime options/);
  assert.match(channelsRoute, /`controlAgentRuntime` capability is required to stop all agents in a channel/);
  assert.match(channelsRoute, /`controlAgentRuntime` capability is required to resume all agents in a channel/);
  assert.doesNotMatch(credentialsRoute, /Only server (?:owners|admins)/);
  assert.doesNotMatch(agentsRoute, /(?:server owners|server admins|owners\/admins)/);
  assert.doesNotMatch(channelsRoute, /Only server owners and admins can manage agents/);
  assert.doesNotMatch(remindersRoute, /Only the agent creator and server admins/);
  assert.doesNotMatch(serversRoute, /Only the (?:agent|machine) creator and server/);
  assert.doesNotMatch(serversRoute, /Only server admins and the attaching human/);
  assert.doesNotMatch(internalAgentApiRoute, /human owner\/admin must start migration/);
  assert.match(agentActionSource, /Agent requires createChannels capability to create channels/);
  assert.match(agentActionSource, /Agent requires editChannelMetadata or changeChannelVisibility capability to update channels/);
  assert.match(agentActionSource, /Agent requires addChannelMembers capability to add channel members/);
  assert.match(agentActionSource, /Agent requires removeChannelMembers capability to remove channel members/);
  assert.match(agentActionSource, /Agent requires archiveChannels capability to \$\{action\} channels/);
  assert.match(agentActionSource, /Agent requires editServerSettings capability to edit the server profile/);
  assert.doesNotMatch(agentActionSource, /admin role|required_role|admin_role_required/);
});
