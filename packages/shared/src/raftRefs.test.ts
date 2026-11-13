import assert from "node:assert/strict";
import {
  createRaftBareTaskRefRegex,
  createRaftChannelTaskRefRegex,
  createRaftDmTaskRefRegex,
  formatRaftChannelTaskRef,
  formatRaftDmTaskRef,
  RAFT_TASK_REF_SEPARATOR,
  createRaftDmThreadRefRegex,
  createRaftUserRefRegex,
  extractRaftMentionHandles,
  extractRaftRefTargets,
  formatRaftRefTarget,
  parseRaftRefTarget,
  taskRefConversationTarget,
  replaceOutsideMarkdownCode,
  resolveRaftMentionHandle,
  structuredRaftMentionRanges,
  structuredRaftMentionStillAppears,
  type RaftTargetString,
} from "./raftRefs";

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
const _okChannelTask: RaftTargetString = formatRaftChannelTaskRef("proj", 7);
const _okDmTask: RaftTargetString = formatRaftDmTaskRef("alice", 7);
void _okChannelTask;
void _okDmTask;
void _okChannel;
void _okDmThread;
void _badDm;
void _badBare;

test("taskRefConversationTarget: a task ref names its conversation; nothing else does, the legacy task ref neither", () => {
  assert.equal(taskRefConversationTarget("#wg-ax:#26"), "#wg-ax");
  assert.equal(taskRefConversationTarget(" dm:@cody:#3 "), "dm:@cody");
  for (const other of ["task #26", "#wg-ax", "#wg-ax:fde584d1", "dm:@cody", "dm:@cody:abcd1234", "#wg-ax:#0", "#wg-ax:#26\nx", ""]) {
    assert.equal(taskRefConversationTarget(other), null, other);
  }
});

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
    formatRaftChannelTaskRef("proj-slock", 7),
    formatRaftChannelTaskRef("对话流专修", 12),
    formatRaftDmTaskRef("alice", 3),
    formatRaftDmTaskRef("skyzh~agent", 4),
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

// Task #762 (artin, #proj-frontend df4947f1 msg 901ebfeb): an @ in a link
// label or URL is not a mention. The web shows `[@Carol](<@Dave>)` as one
// chip for Dave, so only Dave is notified.
test("extractRaftMentionHandles includes bare, angle and named-link target mentions, not link labels", () => {
  assert.deepEqual(
    extractRaftMentionHandles("hi @Bob and <@Alice> plus [@Carol](<@Dave>)").sort(),
    ["Alice", "Bob", "Dave"],
  );
});

test("resource ref labels are inert and do not become human or agent mentions", () => {
  assert.deepEqual(
    extractRaftMentionHandles(
      "see [@Desk](<computer:550e8400-e29b-41d4-a716-446655440000>) and [@Reminder](<app:system.reminder>) plus [@Carol](<@Dave>)",
    ).sort(),
    ["Dave"],
  );
});

test("extractRaftMentionHandles ignores code and escaped angle refs", () => {
  assert.deepEqual(
    extractRaftMentionHandles("hi \\<@Nope> `@Code`\n```txt\n@Fence\n```\n<@Yes>"),
    ["Yes"],
  );
});

// Task #762: "where is code" and "where is a link" come from the markdown
// parser the web renders with, so a mention is notified exactly where the
// web shows a mention chip.
test("extractRaftMentionHandles skips every code form the parser knows", () => {
  assert.deepEqual(extractRaftMentionHandles("~~~\n@Tilde\n~~~\nthen @Yes"), ["Yes"]);
  assert.deepEqual(extractRaftMentionHandles("````\n```\n@Nested\n```\n````\n@Yes"), ["Yes"]);
  assert.deepEqual(extractRaftMentionHandles("``` code @Inline ``` and @Yes"), ["Yes"]);
  assert.deepEqual(extractRaftMentionHandles("@Yes\n```\nunclosed @Fence"), ["Yes"]);
  // Indented lines are prose in chat (the web disables indented code).
  assert.deepEqual(extractRaftMentionHandles("text\n\n    @Indented"), ["Indented"]);
});

test("extractRaftMentionHandles skips link labels and URLs", () => {
  assert.deepEqual(extractRaftMentionHandles("[hi @Label](https://e.com) and @Yes"), ["Yes"]);
  assert.deepEqual(extractRaftMentionHandles("see https://x.com/@Url and @Yes"), ["Yes"]);
  assert.deepEqual(extractRaftMentionHandles("glued seehttps://x.com/@Glued and @Yes"), ["Yes"]);
  assert.deepEqual(extractRaftMentionHandles("<https://x.com/@Angle> and @Yes"), ["Yes"]);
});

