import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHANNEL_ADMIN_CAPABILITIES,
  hasServerCapability,
} from "@botiverse/raft-shared";
import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService";

// Five coarse capabilities were removed when authority became per-operation.
// actorPermissions.boundary.test.ts forbids all five literals in server source
// ("production server code cannot reintroduce removed coarse capability
// literals"), and outside that guard they survive in packages/ only inside
// comments. The Manual teaches every one of them.
//
// The guard here is bound to the capability names and to the capability sets,
// not to any sentence: a rewording survives it, and a page that reintroduces a
// removed name goes red wherever it is written.

// Root is `manual/`, not `manual/agent-knowledge`: recipe cards are Manual
// pages too, and a guard that stops at one subtree is invisible exactly where
// the next page gets written (Cat, 2026-09-23 — she checked, recipes/ carries
// none of the five today, so this widening costs nothing and closes the hole).
const manualRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../manual",
);

// The same five the server-side guard lists.
const REMOVED_CAPABILITIES = [
  "manageServer",
  "manageChannels",
  "manageAgents",
  "manageMachines",
  "manageMembers",
] as const;

// Pages that still teach a removed name, and which names. Self-retiring: the
// test below asserts each listed name is STILL on its page, so an entry goes
// red the moment its page is cleaned and has to be deleted rather than sitting
// there widening the exemption by accident.
//
// Clearing a page is not just deleting the identifier. Each one carries a
// permission claim that has to be checked against the capability sets and the
// route, the way permission-matrix and channel.md were: the retired name is the
// marker, not the whole defect (Cat, 2026-09-23).
const PENDING_REMOVAL: Record<string, readonly string[]> = {
  "agent-knowledge/action-cards.md": ["manageServer"],
};

async function manualPages(): Promise<string[]> {
  const entries = await readdir(manualRoot, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.relative(manualRoot, path.join(entry.parentPath ?? manualRoot, entry.name)));
}

test("the permission model still has none of the five, and channel authority is per-operation", () => {
  for (const capability of REMOVED_CAPABILITIES) {
    assert.ok(
      !(CHANNEL_ADMIN_CAPABILITIES as readonly string[]).includes(capability),
      `${capability} must stay out of the channel-admin set`,
    );
  }

  // Creating is a member capability; editing and archiving are channel-admin
  // capabilities; visibility, deletion and federation are neither.
  assert.equal(hasServerCapability("member", "createChannels"), true);
  for (const capability of ["editChannelMetadata", "archiveChannels"] as const) {
    assert.ok((CHANNEL_ADMIN_CAPABILITIES as readonly string[]).includes(capability));
    assert.equal(hasServerCapability("member", capability), false);
  }
  for (const capability of ["changeChannelVisibility", "deleteChannels", "federateChannels"] as const) {
    assert.ok(
      !(CHANNEL_ADMIN_CAPABILITIES as readonly string[]).includes(capability),
      `${capability} must not be reachable through a channel-admin role`,
    );
    assert.equal(hasServerCapability("member", capability), false);
    assert.equal(hasServerCapability("admin", capability), true);
  }
});

test("no Manual page teaches a removed coarse capability", async () => {
  const dirty: string[] = [];
  for (const page of await manualPages()) {
    const source = await readFile(path.join(manualRoot, page), "utf8");
    const allowed = PENDING_REMOVAL[page] ?? [];
    for (const capability of REMOVED_CAPABILITIES) {
      if (source.includes(capability) && !allowed.includes(capability)) dirty.push(`${page}:${capability}`);
    }
  }
  assert.deepEqual(
    dirty,
    [],
    "these names are not capabilities any more; name the per-operation capability the code checks",
  );
});

test("every pending-removal entry is still dirty, so the list retires itself", async () => {
  const clean: string[] = [];
  for (const [page, capabilities] of Object.entries(PENDING_REMOVAL)) {
    const source = await readFile(path.join(manualRoot, page), "utf8");
    for (const capability of capabilities) {
      if (!source.includes(capability)) clean.push(`${page}:${capability}`);
    }
  }
  assert.deepEqual(clean, [],
    "these are clean now — delete their PENDING_REMOVAL entries so the ban covers them");
});

test("channel.md does not make server role the line for channel operations", async () => {
  const doc = await resolveAgentKnowledgeDoc("channel");
  assert.ok(doc, "the topic must resolve");

  const cliLine = doc.content.split("\n").find((line) => line.startsWith("→ via CLI:"));
  assert.ok(cliLine, "the CLI answer line must exist");
  assert.doesNotMatch(
    cliLine,
    /admin-role agents[^.]*can also create/i,
    "creating a channel must not be presented as an admin-role power",
  );
  assert.match(cliLine, /member-role agent can create a channel/i);
  assert.match(cliLine, /permission-matrix/, "the per-operation rule must stay one hop away");
});

test("server-role.md does not present channel management as one admin-only gate", async () => {
  const doc = await resolveAgentKnowledgeDoc("server-role");
  assert.ok(doc, "the topic must resolve");
  const line = doc.content.split("\n").find((l) => l.startsWith("- Channel management"));
  assert.ok(line, "the composition bullet must exist");
  assert.match(line, /createChannels/, "the member half must be named");
  assert.match(line, /channel-admin role/i, "the channel-admin path must be named");
});
