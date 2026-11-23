// Golden notice lines (S1c): a mention, one comment and a batch for a
// follower, a changed file, a review (S8), a rename (task #147), a resolve (#249); every line within the summary limit, and the tool
// style naming no CLI command.
import assert from "node:assert/strict";

import { artifactAgentNoticeSchema, type ArtifactAgentNotice } from "../artifactAgentNotice";
import { ARTIFACT_NOTICE_MAX_CHARS, formatArtifactNotice } from "./artifactNotices";

const xxchan = { type: "user" as const, name: "xxchan" };
const remy = { type: "agent" as const, name: "Remy" };
const artifact = { id: "pt_abc", title: "Workspace prototype" };
const excerpt = (over: Record<string, unknown> = {}) => ({
  id: "c_812", author: xxchan, version: 12, path: "components.html", createdAt: "2026-10-22T14:05:00.000Z", excerpt: "Can you put the three card states side by side?", truncated: false, bodyChars: 47, ...over,
});
const notice = (over: Record<string, unknown>): ArtifactAgentNotice => artifactAgentNoticeSchema.parse({ artifact, following: null, comments: null, version: null, ...over });

test("a mention: who, where, the comment, how to answer, no reply needed otherwise", () => {
  assert.equal(
    formatArtifactNotice(notice({ reason: "mentioned", comments: { count: 1, latest: [excerpt()] } })),
    `@xxchan mentioned you in a comment on "Workspace prototype" (components.html): "Can you put the three card states side by side?". If it asks something of you, answer in the artifact (comment on stdin): raft artifact comment pt_abc --reply-to c_812. If it needs nothing from you, no reply is needed.`,
  );
});

test("a follower's comment, one and batched: why you get it, and how to stop", () => {
  assert.equal(
    formatArtifactNotice(notice({ reason: "subscribed", following: { kind: "published", version: 12 }, comments: { count: 1, latest: [excerpt()] } })),
    `New comment by @xxchan on "Workspace prototype" (components.html; you follow it because you pushed v12): "Can you put the three card states side by side?". To answer (comment on stdin): raft artifact comment pt_abc --reply-to c_812. If it needs nothing from you, no reply is needed. To stop these: raft artifact unfollow pt_abc`,
  );
  assert.equal(
    formatArtifactNotice(notice({ reason: "subscribed", following: { kind: "commented", version: null }, comments: { count: 3, latest: [excerpt({ id: "c_1" }), excerpt({ path: null, author: remy, excerpt: "Done." })] } })),
    `3 new comments on "Workspace prototype" (you follow it because you commented), the latest by @Remy on the whole artifact: "Done.". Read them: raft artifact comments pt_abc. If they need nothing from you, no reply is needed. To stop these: raft artifact unfollow pt_abc`,
  );
});

test("a comment at a place: the notice names it in Raft's words, never the page's text or selector", () => {
  const at = (anchor: Record<string, unknown>) => formatArtifactNotice(notice({ reason: "mentioned", comments: { count: 1, latest: [excerpt({ anchor })] } }));
  assert.ok(at({ type: "lines", data: { start: 3, end: 5, quote: "secret line" } }).startsWith(`@xxchan mentioned you in a comment on "Workspace prototype" (components.html · lines 3-5): "Can you`));
  const element = at({ type: "annotation", data: { kind: "element", label: "h2#states Card states", selectors: [{ type: "CssSelector", value: "#states" }, { type: "TextQuoteSelector", exact: "Card states" }] } });
  assert.ok(element.includes(`(components.html · element <h2>): "Can you`), element);
  assert.ok(!element.includes("Card states") && !element.includes("#states"), element);
  assert.ok(at({ type: "page", data: { name: "card-3", label: "Card 3" } }).includes(`(components.html · place card-3, named by the page): "Can you`));
  // No anchor (an older Server, or the whole file): the file alone.
  assert.ok(at({ type: "lines", data: {} }).includes(`(components.html): "Can you`));
  const followed = formatArtifactNotice(notice({ reason: "subscribed", following: { kind: "published", version: 12 }, comments: { count: 1, latest: [excerpt({ anchor: { type: "csv-rows", data: { start: 4, end: 4 } } })] } }));
  assert.ok(followed.includes(`(components.html · row 4; you follow it because you pushed v12)`), followed);
});