test("extractRaftMentionHandles skips block quotes: quoting a message does not mention again", () => {
  assert.deepEqual(extractRaftMentionHandles("> @botiverse 组织的 npm 发布权限\n\n好的"), []);
  assert.deepEqual(extractRaftMentionHandles("> @Jasper said so\n\n@Yes agreed"), ["Yes"]);
  assert.deepEqual(extractRaftMentionHandles("> outer\n> > @Nested inner\n\n@Yes"), ["Yes"]);
  // An unquoted line after a quote is drawn after it by the web (which undoes
  // CommonMark's lazy continuation), so it mentions; quoted lines do not.
  assert.deepEqual(extractRaftMentionHandles("> first line\n@After the quote"), ["After"]);
  assert.deepEqual(extractRaftMentionHandles("> first @Quoted\n> second\nthen @After\n> @Lazy"), ["After", "Lazy"]);
  // The first unquoted line ends the quote after a hard break and inside
  // emphasis too; a code span or link it starts inside stays whole in the quote.
  assert.deepEqual(extractRaftMentionHandles("> a  \n@After"), ["After"]);
  assert.deepEqual(extractRaftMentionHandles("> a\\\n@After"), ["After"]);
  assert.deepEqual(extractRaftMentionHandles("> **note\n@After check**"), ["After"]);
  assert.deepEqual(extractRaftMentionHandles("> *a\n> b*\n@After"), ["After"]);
  assert.deepEqual(extractRaftMentionHandles("> [a\nb](<@Linked>)"), []);
  assert.deepEqual(extractRaftMentionHandles("> `x\ny` @After"), ["After"]);
  // Lazy lines of a nested quote stay quoted on the web too.
  assert.deepEqual(extractRaftMentionHandles("> outer\n> > inner\n@StillQuoted"), []);
  assert.deepEqual(extractRaftMentionHandles("> <@Angle> and [x](<@Linked>)\n\n@Yes"), ["Yes"]);
  assert.deepEqual(extractRaftMentionHandles("> `@Code` in a quote\n\nthen `@Code` and @Yes"), ["Yes"]);
  assert.deepEqual(extractRaftMentionHandles("- > @Listed quote\n- @Yes"), ["Yes"]);
});

test("structuredRaftMentionStillAppears does not count a token that is only quoted", () => {
  assert.equal(structuredRaftMentionStillAppears("> @Mona wrote this", "Mona"), false);
  assert.equal(structuredRaftMentionStillAppears("> quoted\n> @Mona", "Mona"), false);
  assert.equal(structuredRaftMentionStillAppears("> @Mona wrote this\n\n@Mona see above", "Mona"), true);
});

// What draws a stored mention (an Artifact comment's parts) asks where it is
// written as one, under the rule that counts it.
const mentionTexts = (source: string, handle: string) => structuredRaftMentionRanges(source, handle).map((range) => source.slice(range.start, range.end));

test("structuredRaftMentionRanges places a mention outside the quote, not inside it", () => {
  const source = "> @Mona said so\n\n@Mona ok";
  assert.deepEqual(structuredRaftMentionRanges(source, "Mona"), [{ start: 17, end: 22 }]);
  assert.equal(source.slice(0, 17), "> @Mona said so\n\n");
  assert.deepEqual(structuredRaftMentionRanges("> @Mona said so\n\nagreed", "Mona"), []);
  // A lazily continued line is drawn below the quote, not in it (markdownRanges drawnQuoteEnd).
  assert.deepEqual(mentionTexts("> quoted\n@Mona lazily continued", "Mona"), ["@Mona"]);
});

test("structuredRaftMentionRanges skips code, link labels, URLs and escaped refs", () => {
  assert.deepEqual(mentionTexts("`@Mona` and @Mona", "Mona"), ["@Mona"]);
  assert.deepEqual(structuredRaftMentionRanges("`@Mona` and @Mona", "Mona"), [{ start: 12, end: 17 }]);
  assert.deepEqual(structuredRaftMentionRanges("```\n@Mona\n```", "Mona"), []);
  assert.deepEqual(structuredRaftMentionRanges("[@Mona](https://example.com) wrote", "Mona"), []);
  assert.deepEqual(structuredRaftMentionRanges("see https://example.com/@Mona", "Mona"), []);
  assert.deepEqual(structuredRaftMentionRanges("literally \\<@Mona>", "Mona"), []);
});

