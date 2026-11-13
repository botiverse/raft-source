// Workspace Artifacts (S3): the card's fact line is formatted on the client
// from raw counts, and never names the kind (F37); links are read by id only. The home page's
// cards show a title without an old .md or .html (#proj-workspace:#177).
import assert from "node:assert/strict";
import { createIntl } from "react-intl";

import { asArtifactId } from "@botiverse/raft-shared";

import { artifactAppHosts, artifactLinkTarget, artifactOpenPath, artifactOpenTarget, artifactPagePath, artifactPermalinkTarget, artifactUrl } from "../src/apps/artifacts/artifactLinks";
import { artifactShortAddressOf } from "../src/apps/artifacts/artifactOpenEarly";
import { artifactActorName, artifactShownTitle, formatArtifactFacts } from "../src/apps/artifacts/artifactFacts";
import { viewerResultOf } from "../src/apps/artifacts/artifactApi";
import { shareableWebOrigin } from "../src/utils/desktopShell";
import { fakeArtifactSource } from "../src/apps/artifacts/fakeArtifactSource";
import { mergedMessages } from "../src/i18n/messages";

const en = createIntl({ locale: "en", messages: mergedMessages("en") });
const zh = createIntl({ locale: "zh-cn", messages: mergedMessages("zh-cn") });

test("facts: pages, rows and columns, pixels, lines, from raw numbers", () => {
  assert.equal(formatArtifactFacts("pdf", { sizeBytes: 1_258_291, fileCount: 1, pages: 6 }, en), "6 pages");
  assert.equal(formatArtifactFacts("pdf", { sizeBytes: 1_258_291, fileCount: 1, pages: 6 }, zh), "6 页");
  const csv = { sizeBytes: 200, fileCount: 1, rows: 5, columns: 4, columnNames: ["Channel", "September"] };
  assert.equal(formatArtifactFacts("csv", csv, en), "5 rows × 4 columns · Channel, September");
  assert.equal(formatArtifactFacts("csv", csv, zh), "5 行 4 列 · Channel、September");
  assert.equal(formatArtifactFacts("csv", { sizeBytes: 9, fileCount: 1, rows: 1, columns: 1 }, en), "1 row × 1 column");
  assert.equal(formatArtifactFacts("image", { sizeBytes: 1, fileCount: 1, width: 1600, height: 1000 }, en), "1600 × 1000");
  assert.equal(formatArtifactFacts("text", { sizeBytes: 1, fileCount: 1, lines: 214 }, zh), "214 行");
});

test("actor name: the display name, or for one no one stands behind any more a word, never empty", () => {
  const actor = { type: "agent" as const, displayName: "Kirby" };
  assert.equal(artifactActorName(actor, en.formatMessage), "Kirby");
  assert.equal(artifactActorName({ type: "agent", displayName: "", gone: "deleted" }, en.formatMessage), "Deleted agent");
  assert.equal(artifactActorName({ type: "agent", displayName: "", gone: "deleted" }, zh.formatMessage), "已删除的 Agent");
  assert.equal(artifactActorName({ type: "user", displayName: "", gone: "deleted" }, zh.formatMessage), "已删除的用户");
  assert.equal(artifactActorName({ type: "user", displayName: "", gone: "system" }, zh.formatMessage), "系统");
});

test("facts: html and markdown have none; nothing computed falls back to the size; no kind words", () => {
  assert.equal(formatArtifactFacts("html", { sizeBytes: 48_213, fileCount: 2 }, en), null);
  assert.equal(formatArtifactFacts("markdown", { sizeBytes: 3_420, fileCount: 1 }, en), null);
  // An encrypted PDF: no page count.
  const encrypted = formatArtifactFacts("pdf", { sizeBytes: 1_258_291, fileCount: 1 }, en);
  assert.equal(encrypted, "1.2 MB");
  for (const line of [encrypted, formatArtifactFacts("csv", { sizeBytes: 9, fileCount: 1, rows: 2 }, en)]) {
    assert.doesNotMatch(line ?? "", /pdf|csv|table|spreadsheet|document/i);
  }
});

