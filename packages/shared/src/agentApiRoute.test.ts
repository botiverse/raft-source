// A first-party app's agent API fragment and its merge into the contract
// (agentApiRoute.ts): an app's routes stay under its own path and client
// resource, two routes never share a key or a client resource and method,
// and an app route's request and response types come from its own schemas,
// as they were written by hand before the fragments.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "vitest";
import { z } from "zod";
import type {
  AgentApiArtifactCommentBody,
  AgentApiArtifactImportBody,
  AgentApiArtifactImported,
  AgentApiArtifactCommentCreated,
  AgentApiArtifactCommentImage,
  AgentApiArtifactCommentImageParams,
  AgentApiArtifactReviewBody,
  AgentApiArtifactReviewCreated,
  AgentApiArtifactCommentsQuery,
  AgentApiArtifactCommentsResponse,
  AgentApiArtifactDeleted,
  AgentApiArtifactFileContentResponse,
  AgentApiArtifactFileParams,
  AgentApiArtifactFileQuery,
  AgentApiArtifactListQuery,
  AgentApiArtifactListResponse,
  AgentApiArtifactMoveBody,
  AgentApiArtifactMoved,
  AgentApiArtifactParams,
  AgentApiArtifactPublishBody,
  AgentApiArtifactPublishResponse,
  AgentApiArtifactReadQuery,
  AgentApiArtifactReadResponse,
  AgentApiArtifactSaveAttachmentBody,
  AgentApiArtifactSaved,
  AgentApiArtifactSubscriptionResponse,
  AgentApiArtifactCommentParams,
  AgentApiArtifactResolveBody,
  AgentApiArtifactThreadResolution,
  AgentApiArtifactUploadParams,
} from "./agentApiArtifactsContract";
import type { AgentApiArtifactCheckQuery, AgentApiArtifactCheckResponse, AgentApiArtifactCheckShotParams } from "./agentApiArtifactChecksContract";
import {
  agentApiContract,
  type AgentApiRequestBodyByRoute,
  type AgentApiRequestParamsByRoute,
  type AgentApiRequestQueryByRoute,
  type AgentApiResponseByRoute,
  type AgentApiRouteKey,
} from "./agentApiContract";
import { AGENT_API_META, agentApiRoute, defineAppAgentApi, mergeAppAgentApis } from "./agentApiRoute";
import { AGENT_API_ROUTE_META } from "./agentApiRouteMeta";
import { artifactsAgentApi } from "./apps/artifacts/agentApi";

const docsPage = () => agentApiRoute({
  key: "docsPage",
  method: "GET",
  path: "/docs/:page",
  client: { resource: "docs", method: "page" },
  capability: "read",
  description: "A page.",
  request: { params: z.object({ page: z.string() }) },
  response: { kind: "binary" },
  meta: AGENT_API_META.read,
  visibility: { entry: "unified", reason: "a page: canViewHomedObjects" },
});
/** docsPage with some fields replaced, past the types (they refuse it; the runtime check must too). */
const docsPageWith = (over: Record<string, unknown>) => ({ ...docsPage(), ...over }) as never;

