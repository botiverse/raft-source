/**
 * A Raft app page for browser checks of the content Worker: on APP_ORIGIN
 * (the stub's), it mounts a frame with Porthole's own host (`createHost`,
 * the served config of src/raftContentDisplays.ts) and a locator that asks
 * a frame route answering as Raft's server signs one (contentWorker.ts
 * signFrame: `/_raft/open`'s ticket and its door's, P125, P126; the issue
 * route gives no door, which the web's Porthole refuses as `blocked:
 * locate`). The client
 * is the web's Porthole (packages/web's), not this Worker's: the Worker
 * upgrades first (test/workspace-porthole.test.ts), so the pair checked is
 * the one deployed. The page's `comments.open` calls land in
 * `window.comments`; the mounted display is `window.display` and its frame's
 * annotation reports land in `window.annotations`.
 */
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { raftDisplays } from "../src/raftContentDisplays";
import { signTicket, type Published, type RaftContentApp } from "./raftContentHarness";

const CLIENT = "../web/node_modules/@botiverse/porthole/dist";

/** Serves Porthole's browser modules, the served config, the frame route and the host page on the app origin. */
export function mountHostPage(app: RaftContentApp): void {
  const { routes } = app.raft;
  routes.set("/config.json", async () => ({
    type: "application/json",
    body: JSON.stringify(raftDisplays.served(`http://*.${app.contentDomain}`)!.artifact),
  }));
  routes.set("/frame", async ({ body }) => {
    const { artifact, version, page } = JSON.parse(body) as Published & { page?: string | null };
    const published = { artifact, version, number: 0 };
    // Another page of the version than its entry (#proj-workspace:#272): both tickets name it, as the server's do.
    const at = typeof page === "string" ? { page } : {};
    const frame = {
      url: app.openUrl(published, signTicket(app.claimsFor(published, at))),
      origin: app.originOf(published),
      reports: true,
      door: { url: app.doorUrl(published, signTicket(app.claimsFor(published, { door: true, ...at }))) },
      instanceVersion: version,
    };
    return { status: 201, type: "application/json", body: JSON.stringify(frame) };
  });
  routes.set("/host", async () => ({ type: "text/html; charset=utf-8", body: HOST_PAGE }));
  // Porthole's modules, by path under /porthole-client/ (each a .js file of its dist).
  const serveClient = async ({ url }: { url: URL }) => {
    const path = normalize(url.pathname.slice("/porthole-client/".length));
    if (path.startsWith("..") || !path.endsWith(".js")) return { status: 404, type: "text/plain", body: "" };
    return { type: "text/javascript", body: await readFile(join(CLIENT, path)) };
  };
  routes.set("/porthole-client/*", serveClient);
}

/**
 * `/host?artifact=…&version=…`: one frame, its outcome in #outcome, each locate counted in
 * `window.locates`. The instance names `version` as the issue did (the web mounts the frame route's
 * `instanceVersion`); `&mounted=…` mounts another version instead (a version's number, as the web
 * did before #proj-workspace:#251), for the pages smoke's control. `&page=…`: the frame opens at
 * that page of the version instead of its entry (a page ticket, #proj-workspace:#272).
 */
const HOST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Raft (test host)</title>
<style>html,body{margin:0;height:100%} #frame{height:760px;width:100%}</style></head>
<body><div id="frame"></div><pre id="outcome"></pre>
<script type="importmap">{"imports":{"@botiverse/porthole":"/porthole-client/index.js"}}</script>
<script type="module">
import { createHost } from "@botiverse/porthole";
const query = new URLSearchParams(location.search);
const artifact = query.get("artifact"), version = query.get("version"), mounted = query.get("mounted") ?? version, page = query.get("page");
window.locates = 0;
const config = await (await fetch("/config.json")).json();
const locator = { locate: async () => {
  window.locates += 1;
  const answer = await fetch("/frame", { method: "POST", body: JSON.stringify({ artifact, version, page }) });
  if (answer.status !== 201) throw new Error("issue " + answer.status);
  return answer.json();
} };
window.opened = [];
window.comments = [];
const handlers = {
  openLink: async ({ url }) => { window.opened.push(url); return {}; },
  copyText: async () => ({}),
  // Raft's composer, opened at the anchor with the page's draft (P108): here, recorded.
  comments: async (request) => { window.comments.push(request); return true; },
};
const host = createHost(config, { locator, handlers, confirm: async () => true });
const instance = { scope: artifact.slice(3), document: { kind: "artifact", id: artifact, version: mounted } };
// No stored declaration (the runtime's built-ins only, comments among them): null, as Raft's mount gives;
// the viewer's level on the mount, as ArtifactFrame's PAGE_VIEWER (Raft's frame names none).
const display = host.mount(document.getElementById("frame"), { displayId: version, title: "t", scheme: "light", instance, declaration: null, viewer: { level: "view" } });
display.on("outcome", (outcome) => { document.getElementById("outcome").textContent = JSON.stringify(outcome); });
// For checks that drive the frame as Raft's web does (find, annotations): the display, and what its frame reported.
window.display = display;
window.annotations = [];
display.on("annotation", (report) => { window.annotations.push(report); });
</script></body></html>`;
