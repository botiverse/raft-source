import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "vitest";
import type { AgentMigrationExportManifest } from "./agentMigrationExport.js";
import {
  AGENT_MIGRATION_CONTROL_SEAM_ENV,
  createAgentMigrationHttpTransport,
  resolveAgentMigrationControlSeamEnabled,
  resolveAgentMigrationHttpTransportListenOptions,
} from "./agentMigrationHttpTransport.js";

const future = new Date("2026-07-06T12:00:00.000Z");
const now = new Date("2026-07-06T11:00:00.000Z");

function manifest(agentId = "agent-http"): AgentMigrationExportManifest {
  return {
    schemaVersion: "agent-bundle/v2",
    agentId,
    mode: "cooperative",
    createdAt: "2026-07-06T10:00:00.000Z",
    defaults: {
      unknownFiles: "include",
      excludePolicy: "regenerable_only",
      regenerableDirectoryNames: ["node_modules", "target", ".venv", "dist", "__pycache__"],
    },
    files: [{
      kind: "file",
      source: "workspace",
      bundlePath: "workspace/notes.md",
      workspaceRelativePath: "notes.md",
      sizeBytes: 6,
      sha256: "a".repeat(64),
    }],
    excludedRegenerable: [],
    promotedIncludes: [],
    proposalRefusals: [],
    unreachable: [],
    secretsDisclosed: [],
    cleaned: [],
    crossTreeRefs: [],
  };
}

