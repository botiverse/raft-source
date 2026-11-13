import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  buildContextEntries,
  buildSessionContext,
  CURRENT_SESSION_VERSION,
  getLastAssistantUsage,
  getLatestCompactionEntry,
  SessionManager,
  VIRTUAL_MODEL_STATE_ENTRY,
  type AgentSession,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { RUNTIME_CONFIG_VERSION } from "@botiverse/raft-shared";
import { buildBuiltInAgentDir, buildBuiltInSessionDir, createPiAgentSessionForContext } from "./pi";
import { buildPiSessionSeed, piSessionRotationPaths, type PiSessionSeed, type PiSessionSeedSource } from "./piSessionSeed";
import type { SpawnContext } from "./types";

// The seed must rebuild exactly what pi rebuilds from the original session:
// the model context, every "last entry of kind X" lookup pi performs on the
// branch, a resume through pi's own SessionManager, and the next provider
// request. Each check runs pi's real functions on both sides. Branch lookups
// pi does not export (model selection, virtual model state, the codemode
// store) are loaded from the installed package's own module files.

// Literal, extensionless specifiers: the daemon runtime boundary check must
// resolve them, and relative imports carry no file extension (bundler resolution).
const { getBranchSelection, getVirtualModelState, VIRTUAL_MODEL_API } = await import(
  "../../node_modules/@earendil-works/pi-coding-agent/dist/core/virtual-models"
);
const { readCodemodeStore } = await import(
  "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/execute"
);
const { CODEMODE_STORE_ENTRY_TYPE } = await import(
  "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/tool"
);

// After any session a test creates: the seed's name must sort after the old file's.
const NOW = new Date("2099-01-01T08:00:00.000Z");
const SESSION_ID = "0199f1c2-seed-test";
const PHYSICAL = { provider: "anthropic", model: "claude-sonnet" };
const OTHER = { provider: "openai", model: "gpt-mini" };
const ROUTER = { provider: "router", model: "auto" };
const ROUTER_B = { provider: "router", model: "cheap" };
/** The catalog getBranchSelection consults: the router models are virtual. */
const catalog = (provider: string, modelId: string) =>
  ({ api: provider === ROUTER.provider ? VIRTUAL_MODEL_API : "anthropic-messages", provider, id: modelId }) as Model<Api>;

function session() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-session-seed-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return SessionManager.create(dir, dir, { id: SESSION_ID });
}

let clock = 0;
function user(sm: SessionManager, text: string): string {
  return sm.appendMessage({ role: "user", content: `${text} ${"words ".repeat(50)}`, timestamp: ++clock });
}
function assistant(sm: SessionManager, text: string, model: { provider: string; model: string } = PHYSICAL, api = "anthropic-messages"): string {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api,
    provider: model.provider,
    model: model.model,
    usage: { input: 100 + clock, output: 10, cacheRead: 5, cacheWrite: 1, totalTokens: 116 + clock, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: ++clock,
  };
  return sm.appendMessage(message);
}
function turn(sm: SessionManager, label: string, model?: { provider: string; model: string }): string {
  const id = user(sm, `${label} question`);
  assistant(sm, `${label} answer`, model);
  return id;
}

const asWritten = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function withoutParent(entries: SessionEntry[]) {
  return entries.map(({ parentId: _parentId, ...rest }) => rest);
}

function lastOf<T extends SessionEntry["type"]>(branch: SessionEntry[], type: T): Extract<SessionEntry, { type: T }> | undefined {
  return [...branch].reverse().find((entry): entry is Extract<SessionEntry, { type: T }> => entry.type === type);
}

