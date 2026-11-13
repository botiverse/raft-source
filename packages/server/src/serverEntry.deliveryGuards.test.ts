// The production entry (src/server.ts, `pnpm start` / `dev`) starts with every
// system app's delivery guard that its agent events require: `system.artifacts`
// (apps/artifacts' notice guard, from the first-party app registry). Started
// as a process exactly as deployed, with its own module graph, so a guard that
// only a test's imports registered would not count. The entry logs the
// guarded apps before it opens the database, and refuses to start with one
// missing (assertRequiredSystemAppDeliveryGuards).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "vitest";

const SERVER_DIR = path.resolve(import.meta.dirname, "..");
const GUARDS_LINE = /\[Slock\] System-app delivery guards: (.*)/;

test("the production entry starts with the system.artifacts delivery guard", { timeout: 120_000 }, async () => {
  const child = spawn(process.execPath, ["--import", "@oxc-node/core/register", "src/server.ts"], {
    cwd: SERVER_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_ENV: "test",
      DATABASE_URL: "pglite://memory",
      JWT_SECRET: "server-entry-delivery-guards-test",
      PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  try {
    const guards = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no delivery guard line within 100 s:\n${output.slice(-4000)}`)), 100_000);
      const onData = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const match = GUARDS_LINE.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]!.trim());
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`server.ts exited (${code ?? signal}) before logging its delivery guards:\n${output.slice(-4000)}`));
      });
    });
    assert.ok(guards.split(", ").includes("system.artifacts"), guards);
  } finally {
    child.kill("SIGKILL");
  }
});
