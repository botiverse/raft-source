import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { expect, test } from "@playwright/test";

type RequestReceipt = Readonly<{
  path: string;
  method: string;
  bytes: number;
  contentLength: string | undefined;
}>;

const require = createRequire(import.meta.url);
const axiosBrowserBundle = resolve(dirname(require.resolve("axios")), "../axios.min.js");

async function readRequest(req: IncomingMessage): Promise<RequestReceipt> {
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
  }
  return {
    path: req.url ?? "",
    method: req.method ?? "",
    bytes,
    contentLength: req.headers["content-length"],
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP test server did not expose a TCP port");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("Chromium sends a raw File over H1 through XHR and reports uploaded bytes", async ({ page }) => {
  const sourceReceipts: RequestReceipt[] = [];
  const axiosSource = await readFile(axiosBrowserBundle);
  const source = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>direct upload transport</title><script src='/axios.min.js'></script>");
      return;
    }
    if (req.url === "/axios.min.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      res.end(axiosSource);
      return;
    }
    if (req.url === "/direct-object") {
      sourceReceipts.push(await readRequest(req));
      res.writeHead(200).end();
      return;
    }
    res.writeHead(404).end();
  });
  const sourcePort = await listen(source);
  try {
    await page.goto(`http://127.0.0.1:${sourcePort}/`);
    const result = await page.evaluate(async ({ origin }) => {
      const axios = (window as typeof window & {
        axios: {
          request(config: Record<string, unknown>): Promise<{ status: number }>;
        };
      }).axios;
      const bytes = new Uint8Array(8 * 1024 * 1024);
      bytes.fill(0x5a);
      const file = new File([bytes], "payload.bin", { type: "application/octet-stream" });
      const progress: number[] = [];
      const response = await axios.request({
        method: "PUT",
        url: `${origin}/direct-object`,
        headers: {
          "Content-Type": "application/octet-stream",
          "If-None-Match": "*",
        },
        data: file,
        adapter: "xhr",
        withCredentials: false,
        onUploadProgress: (event: { loaded: number }) => progress.push(event.loaded),
        validateStatus: () => true,
      });
      return { status: response.status, progress, fileSize: file.size };
    }, { origin: `http://127.0.0.1:${sourcePort}` });

    expect(result.status).toBe(200);
    expect(sourceReceipts).toEqual([
      {
        path: "/direct-object",
        method: "PUT",
        bytes: 8 * 1024 * 1024,
        contentLength: String(8 * 1024 * 1024),
      },
    ]);
    expect(result.progress.length).toBeGreaterThan(0);
    expect(result.progress.at(-1)).toBe(result.fileSize);
  } finally {
    await close(source);
  }
});
