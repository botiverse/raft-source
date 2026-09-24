import assert from "node:assert/strict";
import test from "node:test";
import {
  createRaftBareTaskRefRegex,
  createRaftDmThreadRefRegex,
  createRaftUserRefRegex,
  extractRaftMentionHandles,
  extractRaftRefTargets,
  formatRaftRefTarget,
  parseRaftRefTarget,
  replaceOutsideMarkdownCode,
  structuredRaftMentionStillAppears,
  type RaftTargetString,
} from "./raftRefs.js";

// --- Type-level guarantees for RaftTargetString (enforced by `tsc --noEmit`) ---
// formatRaftRefTarget's return is the precise wire form, not an opaque string:
const _formattedIsTargetString: RaftTargetString = formatRaftRefTarget({ kind: "channel", channelName: "x" });
void _formattedIsTargetString;
// Well-formed targets are assignable; malformed ones are compile-time errors:
const _okChannel: RaftTargetString = "#general";
const _okDmThread: RaftTargetString = "dm:@alice:1a2b3c";
// dm-message wire forms are now part of the type (parser/type kept in sync):
const _okDmMsg: RaftTargetString = "dm:@alice msg=abc12345";
const _okDmThreadMsg: RaftTargetString = "dm:@alice:1a2b3c msg=abc12345";
const _okComputer: RaftTargetString = "computer:550e8400-e29b-41d4-a716-446655440000";
const _okApp: RaftTargetString = "app:system.reminder";
void _okDmMsg;
void _okDmThreadMsg;
void _okComputer;
void _okApp;
// @ts-expect-error — a dm peer without the leading '@' is not a valid target
const _badDm: RaftTargetString = "dm:alice";
// @ts-expect-error — a bare name with no sigil is not a valid target
const _badBare: RaftTargetString = "general";
void _okChannel;
void _okDmThread;
void _badDm;
void _badBare;

test("parseRaftRefTarget parses v0.4 ref target kinds", () => {
  assert.deepEqual(parseRaftRefTarget("@alice"), { kind: "user", name: "alice" });
  assert.deepEqual(parseRaftRefTarget("#proj-message"), { kind: "channel", channelName: "proj-message" });
  assert.deepEqual(parseRaftRefTarget("#对话流专修"), { kind: "channel", channelName: "对话流专修" });
  assert.deepEqual(parseRaftRefTarget("#proj-message:e7aad473"), {
    kind: "channel-thread",
    channelName: "proj-message",
    threadShortId: "e7aad473",
  });
  assert.deepEqual(parseRaftRefTarget("dm:@alice"), { kind: "dm", peerName: "alice" });
  assert.deepEqual(parseRaftRefTarget("dm:@system.reminder"), {
    kind: "dm",
    peerName: "system.reminder",
  });
  assert.deepEqual(parseRaftRefTarget("dm:@alice:e7aad473"), {
    kind: "dm-thread",
    peerName: "alice",
    threadShortId: "e7aad473",
  });
  assert.deepEqual(parseRaftRefTarget("task #123"), { kind: "task", taskNumber: 123 });
  assert.deepEqual(parseRaftRefTarget("computer:550e8400-e29b-41d4-a716-446655440000"), {
    kind: "computer",
    machineId: "550e8400-e29b-41d4-a716-446655440000",
  });
  assert.deepEqual(parseRaftRefTarget("app:system.reminder"), {
    kind: "app",
    appId: "system.reminder",
  });
  assert.deepEqual(parseRaftRefTarget("#proj-message msg=abc12345"), {
    kind: "message",
    channelName: "proj-message",
    threadParentShortId: null,
    messageId: "abc12345",
  });
  assert.deepEqual(parseRaftRefTarget("#proj-message:e7aad473 msg=reply456"), {
    kind: "message",
    channelName: "proj-message",
    threadParentShortId: "e7aad473",
    messageId: "reply456",
  });
  assert.deepEqual(parseRaftRefTarget("dm:@alice msg=abc12345"), {
    kind: "dm-message",
    peerName: "alice",
    threadParentShortId: null,
    messageId: "abc12345",
  });
  assert.deepEqual(parseRaftRefTarget("dm:@alice:e7aad473 msg=reply456"), {
    kind: "dm-message",
    peerName: "alice",
    threadParentShortId: "e7aad473",
    messageId: "reply456",
  });
});