/** Every branch lookup pi (and an extension reloading its state) performs. */
function branchState(branch: SessionEntry[]) {
  return {
    selection: getBranchSelection(branch, catalog),
    hasThinkingEntry: branch.some((entry) => entry.type === "thinking_level_change"),
    thinkingLevel: lastOf(branch, "thinking_level_change")?.thinkingLevel,
    virtualModelState: [ROUTER, ROUTER_B].map((model) => getVirtualModelState(branch, model.provider, model.model)),
    // An extension that folds every entry of its customType.
    codemodeStore: readCodemodeStore(branch),
    sessionInfo: lastOf(branch, "session_info")?.name,
    lastAssistantUsage: getLastAssistantUsage(branch),
    latestCompaction: getLatestCompactionEntry(branch)?.id,
  };
}

function seedOf(sm: SessionManager): PiSessionSeed {
  const seed = buildPiSessionSeed(sm, { now: NOW, oldFileBytes: statSync(sm.getSessionFile()!).size });
  assert.equal(seed.rotatable, true, JSON.stringify(seed));
  return seed;
}

/** Context, state and round-trip parity of the seed of `sm`'s current branch. */
function assertSeedParity(sm: SessionManager): PiSessionSeed {
  const seed = seedOf(sm);
  const branch = sm.getBranch();

  // Context parity: pi's own builders, seed vs original. Entries differ only in
  // parentId; the model context is byte-identical.
  assert.deepEqual(withoutParent(buildContextEntries(seed.entries)), withoutParent(sm.buildContextEntries()));
  assert.equal(JSON.stringify(buildSessionContext(seed.entries)), JSON.stringify(sm.buildSessionContext()));

  // State parity.
  assert.deepEqual(branchState(seed.entries), branchState(branch));

  // Round trip: write the seed under its name, retire the old file the way
  // rotation will, and resume the same id through pi.
  const oldFile = sm.getSessionFile()!;
  const dir = path.dirname(oldFile);
  assert.deepEqual(piSessionRotationPaths(oldFile, SESSION_ID, NOW), { seedFile: seed.seedFile, rotatedOldFile: seed.rotatedOldFile });
  assert.equal(path.basename(seed.seedFile), `2099-01-01T08-00-00-000Z_${SESSION_ID}.jsonl`);
  assert.equal(seed.rotatedOldFile, `${oldFile}.rotated`);
  writeFileSync(seed.seedFile, seed.content);
  renameSync(oldFile, seed.rotatedOldFile);
  try {
    assert.equal(SessionManager.findById(dir, SESSION_ID, dir), seed.seedFile);
    const resumed = SessionManager.open(seed.seedFile, dir);
    assert.equal(resumed.getSessionId(), SESSION_ID);
    assert.deepEqual(resumed.getHeader(), {
      type: "session", version: CURRENT_SESSION_VERSION, id: SESSION_ID, timestamp: NOW.toISOString(), cwd: sm.getCwd(), parentSession: seed.rotatedOldFile,
    });
    assert.equal(resumed.getLeafId(), sm.getLeafId());
    // As written: JSON drops the fields pi leaves undefined in memory.
    assert.deepEqual(resumed.getBranch(), asWritten(seed.entries));
    assert.deepEqual(resumed.buildContextEntries(), asWritten(buildContextEntries(seed.entries)));
    assert.equal(JSON.stringify(resumed.buildSessionContext()), JSON.stringify(sm.buildSessionContext()));
    assert.equal(resumed.getSessionName(), sm.getSessionName());
    for (const entry of seed.entries) assert.equal(resumed.getLabel(entry.id), sm.getLabel(entry.id), `label of ${entry.id}`);
  } finally {
    renameSync(seed.rotatedOldFile, oldFile);
    rmSync(seed.seedFile);
  }

  assert.deepEqual(seed.stats, {
    entries_before: sm.getEntryCount(),
    bytes_before: statSync(oldFile).size,
    entries_after: seed.entries.length,
    bytes_after: Buffer.byteLength(seed.content),
  });
  return seed;
}

const types = (seed: PiSessionSeed) => seed.entries.map((entry) => entry.type);

