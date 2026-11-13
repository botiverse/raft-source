import assert from "node:assert/strict";

import { artifactFileType, artifactTitleFromFileName, artifactTitleFromHtml } from "./artifactFiles";
import { ARTIFACT_LINK_FIXED_HOSTS, artifactLinkId, artifactPagePath, parseArtifactId, parseArtifactRef, parseLegacyArtifactLink } from "./artifactRef";
import type { ArtifactId } from "./workspaceArtifacts";

const ID = "pt_0b6f1c2e-5d4a-4c3b-9a8e-7f6d5c4b3a21";
/** ID's short id (artifactShortId.test.ts's vector). */
const SHORT = "2QthvfPeGfDnqwr7LG6itx";

test("ids and bare names", () => {
  assert.deepEqual(parseArtifactRef(ID), { kind: "id", id: ID });
  assert.deepEqual(parseArtifactRef(`  ${ID}\n`), { kind: "id", id: ID });
  assert.deepEqual(parseArtifactRef("workspace-prototype"), { kind: "name", name: "workspace-prototype" });
  for (const bad of ["", "Workspace", "-lead", "trail-", "a b", "pt_", "pt_a/b", "#general", "x".repeat(64)]) {
    assert.deepEqual(parseArtifactRef(bad), { kind: "invalid", reason: "unrecognised" }, bad);
  }
});

test("a short id is the same id as pt_<uuid>, bare and in every link form", () => {
  assert.deepEqual(parseArtifactRef(SHORT), { kind: "id", id: ID });
  assert.deepEqual(parseArtifactRef(` ${SHORT}\n`), { kind: "id", id: ID });
  assert.deepEqual(parseArtifactRef(`https://app.raft.build/artifacts/${SHORT}`), { kind: "id", id: ID });
  assert.deepEqual(parseArtifactRef(`https://app.raft.build/artifacts/${SHORT}/v/4?c=1#x`), { kind: "id", id: ID, version: 4 });
  assert.deepEqual(parseArtifactRef(`https://app.raft.build/s/raft/artifacts/${SHORT}/v/2`), { kind: "id", id: ID, version: 2 });
  assert.deepEqual(parseArtifactRef(`https://artifacts.raft.build/${SHORT}`), { kind: "id", id: ID });
  assert.deepEqual(parseArtifactRef(`https://app.raft.build/artifacts/${SHORT}`, { appHosts: ["app.raft.build"] }), { kind: "id", id: ID });
  assert.deepEqual(parseArtifactRef(`https://evil.example/artifacts/${SHORT}`, { appHosts: ["app.raft.build"] }), { kind: "invalid", reason: "unrecognised" });
  // Not a short id: one character short, out of the alphabet, or over 16 bytes.
  for (const bad of [SHORT.slice(1), `${SHORT.slice(0, 21)}0`, "YcVfxkQb6JRzqk5kF2tNLw"]) {
    assert.deepEqual(parseArtifactRef(bad), { kind: "invalid", reason: "unrecognised" }, bad);
    assert.deepEqual(parseArtifactRef(`https://app.raft.build/artifacts/${bad}`), { kind: "invalid", reason: "unrecognised" }, bad);
  }
  // A name a short id can't be: lowercase-led names are always over 16 bytes, so they stay names.
  assert.deepEqual(parseArtifactRef("abcdefghijkmnopqrstuvw"), { kind: "name", name: "abcdefghijkmnopqrstuvw" });
  // A 22-character name of digits and lowercase that starts with a digit does decode: it is an id, never a name.
  assert.deepEqual(parseArtifactRef("1abcdefghijkmnopqrstuv"), { kind: "id", id: "pt_04b0e052-5c59-038c-dd43-b1f482e10dc9" });
});