async function withTransport<T>(
  fn: (ctx: {
    baseUrl: string;
    grantId: string;
    token: string;
    manifestSha256: string;
    fetchGrant: (path: string, init?: RequestInit) => Promise<Response>;
    state: () => string | undefined;
  }) => Promise<T>,
  opts: Parameters<typeof createAgentMigrationHttpTransport>[0] = {},
  grantOpts: { bundleSizeBytes?: number | null } = {},
): Promise<T> {
  const transport = createAgentMigrationHttpTransport({
    now: () => now,
    ...opts,
  });
  const { grant, token } = transport.grants.createGrant({
    grantId: "grant-1",
    token: "test-token",
    expiresAt: future,
    manifest: manifest(),
    ...grantOpts,
  });
  const { url } = await transport.listen();
  try {
    return await fn({
      baseUrl: url,
      grantId: grant.grantId,
      token,
      manifestSha256: grant.manifestSha256,
      fetchGrant: (path, init) =>
        fetch(`${url}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(init?.headers as Record<string, string> | undefined),
          },
        }),
      state: () => transport.grants.get(grant.grantId)?.state,
    });
  } finally {
    await transport.close();
  }
}

test("GET manifest returns manifest envelope and does not consume the grant", async () => {
  await withTransport(async ({ fetchGrant, grantId, manifestSha256, state }) => {
    const response = await fetchGrant(`/migration/${grantId}/manifest`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-raft-manifest-sha"), manifestSha256);
    const body = await response.json() as { manifestSha256: string; manifest: AgentMigrationExportManifest };
    assert.equal(body.manifestSha256, manifestSha256);
    assert.equal(body.manifest.agentId, "agent-http");
    assert.equal(state(), "issued");

    const second = await fetchGrant(`/migration/${grantId}/manifest`);
    assert.equal(second.status, 200);
    assert.equal(state(), "issued");
  });
});

test("listen uses configured stable bind defaults and returns configured public URL", async () => {
  const transport = createAgentMigrationHttpTransport({
    listen: {
      host: "127.0.0.1",
      port: 0,
      publicUrl: "http://source:4101",
    },
  });
  try {
    const { url } = await transport.listen();
    assert.equal(url, "http://source:4101");

    const address = transport.server.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(address.address, "127.0.0.1");
    assert.ok(address.port > 0);
  } finally {
    await transport.close();
  }
});

test("listen arguments override configured bind defaults but keep public URL", async () => {
  const transport = createAgentMigrationHttpTransport({
    listen: {
      host: "0.0.0.0",
      port: 4101,
      publicUrl: "http://source:4101",
    },
  });
  try {
    const { url } = await transport.listen(0, "127.0.0.1");
    assert.equal(url, "http://source:4101");

    const address = transport.server.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(address.address, "127.0.0.1");
    assert.notEqual(address.port, 4101);
  } finally {
    await transport.close();
  }
});

test("listen options resolve from migration transport env", () => {
  assert.deepEqual(resolveAgentMigrationHttpTransportListenOptions({
    SLOCK_AGENT_MIGRATION_TRANSPORT_HOST: "0.0.0.0",
    SLOCK_AGENT_MIGRATION_TRANSPORT_PORT: "4101",
    SLOCK_AGENT_MIGRATION_TRANSPORT_PUBLIC_URL: "http://source:4101",
  } as NodeJS.ProcessEnv), {
    host: "0.0.0.0",
    port: 4101,
    publicUrl: "http://source:4101",
  });

  assert.throws(
    () => resolveAgentMigrationHttpTransportListenOptions({
      SLOCK_AGENT_MIGRATION_TRANSPORT_PORT: "70000",
    } as NodeJS.ProcessEnv),
    /SLOCK_AGENT_MIGRATION_TRANSPORT_PORT/,
  );
});

test("control seam enable flag defaults on and only env=0 is an emergency brake", () => {
  assert.equal(resolveAgentMigrationControlSeamEnabled({} as NodeJS.ProcessEnv), true);
  assert.equal(resolveAgentMigrationControlSeamEnabled({
    [AGENT_MIGRATION_CONTROL_SEAM_ENV]: "0",
  } as NodeJS.ProcessEnv), false);
  assert.equal(resolveAgentMigrationControlSeamEnabled({
    [AGENT_MIGRATION_CONTROL_SEAM_ENV]: "1",
  } as NodeJS.ProcessEnv), true);
  assert.equal(resolveAgentMigrationControlSeamEnabled({
    [AGENT_MIGRATION_CONTROL_SEAM_ENV]: "false",
  } as NodeJS.ProcessEnv), true);
});

test("control seam route defaults enabled and creates grants without env opt-in", async () => {
  const transport = createAgentMigrationHttpTransport({ now: () => now });
  const { url } = await transport.listen();
  try {
    const bundle = Buffer.from("default-open-control-seam");
    const response = await fetch(`${url}/migration-control/grants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grantId: "default-control-grant",
        token: "default-control-token",
        expiresInSeconds: 60,
        manifest: manifest(),
        bundleBase64: bundle.toString("base64"),
      }),
    });
    assert.equal(response.status, 201);
    const created = await response.json() as { grantId: string; token: string; bundleSizeBytes: number };
    assert.equal(created.grantId, "default-control-grant");
    assert.equal(created.token, "default-control-token");
    assert.equal(created.bundleSizeBytes, bundle.byteLength);
  } finally {
    await transport.close();
  }
});

test("control seam route is absent when emergency brake env disables it", async () => {
  const transport = createAgentMigrationHttpTransport({
    controlSeam: false,
    now: () => now,
  });
  const { url } = await transport.listen();
  try {
    const response = await fetch(`${url}/migration-control/grants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest: manifest(),
        bundleText: "bundle-bytes",
      }),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { code: "migration_route_not_found" });
  } finally {
    await transport.close();
  }
});

test("HTTP grant creation rejects source-root-bearing symlink metadata before serialization", async () => {
  const transport = createAgentMigrationHttpTransport({
    controlSeam: true,
    now: () => now,
  });
  const { url } = await transport.listen();
  const sourceLocalTarget = "C:\\Users\\alice\\source-local-secret";
  try {
    const unsafeManifest: AgentMigrationExportManifest = {
      ...manifest("agent-unsafe-link"),
      files: [{
        kind: "symlink",
        source: "workspace",
        bundlePath: "workspace/unsafe-link",
        workspaceRelativePath: "unsafe-link",
        linkTarget: sourceLocalTarget,
      }],
    };
    const response = await fetch(`${url}/migration-control/grants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest: unsafeManifest,
        bundleText: "bundle-bytes",
      }),
    });
    assert.equal(response.status, 400);
    const responseText = await response.text();
    assert.equal(responseText.includes(sourceLocalTarget), false);
    assert.equal(responseText.includes(JSON.stringify(sourceLocalTarget).slice(1, -1)), false);
    assert.deepEqual(JSON.parse(responseText), { code: "migration_control_invalid_payload" });
    assert.throws(
      () => transport.grants.createGrant({
        expiresAt: future,
        manifest: unsafeManifest,
      }),
      /MIGRATION_OBJECT_STORE_UNSAFE_LINK/,
    );
  } finally {
    await transport.close();
  }
});

