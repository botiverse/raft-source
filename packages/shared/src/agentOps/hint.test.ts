// Hints: every builder's CLI form is pinned to the exact string the CLI
// printed before hints were structured (golden), its tool form is pinned,
// tool-style text replaces every command, and no shared formatter hand-writes
// a `raft <group> <command>` string any more.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import ts from "typescript";

import { formatAgentAttachmentSuffix, formatAgentInboxHint } from "../agentMessageText";
import { formatAgentPendingMentionActions } from "../agentText/mentions";
import { formatAgentServerInfo, formatAgentServerSummary } from "../agentText/server";
import { formatHint, formatHintName, RAFT_HINTS, raftToolNameFor } from "./hint";
import { RAFT_HINT_SAMPLES } from "./hint.testkit";

test("golden: every hint builder renders the CLI's exact command, and its tool call", () => {
  assert.deepEqual(Object.keys(RAFT_HINT_SAMPLES).sort(), Object.keys(RAFT_HINTS).sort(), "every builder has samples");
  for (const [name, samples] of Object.entries(RAFT_HINT_SAMPLES)) {
    assert.ok(samples.length > 0, `${name}: at least one sample`);
    for (const sample of samples) {
      assert.equal(formatHint(sample.hint), sample.cli, `${name}: CLI form`);
      assert.equal(formatHint(sample.hint, "cli"), sample.cli, `${name}: CLI form is the default`);
      assert.equal(formatHint(sample.hint, "tool"), sample.tool, `${name}: tool form`);
      // A partial call names exactly the arguments left to fill.
      assert.equal(sample.hint.op?.partial === true, (sample.hint.fill?.length ?? 0) > 0, `${name}: partial ⇔ fill`);
      for (const key of sample.hint.fill ?? []) assert.ok(!(key in (sample.hint.op?.args ?? {})), `${name}: ${key} is filled by the caller, not given`);
    }
  }
});

test("names and tool names: prose names a command; tool names are the manifest's snake form", () => {
  assert.equal(formatHintName(RAFT_HINTS.channelJoinName()), "raft channel join");
  assert.equal(formatHintName(RAFT_HINTS.channelJoinName(), "tool"), "channels_join");
  assert.equal(formatHintName(RAFT_HINTS.attachmentDownload("a"), "tool"), "raft.attachments.download");
  assert.equal(raftToolNameFor("tasks.updateStatus"), "tasks_update_status");
  assert.equal(raftToolNameFor("attachments.downloadUrl"), "attachments_download_url");
});

const SERVER = {
  runtimeContext: { agentId: "agent-1", serverId: "server-1" },
  channels: [{ id: "c-1", name: "general", joined: true, type: "channel" }],
  agents: [{ name: "bot", status: "active" }],
  humans: [{ name: "richard" }],
};

test("tool style: server summary and overview name tools, including the role-gated admin tools", () => {
  const summary = formatAgentServerSummary(SERVER, "tool");
  assert.ok(summary.includes(`- server_info({ view: "channels" })\n`));
  assert.ok(summary.includes("- channels_info({ target: … })\n- users_info({ name: … })\n"));
  assert.ok(summary.includes(`Full dump: server_info({ view: "full" })`));
  const full = formatAgentServerInfo(SERVER, "tool");
  assert.ok(full.includes("Use the channel attention tools (`channels_join`, `channels_leave`, `channels_mute`, `channels_unmute`; `threads_unfollow`)"));
  assert.ok(full.includes("Channel management tools (`channels_create`, `channels_update`, `channels_archive`, `channels_unarchive`, `channels_add_member`, `channels_remove_member`) work when your server role allows them, or, for update, archive, unarchive and remove-member, your channel-admin role in that channel; the Server checks on each call, and a refusal says what is missing."));
  assert.ok(full.includes("Server-profile changes use `server_update` and remain server-role gated.\n"));
  assert.ok(!full.includes("actions_prepare"), "admin writes are tools now, not action cards");
  assert.ok(full.includes(`To start a new DM: messages_send({ target: "dm:@name", content: … }). To reply`));
  assert.ok(!/\braft [a-z]/.test(summary + full), "no CLI command left in tool style");
  assert.ok(!full.includes("--help"));
});