test("one compaction: the kept segment verbatim after the last model and thinking level", () => {
  const sm = session();
  sm.appendModelChange(PHYSICAL.provider, PHYSICAL.model);
  sm.appendThinkingLevelChange("high");
  turn(sm, "t1");
  turn(sm, "t2");
  const firstKept = turn(sm, "t3");
  turn(sm, "t4");
  sm.appendCompaction("summary of t1..t2", firstKept, 1234);
  turn(sm, "t5");

  const seed = assertSeedParity(sm);
  const branch = sm.getBranch();
  const segment = branch.slice(branch.findIndex((entry) => entry.id === firstKept));
  assert.deepEqual(types(seed), ["model_change", "thinking_level_change", ...segment.map((entry) => entry.type)]);
  // Original ids and contents; only parent ids are re-chained.
  assert.deepEqual(withoutParent(seed.entries.slice(2)), withoutParent(segment));
  assert.deepEqual(seed.entries.map((entry) => entry.parentId), [null, ...seed.entries.slice(0, -1).map((entry) => entry.id)]);
  assert.ok(seed.stats.entries_after < seed.stats.entries_before);
  assert.ok(seed.stats.bytes_after < seed.stats.bytes_before);
});

test("multiple compactions: seeds from the latest, an older one inside its segment included", () => {
  const sm = session();
  sm.appendModelChange(PHYSICAL.provider, PHYSICAL.model);
  turn(sm, "t1");
  const keptByFirst = turn(sm, "t2");
  sm.appendCompaction("first summary", keptByFirst, 100);
  const keptBySecond = turn(sm, "t3");
  turn(sm, "t4");
  sm.appendCompaction("second summary", keptBySecond, 200);
  turn(sm, "t5");
  const latest = sm.getLeafEntry();
  const keptByThird = turn(sm, "t6");
  // The third compaction keeps from before the second, so the second sits in
  // its segment, as pi's own projection retains it.
  sm.appendCompaction("third summary", keptBySecond, 300);
  turn(sm, "t7");

  const seed = assertSeedParity(sm);
  assert.equal(seed.entries.filter((entry) => entry.type === "compaction").length, 2);
  assert.ok(seed.entries.some((entry) => entry.id === latest?.id));
  assert.ok(seed.entries.some((entry) => entry.id === keptByThird));
  assert.ok(!seed.entries.some((entry) => entry.id === keptByFirst));
});

test("multiple branches: only the current branch, leaf on a side branch", () => {
  const sm = session();
  sm.appendModelChange(PHYSICAL.provider, PHYSICAL.model);
  sm.appendThinkingLevelChange("low");
  const fork = turn(sm, "shared");
  const forkLeaf = sm.getLeafId()!;
  // The main branch: its own state, compaction and turns.
  sm.appendModelChange(OTHER.provider, OTHER.model);
  sm.appendThinkingLevelChange("high");
  sm.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY, { provider: ROUTER.provider, modelId: ROUTER.model, state: { on: "main" } });
  const mainKept = turn(sm, "main-1", OTHER);
  sm.appendCompaction("main summary", mainKept, 100);
  turn(sm, "main-2", OTHER);
  const mainOnly = sm.getBranch().slice(sm.getBranch().findIndex((entry) => entry.id === forkLeaf) + 1).map((entry) => entry.id);

  // The side branch, created after the main branch, holds the leaf.
  sm.branch(forkLeaf);
  sm.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY, { provider: ROUTER.provider, modelId: ROUTER.model, state: { on: "side" } });
  turn(sm, "side-1");
  const sideKept = turn(sm, "side-2");
  sm.appendCompaction("side summary", sideKept, 100);
  turn(sm, "side-3");
  assert.ok(fork);

  const seed = assertSeedParity(sm);
  const seedIds = new Set(seed.entries.map((entry) => entry.id));
  assert.deepEqual(mainOnly.filter((id) => seedIds.has(id)), []);
  assert.deepEqual(seed.entries.map((entry) => entry.type === "thinking_level_change" ? entry.thinkingLevel : null).filter(Boolean), ["low"]);
});

