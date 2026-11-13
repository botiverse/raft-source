import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { shellPlan } from "@botiverse/porthole";
import { DOOR_PATH } from "@botiverse/porthole/server";
import { ARTIFACT_CONTENT_DOOR_PATH } from "@botiverse/raft-shared/src/artifactContentTicket";
import { raftDisplays } from "../src/raftContentDisplays";
import { startRaftContent } from "./raftContentHarness";

/**
 * The workspace's displays (src/raftContentDisplays.ts) and its content Worker
 * (src/raftContent.ts) are Porthole 0.16.0's, for `comments` (P090, P108,
 * P109) and the comment mode's annotations (P112, P115-P117; P118 the React
 * binding's `trackedAnnotation` and ref; 0.14.3's P119 the shell's 44×44 tap
 * area for markers on touch; 0.14.4's P120-P122 nested pages' keyboard and
 * shell label, nested pages being off here), and the door (0.14.6's P125,
 * 0.14.7's P126: the Worker answers its door at ARTIFACT_CONTENT_DOOR_PATH with
 * `doorAnswer`; 0.14.9's P131, find in page: `find` in the displays, for
 * Raft's find bar; 0.14.10's P132, the shell's: each attached mark's place in
 * the document and the document's scroll in `anchored` and `tracked`, which
 * the web's Markdown margin reads; 0.14.11's P133, the shell's: markers are
 * labelled buttons in the frame's Tab order, a posted one at its paragraph's
 * end, and `lastLineDocumentRect` in `selected`, `anchored` and `tracked`, which
 * the web's Comment button reads; 0.14.12's P134, the shell's: `focusMark` and a
 * marker's name without an element's tag; 0.14.13's P135 and 0.14.14's P137,
 * the shell's: a late `focusMark` lands only with the focus in the frame;
 * 0.14.15's P138 and 0.14.16's P140, the shell's selection following, which
 * the web doesn't ask yet; 0.14.16's P139, the shell's: on a tab it asks no
 * host and says so in `data-porthole-host`; 0.14.17's P141, the server's
 * `framedBy`: FRAMED_BY_ORIGINS in every frame-ancestors, never a host;
 * 0.14.18's P142, the shell's: a set's page says it arrived without the
 * Navigation API, and a link within a page says the page stayed; 0.15.0's P143,
 * the server's embed grants: `embeds` on only while EMBEDS is, an embed session's answers
 * `frame-ancestors *` and its plan hostless, no other session's changed; 0.15.1's P145,
 * the embeds audit: the host kit refuses an `access` answer with `embed` (Raft mints
 * embeds with `host.server.issue` alone), and a host origin's or `framedBy`'s port and
 * host must be as a browser serializes them; 0.15.2's P147, a comment's highlight and
 * marker moved with the document's scroll by a scroll timeline; 0.16.0's P149, the page's
 * calls need no proof of a click but `copyText`'s, and nested pages and the focus guard are
 * gone: the P109 and P120-P122 notes above are history). The shell in the
 * frame is this Worker's, so when its Porthole changes, it upgrades first and
 * Raft's web (packages/web), which mounts the frames, follows (an older host
 * ignores what 0.14's shell adds: `cancelled` on Escape while selecting text,
 * `order`, `tracked`; a host before 0.14.6 ignores the frame's `door`). A
 * 0.14.6+ web refuses a frame with no door, so this Worker (and the server,
 * which signs the door's ticket) deploys before it, with no grace release.
 * The web may be ahead only of a Porthole whose release
 * changed nothing this Worker bundles (as 0.14.5 was: P124, host code only): the
 * frames carry the same shell, byte for byte; that the newer host accepts it
 * is shown on staging (that web against this Worker) before the web ships. Nested pages (P111, P114)
 * stay off: no `nested` in the displays.
 */
const ROOT = new URL("../", import.meta.url);
const json = (path: string) => JSON.parse(readFileSync(new URL(path, ROOT), "utf8")) as Record<string, any>;

/** Porthole's runtime modules (not in its exports: by file). */
async function runtimeOf() {
  const dist = new URL("node_modules/@botiverse/porthole/dist/shell/", ROOT);
  const document = (await import(new URL("document.js", dist).href)) as { composedRuntime: (plan: unknown) => string };
  const use = (await import(new URL("use.js", dist).href)) as { USE_RUNTIME: string };
  return { composedRuntime: document.composedRuntime, USE_RUNTIME: use.USE_RUNTIME };
}

/** Porthole's modules in the Worker as wrangler bundled it (pnpm run build), by path in the package. */
function bundledPortholeModules() {
  const worker = readFileSync(new URL("dist/raftContent.js", ROOT), "utf8");
  return [...worker.matchAll(/^\/\/ (\S*@botiverse\/porthole\/\S+)$/gm)].map((match) => match[1]!);
}

/** Whether exact version `a` (x.y.z) is not newer than `b`. */
const notNewer = (a: string, b: string) => {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  const at = x!.findIndex((part, index) => part !== y![index]);
  return at === -1 || x![at]! < y![at]!;
};