test("tool style: message-line attachment pointer, inbox hint, and mention recovery", () => {
  assert.equal(
    formatAgentAttachmentSuffix([{ id: "att-1", filename: "a.png" }], "tool"),
    ` [1 attachment: a.png (id:att-1) — use attachments_download_url({ attachmentId: "att-1" }) to download]`,
  );
  assert.equal(
    formatAgentAttachmentSuffix([{ id: "att-1", filename: "a.png" }, { id: "att-2", filename: "b.pdf" }], "tool"),
    ` [2 attachments: a.png (id:att-1), b.pdf (id:att-2) — use attachments_download_url({ attachmentId: … }) to download]`,
  );
  assert.equal(
    formatAgentAttachmentSuffix([{ id: "att-1", filename: "a.png" }]),
    ` [1 attachment: a.png (id:att-1) — use raft attachment view to download]`,
  );
  assert.equal(formatAgentInboxHint({ unread_conversations: 2 }, "tool"), "Still unread: 2 conversations. Run `inbox_list({})` to list them.");
  const id = "00000000-1111-2222-3333-444444444444";
  const action = { resolutionId: id, messageId: "m-1", targetType: "agent", targetHandle: "@bob", reason: "not_member", availableActions: ["notify", "add"], expiresAt: null };
  const cli = formatAgentPendingMentionActions([action], { source: "pending", hasMore: true, limit: 5 });
  const tool = formatAgentPendingMentionActions([action], { source: "pending", hasMore: true, limit: 5, hints: "tool" });
  assert.ok(cli.includes(`  notify: raft mention notify ${id}\n  add: raft mention add ${id}\n  note: notify exits nonzero`));
  assert.ok(cli.includes("--limit 5 — truncated=true · more pending actions exist; raise --limit "));
  assert.ok(tool.includes(`  notify: mentions_notify({ resolutionIds: ["${id}"] })\n`));
  assert.ok(tool.includes("  note: notify exits nonzero"), "the notify note follows the verb, not the rendered string");
  assert.ok(tool.includes("limit 5 — truncated=true · more pending actions exist; raise limit "));
  const sent = formatAgentPendingMentionActions([action], { source: "send", hints: "tool" });
  assert.ok(sent.includes("Do not rerun `messages_send`;"));
  assert.ok(sent.includes(`  recovery: mentions_notify({ resolutionIds: ["${id}"] })\n`));
});

// ── lint: no hand-written CLI commands in the shared formatters ─────────────

const SRC = resolve(import.meta.dirname, "..");
const SCANNED = ["agentOps", "agentText", "agentMessageText.ts"];
// A CLI command in a string: `raft <group> <command>`, or `raft ` right before
// an interpolation (a computed command).
const CLI_COMMAND = /\braft [a-z][a-z-]* [a-z-]/;
const CLI_COMMAND_PREFIX = /\braft $/;

/**
 * The only literals allowed to name a CLI command, by file and literal text.
 * Everything else renders through formatHint (hint.ts). Out of scope and not
 * scanned: raftCliGuide.ts (the CLI operating guide) and Server-originated
 * strings outside these directories (the `inbox_hint.command` wire literal,
 * MANUAL_INDEX_COMMAND, the integration-invoke recovery in agentApiContract.ts).
 */
const ALLOWED: Array<{ file: string; literal: string; why: string }> = [
  { file: "agentOps/passiveResources.ts", literal: "raft ", why: "CLI-only: `raft <command> --help` for the command-guidance resource; never on the SDK path." },
  { file: "agentText/raftDeliveryParse.ts", literal: "raft inbox read --target <item>", why: "Read, not rendered: View Context's parser recognizes RFC 081's inbox footer by this text." },
];

function scannedFiles(): string[] {
  const files: string[] = [];
  const walk = (path: string) => {
    if (path.endsWith(".ts")) {
      if (!/\.(test|testkit)\.ts$/.test(path) && !path.endsWith("/hint.ts")) files.push(path);
      return;
    }
    for (const entry of readdirSync(path, { withFileTypes: true })) walk(join(path, entry.name));
  };
  for (const entry of SCANNED) walk(join(SRC, entry));
  return files;
}

function stringLiterals(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const literals: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.push(node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) literals.push(node.text);
    node.forEachChild(visit);
  };
  visit(source);
  return literals;
}

test("lint: shared formatters render every CLI command through formatHint", () => {
  const files = scannedFiles();
  assert.ok(files.some((file) => file.endsWith("agentMessageText.ts")) && files.length > 20, "the scan covers the formatters");
  const offenders: string[] = [];
  const used = new Set<string>();
  for (const file of files) {
    const rel = relative(SRC, file);
    for (const literal of stringLiterals(file)) {
      if (!CLI_COMMAND.test(literal) && !CLI_COMMAND_PREFIX.test(literal)) continue;
      const allowed = ALLOWED.find((entry) => entry.file === rel && entry.literal === literal);
      if (allowed) used.add(`${allowed.file}:${allowed.literal}`);
      else offenders.push(`${rel}: ${JSON.stringify(literal)}`);
    }
  }
  assert.deepEqual(offenders, [], "hand-written CLI commands: build them with a RAFT_HINTS builder and formatHint");
  assert.deepEqual([...used].sort(), ALLOWED.map((entry) => `${entry.file}:${entry.literal}`).sort(), "every allow-list entry is still needed");
});