test("context edits targeting kept entries replay; edits of dropped entries stay inert", () => {
  const sm = session();
  sm.appendModelChange(PHYSICAL.provider, PHYSICAL.model);
  const dropped = turn(sm, "t1");
  sm.appendContextEdit(dropped, { content: "edited before the segment" });
  const firstKept = turn(sm, "t2");
  const keptAnswer = sm.getLeafId()!;
  turn(sm, "t3");
  sm.appendContextEdit(firstKept, { content: "replaced kept question" });
  sm.appendCompaction("summary", firstKept, 100);
  const later = turn(sm, "t4");
  sm.appendContextEdit(keptAnswer, null);
  sm.appendContextEdit(later, { content: "replaced later question" });

  const seed = assertSeedParity(sm);
  assert.deepEqual(
    seed.entries.flatMap((entry) => entry.type === "context_edit" ? [entry.targetId] : []),
    [firstKept, keptAnswer, later],
  );
  const context = JSON.stringify(buildSessionContext(seed.entries).messages);
  assert.match(context, /replaced kept question/);
  assert.match(context, /replaced later question/);
  assert.doesNotMatch(context, /t2 answer/);
});

test("model switches before and after the compaction, including a virtual selection", () => {
  const sm = session();
  sm.appendModelChange(OTHER.provider, OTHER.model);
  turn(sm, "t1", OTHER);
  // A virtual selection holds across the physical models it routes to.
  sm.appendModelChange(ROUTER.provider, ROUTER.model);
  turn(sm, "t2", PHYSICAL);
  const firstKept = turn(sm, "t3", PHYSICAL);
  sm.appendCompaction("summary", firstKept, 100);
  turn(sm, "t4", PHYSICAL);
  const seed = assertSeedParity(sm);
  assert.deepEqual(getBranchSelection(seed.entries, catalog), { provider: ROUTER.provider, modelId: ROUTER.model });

  // A switch after the compaction wins on both sides.
  sm.appendModelChange(OTHER.provider, OTHER.model);
  turn(sm, "t5", OTHER);
  assertSeedParity(sm);
});

test("thinking level changes before and after the compaction", () => {
  const sm = session();
  sm.appendModelChange(PHYSICAL.provider, PHYSICAL.model);
  sm.appendThinkingLevelChange("low");
  turn(sm, "t1");
  sm.appendThinkingLevelChange("medium");
  const firstKept = turn(sm, "t2");
  sm.appendCompaction("summary", firstKept, 100);
  turn(sm, "t3");
  const seed = assertSeedParity(sm);
  assert.equal(buildSessionContext(seed.entries).thinkingLevel, "medium");

  sm.appendThinkingLevelChange("xhigh");
  turn(sm, "t4");
  assert.equal(buildSessionContext(assertSeedParity(sm).entries).thinkingLevel, "xhigh");
});

test("custom entries: router state carried per virtual model, other custom state only inside the segment", () => {
  const sm = session();
  sm.appendModelChange(ROUTER.provider, ROUTER.model);
  sm.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY, { provider: ROUTER.provider, modelId: ROUTER.model, state: { pick: 1 } });
  turn(sm, "t1");
  sm.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY, { provider: ROUTER_B.provider, modelId: ROUTER_B.model, state: { pick: "b" } });
  sm.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY, { provider: ROUTER.provider, modelId: ROUTER.model, state: { pick: 2 } });
  const firstKept = turn(sm, "t2");
  sm.appendCustomEntry(CODEMODE_STORE_ENTRY_TYPE, { set: { a: 1 }, delete: [] });
  sm.appendCompaction("summary", firstKept, 100);
  sm.appendCustomEntry(CODEMODE_STORE_ENTRY_TYPE, { set: { b: 2 }, delete: [] });
  turn(sm, "t3");

  const seed = assertSeedParity(sm);
  const carried = seed.entries.slice(0, seed.entries.findIndex((entry) => entry.id === firstKept));
  assert.deepEqual(carried.map((entry) => entry.type === "custom" ? [entry.customType, entry.data] : [entry.type]), [
    ["model_change"],
    [VIRTUAL_MODEL_STATE_ENTRY, { provider: ROUTER_B.provider, modelId: ROUTER_B.model, state: { pick: "b" } }],
    [VIRTUAL_MODEL_STATE_ENTRY, { provider: ROUTER.provider, modelId: ROUTER.model, state: { pick: 2 } }],
  ]);
  assert.deepEqual(getVirtualModelState(seed.entries, ROUTER_B.provider, ROUTER_B.model), { pick: "b" });
  assert.deepEqual(readCodemodeStore(seed.entries), { a: 1, b: 2 });
});