test("parseArtifactId: a bare id exactly as written; artifactLinkId and artifactPagePath write the short form", () => {
  assert.equal(parseArtifactId(ID), ID);
  assert.equal(parseArtifactId(SHORT), ID);
  for (const bad of ["", ` ${ID}`, `${SHORT} `, "workspace-prototype", `https://app.raft.build/artifacts/${SHORT}`]) {
    assert.equal(parseArtifactId(bad), null, bad);
  }
  assert.equal(artifactLinkId(ID as ArtifactId), SHORT);
  assert.equal(parseArtifactId(artifactLinkId(ID as ArtifactId)), ID);
  // An id that isn't pt_<lowercase uuid> (a fixture's) is written as it is, and still reads back.
  assert.equal(artifactLinkId("pt_fake-roadmap" as ArtifactId), "pt_fake-roadmap");
  assert.equal(artifactLinkId(ID.toUpperCase().replace("PT_", "pt_") as ArtifactId), ID.toUpperCase().replace("PT_", "pt_"));
  assert.equal(artifactPagePath(ID as ArtifactId), `/artifacts/${SHORT}`);
  assert.equal(artifactPagePath(ID as ArtifactId, 3), `/artifacts/${SHORT}/v/3`);
  assert.equal(artifactPagePath("pt_fake-roadmap" as ArtifactId), "/artifacts/pt_fake-roadmap");
});

test("Raft app links, with and without a server and a pinned version", () => {
  assert.deepEqual(parseArtifactRef(`https://app.raft.build/artifacts/${ID}`), { kind: "id", id: ID });
  assert.deepEqual(parseArtifactRef(`https://app.raft.build/artifacts/${ID}/v/12`), { kind: "id", id: ID, version: 12 });
  assert.deepEqual(parseArtifactRef(`https://app.raft.build/s/raft/artifacts/${ID}`), { kind: "id", id: ID });
  assert.deepEqual(parseArtifactRef(`https://app.raft.build/s/raft/artifacts/${ID}/v/3?x=1#c`), { kind: "id", id: ID, version: 3 });
  // Other deployments of the app (staging, local) name the same Artifact.
  assert.deepEqual(parseArtifactRef(`http://localhost:5173/artifacts/${ID}`), { kind: "id", id: ID });
  assert.deepEqual(parseArtifactRef(`https://app.raft.build/artifacts/${ID}/v/0`), { kind: "invalid", reason: "unrecognised" });
  assert.deepEqual(parseArtifactRef("https://app.raft.build/artifacts/not-an-id"), { kind: "invalid", reason: "unrecognised" });
  assert.deepEqual(parseArtifactRef("https://app.raft.build/s/raft/channels/general"), { kind: "invalid", reason: "unrecognised" });
});

test("the short host and the content origin", () => {
  assert.deepEqual(parseArtifactRef(`https://artifacts.raft.build/${ID}`), { kind: "id", id: ID });
  assert.deepEqual(parseArtifactRef(`https://artifacts.raft.build/${ID}/v/2`), { kind: "id", id: ID, version: 2 });
  assert.deepEqual(
    parseArtifactRef(`https://a-pt-${ID.slice(3)}.raftusercontent.com/index.html`),
    { kind: "id", id: ID },
  );
  assert.deepEqual(parseArtifactRef("https://a-0b6f1c2e.raftusercontent.com/"), { kind: "invalid", reason: "unrecognised" });
});

test("the standalone app's links: /p/<server>/<name> names an Artifact, /a/<token> only a version", () => {
  assert.deepEqual(
    parseArtifactRef("https://raft-artifacts.com/p/raft/workspace-prototype"),
    { kind: "name", name: "workspace-prototype", server: "raft" },
  );
  assert.deepEqual(
    parseArtifactRef("https://raft-artifacts.com/p/raft/workspace-prototype/v/9/raw"),
    { kind: "name", name: "workspace-prototype", server: "raft", version: 9 },
  );
  assert.deepEqual(
    parseArtifactRef("https://artifact-share.botiverse.dev/p/raft/notes?comments_scope=all#comments"),
    { kind: "name", name: "notes", server: "raft" },
  );
  assert.deepEqual(parseArtifactRef("https://raft-artifacts.com/a/3f1c0d2e-aaaa-4bbb-8ccc-123456789abc"), { kind: "invalid", reason: "legacy_version_link" });
  assert.deepEqual(parseArtifactRef("https://raft-artifacts.com/p/raft"), { kind: "invalid", reason: "unrecognised" });
  assert.deepEqual(parseArtifactRef("https://example.com/p/raft/notes"), { kind: "invalid", reason: "unrecognised" });
  assert.deepEqual(parseArtifactRef("ftp://raft-artifacts.com/p/raft/notes"), { kind: "invalid", reason: "unrecognised" });
});