test("a comment at a place in a section (Porthole P152): the notice names the section too, still without the selector or the page's quote", () => {
  const at = (context: Record<string, unknown>) => formatArtifactNotice(notice({ reason: "mentioned", comments: { count: 1, latest: [excerpt({ anchor: { type: "annotation", data: {
    kind: "element", label: "h2#states Card states", selectors: [{ type: "CssSelector", value: "#states" }, { type: "TextQuoteSelector", exact: "Card states" }], context,
  } } })] } }));
  const both = at({ headings: ["Agent 收件箱现状", "P5 · 读取页"], region: "设计" });
  assert.ok(both.includes(`(components.html · element <h2> · in "Agent 收件箱现状 › P5 · 读取页" · region "设计"): "Can you`), both);
  assert.ok(!both.includes("#states") && !both.includes("Card states"), both);
  assert.ok(at({ headings: ["Plans"] }).includes(`(components.html · element <h2> · in "Plans"): "Can you`));
  assert.ok(at({ region: "Design" }).includes(`(components.html · element <h2> · region "Design"): "Can you`));
  assert.ok(at({}).includes(`(components.html · element <h2>): "Can you`));
  // A heading's own ` › ` reads ` > `.
  assert.ok(at({ headings: ["Docs › API", "Auth"] }).includes(`(components.html · element <h2> · in "Docs > API › Auth"): "Can you`));
});