test("refuses custom state of unknown semantics from before the segment", () => {
  // pi's codemode store folds every delta: keeping only the last would lose `a`.
  const sm = session();
  sm.appendModelChange(PHYSICAL.provider, PHYSICAL.model);
  sm.appendCustomEntry(CODEMODE_STORE_ENTRY_TYPE, { set: { a: 1 }, delete: [] });
  turn(sm, "t1");
  sm.appendCustomEntry(CODEMODE_STORE_ENTRY_TYPE, { set: { b: 2 }, delete: [] });
  const firstKept = turn(sm, "t2");
  sm.appendCompaction("summary", firstKept, 100);
  turn(sm, "t3");
  assert.deepEqual(readCodemodeStore(sm.getBranch()), { a: 1, b: 2 });
  assert.deepEqual(buildPiSessionSeed(sm, { now: NOW, oldFileBytes: 1 }), {
    rotatable: false, reason: "unknown_custom_type", customType: CODEMODE_STORE_ENTRY_TYPE,
  });
});

test("session_info and labels", () => {
  const sm = session();
  sm.appendModelChange(PHYSICAL.provider, PHYSICAL.model);
  sm.appendSessionInfo("first name");
  const dropped = turn(sm, "t1");
  sm.appendLabelChange(dropped, "old bookmark");
  sm.appendSessionInfo("second name");
  const firstKept = turn(sm, "t2");
  sm.appendLabelChange(firstKept, "kept bookmark");
  sm.appendCompaction("summary", firstKept, 100);
  turn(sm, "t3");

  const seed = assertSeedParity(sm);
  assert.equal(seed.entries.filter((entry) => entry.type === "session_info").length, 1);
  // A label lives beside its target: a dropped target takes its labels along.
  assert.deepEqual(seed.entries.flatMap((entry) => entry.type === "label" ? [entry.targetId] : []), [firstKept]);

  sm.appendSessionInfo("renamed after compaction");
  turn(sm, "t4");
  assertSeedParity(sm);
});

test("a compaction that keeps nothing before itself seeds from the compaction", () => {
  const sm = session();
  sm.appendModelChange(PHYSICAL.provider, PHYSICAL.model);
  turn(sm, "t1");
  const compaction = sm.appendCompaction("summary", null, 100);
  turn(sm, "t2");
  const seed = assertSeedParity(sm);
  assert.deepEqual(types(seed), ["model_change", "compaction", "message", "message"]);
  assert.equal(seed.entries[1]!.id, compaction);
});

