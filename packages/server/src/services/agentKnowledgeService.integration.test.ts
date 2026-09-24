import { test } from "vitest";
import assert from "node:assert/strict";
import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService.js";

// Manual telemetry (meichen 7/28) surfaced Chinese joint-channel discovery
// missing while the canonical `joint-channel` doc succeeded 26 times. The
// content is healthy; only discovery failed. Exact observed phrasing only —
// no broad CJK fuzzing.
test("Chinese joint-channel phrasing resolves to the joint-channel doc", async () => {
  const doc = await resolveAgentKnowledgeDoc("联合频道");
  assert.ok(doc, "联合频道 must resolve");
  assert.equal(doc.docId, "joint-channel");
});

test("existing joint-channel aliases still resolve", async () => {
  for (const alias of ["joint-channel", "joint-channels", "joint channel", "joint channels"]) {
    const doc = await resolveAgentKnowledgeDoc(alias);
    assert.ok(doc, `${alias} must resolve`);
    assert.equal(doc.docId, "joint-channel");
  }
});

test("the Chinese alias does not shadow unrelated Chinese phrasings", async () => {
  // No broad fallback: a different Chinese term must stay not_found rather
  // than collapsing onto joint-channel.
  for (const miss of ["频道", "联合", "私密频道"]) {
    const doc = await resolveAgentKnowledgeDoc(miss);
    assert.equal(doc, null, `${miss} must not resolve to a doc`);
  }
});

// Keep the executable Manual aligned with the released integration surface.
test("integration doc documents the invoke action surface", async () => {
  const doc = await resolveAgentKnowledgeDoc("integration");
  assert.ok(doc, "integration must resolve");
  assert.match(doc.content, /raft integration invoke/, "must document the invoke command");
  // Assert the FLAG TABLE rows, not a bare string match: `--target` and
  // `--list-actions` both also appear in surrounding prose, so a loose
  // /--target/ match stays green even if the flag reference is deleted.
  for (const flag of ["--service <id>", "--action <name>", "--list-actions", "--param <key=value>", "--data-json <json>", "--data-file <path>", "--scope <scope>", "--target <target>", "--json"]) {
    assert.ok(
      doc.content.includes(`| \`${flag}\` |`),
      `the invoke flag table must carry a row for ${flag}`,
    );
  }
  // `--target` is the flag that keeps an approval-gated action from stalling
  // invisibly, so pin its meaning, not just its presence.
  assert.match(
    doc.content,
    /`--target <target>`[^|]*\|[^|]*human approval card/,
    "the --target row must say it is where the human approval card is posted",
  );
});

test("integration doc separates installed inventory from public Marketplace discovery", async () => {
  const doc = await resolveAgentKnowledgeDoc("integration");
  assert.ok(doc, "integration must resolve");
  assert.match(doc.content, /`raft integration list`[^\n]*installed registered services/);
  assert.match(doc.content, /`raft integration marketplace \[query\]`/);
  assert.match(doc.content, /Read-only public Marketplace candidates[^\n]*neither installs an App nor changes `integration list`/);
  assert.match(doc.content, /publisher supplied and untrusted/);
  assert.match(doc.content, /Omit the query to list public Apps/);
  assert.doesNotMatch(doc.content, /list recent public Apps/);
  assert.match(doc.content, /Only an owner\/admin can commit it; a member gets 403/);
  assert.match(doc.content, /private, disabled, rejected, draft, or unpublished Apps/);
  assert.match(doc.content, /commands are not a required sequence/);
});

test("integration doc pins the released app command table", async () => {
  const doc = await resolveAgentKnowledgeDoc("integration");
  assert.ok(doc, "integration must resolve");
  const tableStart = doc.content.indexOf("Use these exact commands");
  const tableEnd = doc.content.indexOf("`list` and `status` deliberately omit", tableStart);
  assert.ok(tableStart >= 0, "the exact-commands table heading must exist");
  assert.ok(tableEnd > tableStart, "the command-table boundary must follow the heading");
  const table = doc.content.slice(tableStart, tableEnd);
  const documentedCommands = [...table.matchAll(/^\| `(raft integration app [^`]+)` \|/gm)]
    .map((match) => match[1]);
  assert.deepEqual(documentedCommands, [
    "raft integration app prepare register",
    "raft integration app prepare recover-owner",
    "raft integration app rotate-secret",
    "raft integration app transfer-owner",
    "raft integration app update",
    "raft integration app logo",
    "raft integration app clear-logo",
    "raft integration app share-link",
    "raft integration app share-link-status",
    "raft integration app revoke-share-link",
    "raft integration app request-publish",
    "raft integration app request-unpublish",
    "raft integration app delete",
    "raft integration app list",
    "raft integration app status",
  ]);
});