test("a long section gives way before the title or the place is cut: the region, then the middle headings, then the outermost, then all of it; a quote is never cut", () => {
  const long = (context: Record<string, unknown>, over: Record<string, unknown> = {}) => formatArtifactNotice(notice({ reason: "mentioned", comments: { count: 1, latest: [excerpt({
    path: "docs/pricing.html", excerpt: "y".repeat(300),
    anchor: { type: "annotation", data: { kind: "element", label: "h2 Plans", selectors: [{ type: "CssSelector", value: "#plans" }], context } },
    ...over,
  })] } }));
  const headings = ["一".repeat(80), "二".repeat(80), "三".repeat(80), "Plans \"tiers\""];
  const balanced = (line: string) => {
    assert.ok(line.length <= ARTIFACT_NOTICE_MAX_CHARS, `${line.length} chars: ${line}`);
    assert.ok(line.includes(`on "Workspace prototype" (docs/pricing.html · element <h2>`), `the title and the place whole: ${line}`);
    assert.equal(line.replace(/\\"/g, "").split('"').length % 2, 1, `quotes balance: ${line}`);
    assert.doesNotMatch(line, /\\(?:u[0-9a-f]{0,3})?…/, `no escape cut: ${line}`);
    // A `…` in the chain stands for whole headings (` › … › `, `"… › `), never for the end of one.
    assert.doesNotMatch(line, /· in "[^"]*[^\s"]…/, `no heading cut: ${line}`);
  };
  // No room for all of it: the region goes, then the middle headings; the outermost and the section's own heading stay, each whole.
  const some = long({ headings, region: "区".repeat(80) });
  balanced(some);
  assert.ok(some.includes(`· in "${"一".repeat(80)} › … › Plans \\"tiers\\""): "y`), some);
  assert.ok(!some.includes("region") && !some.includes("区") && !some.includes("二") && !some.includes("三"), some);
  // Six headings: the outermost and the innermost, the four between them one `…`.
  const ends = long({ headings: Array.from({ length: 6 }, (_, index) => `${index}${"节".repeat(79)}`), region: "区".repeat(80) });
  balanced(ends);
  assert.ok(ends.includes(`· in "0${"节".repeat(79)} › … › 5${"节".repeat(79)}"): "y`), ends);
  assert.ok(!/[1-4]节/.test(ends) && !ends.includes("区"), ends);
  for (const style of ["cli", "tool"] as const) balanced(formatArtifactNotice(notice({ reason: "subscribed", following: { kind: "followed", version: null }, comments: { count: 1, latest: [excerpt({
    path: "docs/pricing.html", excerpt: "y".repeat(300), anchor: { type: "annotation", data: { kind: "element", label: "h2 Plans", selectors: [{ type: "CssSelector", value: "#plans" }], context: { headings, region: "区".repeat(80) } } },
  })] } }), style));
});

test("a section's steps, as the title grows: the region first, then the middle headings (`A › … › D`), then the outermost (`… › D`), then the whole section (`· …`)", () => {
  // Each place a notice gives, in order, as a longer title leaves it less room.
  const placesOf = (context: Record<string, unknown> | undefined, path = "docs/plan.html") => {
    const places: string[] = [];
    for (let n = 0; n <= 400; n += 1) {
      const line = formatArtifactNotice(notice({ artifact: { ...artifact, title: "T".repeat(n) }, reason: "mentioned", comments: { count: 1, latest: [excerpt({
        path, excerpt: "y".repeat(300),
        anchor: { type: "annotation", data: { kind: "element", label: "h3 Plans", selectors: [{ type: "CssSelector", value: "#f-deliver > div > h3" }], ...(context ? { context } : {}) } },
      })] } }));
      assert.ok(line.length <= ARTIFACT_NOTICE_MAX_CHARS, `${line.length} chars: ${line}`);
      const place = line.slice(line.indexOf(" (") + 2, line.indexOf("): "));
      if (places[places.length - 1] !== place) places.push(place);
    }
    return places;
  };
  const sage = ["P2 · 条目行", "数据模型", "条目行的组成", "统一视图：固定部分 + 条件插入"];
  assert.deepEqual(placesOf({ headings: sage, region: "设计" }), [
    `docs/plan.html · element <h3> · in "P2 · 条目行 › 数据模型 › 条目行的组成 › 统一视图：固定部分 + 条件插入" · region "设计"`,
    `docs/plan.html · element <h3> · in "P2 · 条目行 › 数据模型 › 条目行的组成 › 统一视图：固定部分 + 条件插入"`,
    `docs/plan.html · element <h3> · in "P2 · 条目行 › … › 统一视图：固定部分 + 条件插入"`,
    `docs/plan.html · element <h3> · in "… › 统一视图：固定部分 + 条件插入"`,
    `docs/plan.html · element <h3> · …`,
  ]);
  // Two headings: no middle to give up; the outermost goes, marked.
  assert.deepEqual(placesOf({ headings: ["P2 · 条目行", "统一视图：固定部分 + 条件插入"] }), [
    `docs/plan.html · element <h3> · in "P2 · 条目行 › 统一视图：固定部分 + 条件插入"`,
    `docs/plan.html · element <h3> · in "… › 统一视图：固定部分 + 条件插入"`,
    `docs/plan.html · element <h3> · …`,
  ]);
  // One heading, or only a region: the section whole, then marked gone.
  assert.deepEqual(placesOf({ headings: ["统一视图：固定部分 + 条件插入"] }), [
    `docs/plan.html · element <h3> · in "统一视图：固定部分 + 条件插入"`,
    `docs/plan.html · element <h3> · …`,
  ]);
  assert.deepEqual(placesOf({ region: "设计".repeat(40) }), [`docs/plan.html · element <h3> · region "${"设计".repeat(40)}"`, `docs/plan.html · element <h3> · …`]);
  // No section (an older comment): nothing given up, nothing marked.
  assert.deepEqual(placesOf(undefined), [`docs/plan.html · element <h3>`]);
  // A path over 40: the place's parts go, then the path is cut, a `…` part still where they were.
  const path = `docs/${"very-long-folder-name/".repeat(2)}pricing.html`;
  assert.deepEqual(placesOf({ headings: ["P2 · 条目行", "统一视图：固定部分 + 条件插入"] }, path), [
    `${path} · element <h3> · in "P2 · 条目行 › 统一视图：固定部分 + 条件插入"`,
    `${path} · element <h3> · in "… › 统一视图：固定部分 + 条件插入"`,
    `${path} · element <h3> · …`,
    `docs/very-long-folder-name/very-lon… · …`,
  ]);
  assert.deepEqual(placesOf(undefined, path), [`${path} · element <h3>`, `docs/very-long-folder-name/very-lon… · …`]);
  // A shorter path: only the parts that don't fit in 40 go, one `…` for them all.
  assert.deepEqual(placesOf({ headings: ["节".repeat(80)] }, `${"d".repeat(10)}.html`).slice(-1), [`${"d".repeat(10)}.html · element <h3> · …`]);
  assert.deepEqual(placesOf({ headings: ["节".repeat(80)] }, `${"d".repeat(30)}.html`).slice(-2), [`${"d".repeat(30)}.html · element <h3> · …`, `${"d".repeat(30)}.html · …`]);
});

test("your file changed: who, which version, which of your files, read it if your work depends on it", () => {
  assert.equal(
    formatArtifactNotice(notice({ reason: "your_file_changed", version: { number: 14, publisher: { type: "agent", name: "Tenny" }, note: "new tech section", yourFiles: ["tech.html"], yourVersion: 12 } })),
    `@Tenny pushed v14 of "Workspace prototype", changing tech.html, which you last pushed in v12 — "new tech section". If your work depends on it, read it: raft artifact read pt_abc. Otherwise no reply is needed. To stop these: raft artifact unfollow pt_abc`,
  );
});

test("within the summary limit however long the comment; tool style names no CLI command", () => {
  const long = notice({ reason: "subscribed", following: { kind: "followed", version: null }, comments: { count: 1, latest: [excerpt({ excerpt: "x".repeat(300), truncated: true, bodyChars: 900 })] } });
  const text = formatArtifactNotice(long);
  assert.ok(text.length <= ARTIFACT_NOTICE_MAX_CHARS, `${text.length} chars`);
  assert.ok(text.includes("x…\". To answer (comment on stdin): raft artifact comment pt_abc --reply-to c_812. If it needs nothing from you"), text);
  for (const n of [long, notice({ reason: "mentioned", comments: { count: 1, latest: [excerpt()] } }), notice({ reason: "your_file_changed", version: { number: 2, publisher: remy, note: null, yourFiles: ["a.html", "b.html"], yourVersion: 1 } })]) {
    const tool = formatArtifactNotice(n, "tool");
    assert.ok(!/\braft [a-z]/.test(tool), tool);
    assert.ok(tool.length <= ARTIFACT_NOTICE_MAX_CHARS);
  }
});

test("tool style: the same line, tool calls for the next steps", () => {
  assert.equal(
    formatArtifactNotice(notice({ reason: "mentioned", comments: { count: 1, latest: [excerpt()] } }), "tool"),
    `@xxchan mentioned you in a comment on "Workspace prototype" (components.html): "Can you put the three card states side by side?". If it asks something of you, answer in the artifact: artifacts_comment({ artifact: "pt_abc", replyTo: "c_812", body: … }). If it needs nothing from you, no reply is needed.`,
  );
});

test("real ids and long titles, paths and file lists still fit, in both styles, without cutting a command", () => {
  const id = "pt_0e9a6c1e-6f3b-4c55-9d1d-6b1b0f2c7a41";
  const commentId = "7c1d2f0e-55a1-4e8b-bb5e-0d3f6e9a1c22";
  const long = (n: number) => "t".repeat(n);
  const cases = [
    notice({ artifact: { id, title: long(120) }, reason: "subscribed", following: { kind: "published", version: 12 }, comments: { count: 1, latest: [excerpt({ id: commentId, path: `docs/${long(80)}.html`, excerpt: "y".repeat(300), truncated: true, bodyChars: 900 })] } }),
    notice({ artifact: { id, title: long(120) }, reason: "mentioned", comments: { count: 1, latest: [excerpt({ id: commentId, path: `docs/${long(80)}.html`, excerpt: "y".repeat(300) })] } }),
    notice({ artifact: { id, title: long(120) }, reason: "subscribed", following: { kind: "commented", version: null }, comments: { count: 7, latest: [excerpt({ id: commentId, path: `docs/${long(80)}.html` })] } }),
    notice({ artifact: { id, title: long(120) }, reason: "your_file_changed", version: { number: 14, publisher: remy, note: long(400), yourFiles: Array.from({ length: 9 }, (_, i) => `section-${i}-${long(30)}.html`), yourVersion: 12 } }),
  ];
  for (const n of cases) {
    for (const style of ["cli", "tool"] as const) {
      const text = formatArtifactNotice(n, style);
      assert.ok(text.length <= ARTIFACT_NOTICE_MAX_CHARS, `${style}: ${text.length} chars: ${text}`);
      assert.ok(text.includes(id), `${style}: the artifact id survives`);
      if (n.comments?.count === 1) assert.ok(text.includes(commentId), `${style}: the reply target survives`);
    }
  }
});

const review = (over: Record<string, unknown> = {}) => ({
  id: "rv_7", author: xxchan, version: 12, commentCount: 5, fileCount: 3, mentionsYou: 2, summaryExcerpt: "Close; two things before v13.", ...over,
});

test("a review: one line for all of it, read with one command, a mention answered on its comment", () => {
  assert.equal(
    formatArtifactNotice(notice({ reason: "mentioned", review: review(), comments: { count: 5, latest: [excerpt()] } })),
    `@xxchan reviewed "Workspace prototype" (v12): 5 comments on 3 files; you're mentioned 2 times. Summary: "Close; two things before v13.". Read them: raft artifact comments pt_abc. If one asks something of you, answer it in the artifact (comment on stdin): raft artifact comment pt_abc --reply-to <comment>. If it needs nothing from you, no reply is needed.`,
  );
  assert.equal(
    formatArtifactNotice(notice({ reason: "subscribed", following: { kind: "published", version: 12 }, review: review({ mentionsYou: 0, fileCount: 0, commentCount: 1, summaryExcerpt: null }), comments: { count: 1, latest: [excerpt({ path: null })] } })),
    `@xxchan reviewed "Workspace prototype" (v12; you follow it because you pushed v12): 1 comment on the whole artifact. Read it: raft artifact comments pt_abc. If it needs nothing from you, no reply is needed. To stop these: raft artifact unfollow pt_abc`,
  );
  const tool = formatArtifactNotice(notice({ reason: "mentioned", review: review({ mentionsYou: 1, summaryExcerpt: "y".repeat(300) }), comments: { count: 5, latest: [excerpt()] } }), "tool");
  assert.ok(tool.length <= ARTIFACT_NOTICE_MAX_CHARS, `${tool.length} chars`);
  assert.ok(!/\braft [a-z]/.test(tool), tool);
  assert.ok(tool.includes(`; you're mentioned once. Summary: "yyy`), tool);
  // Only commands every Artifacts client has: the Server writes the line once for all of them.
  assert.ok(tool.includes(`artifacts_comments({ artifact: "pt_abc" })`) && !tool.includes("rv_7"), tool);
});

test("a review notice from before S8's notice fields still reads as comments", () => {
  // `review` absent: a Server that batches the review as comments only.
  const old = formatArtifactNotice(notice({ reason: "subscribed", following: { kind: "commented", version: null }, comments: { count: 5, latest: [excerpt()] } }));
  assert.ok(old.startsWith("5 new comments on"), old);
});

test("a rename: who, from what to what, the id it keeps; no reply needed; how to stop", () => {
  const renamed = notice({ reason: "subscribed", following: { kind: "published", version: 12 }, renamed: { by: xxchan, from: "Workspace draft", to: "Workspace prototype" } });
  assert.equal(
    formatArtifactNotice(renamed),
    `@xxchan renamed "Workspace draft" to "Workspace prototype" (you follow it because you pushed v12). Its id is unchanged: raft artifact read pt_abc. No reply is needed. To stop these: raft artifact unfollow pt_abc`,
  );
  const tool = formatArtifactNotice(renamed, "tool");
  assert.ok(!/\braft [a-z]/.test(tool), tool);
  assert.ok(tool.includes(`Its id is unchanged: artifacts_read({ artifact: "pt_abc" }).`), tool);
  // Long titles shrink, the commands never.
  const long = formatArtifactNotice(notice({ reason: "subscribed", following: { kind: "followed", version: null }, renamed: { by: remy, from: "a".repeat(400), to: "b".repeat(400) } }));
  assert.ok(long.length <= ARTIFACT_NOTICE_MAX_CHARS, `${long.length} chars`);
  assert.ok(long.endsWith("Its id is unchanged: raft artifact read pt_abc. No reply is needed. To stop these: raft artifact unfollow pt_abc"), long);
  // A client from before `renamed` reads it as something that changed, with the read.
  assert.equal(formatArtifactNotice(notice({ reason: "subscribed", following: { kind: "published", version: 12 } })), `Something changed in "Workspace prototype": raft artifact read pt_abc`);
});

test("a comment with images (#146): its text, then the count; images alone, the count; in every notice of a comment", () => {
  const followed = (over: Record<string, unknown>) => formatArtifactNotice(notice({ reason: "subscribed", following: { kind: "published", version: 12 }, comments: { count: 1, latest: [excerpt(over)] } }));
  assert.equal(
    followed({ excerpt: "looks off here", bodyChars: 14, imageCount: 2 }),
    `New comment by @xxchan on "Workspace prototype" (components.html; you follow it because you pushed v12): "looks off here" (+2 images). To answer (comment on stdin): raft artifact comment pt_abc --reply-to c_812. If it needs nothing from you, no reply is needed. To stop these: raft artifact unfollow pt_abc`,
  );
  assert.equal(
    followed({ excerpt: "", bodyChars: 0, imageCount: 2 }),
    `New comment by @xxchan on "Workspace prototype" (components.html; you follow it because you pushed v12): (2 images). To answer (comment on stdin): raft artifact comment pt_abc --reply-to c_812. If it needs nothing from you, no reply is needed. To stop these: raft artifact unfollow pt_abc`,
  );
  assert.ok(followed({ excerpt: "", bodyChars: 0, imageCount: 1 }).includes(`pushed v12): (1 image). To answer`));
  // No images (and Servers from before them): as before.
  assert.ok(followed({}).includes(`side by side?". To answer`));
  const mention = formatArtifactNotice(notice({ reason: "mentioned", comments: { count: 1, latest: [excerpt({ excerpt: "@Remy this one?", imageCount: 1 })] } }), "tool");
  assert.ok(mention.includes(`(components.html): "@Remy this one?" (+1 image). If it asks something of you`), mention);
  const batch = formatArtifactNotice(notice({ reason: "subscribed", following: { kind: "commented", version: null }, comments: { count: 3, latest: [excerpt({ id: "c_1" }), excerpt({ path: null, excerpt: "", imageCount: 3 })] } }));
  assert.ok(batch.includes(`the latest by @xxchan on the whole artifact: (3 images). Read them`), batch);
});

test("a long comment with images: the text is cut to fit, never the count", () => {
  const long = (imageCount: number, artifact = { id: "pt_abc", title: "Workspace prototype" }) => notice({
    artifact, reason: "subscribed", following: { kind: "followed", version: null },
    comments: { count: 1, latest: [excerpt({ excerpt: "x".repeat(300), truncated: true, bodyChars: 900, imageCount })] },
  });
  for (const style of ["cli", "tool"] as const) {
    const text = formatArtifactNotice(long(4), style);
    assert.ok(text.length <= ARTIFACT_NOTICE_MAX_CHARS, `${text.length} chars`);
    assert.ok(text.includes(`x…" (+4 images). To answer`), text);
    // Even when the text has to go entirely (a long id in the commands, a long title), the count stays, as text's, not images alone.
    const squeezed = formatArtifactNotice(long(4, { id: `pt_${"a".repeat(110)}`, title: "T".repeat(480) }), style);
    assert.ok(squeezed.length <= ARTIFACT_NOTICE_MAX_CHARS, `${squeezed.length} chars`);
    assert.ok(!squeezed.includes(`x…"`), squeezed);
    assert.ok(squeezed.includes("you follow it) (+4 images). To answer"), squeezed);
  }
});

test("a resolve (#249): who resolved your thread, its note (or the comment), how to reopen; no stop clause, a tool form, within the limit", () => {
  const resolved = (noteExcerpt: string | null) => notice({ reason: "your_comment_resolved", resolved: { by: xxchan, comment: excerpt({ author: remy }), noteExcerpt } });
  assert.equal(
    formatArtifactNotice(resolved("Done in v13.")),
    `@xxchan resolved your comment on "Workspace prototype" (components.html), noting: "Done in v13.". If it isn't done, reply in it or reopen it: raft artifact reopen pt_abc c_812. Otherwise no reply is needed.`,
  );
  assert.equal(
    formatArtifactNotice(resolved(null)),
    `@xxchan resolved your comment on "Workspace prototype" (components.html): "Can you put the three card states side by side?". If it isn't done, reply in it or reopen it: raft artifact reopen pt_abc c_812. Otherwise no reply is needed.`,
  );
  const tool = formatArtifactNotice(resolved(null), "tool");
  assert.ok(tool.includes(`artifacts_reopen({ artifact: "pt_abc", comment: "c_812" })`) && !tool.includes("raft "), tool);
  const long = formatArtifactNotice(notice({ reason: "your_comment_resolved", resolved: { by: remy, comment: excerpt({ excerpt: "x".repeat(300) }), noteExcerpt: "y\n".repeat(150) } }));
  assert.ok(long.length <= ARTIFACT_NOTICE_MAX_CHARS && long.endsWith("raft artifact reopen pt_abc c_812. Otherwise no reply is needed.") && !long.includes("\n"), long);
});

test("settled (#334): who settled it at which version, or took it back to Working; no reply needed, and how to stop", () => {
  assert.equal(
    formatArtifactNotice(notice({ reason: "subscribed", following: { kind: "published", version: 12 }, settlement: { by: xxchan, settled: true, version: 12 } })),
    `@xxchan settled "Workspace prototype" at v12 (you follow it because you pushed v12): it is done, and a new version takes it back to Working. To read it: raft artifact read pt_abc. No reply is needed. To stop these: raft artifact unfollow pt_abc`,
  );
  assert.equal(
    formatArtifactNotice(notice({ reason: "subscribed", following: { kind: "commented", version: null }, settlement: { by: remy, settled: false, version: 12 } })),
    `@Remy took "Workspace prototype" back to Working (it was settled at v12); you follow it because you commented. To read it: raft artifact read pt_abc. No reply is needed. To stop these: raft artifact unfollow pt_abc`,
  );
  // Its author, told though it doesn't follow it: nothing to stop.
  assert.equal(
    formatArtifactNotice(notice({ reason: "subscribed", following: null, settlement: { by: xxchan, settled: true, version: 12 } })),
    `@xxchan settled "Workspace prototype" at v12: it is done, and a new version takes it back to Working. To read it: raft artifact read pt_abc. No reply is needed.`,
  );
  assert.equal(
    formatArtifactNotice(notice({ reason: "subscribed", following: null, settlement: { by: remy, settled: false, version: 12 } })),
    `@Remy took "Workspace prototype" back to Working (it was settled at v12). To read it: raft artifact read pt_abc. No reply is needed.`,
  );
  const tool = formatArtifactNotice(notice({ reason: "subscribed", settlement: { by: remy, settled: true, version: 12 } }), "tool");
  assert.ok(!tool.includes("raft "), tool);
  const long = formatArtifactNotice(notice({ reason: "subscribed", artifact: { id: "pt_abc", title: "a".repeat(800) }, settlement: { by: remy, settled: true, version: 12 } }));
  assert.ok([...long].length <= ARTIFACT_NOTICE_MAX_CHARS, long);
});