test("links: every Artifact address via the shared parser; legacy names and per-version links are not cards", () => {
  const id = "pt_3c10b4ed-d947-49df-9031-91ae837f010a";
  const hosts = ["app.raft.build"];
  const targets = [
    "https://app.raft.build/artifacts/pt_abc/v/3",
    "https://artifacts.raft.build/pt_def",
    "https://app.raft.build/s/raft/artifacts/pt_ghi",
    "https://a-pt-3c10b4ed-d947-49df-9031-91ae837f010a.raftusercontent.com/index.html",
  ].map((link) => artifactLinkTarget(link, hosts));
  assert.deepEqual(targets, [
    { id: "pt_abc", version: 3 },
    { id: "pt_def", version: null },
    { id: "pt_ghi", version: null },
    { id, version: null },
  ]);
  for (const link of [
    "https://raft-artifacts.com/p/raft/workspace-artifacts-prototype",
    "https://raft-artifacts.com/a/tok123",
    "https://example.com/docs/pt_x",
    "https://evil.com/artifacts/pt_evil",
    "https://app.raft.build.evil.com/artifacts/pt_evil2",
  ]) assert.equal(artifactLinkTarget(link, hosts), null, link);
});

test("links: /artifacts/<id> counts only on the app hosts given (the deployment's own from config)", () => {
  const links = ["https://staging.example.dev/artifacts/pt_a", "https://evil.com/artifacts/pt_b", "https://app.raft.build/artifacts/pt_c"];
  const ids = (hosts: string[]) => links.flatMap((link) => artifactLinkTarget(link, hosts)?.id ?? []);
  assert.deepEqual(ids(["app.raft.build", "staging.example.dev"]), ["pt_a", "pt_c"]);
  assert.deepEqual(ids(["app.raft.build"]), ["pt_c"]);
});

test("addresses are built by the client: canonical outward link, Raft API file path", () => {
  assert.equal(artifactUrl(asArtifactId("pt_abc"), null, "https://app.raft.build"), "https://app.raft.build/artifacts/pt_abc");
  assert.equal(artifactUrl(asArtifactId("pt_abc"), 2, "https://app.raft.build"), "https://app.raft.build/artifacts/pt_abc/v/2");
  // Another deployment links to itself, not to production.
  assert.equal(
    artifactUrl(asArtifactId("pt_abc"), null, "https://raft-app-staging.botiverse.dev"),
    "https://raft-app-staging.botiverse.dev/artifacts/pt_abc",
  );
  assert.equal(artifactUrl(asArtifactId("pt_abc"), 3, "http://localhost:5173/"), "http://localhost:5173/artifacts/pt_abc/v/3");
  // No usable origin: the canonical host.
  assert.equal(artifactUrl(asArtifactId("pt_abc"), null, ""), "https://app.raft.build/artifacts/pt_abc");
  assert.equal(artifactUrl(asArtifactId("pt_abc"), null, "null"), "https://app.raft.build/artifacts/pt_abc");
});