test("Porthole is 0.16.0, and the web that mounts the frames is not ahead of what it bundles", () => {
  const manifest = json("package.json");
  const pinned: string = manifest.dependencies["@botiverse/porthole"];
  assert.equal(pinned, "0.16.0");
  const installed = json("node_modules/@botiverse/porthole/package.json");
  assert.equal(installed.name, "@botiverse/porthole");
  assert.equal(installed.version, "0.16.0");
  const web: string = json("../web/package.json").dependencies["@botiverse/porthole"];
  assert.match(web, /^\d+\.\d+\.\d+$/, "the web pins an exact version");
  if (notNewer(web, pinned)) return;
  // Ahead: every module this Worker bundles is the same in the web's Porthole.
  const webPackage = new URL("../web/node_modules/@botiverse/porthole/", ROOT);
  assert.equal(json("../web/node_modules/@botiverse/porthole/package.json").version, web);
  const bundled = bundledPortholeModules();
  assert.ok(bundled.length > 0, "Porthole's modules in the bundle");
  for (const path of bundled) {
    const inPackage = path.slice(path.lastIndexOf("@botiverse/porthole/") + "@botiverse/porthole/".length);
    const ours = readFileSync(new URL(`node_modules/@botiverse/porthole/${inPackage}`, ROOT));
    assert.ok(ours.equals(readFileSync(new URL(inPackage, webPackage))), `the web's Porthole (${web}) changes ${inPackage}, which the Worker (${pinned}) bundles: upgrade the Worker first`);
  }
});

test("the workspace's displays offer comments, under Porthole's capability runtime", () => {
  const config = raftDisplays.guideConfig("artifact", "served");
  assert.ok(Object.keys(config.capabilities ?? {}).includes("comments"), "comments among the capabilities");
  assert.equal(config.runtime, "1", "comments is the runtime's (P085): only a config with one may offer it");
  const plan = shellPlan(config)!;
  assert.ok(Object.keys(plan.capabilities).includes("comments"), "the frame's plan offers comments");
});

test("Raft's door is under Porthole's DOOR_PATH, where the host takes a door from, and never one of Porthole's own door keys", () => {
  assert.ok(ARTIFACT_CONTENT_DOOR_PATH.startsWith(DOOR_PATH), ARTIFACT_CONTENT_DOOR_PATH);
  // Porthole's door route takes 16 base32 letters (`/__porthole/door/<key>`): `_raft` is none.
  assert.doesNotMatch(ARTIFACT_CONTENT_DOOR_PATH.slice(DOOR_PATH.length), /^[a-z2-7]{16}$/);
});

test("a workspace frame runs Porthole 0.16.0's runtime, comments in its plan; the Worker bundles 0.16.0 only", async (t) => {
  const app = await startRaftContent();
  t.after(() => app.close());
  const published = await app.publish({ "index.html": `<!doctype html><title>t</title><h1>Decision sheet</h1>` });
  const issued = await app.issue(app.bodyFor(published));
  assert.equal(issued.status, 201, await issued.clone().text());
  const location = (await issued.json()) as { url: string; viewer?: unknown; door?: unknown };
  // The bridge refuses the runtime's host functions without a viewer: the issue's answer carries one.
  assert.deepEqual(location.viewer, { level: "view" });
  // But no door (P125): a frame's door is Raft's own (ARTIFACT_CONTENT_DOOR_PATH), its ticket the
  // server's; this legacy route's callers predate the door.
  assert.equal(location.door, undefined);
  const served = await app.contentFetch(location.url, { headers: { "sec-fetch-dest": "iframe" } });
  assert.equal(served.status, 200);
  const body = await served.text();

  const plan = JSON.parse(/\n\s*const plan = (\{.*\});\n/.exec(body)?.[1] ?? "null") as { capabilities: Record<string, unknown>; runtime?: unknown } | null;
  assert.ok(plan, "the shell's plan");
  assert.ok(Object.keys(plan.capabilities).includes("comments"), "comments in the served plan");
  assert.ok(plan.runtime !== undefined, "the capability runtime in the served plan");
  // The page's comment button and its links need no proof of a click (Porthole's defaults since
  // 0.16.0: the check refused real presses, #proj-workspace:#271); the clipboard still does.
  const needsClick = (name: string) => (plan.capabilities[name] as { userActivation?: unknown } | undefined)?.userActivation;
  assert.equal(needsClick("comments"), false, "comments.open: the shell stops no call for want of a click");
  assert.equal(needsClick("openLink"), false, "openLink: Porthole's confirmation is its gate");
  assert.equal(needsClick("copyText"), true, "copyText keeps Porthole's default");

  const workspace = await runtimeOf();
  const parts = workspace.composedRuntime(shellPlan(raftDisplays.guideConfig("artifact", "served"))).split("__PLAN__");
  assert.equal(parts.length, 2);
  for (const part of parts) assert.ok(body.includes(part), "0.16.0's composed runtime, around the plan");
  assert.ok(body.includes(workspace.USE_RUNTIME), "0.16.0's capability runtime");

  // The Worker as wrangler bundled it: Porthole's modules, every one 0.16.0's.
  const bundled = bundledPortholeModules();
  assert.ok(bundled.some((path) => path.endsWith("@botiverse/porthole/dist/shell/runtime.js")), "Porthole's shell runtime in the bundle");
  assert.ok(bundled.every((path) => path.includes("/@botiverse+porthole@0.16.0")), `only 0.16.0's modules: ${bundled.filter((path) => !path.includes("/@botiverse+porthole@0.16.0"))}`);
});
