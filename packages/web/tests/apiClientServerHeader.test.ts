// The web API client's X-Server-Id (api/client.ts's request interceptor), as it goes on the wire:
// - a request that names no server carries the current one;
// - one that names a server keeps it;
// - one that names `false` carries none, whichever server is current (the public Artifact routes:
//   a signed-in reader's current server may be one whose Artifacts are off, #proj-workspace:#74).
import assert from "node:assert/strict";
import "./helpers/domSetup";
import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";
import { asArtifactId } from "@botiverse/raft-shared";

import api from "../src/api/client";
import { publicArtifactView } from "../src/apps/artifacts/apiArtifactSource";
import { useServerStore } from "../src/store/serverStore";

const originalAdapter = api.defaults.adapter;
let sent: Array<{ url: string; serverId: unknown }> = [];

beforeEach(() => {
  sent = [];
  api.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
    // What goes on the wire: the adapters send the headers' JSON, which leaves a `false` header out.
    sent.push({ url: config.url ?? "", serverId: config.headers.toJSON()["X-Server-Id"] });
    return { status: 200, statusText: "OK", data: {}, headers: {}, config, request: {} };
  }) as AxiosAdapter;
  useServerStore.setState({ current: { id: "server-current", slug: "current", name: "Current" } } as never);
});

afterEach(() => {
  api.defaults.adapter = originalAdapter;
  useServerStore.setState(useServerStore.getInitialState(), true);
});

test("no server named: the current one; a named server: kept; `false`: none", async () => {
  await api.get("/plain");
  await api.get("/named", { headers: { "X-Server-Id": "server-named" } });
  await api.get("/none", { headers: { "X-Server-Id": false } });
  assert.deepEqual(sent, [
    { url: "/plain", serverId: "server-current" },
    { url: "/named", serverId: "server-named" },
    { url: "/none", serverId: undefined },
  ]);
});

test("the public Artifact view is sent with no server, though one is current", async () => {
  const id = asArtifactId("pt_3c10b4ed-d947-49df-9031-91ae837f010a");
  await publicArtifactView(id);
  assert.deepEqual(sent, [{ url: `/public/artifacts/${id}`, serverId: undefined }]);
});