test("links carry the short id, never pt_: the canonical link (copy link, open in new page), the page path, the in-app open path", () => {
  const id = asArtifactId("pt_cf5d7bb5-6bbe-4304-bc87-1ab40601a98e");
  const short = "ScAiFjjtiUvoyEYA6Ry12u";
  assert.equal(artifactUrl(id, null, "https://app.raft.build"), `https://app.raft.build/artifacts/${short}`);
  assert.equal(artifactUrl(id, 4, "https://app.raft.build"), `https://app.raft.build/artifacts/${short}/v/4`);
  assert.equal(artifactPagePath(id, 2), `/artifacts/${short}/v/2`);
  assert.equal(artifactOpenPath(id, 3, "link"), `/artifacts?artifact=${short}&version=3&from=link`);
  // Both forms read as the same id: the canonical route and the Artifacts page's ?artifact=.
  for (const written of [short, id]) {
    assert.deepEqual(artifactPermalinkTarget(written, undefined), { id, version: null }, written);
    assert.deepEqual(artifactPermalinkTarget(written, "7"), { id, version: 7 }, written);
    assert.deepEqual(artifactOpenTarget(new URLSearchParams({ artifact: written, from: "link" })), { id, version: null, from: "link" }, written);
  }
  for (const bad of ["ScAiFjjtiUvoyEYA6Ry12", "YcVfxkQb6JRzqk5kF2tNLw", "workspace-prototype", ` ${short}`]) {
    assert.equal(artifactPermalinkTarget(bad, undefined), null, bad);
    assert.equal(artifactOpenTarget(new URLSearchParams({ artifact: bad })), null, bad);
  }
  // An older link's address shows as the short one; the short one, and anything else, stays.
  assert.equal(artifactShortAddressOf(`/artifacts/${id}`), `/artifacts/${short}`);
  assert.equal(artifactShortAddressOf(`/artifacts/${id}/v/2/`), `/artifacts/${short}/v/2`);
  assert.equal(artifactShortAddressOf(`/artifacts/${short}`), null);
  assert.equal(artifactShortAddressOf(`/artifacts/${short}/`), null);
  assert.equal(artifactShortAddressOf("/artifacts/pt_fake-roadmap"), null);
  assert.equal(artifactShortAddressOf("/artifacts/not-an-id"), null);
  assert.equal(artifactShortAddressOf(`/s/raft/artifacts`), null);
});

test("viewer: 404 NOT_VISIBLE is the one unavailable state; other errors stay errors", async () => {
  assert.deepEqual(await viewerResultOf(async () => { throw { status: 404, code: "NOT_VISIBLE" }; }), { status: "unavailable" });
  await assert.rejects(viewerResultOf(async () => { throw { status: 500, code: "INTERNAL" }; }));
});

test("the fake frame route (S2): a fixed FrameLocation on a local *.localhost content origin for html, markdown and pdf; the route's errors otherwise", async () => {
  const at = await fakeArtifactSource.frame(asArtifactId("pt_fake-bundle-report"), { version: 2 });
  assert.deepEqual(at, {
    url: "http://w-fake-bundle-report.content.localhost:8791/_fake/enter?version=2",
    origin: "http://w-fake-bundle-report.content.localhost:8791",
    reports: true,
    // Its door (Porthole 0.14.7+, P125), as the content Worker answers one.
    door: { url: "http://w-fake-bundle-report.content.localhost:8791/__porthole/door/_fake?version=2" },
  });
  assert.equal((await fakeArtifactSource.frame(asArtifactId("pt_fake-launch-plan"), {})).origin, "http://w-fake-launch-plan.content.localhost:8791");
  assert.equal((await fakeArtifactSource.frame(asArtifactId("pt_fake-contract"), {})).url, "http://w-fake-contract.content.localhost:8791/_fake/enter?version=1");
  await assert.rejects(fakeArtifactSource.frame(asArtifactId("pt_fake-hidden-budget"), {}), { status: 404, code: "NOT_VISIBLE" });
  await assert.rejects(fakeArtifactSource.frame(asArtifactId("pt_fake-bundle-report"), { version: 9 }), { status: 404, code: "VERSION_NOT_FOUND" });
  for (const id of ["pt_fake-signups", "pt_fake-runbook", "pt_fake-wireframe", "pt_fake-flow"]) {
    await assert.rejects(fakeArtifactSource.frame(asArtifactId(id), {}), { status: 409, code: "NOT_FRAMED" }, id);
  }
});

test("app hosts: the canonical host and this deployment's own hostname from config, without the port", () => {
  assert.deepEqual(artifactAppHosts("http://localhost:5173"), ["app.raft.build", "localhost"]);
  assert.deepEqual(artifactAppHosts("https://staging.example.dev"), ["app.raft.build", "staging.example.dev"]);
  assert.deepEqual(artifactAppHosts("https://app.raft.build"), ["app.raft.build"]);
  assert.deepEqual(artifactAppHosts(""), ["app.raft.build"]);
  // The default reads the deployment's origin the same way the rest of the app does.
  const own = shareableWebOrigin();
  assert.deepEqual(artifactAppHosts(), own ? artifactAppHosts(own) : ["app.raft.build"]);
  // A link on the own host, with its port, gets a card through the shared parser.
  assert.deepEqual(artifactLinkTarget("http://localhost:5173/artifacts/pt_dev", artifactAppHosts("http://localhost:5173")), { id: "pt_dev", version: null });
});

