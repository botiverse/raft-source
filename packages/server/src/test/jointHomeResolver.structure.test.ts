// #460: an object homed in a joint channel names the joint's canonical
// channel, a channel of the `joint_storage` server (`joint-storage-<uuid>`),
// and a joint's messages are stored there too. Whatever shows such a home to
// a person or an agent, or decides with it, maps it to the reader's server's
// projection first (platform/conversations: conversationNames for people,
// agentConversationRefs / agentConversationTargets for agents,
// localConversationIds for decisions; all on visibilityService
// jointHomeProjections). Two mechanical guards:
//
// A. A production file that reads a home (homeChannelId, home_channel_id,
//    originalHomeChannelId) and names a channel (channels.name,
//    getChannel(…).name, or builds a `#${…}` ref) imports one of those
//    resolvers, or is listed in RULE_A_ALLOWED with why it needs none. The
//    list only shrinks: an entry that no longer needs to be there fails too.
// B. A home is not passed on as a conversation (`relatedChannelId:` or
//    `channelId: <x>.homeChannelId`) outside the files that store or read it
//    as the stored home (RULE_B_ALLOWED, each with why): anywhere else it
//    would reach a reader unmapped. An entry with no such line any more fails
//    too.
//
// Heuristics over source text: they name the failure they catch, not every
// way to write it (a name read through another helper passes). Review owns
// the rest (docs/development/review-principles.md, joint-channel access).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const READS_HOME = /\b(?:homeChannelId|home_channel_id|originalHomeChannelId)\b/;
const NAMES_CHANNEL = /\bchannels\.name\b|getChannel\([^)]*\)\)?\??\.name\b|`#\$\{/;
const IMPORTS_RESOLVER = /import\s[^;]*?\b(?:conversationNames|agentConversationRefs|agentConversationTargets|localConversationIds|jointHomeProjections)\b[^;]*?from\s/s;
const HOME_AS_CONVERSATION = /\b(?:relatedChannelId|channelId)\s*:\s*[A-Za-z_$][\w$]*(?:\?\.|\.)homeChannelId\b/;

/** Rule A's ratchet: files that read a home and name a channel without a resolver, and why that is right. */
const RULE_A_ALLOWED: Record<string, string> = {};

/** Rule B: files that pass a home on as a conversation id, and why it is the stored home there, not a reader's. */
const RULE_B_ALLOWED: Record<string, string> = {
  // Storage writers: the stored home itself.
  "apps/artifacts/events.ts": "records the home on object events as stored; readers map it (objectActivity)",
  "apps/artifacts/publish.ts": "stores the home a publish resolved (a joint's canonical channel)",
  "apps/artifacts/publishAs.ts": "the home a person's publish places into, stored as the joint's canonical channel (postableConversation)",
  "apps/artifacts/takedown.ts": "the stored home a name is unique in",
  "platform/visibility.ts": "homeOf: the stored home, which canViewHomes decides by each server's projection",
  // Readers that hand the stored home to a caller who maps it.
  "apps/artifacts/notices.ts": "relatedChannelId is stored; the agent inbox renders it by the agent's projection (agentInboxItems renderRelatedTargets)",
  "apps/artifacts/readAsUser.ts": "homeAllowed gets the stored home; the caller decides with it (assistantOwnerArtifactAsOwner maps it to the owner's projection; the read path's mapping is #triage:#462)",
};

function rel(file: string): string {
  return path.relative(SRC, file).split(path.sep).join("/");
}

test("#460 rule A: a file that reads a home and names a channel maps the home through a joint resolver (ratchet)", () => {
  const files = sourceFiles(SRC);
  assert.ok(files.some((file) => rel(file) === "services/objectActivity.ts"), "the scan must reach services/");
  const offenders: string[] = [];
  const unneeded: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const candidate = READS_HOME.test(text) && NAMES_CHANNEL.test(text) && !IMPORTS_RESOLVER.test(text);
    const listed = rel(file) in RULE_A_ALLOWED;
    if (candidate && !listed) offenders.push(rel(file));
    if (!candidate && listed) unneeded.push(rel(file));
  }
  for (const listed of Object.keys(RULE_A_ALLOWED)) if (!existsSync(path.join(SRC, listed))) unneeded.push(listed);
  assert.deepEqual(offenders, [], "map the home first (platform/conversations conversationNames / agentConversationRefs / agentConversationTargets / localConversationIds), or list the file in RULE_A_ALLOWED with why it needs none");
  assert.deepEqual(unneeded, [], "the file no longer needs its RULE_A_ALLOWED entry: remove it");
});

test("#460 rule B: a home is passed on as a conversation id only where it is the stored home", () => {
  const offenders: string[] = [];
  const matched = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      if (!HOME_AS_CONVERSATION.test(line)) return;
      matched.add(rel(file));
      if (!(rel(file) in RULE_B_ALLOWED)) offenders.push(`${rel(file)}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], "map the home to the reader's projection first (platform/conversations localConversationIds), or list the file in RULE_B_ALLOWED if it stores the home");
  const unneeded = Object.keys(RULE_B_ALLOWED).filter((listed) => !matched.has(listed));
  assert.deepEqual(unneeded, [], "the file no longer passes a home on as a conversation id: remove its RULE_B_ALLOWED entry");
});

test("#460: the scans catch what they name", () => {
  assert.ok(READS_HOME.test("const id = item.homeChannelId;"));
  assert.ok(READS_HOME.test("sql`home_channel_id = ${id}`"));
  assert.ok(READS_HOME.test("shown.originalHomeChannelId"));
  assert.ok(!READS_HOME.test("const homeChannelIds = [];"));
  assert.ok(NAMES_CHANNEL.test("select({ name: channels.name })"));
  assert.ok(NAMES_CHANNEL.test("(await channelService.getChannel(id))?.name"));
  assert.ok(NAMES_CHANNEL.test("return `#${row.name}`;"));
  assert.ok(!NAMES_CHANNEL.test("channel.name"));
  assert.ok(IMPORTS_RESOLVER.test(`import { conversationNames, type ConversationName } from "../../platform/conversations";`));
  assert.ok(IMPORTS_RESOLVER.test(`import {\n  canView,\n  jointHomeProjections,\n} from "./visibilityService";`));
  assert.ok(!IMPORTS_RESOLVER.test(`import { postableConversation } from "../platform/conversations";\nconst x = conversationNames;`));
  assert.ok(HOME_AS_CONVERSATION.test("    relatedChannelId: item.homeChannelId ?? null,"));
  assert.ok(HOME_AS_CONVERSATION.test("{ kind: \"conversation\", channelId: located?.homeChannelId }"));
  assert.ok(!HOME_AS_CONVERSATION.test("    channelId: local,"));
  assert.ok(!HOME_AS_CONVERSATION.test("    homeChannelId: item.homeChannelId,"));
});
