import { createHash, createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";

const SECRET = "scope-secret-for-node-tests";

test("Node trace upload service resolves https from comma-list x-forwarded-proto", async () => {
  const port = await getFreePort();
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/node.ts",
    ],
    {
      env: {
        ...process.env,
        PORT: String(port),
        SCOPE_ATTESTATION_SECRET: SECRET,
        R2_ENDPOINT: "https://example.com",
        R2_BUCKET: "trace-bucket",
        R2_ACCESS_KEY_ID: "access-key",
        R2_SECRET_ACCESS_KEY: "secret-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    await waitForHealthz(port);
    const bundle = Buffer.from("trace\n");
    const metadata = {
      uploadId: "upload-comma-https",
      objectKey: "trace-bundles/server-1/machine-1/upload-comma-https.jsonl",
      bundleId: "bundle-comma-https",
      bundleSha256: sha256Hex(bundle),
      bundleSizeBytes: bundle.byteLength,
      maxBytes: 1024,
    };
    const response = await fetch(`http://127.0.0.1:${port}/api/trace-bundles`, {
      method: "POST",
      headers: {
        "x-forwarded-host": "api-aws-staging.botiverse.dev",
        // AWS ALB appends its own hop scheme; leftmost is the public client scheme.
        "x-forwarded-proto": "https, http",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        attestation: signAttestation(traceUploadClaims(metadata)),
        bundleSha256: metadata.bundleSha256,
        bundleSizeBytes: metadata.bundleSizeBytes,
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as { upload: { url: string } };
    const uploadUrl = new URL(body.upload.url);
    assert.equal(uploadUrl.protocol, "https:");
    assert.equal(uploadUrl.host, "api-aws-staging.botiverse.dev");
  } finally {
    child.kill();
  }
});

test("Node trace upload service treats http-first comma-list x-forwarded-proto as HTTP", async () => {
  const port = await getFreePort();
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/node.ts",
    ],
    {
      env: {
        ...process.env,
        PORT: String(port),
        SCOPE_ATTESTATION_SECRET: SECRET,
        R2_ENDPOINT: "https://example.com",
        R2_BUCKET: "trace-bucket",
        R2_ACCESS_KEY_ID: "access-key",
        R2_SECRET_ACCESS_KEY: "secret-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    await waitForHealthz(port);
    const bundle = Buffer.from("trace\n");
    const metadata = {
      uploadId: "upload-http-first",
      objectKey: "trace-bundles/server-1/machine-1/upload-http-first.jsonl",
      bundleId: "bundle-http-first",
      bundleSha256: sha256Hex(bundle),
      bundleSizeBytes: bundle.byteLength,
      maxBytes: 1024,
    };
    const response = await fetch(`http://127.0.0.1:${port}/api/trace-bundles`, {
      method: "POST",
      headers: {
        "x-forwarded-host": "trace-upload-staging.fly.dev",
        "x-forwarded-proto": "http, https",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        attestation: signAttestation(traceUploadClaims(metadata)),
        bundleSha256: metadata.bundleSha256,
        bundleSizeBytes: metadata.bundleSizeBytes,
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as { upload: { url: string } };
    assert.equal(new URL(body.upload.url).protocol, "http:");
  } finally {
    child.kill();
  }
});

test("Node trace upload service uses forwarded HTTPS proto when returning signed PUT URL", async () => {
  const port = await getFreePort();
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/node.ts",
    ],
    {
      env: {
        ...process.env,
        PORT: String(port),
        SCOPE_ATTESTATION_SECRET: SECRET,
        R2_ENDPOINT: "https://example.com",
        R2_BUCKET: "trace-bucket",
        R2_ACCESS_KEY_ID: "access-key",
        R2_SECRET_ACCESS_KEY: "secret-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    await waitForHealthz(port);
    const bundle = Buffer.from("trace\n");
    const metadata = {
      uploadId: "upload-https",
      objectKey: "trace-bundles/server-1/machine-1/upload-https.jsonl",
      bundleId: "bundle-https",
      bundleSha256: sha256Hex(bundle),
      bundleSizeBytes: bundle.byteLength,
      maxBytes: 1024,
    };
    const response = await fetch(`http://127.0.0.1:${port}/api/trace-bundles`, {
      method: "POST",
      headers: {
        "x-forwarded-host": "trace-upload-staging.fly.dev",
        "x-forwarded-proto": "https",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        attestation: signAttestation(traceUploadClaims(metadata)),
        bundleSha256: metadata.bundleSha256,
        bundleSizeBytes: metadata.bundleSizeBytes,
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as { upload: { url: string } };
    assert.equal(new URL(body.upload.url).protocol, "https:");
    assert.equal(new URL(body.upload.url).host, "trace-upload-staging.fly.dev");
  } finally {
    child.kill();
  }
});

async function waitForHealthz(port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      // Keep polling until the child has bound the port.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Node trace upload service did not become healthy");
}

async function getFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate test port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function signAttestation(claims: Record<string, unknown>, secret = SECRET): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function sha256Hex(body: Buffer | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function traceUploadClaims(metadata: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    typ: "scope-attestation",
    scope: "daemon-trace-bundle:create",
    sub: "machine-1",
    actorType: "machine",
    machineId: "machine-1",
    serverId: "server-1",
    aud: "trace-ingest-worker",
    resource: "servers/server-1/machines/machine-1/trace-bundles",
    nonce: "nonce-1",
    exp: Math.floor(Date.now() / 1000) + 60,
    metadata,
    ...overrides,
  };
}