// Tenny (#proj-workspace:fbc76200): the server leaves Artifact links out of
// the App link read on every host its appHosts() lists (APP_URL's, Raft's
// earlier hosts, APP_PERMALINK_HOSTS); once the page has that list
// (store/raftAppHosts.ts) the web recognises them on the same hosts.
test("app hosts: the server's list once it has arrived, plus the page's own host, deduped; only those exact hostnames count", () => {
  const server = ["app.raft.build", "chat.example.test", "app.slock.ai", "staging.slock.ai", "raft-staging.pages.dev"];
  assert.deepEqual(artifactAppHosts("https://raft-staging.pages.dev", server), server, "the page's host is on it already");
  assert.deepEqual(artifactAppHosts("https://preview-7.raft-web.pages.dev", server), [...server, "preview-7.raft-web.pages.dev"], "a page on a host the server doesn't list is still its own");
  assert.deepEqual(artifactAppHosts("https://raft-staging.pages.dev", null), ["app.raft.build", "raft-staging.pages.dev"], "before it arrives: the canonical host and the page's own");
  assert.deepEqual(artifactAppHosts("https://raft-staging.pages.dev", []), ["app.raft.build", "raft-staging.pages.dev"], "an empty list is no list");

  const hosts = artifactAppHosts("https://app.raft.build", server);
  assert.deepEqual(artifactLinkTarget("https://raft-staging.pages.dev/artifacts/pt_staging/v/2", hosts), { id: "pt_staging", version: 2 });
  assert.deepEqual(artifactLinkTarget("https://app.slock.ai/s/team/artifacts/pt_old", hosts), { id: "pt_old", version: null });
  assert.deepEqual(artifactLinkTarget("https://RAFT-STAGING.pages.dev/artifacts/pt_case", hosts), { id: "pt_case", version: null }, "hostnames compare as URL.hostname spells them");
  // Look-alikes: a host that contains, ends with or starts like one on the list is not on it.
  for (const lookalike of [
    "https://raft-staging.pages.dev.evil.example/artifacts/pt_x",
    "https://evil-raft-staging.pages.dev/artifacts/pt_x",
    "https://sub.raft-staging.pages.dev/artifacts/pt_x",
    "https://pages.dev/artifacts/pt_x",
    "https://app.slock.ai.evil.example/artifacts/pt_x",
  ]) {
    assert.equal(artifactLinkTarget(lookalike, hosts), null, lookalike);
  }
  assert.equal(artifactLinkTarget("https://raft-staging.pages.dev/artifacts/pt_staging", artifactAppHosts("https://app.raft.build", null)), null, "not on the fallback");
});

test("a shown title: without a trailing .md, .markdown, .html or .htm, any case; anything else as it is, never empty", () => {
  for (const [title, shown] of [
    ["hello.md", "hello"],
    ["Q3 plan.markdown", "Q3 plan"],
    ["report.HTML", "report"],
    ["index.htm", "index"],
    ["龟背竹养殖要点.md", "龟背竹养殖要点"],
    ["notes .md", "notes"],
    // #187: trailing whitespace after the extension, trimmed first.
    ["notes.md ", "notes"],
    ["plan.markdown\t", "plan"],
    ["  report.html \n", "report"],
    ["index.HTM  ", "index"],
  ] as const) {
    assert.equal(artifactShownTitle(title), shown, title);
  }
  // Reverse: other extensions, an extension mid-title, a near miss and a bare extension stay.
  for (const title of ["data.csv", "photo.png", "v1.2", "hello.md draft", "readme.mdx", "page.html5", ".md", "Q3 launch plan"]) {
    assert.equal(artifactShownTitle(title), title, title);
  }
  // Never empty: a bare extension with whitespace around it is that extension; only whitespace stays as it is.
  assert.equal(artifactShownTitle(" .md "), ".md");
  assert.equal(artifactShownTitle("   "), "   ");
});