test("refuses what it cannot seed, without throwing", () => {
  const refusal = (source: PiSessionSeedSource) => buildPiSessionSeed(source, { now: NOW, oldFileBytes: 1 });

  const plain = session();
  turn(plain, "t1");
  assert.deepEqual(refusal(plain), { rotatable: false, reason: "no_compaction" });

  const lost = session();
  turn(lost, "t1");
  lost.appendCompaction("summary", "not-an-entry", 100);
  turn(lost, "t2");
  assert.deepEqual(refusal(lost), { rotatable: false, reason: "first_kept_entry_not_on_branch" });

  // The kept entry exists, but on another branch.
  const elsewhere = session();
  const root = turn(elsewhere, "t1");
  const otherBranch = turn(elsewhere, "t2");
  elsewhere.branch(root);
  elsewhere.appendCompaction("summary", otherBranch, 100);
  turn(elsewhere, "t3");
  assert.deepEqual(refusal(elsewhere), { rotatable: false, reason: "first_kept_entry_not_on_branch" });

  // pi would read the model from the dropped history.
  const unanswered = session();
  turn(unanswered, "t1");
  const kept = user(unanswered, "t2 question");
  unanswered.appendCompaction("summary", kept, 100);
  assert.deepEqual(refusal(unanswered), { rotatable: false, reason: "no_response_in_kept_segment" });
  // A response that failed to route names the virtual model, not a physical one.
  assistant(unanswered, "routing failed", ROUTER, VIRTUAL_MODEL_API);
  assert.deepEqual(refusal(unanswered), { rotatable: false, reason: "no_response_in_kept_segment" });
  assistant(unanswered, "t2 answer");
  assert.equal(refusal(unanswered).rotatable, true);

  // A kept entry after the compaction is not one pi keeps.
  const keptAfter = seedSource(session(), (branch) => branch.map((entry) =>
    entry.type === "compaction" ? { ...entry, firstKeptEntryId: branch.at(-1)!.id } : entry));
  assert.deepEqual(refusal(keptAfter), { rotatable: false, reason: "first_kept_entry_not_on_branch" });

  const future = seedSource(session(), (branch) => [...branch.slice(0, 1), { ...branch[1]!, type: "future_kind" } as unknown as SessionEntry, ...branch.slice(2)]);
  assert.deepEqual(refusal(future), { rotatable: false, reason: "unknown_entry_type", entryType: "future_kind" });

  const oldVersion = seedSource(session(), (branch) => branch, 2);
  assert.deepEqual(refusal(oldVersion), { rotatable: false, reason: "unsupported_session_version", version: 2 });

  // The seed's name must sort after the old file's, which carries the
  // session's creation time.
  const named = session();
  seedSource(named, (branch) => branch);
  const created = new Date(named.getHeader()!.timestamp).getTime();
  const at = (ms: number) => buildPiSessionSeed(named, { now: new Date(ms), oldFileBytes: 1 });
  assert.deepEqual(at(created), { rotatable: false, reason: "seed_name_not_newer" });
  assert.deepEqual(at(created - 1), { rotatable: false, reason: "seed_name_not_newer" });
  assert.equal(at(created + 1).rotatable, true);

  const inMemory = SessionManager.inMemory();
  turn(inMemory, "t1");
  assert.deepEqual(refusal(inMemory), { rotatable: false, reason: "no_session_file" });
});

/** A compacted session whose branch or header version a test rewrites. */
function seedSource(sm: SessionManager, rewrite: (branch: SessionEntry[]) => SessionEntry[], version = CURRENT_SESSION_VERSION): PiSessionSeedSource {
  sm.appendModelChange(PHYSICAL.provider, PHYSICAL.model);
  const firstKept = turn(sm, "t1");
  sm.appendCompaction("summary", firstKept, 100);
  turn(sm, "t2");
  assert.equal(buildPiSessionSeed(sm, { now: NOW, oldFileBytes: 1 }).rotatable, true);
  return {
    getHeader: () => ({ ...sm.getHeader()!, version }),
    getBranch: () => rewrite(sm.getBranch()),
    getEntryCount: () => sm.getEntryCount(),
    getSessionFile: () => sm.getSessionFile(),
  };
}