test("structuredRaftMentionRanges keeps source offsets after an escaped ref or a bare URL in the same stretch", () => {
  const source = "a \\<@Bob> then https://example.com/x and @Mona, draft@Mona and @Mona的";
  const ranges = structuredRaftMentionRanges(source, "Mona");
  assert.deepEqual(ranges.map((range) => source.slice(range.start, range.end)), ["@Mona", "@Mona", "@Mona"]);
  assert.deepEqual(ranges.map((range) => range.start), [source.indexOf("@Mona,"), source.indexOf("@Mona and"), source.indexOf("@Mona的")]);
  assert.deepEqual(structuredRaftMentionRanges(source, "Bob"), []);
});

test("structuredRaftMentionRanges reports a link to a user ref as the whole link, unless it is quoted", () => {
  assert.deepEqual(mentionTexts("ask [the owner](<@Mona>) today", "Mona"), ["[the owner](<@Mona>)"]);
  assert.deepEqual(mentionTexts("> ask [the owner](<@Mona>)\n\nok", "Mona"), []);
  // `<@Mona>` alone is not a link to the parser: the name inside the brackets is the mention.
  assert.deepEqual(mentionTexts("ask <@Mona> today", "Mona"), ["@Mona"]);
  assert.deepEqual(mentionTexts("> ask <@Mona>\n\nthen <@Mona> and @Mona", "Mona"), ["@Mona", "@Mona"]);
});

test("structuredRaftMentionRanges draws nothing for a name pieced together, a longer name or a handle that is not one", () => {
  assert.deepEqual(structuredRaftMentionRanges("@Mo\\<@x>na", "Mona"), []);
  assert.deepEqual(structuredRaftMentionRanges("@Monaco and @Mona-2", "Mona"), []);
  assert.deepEqual(structuredRaftMentionRanges("@Mona", "not a handle"), []);
});

