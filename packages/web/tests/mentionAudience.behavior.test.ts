// The @ picker's candidates for an audience other than an Artifact come from
// core's audience route directly (POST /api/mentions/audience), mapped to
// the picker's candidates.
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { afterEach, beforeEach, test } from "vitest";
import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";
import { asChannelId } from "@botiverse/raft-shared";

import api from "../src/api/client";
import { fetchMentionAudienceCandidates } from "../src/components/mention/mentionAudience";

let requests: Array<{ method: string; url: string; data: unknown }> = [];
const originalAdapter = api.defaults.adapter;

beforeEach(() => {
  requests = [];
  api.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
    requests.push({ method: (config.method ?? "get").toUpperCase(), url: config.url ?? "", data: config.data ? JSON.parse(config.data as string) : undefined });
    const data = { candidates: [{ type: "user", id: "u1", name: "judith", displayName: "Judith", avatarUrl: null, guest: true }], capped: true };
    return { status: 200, statusText: "200", data, headers: {}, config, request: {} };
  }) as AxiosAdapter;
});

afterEach(() => {
  api.defaults.adapter = originalAdapter;
});

test("a conversation audience asks the route under the client's /api base and maps its actors", async () => {
  const answer = await fetchMentionAudienceCandidates({ kind: "conversation", channelId: asChannelId("c1") }, "ju");
  assert.deepEqual(requests, [{ method: "POST", url: "/mentions/audience", data: { audience: { kind: "conversation", channelId: "c1" }, q: "ju" } }]);
  assert.deepEqual(answer, { candidates: [{ id: "u1", type: "user", name: "judith", displayName: "Judith", avatarUrl: null }], capped: true });
});