// The real thing: a Built-in session through the daemon's own driver against a
// loopback Anthropic-compatible provider, compacted twice by pi itself. The
// next request after resuming the seed must be the request the original
// session sends, byte for byte, under the same session id.
test("the next provider request from the resumed seed equals the original's", { timeout: 60_000 }, async () => {
  const bodies: string[] = [];
  const provider = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "fake-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 0 } } });
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `answer ${"lorem ipsum ".repeat(200)}` } });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 200 } });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  const port = await listen(provider);
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-session-seed-e2e-"));
  const workingDirectory = path.join(root, "ws");
  mkdirSync(workingDirectory, { recursive: true });
  onTestFinished(async () => {
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  const sessionId = "pi-seed-e2e";
  const ctx = (resume: boolean): SpawnContext => ({
    agentId: "agent-seed", standingPrompt: "standing instructions", prompt: "wake", workingDirectory, slockCliPath: "/tmp/slock-cli.js", daemonApiKey: "x", launchId: "launch-seed",
    config: {
      name: "Seed", displayName: null, description: null, runtime: "builtin", serverUrl: "https://slock.example", authToken: "t",
      sessionId: resume ? sessionId : null, model: "fake-model", reasoningEffort: null, envVars: null, runtimeContext: null,
      runtimeConfig: {
        version: RUNTIME_CONFIG_VERSION, runtime: "builtin",
        provider: { kind: "gateway", providerId: "anthropic-compatible", baseUrl: `http://127.0.0.1:${port}/anthropic`, apiKey: "fake" },
        hostUserState: "forbidden", model: { kind: "custom", name: "fake-model" }, mode: { kind: "default" },
      },
    },
  });
  const open = (resume: boolean) => createPiAgentSessionForContext(ctx(resume), sessionId, {
    agentDir: buildBuiltInAgentDir(workingDirectory), sessionDir: buildBuiltInSessionDir(workingDirectory),
    agentDirSource: "managed_builtin", exposeLaunchEnvToTools: false, isolateHostProviderEnv: true,
  });
  const prompt = (session: AgentSession, n: number) => session.prompt(`turn ${n}: ${"context line with some words ".repeat(1400)}`);

  let session = await open(false);
  for (let n = 1; n <= 4; n++) await prompt(session, n);
  await session.compact();
  for (let n = 5; n <= 6; n++) await prompt(session, n);
  await session.compact();
  await prompt(session, 7);
  const sessionFile = session.sessionManager.getSessionFile()!;
  session.dispose();
  const original = readFileSync(sessionFile);

  // Without rotation.
  session = await open(true);
  let from = bodies.length;
  await prompt(session, 8);
  const unrotated = bodies.slice(from);
  session.dispose();

  // With rotation, from the same original.
  writeFileSync(sessionFile, original);
  const old = SessionManager.open(sessionFile, path.dirname(sessionFile), workingDirectory);
  assert.equal(old.getBranch().filter((entry) => entry.type === "compaction").length, 2, "pi compacted twice");
  const seed = buildPiSessionSeed(old, { now: new Date(), oldFileBytes: original.length });
  assert.equal(seed.rotatable, true, JSON.stringify(seed));
  if (!seed.rotatable) return;
  assert.deepEqual(withoutParent(buildContextEntries(seed.entries)), withoutParent(old.buildContextEntries()));
  writeFileSync(seed.seedFile, seed.content);
  renameSync(sessionFile, seed.rotatedOldFile);
  session = await open(true);
  assert.equal(session.sessionManager.getSessionFile(), seed.seedFile, "the daemon resumed the seed");
  assert.equal(session.sessionManager.getSessionId(), sessionId);
  from = bodies.length;
  await prompt(session, 8);
  const rotated = bodies.slice(from);
  session.dispose();

  const sha = (body: string) => createHash("sha256").update(body).digest("hex").slice(0, 16);
  assert.ok(unrotated.length > 0);
  assert.deepEqual(rotated.map(sha), unrotated.map(sha));
  assert.equal(rotated[0], unrotated[0]);
  assert.ok(seed.stats.bytes_after < seed.stats.bytes_before, JSON.stringify(seed.stats));
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as AddressInfo).port;
}