test("enabled control seam creates a real grant served by manifest, HEAD, and Range routes", async () => {
  const transport = createAgentMigrationHttpTransport({
    controlSeam: true,
    now: () => now,
  });
  const { url } = await transport.listen();
  try {
    const bundle = Buffer.from("hello-control-seam");
    const createResponse = await fetch(`${url}/migration-control/grants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grantId: "control-grant-1",
        token: "control-token-1",
        expiresInSeconds: 60,
        manifest: manifest("agent-control"),
        bundleBase64: bundle.toString("base64"),
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json() as {
      grantId: string;
      token: string;
      manifestSha256: string;
      bundleSizeBytes: number;
      expiresAt: string;
      manifestUrl: string;
      bundleUrl: string;
    };
    assert.equal(created.grantId, "control-grant-1");
    assert.equal(created.token, "control-token-1");
    assert.equal(created.bundleSizeBytes, bundle.byteLength);
    assert.equal(created.expiresAt, "2026-07-06T11:01:00.000Z");
    assert.equal(created.manifestUrl, "/migration/control-grant-1/manifest");
    assert.equal(created.bundleUrl, "/migration/control-grant-1/bundle.tar");

    const authHeaders = { Authorization: `Bearer ${created.token}` };
    const manifestResponse = await fetch(`${url}${created.manifestUrl}`, { headers: authHeaders });
    assert.equal(manifestResponse.status, 200);
    assert.equal(manifestResponse.headers.get("x-raft-manifest-sha"), created.manifestSha256);
    const manifestBody = await manifestResponse.json() as { manifest: AgentMigrationExportManifest };
    assert.equal(manifestBody.manifest.agentId, "agent-control");
    assert.doesNotMatch(JSON.stringify(manifestBody), /\/tmp\/slock/);

    const headResponse = await fetch(`${url}${created.bundleUrl}`, {
      method: "HEAD",
      headers: authHeaders,
    });
    assert.equal(headResponse.status, 200);
    assert.equal(headResponse.headers.get("accept-ranges"), "bytes");
    assert.equal(headResponse.headers.get("x-raft-bundle-size"), String(bundle.byteLength));

    const rangeResponse = await fetch(`${url}${created.bundleUrl}`, {
      headers: {
        ...authHeaders,
        Range: "bytes=6-12",
      },
    });
    assert.equal(rangeResponse.status, 206);
    assert.equal(rangeResponse.headers.get("content-range"), `bytes 6-12/${bundle.byteLength}`);
    assert.equal(await rangeResponse.text(), "control");
    assert.equal(transport.grants.get(created.grantId)?.state, "interrupted");
  } finally {
    await transport.close();
  }
});

test("bundle stream includes manifest hash header and successful EOF consumes one-time grant", async () => {
  await withTransport(async ({ fetchGrant, grantId, manifestSha256, state }) => {
    const response = await fetchGrant(`/migration/${grantId}/bundle.tar`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-raft-manifest-sha"), manifestSha256);
    assert.equal(await response.text(), "bundle-bytes");
    assert.equal(state(), "consumed");

    const second = await fetchGrant(`/migration/${grantId}/bundle.tar`);
    assert.equal(second.status, 410);
    assert.deepEqual(await second.json(), { code: "migration_grant_unavailable" });
  }, {
    bundleStreamFactory: () => Readable.from(["bundle-bytes"]),
  });
});

test("HEAD bundle returns honest metadata without consuming the grant", async () => {
  await withTransport(async ({ fetchGrant, grantId, manifestSha256, state }) => {
    const response = await fetchGrant(`/migration/${grantId}/bundle.tar`, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-raft-manifest-sha"), manifestSha256);
    assert.equal(response.headers.get("accept-ranges"), "none");
    assert.equal(response.headers.get("x-raft-bundle-size"), "unknown");
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(state(), "issued");
  });
});

test("HEAD bundle advertises byte ranges only when bundle size is known", async () => {
  await withTransport(async ({ fetchGrant, grantId, manifestSha256, state }) => {
    const response = await fetchGrant(`/migration/${grantId}/bundle.tar`, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-raft-manifest-sha"), manifestSha256);
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("x-raft-bundle-size"), "12");
    assert.equal(response.headers.get("content-length"), "12");
    assert.equal(state(), "issued");
  }, {}, { bundleSizeBytes: 12 });
});

test("bad token and missing grant use the same auth failure shape", async () => {
  await withTransport(async ({ baseUrl, grantId }) => {
    const badToken = await fetch(`${baseUrl}/migration/${grantId}/manifest`, {
      headers: { Authorization: "Bearer bad-token" },
    });
    assert.equal(badToken.status, 401);
    assert.deepEqual(await badToken.json(), { code: "migration_grant_auth_failed" });

    const missingGrant = await fetch(`${baseUrl}/migration/missing/manifest`, {
      headers: { Authorization: "Bearer bad-token" },
    });
    assert.equal(missingGrant.status, 401);
    assert.deepEqual(await missingGrant.json(), { code: "migration_grant_auth_failed" });
  });
});

test("expired grant is unavailable and does not disclose grant existence", async () => {
  const transport = createAgentMigrationHttpTransport({ now: () => now });
  const { grant, token } = transport.grants.createGrant({
    grantId: "expired-grant",
    token: "expired-token",
    expiresAt: new Date("2026-07-06T10:59:59.000Z"),
    manifest: manifest("agent-expired"),
  });
  const { url } = await transport.listen();
  try {
    const response = await fetch(`${url}/migration/${grant.grantId}/manifest`, {
      headers: { "X-Raft-Migration-Token": token },
    });
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), { code: "migration_grant_unavailable" });
    assert.equal(transport.grants.get(grant.grantId)?.state, "expired");
  } finally {
    await transport.close();
  }
});

test("interrupted bundle stream records interrupted state and allows re-stream before expiry", async () => {
  let attempts = 0;
  await withTransport(async ({ fetchGrant, grantId, state }) => {
    const first = await fetchGrant(`/migration/${grantId}/bundle.tar`);
    assert.equal(first.status, 200);
    await first.text().catch(() => "");
    assert.equal(state(), "interrupted");

    const retry = await fetchGrant(`/migration/${grantId}/bundle.tar`);
    assert.equal(retry.status, 200);
    assert.equal(await retry.text(), "complete");
    assert.equal(state(), "consumed");
  }, {
    bundleStreamFactory: () => {
      attempts += 1;
      if (attempts === 1) {
        return Readable.from((async function* () {
          yield "partial";
          throw new Error("simulated interrupted migration stream");
        })());
      }
      return Readable.from(["complete"]);
    },
  });
});

test("Range resume streams from requested offset and consumes grant when resumed through EOF", async () => {
  const bundle = Buffer.from("hello-resume");
  await withTransport(async ({ fetchGrant, grantId, state }) => {
    const response = await fetchGrant(`/migration/${grantId}/bundle.tar`, {
      headers: { Range: "bytes=6-" },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("content-range"), "bytes 6-11/12");
    assert.equal(response.headers.get("content-length"), "6");
    assert.equal(await response.text(), "resume");
    assert.equal(state(), "consumed");
  }, {
    bundleStreamFactory: (_grant, request) => {
      assert.deepEqual(request, {
        range: { start: 6, end: 11 },
        offsetBytes: 6,
        lengthBytes: 6,
      });
      return Readable.from([bundle.subarray(request.offsetBytes)]);
    },
  }, { bundleSizeBytes: bundle.byteLength });
});

test("bounded byte range leaves one-time grant resumable until a range reaches EOF", async () => {
  const bundle = Buffer.from("partial-resume");
  const requests: unknown[] = [];
  await withTransport(async ({ fetchGrant, grantId, state }) => {
    const first = await fetchGrant(`/migration/${grantId}/bundle.tar`, {
      headers: { Range: "bytes=0-6" },
    });
    assert.equal(first.status, 206);
    assert.equal(first.headers.get("content-range"), "bytes 0-6/14");
    assert.equal(await first.text(), "partial");
    assert.equal(state(), "interrupted");

    const retry = await fetchGrant(`/migration/${grantId}/bundle.tar`, {
      headers: { Range: "bytes=7-" },
    });
    assert.equal(retry.status, 206);
    assert.equal(retry.headers.get("content-range"), "bytes 7-13/14");
    assert.equal(await retry.text(), "-resume");
    assert.equal(state(), "consumed");

    assert.deepEqual(requests, [
      { range: { start: 0, end: 6 }, offsetBytes: 0, lengthBytes: 7 },
      { range: { start: 7, end: 13 }, offsetBytes: 7, lengthBytes: 7 },
    ]);
  }, {
    bundleStreamFactory: (_grant, request) => {
      requests.push(request);
      const endExclusive = request.range ? request.range.end + 1 : undefined;
      return Readable.from([bundle.subarray(request.offsetBytes, endExclusive)]);
    },
  }, { bundleSizeBytes: bundle.byteLength });
});

test("unsatisfiable byte range fails without consuming the grant", async () => {
  await withTransport(async ({ fetchGrant, grantId, state }) => {
    const response = await fetchGrant(`/migration/${grantId}/bundle.tar`, {
      headers: { Range: "bytes=99-" },
    });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("content-range"), "bytes */12");
    assert.deepEqual(await response.json(), { code: "migration_range_not_satisfiable" });
    assert.equal(state(), "issued");
  }, {
    bundleStreamFactory: () => {
      throw new Error("range failure must not open bundle stream");
    },
  }, { bundleSizeBytes: 12 });
});

test("Range request is rejected when bundle size is unknown", async () => {
  await withTransport(async ({ fetchGrant, grantId, state }) => {
    const response = await fetchGrant(`/migration/${grantId}/bundle.tar`, {
      headers: { Range: "bytes=1-" },
    });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("accept-ranges"), "none");
    assert.deepEqual(await response.json(), { code: "migration_range_not_available" });
    assert.equal(state(), "issued");
  }, {
    bundleStreamFactory: () => {
      throw new Error("range failure must not open bundle stream");
    },
  });
});

test("concurrent bundle streams are rejected while the first stream is in progress", async () => {
  let releaseFirstStream: (() => void) | null = null;
  await withTransport(async ({ fetchGrant, grantId, state }) => {
    const first = fetchGrant(`/migration/${grantId}/bundle.tar`);
    const firstResponse = await first;
    assert.equal(firstResponse.status, 200);
    assert.equal(state(), "streaming");

    const second = await fetchGrant(`/migration/${grantId}/bundle.tar`);
    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), { code: "migration_bundle_stream_in_progress" });
    assert.equal(state(), "streaming");

    releaseFirstStream?.();
    assert.equal(await firstResponse.text(), "beginend");
    assert.equal(state(), "consumed");
  }, {
    bundleStreamFactory: () => Readable.from((async function* () {
      yield "begin";
      await new Promise<void>((resolve) => {
        releaseFirstStream = resolve;
      });
      yield "end";
    })()),
  });
});

test("default bundle stream fails loudly instead of serving placeholder tar bytes", async () => {
  await withTransport(async ({ fetchGrant, grantId, state }) => {
    const response = await fetchGrant(`/migration/${grantId}/bundle.tar`);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.deepEqual(await response.json(), { code: "migration_bundle_stream_not_wired" });
    assert.equal(state(), "issued");
  });
});

test("chunk endpoint is reserved with a machine-readable not-implemented code", async () => {
  await withTransport(async ({ fetchGrant, grantId, state }) => {
    const response = await fetchGrant(`/migration/${grantId}/chunk/${"a".repeat(64)}`);
    assert.equal(response.status, 501);
    assert.deepEqual(await response.json(), { code: "migration_chunk_not_implemented" });
    assert.equal(state(), "issued");
  });
});
