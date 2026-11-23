// A framed page's bare links to other Artifacts, shown with each target's live title
// (#proj-workspace:#336): the links route's answer made into Porthole's link labels.
import assert from "node:assert/strict";
import { LINK_LABEL_LIMITS } from "@botiverse/porthole";
import { asArtifactId } from "@botiverse/raft-shared";
import type { ArtifactContentLink, ArtifactLinkTarget } from "@botiverse/raft-shared";

import { artifactLinkLabel, artifactLinkLabels, artifactLinkTag } from "../src/apps/artifacts/artifactLinkLabels";

const WORDS = { deleted: "Deleted", unavailable: "No access to this" };
const ID = asArtifactId("pt_00000000-0000-4000-8000-000000000001");

function link(href: string, target: ArtifactLinkTarget, more: Partial<ArtifactContentLink> = {}): ArtifactContentLink {
  return { href, path: "index.md", bare: true, id: ID, version: null, target, authorSees: true, ...more };
}

const OK: ArtifactLinkTarget = { state: "ok", title: "Q3 plan", kind: "markdown" };

test("an Artifact the reader can open: its title, tagged with its kind", () => {
  assert.deepEqual(artifactLinkLabel(link("https://app.raft.build/artifacts/a", OK), WORDS), {
    href: "https://app.raft.build/artifacts/a",
    text: "Q3 plan",
    tag: "artifact-markdown",
  });
  assert.equal(artifactLinkLabel(link("https://x/a", { state: "ok", title: "Deck", kind: "html" }), WORDS)?.tag, "artifact-html");
});

test("a pinned version says which; one the reader can't open is left as the page wrote it", () => {
  const pinned = (versionExists?: boolean) =>
    artifactLinkLabel(link("https://x/a/v/3", { ...OK, ...(versionExists === undefined ? {} : { versionExists }) }, { version: 3 }), WORDS);
  assert.equal(pinned(true)?.text, "Q3 plan · v3");
  assert.equal(pinned()?.text, "Q3 plan · v3");
  assert.equal(pinned(false), null);
});

test("deleted and unavailable say Raft's words, never more, with their own tags", () => {
  assert.deepEqual(artifactLinkLabel(link("https://x/d", { state: "deleted" }), WORDS), { href: "https://x/d", text: "Deleted", tag: "artifact-deleted" });
  assert.deepEqual(artifactLinkLabel(link("https://x/u", { state: "unavailable" }), WORDS), { href: "https://x/u", text: "No access to this", tag: "artifact-unavailable" });
});

test("a target the version's author can't see now is never labelled, whatever the reader is told: the page reads every label", () => {
  for (const target of [OK, { state: "deleted" }, { state: "unavailable" }] as ArtifactLinkTarget[]) {
    assert.equal(artifactLinkLabel(link("https://x/a", target, { authorSees: false }), WORDS), null, target.state);
    // An answer without it (a server before it) reads as no.
    const { authorSees: _authorSees, ...older } = link("https://x/a", target);
    assert.equal(artifactLinkLabel(older as ArtifactContentLink, WORDS), null, `${target.state}, no authorSees`);
  }
  // Another link to the same address the author does see still labels it.
  assert.deepEqual(artifactLinkLabels([link("https://x/a", OK, { authorSees: false }), link("https://x/a", OK, { path: "b.md" })], WORDS).map((label) => label.href), ["https://x/a"]);
});

test("only bare links are labelled", () => {
  assert.equal(artifactLinkLabel(link("https://x/a", OK, { bare: false }), WORDS), null);
  assert.equal(artifactLinkLabel(link("https://x/d", { state: "deleted" }, { bare: false }), WORDS), null);
});

test("a blank title labels nothing; a long one is cut to Porthole's limit, its version kept", () => {
  assert.equal(artifactLinkLabel(link("https://x/a", { ...OK, title: "   " }), WORDS), null);
  const long = artifactLinkLabel(link("https://x/a", { ...OK, title: "t".repeat(400) }, { version: 12 }), WORDS);
  assert.ok(long);
  assert.equal(long.text.length, LINK_LABEL_LIMITS.text);
  assert.ok(long.text.endsWith("… · v12"), long.text);
  // Never half a surrogate pair at the cut.
  const emoji = artifactLinkLabel(link("https://x/a", { ...OK, title: `${"t".repeat(LINK_LABEL_LIMITS.text - 2)}😀😀` }), WORDS);
  assert.ok(emoji);
  assert.ok(emoji.text.length <= LINK_LABEL_LIMITS.text);
  assert.doesNotMatch(emoji.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test("a tag holds to Porthole's characters and length", () => {
  assert.equal(artifactLinkTag("PDF"), "artifact-pdf");
  assert.equal(artifactLinkTag("a b_c"), "artifact-abc");
  assert.equal(artifactLinkTag(""), "artifact-other");
  assert.match(artifactLinkTag("k".repeat(80)), /^[a-z0-9-]{1,32}$/);
});

test("one label per address, the first that makes one; at most Porthole's 500", () => {
  const labels = artifactLinkLabels([
    link("https://x/a", OK, { bare: false }),
    link("https://x/a", OK, { path: "other.md" }),
    link("https://x/a", { state: "unavailable" }, { path: "third.md" }),
    link("https://x/b", { state: "deleted" }),
  ], WORDS);
  assert.deepEqual(labels.map((label) => [label.href, label.text]), [["https://x/a", "Q3 plan"], ["https://x/b", "Deleted"]]);

  const many = Array.from({ length: LINK_LABEL_LIMITS.labels + 20 }, (_, i) => link(`https://x/${i}`, OK));
  assert.equal(artifactLinkLabels(many, WORDS).length, LINK_LABEL_LIMITS.labels);
  assert.deepEqual(artifactLinkLabels([], WORDS), []);
});