test("formatRaftRefTarget round-trips parsed targets", () => {
  for (const raw of [
    "@alice",
    "#general",
    "#general:abc12345",
    "dm:@alice",
    "dm:@alice:abc12345",
    "task #42",
    "computer:550e8400-e29b-41d4-a716-446655440000",
    "app:system.reminder",
    "#general msg=deadbeef",
    "#general:abc12345 msg=reply456",
    // dm-message forms — produced by agentPermalinkRenderService but, before the
    // dm-message kind was added, parseRaftRefTarget returned null for these
    // (so they failed the assert.ok below). This pins the producer/parser round-trip.
    "dm:@alice msg=deadbeef",
    "dm:@alice:abc12345 msg=reply456",
  ]) {
    const parsed = parseRaftRefTarget(raw);
    assert.ok(parsed, `expected ${raw} to parse`);
    assert.equal(formatRaftRefTarget(parsed), raw);
  }
});

test("replaceOutsideMarkdownCode leaves inline and fenced code literal", () => {
  const source = "open <#general>\n`<#code>`\n```md\n<#fenced>\n```\nthen <task #7>";
  const replaced = replaceOutsideMarkdownCode(source, (chunk) => chunk.replace(/</g, "["));

  assert.equal(replaced, "open [#general>\n`<#code>`\n```md\n<#fenced>\n```\nthen [task #7>");
});

test("shared bare token scanners cover user, task, and DM thread refs", () => {
  assert.deepEqual(Array.from("hi @Alice and @Bob".matchAll(createRaftUserRefRegex())).map((m) => m[1]), [
    " ",
    " ",
  ]);
  assert.deepEqual(Array.from("hi @Alice and @Bob".matchAll(createRaftUserRefRegex())).map((m) => m[2]), [
    "Alice",
    "Bob",
  ]);
  assert.deepEqual(
    Array.from("see task #42 and (#7) but not path/#9".matchAll(createRaftBareTaskRefRegex())).map((m) => [
      m[1],
      m[2] ?? "",
      m[3],
    ]),
    [
      [" ", "task ", "42"],
      ["(", "", "7"],
    ],
  );
  assert.deepEqual(
    Array.from("open dm:@alice:abc12345".matchAll(createRaftDmThreadRefRegex())).map((m) => [
      m[1],
      m[2],
    ]),
    [["alice", "abc12345"]],
  );
});

test("extractRaftMentionHandles includes bare, angle, named-link label, and named-link target mentions", () => {
  assert.deepEqual(
    extractRaftMentionHandles("hi @Bob and <@Alice> plus [@Carol](<@Dave>)").sort(),
    ["Alice", "Bob", "Carol", "Dave"],
  );
});

test("resource ref labels are inert and do not become human or agent mentions", () => {
  assert.deepEqual(
    extractRaftMentionHandles(
      "see [@Desk](<computer:550e8400-e29b-41d4-a716-446655440000>) and [@Reminder](<app:system.reminder>) plus [@Carol](<@Dave>)",
    ).sort(),
    ["Carol", "Dave"],
  );
});

test("extractRaftMentionHandles ignores code and escaped angle refs", () => {
  assert.deepEqual(
    extractRaftMentionHandles("hi \\<@Nope> `@Code` ```txt\n@Fence\n``` <@Yes>"),
    ["Yes"],
  );
});

test("extractRaftMentionHandles ignores package versions and email-like words", () => {
  assert.deepEqual(extractRaftMentionHandles("ship foo@1.2.3 and node@22 today"), []);
  assert.deepEqual(extractRaftMentionHandles("contact alice@example.com, then notify @Alice"), ["Alice"]);
});

test("extractRaftMentionHandles treats handle-character-prefixed at-signs as literal text", () => {
  assert.deepEqual(extractRaftMentionHandles("skip -@bob and _@bob, but notify - @Alice"), ["Alice"]);
});

test("extractRaftMentionHandles treats repeated handles existentially by occurrence", () => {
  assert.deepEqual(extractRaftMentionHandles("```\n@handle\n```\n@handle\n"), ["handle"]);
  assert.deepEqual(extractRaftMentionHandles("```\n@handle\n```\nx\n```\n@handle\n```\n"), []);
});

test("identity-backed mentions survive left-boundary edits without becoming prefix matches", () => {
  assert.equal(structuredRaftMentionStillAppears("先给个草案@Mona", "Mona"), true);
  assert.equal(structuredRaftMentionStillAppears("draft@Mona", "Mona"), true);
  assert.equal(structuredRaftMentionStillAppears("先给个草案 @Mona", "Mona"), true);
  assert.equal(structuredRaftMentionStillAppears("先给个草案@Mona继续", "Mona"), false);
  assert.equal(structuredRaftMentionStillAppears("ask `@Mona`", "Mona"), false);
  assert.equal(
    structuredRaftMentionStillAppears(
      "see [@Mona](<computer:550e8400-e29b-41d4-a716-446655440000>)",
      "Mona",
    ),
    false,
  );
  assert.equal(structuredRaftMentionStillAppears("draft@Mona", "Mona."), false);
});