test("structuredRaftMentionRanges finds a place exactly when structuredRaftMentionStillAppears counts the mention", () => {
  for (const source of [
    "@Mona", "hi @Mona.", "> @Mona", "> @Mona\n\n@Mona", "`@Mona`", "~~~\n@Mona\n~~~", "[@Mona](https://example.com)", "<@Mona>", "[x](<@Mona>)",
    "> <@Mona>", "> [x](<@Mona>)", "> quoted\n@Mona lazily continued", "https://example.com/@Mona", "\\<@Mona>", "draft@Mona", "@Mona的", "@Monaco", "- @Mona\n- item", "**@Mona**", "| a |\n| - |\n| @Mona |",
  ]) {
    assert.equal(structuredRaftMentionRanges(source, "Mona").length > 0, structuredRaftMentionStillAppears(source, "Mona"), source);
  }
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
  assert.equal(structuredRaftMentionStillAppears("先给个草案@Mona继续", "Mona"), true);
  assert.equal(structuredRaftMentionStillAppears("@Mona的方案", "Mona"), true);
  assert.equal(structuredRaftMentionStillAppears("@Monaさん", "Mona"), true);
  assert.equal(structuredRaftMentionStillAppears("@Mona와", "Mona"), true);
  assert.equal(structuredRaftMentionStillAppears("@민수가 확인", "민수"), true);
  assert.equal(structuredRaftMentionStillAppears("@Monica", "Mona"), false);
  assert.equal(structuredRaftMentionStillAppears("@Mona2", "Mona"), false);
  assert.equal(structuredRaftMentionStillAppears("@Mona_x", "Mona"), false);
  assert.equal(structuredRaftMentionStillAppears("@Mona-x", "Mona"), false);
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

test("resolveRaftMentionHandle splits free text only where Latin meets CJK", () => {
  const known = (...names: string[]) => (name: string) => names.includes(name);

  assert.deepEqual(resolveRaftMentionHandle("ops", known("ops")), { handle: "ops", suffix: "" });
  assert.deepEqual(resolveRaftMentionHandle("ops와", known("ops")), { handle: "ops", suffix: "와" });
  assert.deepEqual(resolveRaftMentionHandle("ops的", known("ops")), { handle: "ops", suffix: "的" });
  assert.deepEqual(resolveRaftMentionHandle("opsさん", known("ops")), { handle: "ops", suffix: "さん" });
  assert.deepEqual(resolveRaftMentionHandle("opsテスト", known("ops")), { handle: "ops", suffix: "テスト" });
  assert.deepEqual(resolveRaftMentionHandle("ops-2的", known("ops-2")), { handle: "ops-2", suffix: "的" });
  // An exact member name always wins over a split.
  assert.deepEqual(resolveRaftMentionHandle("ops的", known("ops", "ops的")), { handle: "ops的", suffix: "" });

  // Same-script continuations are never guessed.
  assert.equal(resolveRaftMentionHandle("opsteam", known("ops")), null);
  assert.equal(resolveRaftMentionHandle("Kaiwen", known("Kai")), null);
  assert.equal(resolveRaftMentionHandle("ops2", known("ops")), null);
  assert.equal(resolveRaftMentionHandle("ops_bot", known("ops")), null);
  assert.equal(resolveRaftMentionHandle("민수가", known("민", "민수")), null);
  assert.equal(resolveRaftMentionHandle("张三的", known("张三")), null);
  assert.equal(resolveRaftMentionHandle("ops的", known("other")), null);
  assert.equal(resolveRaftMentionHandle("opsx的", known("ops")), null);
  // A member literally named `ops君` is reached exactly; with both names
  // present a glued suffix is ambiguous and stays unresolved.
  assert.deepEqual(resolveRaftMentionHandle("ops君", known("ops", "ops君")), { handle: "ops君", suffix: "" });
  assert.deepEqual(resolveRaftMentionHandle("ops君", known("ops")), { handle: "ops", suffix: "君" });
  assert.equal(resolveRaftMentionHandle("ops君的", known("ops", "ops君")), null);
  // Two valid splits (`ops|君a的` and `ops君a|的`) also leave it unresolved.
  assert.equal(resolveRaftMentionHandle("ops君a的", known("ops", "ops君a")), null);
  assert.deepEqual(resolveRaftMentionHandle("ops君a的", known("ops君a")), { handle: "ops君a", suffix: "的" });
});

test("resolveRaftMentionHandle matches its rule for every short token and member set", () => {
  // One character per class that matters: Latin, digit, `_`, `-`, Han,
  // hiragana, katakana, hangul. Every token up to five characters is tried
  // against every choice of which of its prefixes are member names (other
  // names cannot affect the result).
  const alphabet = ["a", "1", "_", "-", "的", "さ", "テ", "가"];
  const handleEnd = /[\p{Script=Latin}\p{N}_-]$/u;
  const cjkStart = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

  const expected = (chars: string[], members: Set<string>) => {
    const token = chars.join("");
    if (members.has(token)) return { handle: token, suffix: "" };
    const prefix = (length: number) => chars.slice(0, length).join("");
    const valid = [];
    for (let length = 1; length < chars.length; length += 1) {
      const rest = chars.slice(length).join("");
      if (members.has(prefix(length)) && handleEnd.test(prefix(length)) && cjkStart.test(rest)) valid.push(length);
    }
    // Exactly one valid split, and no longer member that also fits;
    // anything else makes the split point a guess, so nobody is mentioned.
    if (valid.length !== 1) return null;
    const chosen = valid[0];
    for (let length = chosen + 1; length < chars.length; length += 1) {
      if (members.has(prefix(length))) return null;
    }
    return { handle: prefix(chosen), suffix: chars.slice(chosen).join("") };
  };

  let tokens: string[][] = [[]];
  let checked = 0;
  for (let size = 1; size <= 5; size += 1) {
    tokens = tokens.flatMap((chars) => alphabet.map((char) => [...chars, char]));
    for (const chars of tokens) {
      const prefixes = chars.map((_, index) => chars.slice(0, index + 1).join(""));
      for (let mask = 0; mask < 1 << prefixes.length; mask += 1) {
        const members = new Set(prefixes.filter((_, index) => mask & (1 << index)));
        const token = chars.join("");
        const actual = resolveRaftMentionHandle(token, (name) => members.has(name));
        const label = `@${token} with members [${[...members].join(", ")}]`;
        assert.deepEqual(actual, expected(chars, members), label);
        // Direct invariants, independent of the restated rule above.
        if (actual) {
          assert.ok(members.has(actual.handle), label);
          assert.equal(actual.handle + actual.suffix, token, label);
          if (actual.suffix) assert.ok(handleEnd.test(actual.handle) && cjkStart.test(actual.suffix), label);
        }
        // Tokens without a Latin-to-CJK boundary keep the pre-split behaviour.
        const hasBoundary = chars.some((_, index) =>
          index > 0 && handleEnd.test(chars[index - 1]) && cjkStart.test(chars[index]));
        if (!hasBoundary) assert.equal(actual?.handle ?? null, members.has(token) ? token : null);
        checked += 1;
      }
    }
  }
  assert.equal(checked, 1118480);
});

// Task refs: fixtures are built with the formatters, so switching
// RAFT_TASK_REF_SEPARATOR needs no edits here.
const T = formatRaftChannelTaskRef;
const D = formatRaftDmTaskRef;
const SEP = RAFT_TASK_REF_SEPARATOR;

test("channel-qualified task refs parse and format (task v2 #channel:#7)", () => {
  assert.equal(T("proj", 7), "#proj:#7", "current syntax (update with RAFT_TASK_REF_SEPARATOR)");
  assert.deepEqual(parseRaftRefTarget(T("proj-slock", 7)), { kind: "task", channelName: "proj-slock", taskNumber: 7 });
  assert.deepEqual(parseRaftRefTarget(D("alice", 3)), { kind: "task", peerName: "alice", taskNumber: 3 });
  // Legacy form keeps its shape: no channel or peer key at all.
  assert.deepEqual(parseRaftRefTarget("task #7"), { kind: "task", taskNumber: 7 });
  for (const bad of [
    `#proj${SEP}0`,
    `#proj${SEP}07`,
    `${T("proj", 7)}a`,
    `${T("proj", 7)}/8`,
    `${T("proj", 7)}${SEP}8`,
    `#${SEP}7`,
    `#proj${SEP}`,
    `dm:alice${SEP}7`,
  ]) {
    assert.equal(parseRaftRefTarget(bad), null, bad);
  }
  assert.equal(formatRaftRefTarget({ kind: "task", channelName: "proj", taskNumber: 7 }), T("proj", 7));
  assert.equal(formatRaftRefTarget({ kind: "task", peerName: "alice", taskNumber: 7 }), D("alice", 7));
  assert.equal(formatRaftRefTarget({ kind: "task", taskNumber: 7 }), "task #7");
});

test("channel/DM task scanners need the number to end the token", () => {
  const scan = (text: string, re: RegExp) => Array.from(text.matchAll(re)).map((m) => [m[0], m[1], m[2]]);
  assert.deepEqual(
    scan(`see ${T("proj", 7)}, ${T("a-b", 12)}. not ${T("proj", 7)}a or ${T("proj", 7)}/8`, createRaftChannelTaskRefRegex()),
    [
      [T("proj", 7), "proj", "7"],
      [T("a-b", 12), "a-b", "12"],
    ],
  );
  assert.deepEqual(scan(`in ${D("Bob", 2)} and ${D("bob~agent", 5)}.`, createRaftDmTaskRefRegex()), [
    [D("Bob", 2), "Bob", "2"],
    [D("bob~agent", 5), "bob~agent", "5"],
  ]);
});

test("extractRaftRefTargets claims #channel:#7 before #channel and bare #N", () => {
  const source = `see ${T("proj", 7)}, ${T("12", 3)}, ${D("bob", 4)} and task #9 in #proj; <${T("ops", 2)}>; \`${T("code", 1)}\``;
  const refs = extractRaftRefTargets(source, { dedupe: false });
  assert.deepEqual(
    refs.map((ref) => ({ target: formatRaftRefTarget(ref.target), slice: source.slice(ref.start, ref.end) })),
    [
      { target: T("proj", 7), slice: T("proj", 7) },
      { target: T("12", 3), slice: T("12", 3) },
      { target: D("bob", 4), slice: D("bob", 4) },
      { target: "task #9", slice: "task #9" },
      { target: "#proj", slice: "#proj" },
      { target: T("ops", 2), slice: T("ops", 2) },
    ],
  );
  // A trailing path segment or second separator is not a task ref.
  for (const text of [`${T("proj", 7)}/8`, `${T("proj", 7)}${SEP}8`]) {
    const projTask = extractRaftRefTargets(text).find(
      (ref) => ref.target.kind === "task" && ref.target.channelName === "proj",
    );
    assert.equal(projTask, undefined, text);
  }
});
