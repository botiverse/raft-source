// A local content origin for the web's fake Artifact data (workspace Artifacts S2), for
// development and screenshots only: never in production, never in unit tests.
//
//   node --import @oxc-node/core/register packages/web/scripts/fake-artifact-content.ts   # APP_ORIGIN=http://localhost:5173 by default
//
// The fake data source's frame route (src/apps/artifacts/fakeArtifactSource.ts) answers one fixed
// FrameLocation per framed fixture: http://w-<id>.content.localhost:8791/_fake/enter?version=<n>.
// That address asks this server's own Porthole host for a one-time ticket and goes on to it, so
// every mount still enters the way the content Worker's frames do (ticket, then a session), with
// the same display config (ArtifactFrame's RAFT_ARTIFACT_DISPLAYS, raft-artifact-share
// src/raftContentDisplays.ts). Pages are the fixtures' stand-ins (fakeArtifactPages.json). Its door
// (Porthole P125), /__porthole/door/_fake?version=<n>, which the host frames first, is answered by
// this host's own `doorAnswer` for the fake viewer, as the content Worker answers its own door path.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { defineDisplays, LIBRARY_CDNS } from "@botiverse/porthole";
import { nodeListener } from "@botiverse/porthole/node";
import { createContentHost, memoryTicketStore, prefixedName } from "@botiverse/porthole/server";
import { ARTIFACT_PAGE_THEME_VARIABLES } from "@botiverse/raft-shared/src/artifactPageTheme";

const PORT = Number(process.env.PORT ?? 8791);
const DOMAIN = `content.localhost:${PORT}`;
const APP_ORIGIN = process.env.APP_ORIGIN ?? "http://localhost:5173";
const pages = JSON.parse(await readFile(new URL("../src/apps/artifacts/fakeArtifactPages.json", import.meta.url), "utf8"));

const displays = defineDisplays({
  artifact: {
    preset: "artifact",
    options: {
      egress: LIBRARY_CDNS,
      runtime: "1",
      // As ArtifactFrame's RAFT_ARTIFACT_DISPLAYS and the content Worker's (annotate for comment mode,
      // find for the find bar).
      capabilities: { annotate: {}, comments: {}, copyText: {}, find: {}, openLink: {} },
      layout: { kind: "fill" },
      errors: "host",
      theme: { variables: ARTIFACT_PAGE_THEME_VARIABLES },
    },
    served: { storage: { scope: "this artifact, across its versions" } },
  },
});

const content = createContentHost({
  domain: DOMAIN,
  appOrigins: [APP_ORIGIN],
  secret: randomBytes(32),
  tickets: memoryTicketStore(),
  displays,
  name: prefixedName("w-"),
  // The fake's Artifact `pt_<scope>`, a version of it: anything else names nothing.
  instance: (proposal) => (proposal.document.kind === "artifact" && pages[`pt_${proposal.scope}`] && proposal.document.id === `pt_${proposal.scope}` ? proposal : null),
  access: () => ({ viewer: "fake-viewer" }),
  source: async (id) => (pages[id] ? { html: pages[id] } : null),
});
const issue = content.issue(() => "fake-viewer");

async function app(request) {
  const url = new URL(request.url);
  const label = url.hostname.endsWith(`.content.localhost`) ? url.hostname.split(".")[0] : "";
  if (url.pathname === "/__porthole/door/_fake" && label.startsWith("w-") && content.server) {
    const scope = label.slice(2);
    const instance = { scope, document: { kind: "artifact", id: `pt_${scope}`, version: url.searchParams.get("version") ?? "1" } };
    try {
      return await content.server.doorAnswer(instance, { viewer: "fake-viewer" }, request);
    } catch {
      return new Response("not found", { status: 404 });
    }
  }
  if (url.pathname === "/_fake/enter" && label.startsWith("w-")) {
    const scope = label.slice(2);
    const version = url.searchParams.get("version") ?? "1";
    const issued = await issue(new Request(`${APP_ORIGIN}/porthole/frames`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({ instance: { scope, document: { kind: "artifact", id: `pt_${scope}`, version } } }),
    }));
    if (issued.status !== 201) return new Response(`issue ${issued.status}: ${await issued.text()}`, { status: 502 });
    const location = await issued.json();
    return new Response(null, { status: 303, headers: { location: location.url, "cache-control": "no-store" } });
  }
  return (await content.fetch(request)) ?? new Response("not found", { status: 404 });
}

// Loopback only: it hands out tickets to anyone who asks.
createServer(nodeListener(app)).listen(PORT, "127.0.0.1", () => {
  console.log(`Fake Artifact content on http://*.${DOMAIN}, framed by ${APP_ORIGIN}`);
});