test("extractRaftRefTargets covers unified side-effecting ref grammar", () => {
  const refs = extractRaftRefTargets([
    "@Alice",
    "#general",
    "#general:abc12345",
    "dm:@Bob",
    "dm:@Bob:deadbeef",
    "task #42",
    "#general msg=msg123",
    "[named](<#ops msg=abc12345>)",
    "[@Desk](<computer:550e8400-e29b-41d4-a716-446655440000>)",
    "[@Reminder](<app:system.reminder>)",
    "`@Code`",
    "```txt\n#Fence\n```",
  ].join("\n")).map((ref) => formatRaftRefTarget(ref.target)).sort();

  assert.deepEqual(refs, [
    "#general",
    "#general msg=msg123",
    "#general:abc12345",
    "#ops msg=abc12345",
    "@Alice",
    "app:system.reminder",
    "computer:550e8400-e29b-41d4-a716-446655440000",
    "dm:@Bob",
    "dm:@Bob:deadbeef",
    "task #42",
  ].sort());
});

test("extractRaftRefTargets reports source ranges for neutralization", () => {
  const source = [
    "contact alice@user_example_1.com",
    "ship foo@1.2.3",
    "prefixfoo#channel_example",
    "(#7)",
    "[named](<#ops msg=abc12345>)",
  ].join("\n");
  const refs = extractRaftRefTargets(source);

  assert.deepEqual(
    refs.map((ref) => ({ raw: ref.raw, slice: source.slice(ref.start, ref.end) })),
    [
      { raw: "#channel_example", slice: "#channel_example" },
      { raw: "task #7", slice: "#7" },
      { raw: "#ops msg=abc12345", slice: "#ops msg=abc12345" },
    ],
  );
});

test("extractRaftRefTargets skips markdown code and fenced refs", () => {
  // This pins the current Raft Ref parser contract. It is not, by itself, a
  // GTAS-002 Strong oracle for every future third-party readout surface: any
  // side-effect path used by a call site must prove it shares this code/fence
  // semantics or use its real extractor as the gate oracle.
  assert.deepEqual(
    extractRaftRefTargets([
      "`@CodeUser`",
      "```txt",
      "@FenceUser",
      "#fence-channel",
      "task #42",
      "```",
    ].join("\n")),
    [],
  );
});

// --- Markdown code-span overlap (task #92) ------------------------------------
//
// A fenced block followed by a backtick-wrapped name is the commonest shape we
// write. Its fence-closing backticks paired with that name's opening backtick
// into a spurious span straddling the fence, and every consumer walked the
// ranges with one forward cursor -- so the wrapped name fell through to prose.
// Measured on staging d6237b100 before the fix, and on the delivery face it
// woke the person (probe c548d35f; the same message minus the fence, 48ca364e,
// did not).

test("a fenced block does not leak the backtick-wrapped name that follows it", () => {
  // Fails before the fix: extraction returned ["handle"].
  assert.deepEqual(extractRaftMentionHandles("```\nx\n```\nA `@handle` B\n"), []);
  assert.deepEqual(extractRaftMentionHandles("a\n```\nx\n```\nB `@handle` C\n"), []);
  assert.deepEqual(extractRaftMentionHandles("```x```y`@handle`"), []);
  // Already covered before this change; kept so a fix that greens only this
  // shape is still visibly incomplete against the three above.
  assert.deepEqual(extractRaftMentionHandles("``a`` ```x``` `@handle`"), []);
});

test("an unwrapped name after a fenced block is still extracted", () => {
  // Guards the fix against over-suppression: the fence must not swallow prose.
  assert.deepEqual(extractRaftMentionHandles("```\nx\n```\nA @handle B\n"), ["handle"]);
});

test("prose outside code survives the walk byte for byte", () => {
  // FIX B in isolation: with an identity replacer the walk must be lossless for
  // ANY input. Before the fix, straddling ranges re-emitted already-written
  // text -- "A `B ```C``` D` E" came back with a fourth backtick on each side.
  for (const source of [
    "A `B ```C``` D` E",
    "```\nx\n```\nA `@handle` B\n",
    "``a`` ```x``` `@handle`",
    "plain text with no code at all",
  ]) {
    assert.equal(replaceOutsideMarkdownCode(source, (chunk) => chunk), source);
  }
});