test("file types come from the extension only", () => {
  assert.deepEqual(artifactFileType("index.html"), { contentType: "text/html; charset=utf-8", kind: "html", text: true });
  assert.deepEqual(artifactFileType("docs/README.MD"), { contentType: "text/markdown; charset=utf-8", kind: "markdown", text: true });
  assert.deepEqual(artifactFileType("data.json"), { contentType: "application/json; charset=utf-8", kind: "text", text: true });
  assert.deepEqual(artifactFileType("logo.svg"), { contentType: "image/svg+xml", kind: "image", text: true });
  assert.deepEqual(artifactFileType("assets/logo.png"), { contentType: "image/png", kind: "image", text: false });
  assert.deepEqual(artifactFileType("Makefile"), { contentType: "application/octet-stream", kind: "other", text: false });
  assert.deepEqual(artifactFileType(".env"), { contentType: "application/octet-stream", kind: "other", text: false });
});

test("a title from a file name drops only a known last extension, and is never empty", () => {
  assert.equal(artifactTitleFromFileName("龟背竹养殖要点.md"), "龟背竹养殖要点");
  assert.equal(artifactTitleFromFileName("Q3 report.PDF"), "Q3 report");
  assert.equal(artifactTitleFromFileName("site.v2.html"), "site.v2", "only the last segment");
  assert.equal(artifactTitleFromFileName("archive.tar.gz"), "archive.tar.gz", "gz isn't a type Raft knows");
  assert.equal(artifactTitleFromFileName("v1.2"), "v1.2");
  assert.equal(artifactTitleFromFileName("2026.10.30"), "2026.10.30");
  assert.equal(artifactTitleFromFileName(".env"), ".env");
  assert.equal(artifactTitleFromFileName(" .md"), " .md", "nothing left: as it is");
  assert.equal(artifactTitleFromFileName("Makefile"), "Makefile");
});

test("a page's <title>: the first one, references decoded, whitespace collapsed; none or empty is null", () => {
  assert.equal(artifactTitleFromHtml("<!doctype html><html><head><title>Q3 report</title></head></html>"), "Q3 report");
  assert.equal(artifactTitleFromHtml(`<TITLE lang="zh" data-x='1'>\n  财务报告\t 2026 \n</TITLE>`), "财务报告 2026", "any case, attributes, whitespace");
  assert.equal(artifactTitleFromHtml("<title>R&amp;D &lt;draft&gt; &quot;v2&quot; &#39;ok&#39; &#x4e2d;&nbsp;x &bogus;</title>"), `R&D <draft> "v2" 'ok' 中 x &bogus;`);
  assert.equal(artifactTitleFromHtml("<title>First</title><title>Second</title>"), "First");
  assert.equal(artifactTitleFromHtml("<h1>No title here</h1>"), null);
  assert.equal(artifactTitleFromHtml("<title>  \n </title>"), null, "empty is none");
  assert.equal(artifactTitleFromHtml("<title>never closed"), null);
  assert.equal(artifactTitleFromHtml("<titles>not it</titles>"), null, "only the title element");
});