test("an app's routes stay under /<id>/ and its client resource, each keyed by its property name", () => {
  assert.doesNotThrow(() => defineAppAgentApi("docs", { docsPage: docsPage() }));
  assert.throws(() => defineAppAgentApi("docs", { docsPage: docsPageWith({ path: "/send" }) }), /docs's agent API route docsPage is at \/send, not under \/docs\//);
  assert.throws(() => defineAppAgentApi("docs", { docsPage: docsPageWith({ path: "/docsx/1" }) }), /is at \/docsx\/1/, "a prefix of another word is not the app's");
  assert.throws(() => defineAppAgentApi("docs", { docsPage: docsPageWith({ client: { resource: "messages", method: "page" } }) }), /is on the client's messages, not docs/);
  assert.throws(() => defineAppAgentApi("docs", { docsPage: docsPageWith({ key: "other" }) }), /route docsPage has key other/);
  // What core lists per route comes with it: its meta, and a read's visibility or a write's authority (only that).
  assert.throws(() => defineAppAgentApi("docs", { docsPage: docsPageWith({ meta: undefined }) }), /route docsPage has no meta/);
  assert.throws(() => defineAppAgentApi("docs", { docsPage: docsPageWith({ visibility: undefined }) }), /docsPage \(GET\) declares a read's visibility and only that/);
  assert.throws(() => defineAppAgentApi("docs", { docsPage: docsPageWith({ method: "POST" }) }), /docsPage \(POST\) declares a write's authority and only that/);
  assert.doesNotThrow(() => defineAppAgentApi("docs", { docsPage: docsPageWith({ method: "POST", visibility: undefined, authority: { reason: "the caller's own page" }, meta: AGENT_API_META.write }) }), "a write with its authority");
  assert.throws(() => {
    // @ts-expect-error a path outside /docs/ is a type error too
    defineAppAgentApi("docs", { docsPage: agentApiRoute({ ...docsPage(), path: "/send" }) });
  }, /not under \/docs\//);
});

test("merging refuses a route key or a client resource and method that two routes share", () => {
  const docs = defineAppAgentApi("docs", { docsPage: docsPage() });
  const core = { messageSend: agentApiContract.messageSend };
  assert.deepEqual(Object.keys(mergeAppAgentApis(core, [docs])), ["messageSend", "docsPage"], "core first, then each app");
  const sameKey = { docsPage: { ...agentApiContract.messageSend, key: "docsPage" } };
  assert.throws(() => mergeAppAgentApis(sameKey, [docs]), /agent API route docsPage of docs is already a route of the contract/);
  const twin = defineAppAgentApi("docs", { docsPageAgain: docsPageWith({ key: "docsPageAgain" }) });
  assert.throws(() => mergeAppAgentApis(core, [docs, twin]), /docsPageAgain of docs is the client's docs\.page, which docsPage already is/);
});

test("an app route's metadata is its fragment's", () => {
  for (const route of Object.values(artifactsAgentApi.routes)) assert.equal(AGENT_API_ROUTE_META[route.key], route.meta, route.key);
  assert.equal(AGENT_API_ROUTE_META.artifactComment.idempotency, "none");
  assert.equal(AGENT_API_ROUTE_META.artifactPublish.idempotency, "natural");
});

test("the contract has Artifacts' routes from its fragment, after core's, at the same paths", () => {
  const keys = Object.keys(agentApiContract);
  const artifactKeys = Object.keys(artifactsAgentApi.routes);
  assert.deepEqual(keys.slice(-artifactKeys.length), artifactKeys);
  for (const key of artifactKeys) {
    assert.equal(agentApiContract[key as AgentApiRouteKey], artifactsAgentApi.routes[key as keyof typeof artifactsAgentApi.routes]);
    assert.match(agentApiContract[key as AgentApiRouteKey].fullPath, /^\/internal\/agent-api\/artifacts(\/|$)/);
  }
});

test("apps' samples are for tests only: no runtime file imports them, in any form", () => {
  const repoRoot = resolve(import.meta.dirname, "../../..");
  const allowed = join("packages", "shared", "src", "apps", "agentApiSamples.ts");
  // Any module path ending in agentApi.samples or agentApiSamples (an import, export … from, import(), require, a side-effect import, any suffix).
  const samplesPath = /["'`](?:[^"'`]*\/)?(?:agentApi\.samples|agentApiSamples)(?:\.[cm]?[jt]sx?)?["'`]/;
  const offenders: string[] = [];
  for (const group of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(repoRoot, group))) {
      const src = join(repoRoot, group, pkg, "src");
      let files: string[];
      try { files = readdirSync(src, { recursive: true }) as string[]; } catch { continue; }
      for (const file of files) {
        if (!/\.[cm]?[jt]sx?$/.test(file) || /\.(test|testkit|spec)\.[cm]?[jt]sx?$/.test(file) || file.includes("node_modules")) continue;
        const path = join(src, file);
        // The samples themselves (each app's, and the index of them) import each other.
        if (relative(repoRoot, path) === allowed || /(^|\/)agentApi\.samples\.ts$/.test(file)) continue;
        if (samplesPath.test(readFileSync(path, "utf8"))) offenders.push(relative(repoRoot, path));
      }
    }
  }
  assert.deepEqual(offenders, []);
});

// The types an app route had by hand are the ones its schemas now give:
// each whole map, over every Artifacts route (keys and values).
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type ArtifactKey = keyof typeof artifactsAgentApi.routes;
type Pick4<M> = { [K in ArtifactKey]: M extends Record<ArtifactKey, unknown> ? M[K] : never };
type _Types = [
  Expect<Equal<Pick4<AgentApiRequestParamsByRoute>, {
    artifactList: never; artifactRead: AgentApiArtifactParams; artifactFile: AgentApiArtifactFileParams; artifactFileContent: AgentApiArtifactFileParams;
    artifactComments: AgentApiArtifactParams; artifactPublish: never; artifactUpload: AgentApiArtifactUploadParams; artifactComment: AgentApiArtifactParams; artifactReview: AgentApiArtifactParams;
    artifactCommentImageUpload: AgentApiArtifactParams; artifactCommentImage: AgentApiArtifactCommentImageParams;
    artifactCheck: AgentApiArtifactParams; artifactCheckShot: AgentApiArtifactCheckShotParams;
    artifactCommentResolve: AgentApiArtifactCommentParams; artifactCommentReopen: AgentApiArtifactCommentParams;
    artifactSubscribe: AgentApiArtifactParams; artifactUnsubscribe: AgentApiArtifactParams; artifactImport: never;
    artifactMove: AgentApiArtifactParams; artifactDelete: AgentApiArtifactParams; artifactSaveAttachment: never;
  }>>,
  Expect<Equal<Pick4<AgentApiRequestQueryByRoute>, {
    artifactList: AgentApiArtifactListQuery; artifactRead: AgentApiArtifactReadQuery; artifactFile: AgentApiArtifactFileQuery; artifactFileContent: AgentApiArtifactFileQuery;
    artifactComments: AgentApiArtifactCommentsQuery; artifactPublish: never; artifactUpload: never; artifactComment: never; artifactReview: never;
    artifactCommentImageUpload: never; artifactCommentImage: never;
    artifactCheck: AgentApiArtifactCheckQuery; artifactCheckShot: AgentApiArtifactCheckQuery;
    artifactCommentResolve: never; artifactCommentReopen: never;
    artifactSubscribe: never; artifactUnsubscribe: never; artifactImport: never;
    artifactMove: never; artifactDelete: never; artifactSaveAttachment: never;
  }>>,
  Expect<Equal<Pick4<AgentApiRequestBodyByRoute>, {
    artifactList: never; artifactRead: never; artifactFile: never; artifactFileContent: never;
    artifactComments: never; artifactPublish: AgentApiArtifactPublishBody; artifactUpload: never; artifactComment: AgentApiArtifactCommentBody; artifactReview: AgentApiArtifactReviewBody;
    artifactCommentImageUpload: never; artifactCommentImage: never;
    artifactCheck: never; artifactCheckShot: never;
    artifactCommentResolve: AgentApiArtifactResolveBody; artifactCommentReopen: never;
    artifactSubscribe: never; artifactUnsubscribe: never; artifactImport: AgentApiArtifactImportBody;
    artifactMove: AgentApiArtifactMoveBody; artifactDelete: never; artifactSaveAttachment: AgentApiArtifactSaveAttachmentBody;
  }>>,
  Expect<Equal<Pick4<AgentApiResponseByRoute>, {
    artifactList: AgentApiArtifactListResponse; artifactRead: AgentApiArtifactReadResponse; artifactFile: Uint8Array; artifactFileContent: AgentApiArtifactFileContentResponse;
    artifactComments: AgentApiArtifactCommentsResponse; artifactPublish: AgentApiArtifactPublishResponse; artifactUpload: null; artifactComment: AgentApiArtifactCommentCreated; artifactReview: AgentApiArtifactReviewCreated;
    artifactCommentImageUpload: AgentApiArtifactCommentImage; artifactCommentImage: Uint8Array;
    artifactCheck: AgentApiArtifactCheckResponse; artifactCheckShot: Uint8Array;
    artifactCommentResolve: AgentApiArtifactThreadResolution; artifactCommentReopen: AgentApiArtifactThreadResolution;
    artifactSubscribe: AgentApiArtifactSubscriptionResponse; artifactUnsubscribe: AgentApiArtifactSubscriptionResponse; artifactImport: AgentApiArtifactImported;
    artifactMove: AgentApiArtifactMoved; artifactDelete: AgentApiArtifactDeleted; artifactSaveAttachment: AgentApiArtifactSaved;
  }>>,
  // And the maps' app entries are plain (not readonly), as the hand-written ones were.
  Expect<Equal<{ artifactList: AgentApiArtifactListResponse }, Pick<AgentApiResponseByRoute, "artifactList">>>,
];