test("appHosts: app links count only on this deployment's hosts; fixed hosts always", () => {
  const appHosts = ["app.raft.build"];
  const id = "pt_3c10b4ed-d947-49df-9031-91ae837f010a";
  assert.deepEqual(parseArtifactRef(`https://app.raft.build/artifacts/${id}`, { appHosts }), { kind: "id", id });
  assert.deepEqual(parseArtifactRef(`https://APP.raft.build/artifacts/${id}/v/3`, { appHosts }), { kind: "id", id, version: 3 });
  assert.deepEqual(parseArtifactRef(`https://evil.example/artifacts/${id}`, { appHosts }), { kind: "invalid", reason: "unrecognised" });
  assert.deepEqual(parseArtifactRef(`https://evil.example/s/raft/artifacts/${id}`, { appHosts }), { kind: "invalid", reason: "unrecognised" });
  assert.deepEqual(parseArtifactRef(`https://app.raft.build.evil.example/artifacts/${id}`, { appHosts }), { kind: "invalid", reason: "unrecognised" });
  // Fixed hosts and the content origin don't depend on appHosts.
  assert.deepEqual(parseArtifactRef(`https://artifacts.raft.build/${id}`, { appHosts }), { kind: "id", id });
  assert.deepEqual(parseArtifactRef("https://raft-artifacts.com/p/raft/notes", { appHosts }), { kind: "name", name: "notes", server: "raft" });
  assert.deepEqual(parseArtifactRef(`https://a-pt-3c10b4ed-d947-49df-9031-91ae837f010a.raftusercontent.com/index.html`, { appHosts }), { kind: "id", id });
  // Ids and names are not links.
  assert.deepEqual(parseArtifactRef(id, { appHosts }), { kind: "id", id });
  // Without appHosts (an agent's own argument), any host.
  assert.deepEqual(parseArtifactRef(`https://staging.example/artifacts/${id}`), { kind: "id", id });
  assert.ok(ARTIFACT_LINK_FIXED_HOSTS.includes("artifacts.raft.build"));
  assert.ok(ARTIFACT_LINK_FIXED_HOSTS.includes("raft-artifacts.com"));
});

test("an import's legacy link: only the standalone app's hosts (and configured ones), only /p/<server>/<name>", () => {
  const legacy = (server: string, name: string) => ({ kind: "legacy", server, name, link: `https://raft-artifacts.com/p/${server}/${name}` });
  assert.deepEqual(parseLegacyArtifactLink("https://raft-artifacts.com/p/raft/notes"), legacy("raft", "notes"));
  assert.deepEqual(parseLegacyArtifactLink(" https://WWW.raft-artifacts.com/p/raft/notes/v/3/raw?x#y "), legacy("raft", "notes"));
  assert.deepEqual(parseLegacyArtifactLink("http://artifact-share.botiverse.dev/p/raft/notes"), legacy("raft", "notes"));
  for (const host of ["evil.example", "raft-artifacts.com.evil.example", "169.254.169.254", "localhost", "app.raft.build"]) {
    assert.deepEqual(parseLegacyArtifactLink(`https://${host}/p/raft/notes`), { kind: "invalid", reason: "host" }, host);
  }
  assert.deepEqual(parseLegacyArtifactLink("https://staging-artifacts.example/p/raft/notes", { extraHosts: ["Staging-Artifacts.example"] }), legacy("raft", "notes"));
  assert.deepEqual(parseLegacyArtifactLink("https://raft-artifacts.com/a/token"), { kind: "invalid", reason: "legacy_version_link" });
  assert.deepEqual(parseLegacyArtifactLink("https://raft-artifacts.com/p/raft"), { kind: "invalid", reason: "unrecognised" });
  assert.deepEqual(parseLegacyArtifactLink("https://raft-artifacts.com/p/raft/Not_A_Name"), { kind: "invalid", reason: "unrecognised" });
  for (const value of ["notes", "pt_abc", "ftp://raft-artifacts.com/p/raft/notes", "file:///etc/passwd", "https://"]) {
    assert.deepEqual(parseLegacyArtifactLink(value), { kind: "invalid", reason: "not_a_link" }, value);
  }
});
