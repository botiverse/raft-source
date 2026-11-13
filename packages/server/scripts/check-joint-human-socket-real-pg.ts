import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { getDb } from "../src/db";
import { createSeed } from "../src/test/integration/seed";
import { installRisingWaveReadReferences } from "../src/test/risingWaveReadReference";
import { openTestApp } from "../src/test/integration/app";
import { jointHumanHttpScenario } from "../src/test/jointHumanHttpScenario";
import { jointMembershipDepartureEffects } from "../src/services/jointMembershipDepartureEffects";
import {
  initRedis,
  getRedis,
  getRedisPub,
  getRedisSub,
  shutdownRedis,
} from "../src/redis";
const databaseUrl = process.env.JOINT_MEMBERSHIP_TEST_DATABASE_URL,
  redisUrl = process.env.JOINT_MEMBERSHIP_TEST_REDIS_URL;
if (!databaseUrl || !redisUrl)
  throw new Error(
    "name disposable PostgreSQL and Redis services; apply migrations first",
  );
process.env.JWT_SECRET = "joint-socket-test-only";
installRisingWaveReadReferences();
initRedis(redisUrl);
await Promise.all([
  getRedis().ping(),
  getRedisPub().ping(),
  getRedisSub().ping(),
]);
const app = await openTestApp(databaseUrl, 0);
const child = fork(
  fileURLToPath(new URL("./joint-socket-replica-child.ts", import.meta.url)),
  [],
  {
    cwd: process.cwd(),
    execArgv: ["--import", "@oxc-node/core/register"],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  },
);
const pending = new Map<
  string,
  {
    resolve: (size: number) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const ready = new Promise<string>((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error("Socket peer did not start")),
    20000,
  );
  child.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object" || !("kind" in message)) return;
    if (
      message.kind === "ready" &&
      "baseUrl" in message &&
      typeof message.baseUrl === "string" &&
      message.baseUrl.startsWith("http://127.0.0.1:")
    ) {
      clearTimeout(timer);
      resolve(message.baseUrl);
    }
    if (
      message.kind === "room" &&
      "requestId" in message &&
      typeof message.requestId === "string" &&
      "size" in message &&
      typeof message.size === "number"
    ) {
      const probe = pending.get(message.requestId);
      if (probe) {
        clearTimeout(probe.timer);
        pending.delete(message.requestId);
        probe.resolve(message.size);
      }
    }
  });
});
try {
  const peerUrl = await ready,
    db = getDb();
  await jointHumanHttpScenario({
    db,
    seed: createSeed(db),
    baseUrl: app.baseUrl,
    io: app.io,
    departureEffects: jointMembershipDepartureEffects(
      app.app.get("agentOrchestrator"),
    ),
    socketReplica: {
      baseUrl: peerUrl,
      roomSize: (room: string) =>
        new Promise<number>((resolve, reject) => {
          const requestId = randomUUID();
          const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error("Socket peer room query timed out"));
          }, 5000);
          pending.set(requestId, { resolve, reject, timer });
          child.send({ kind: "room", requestId, room });
        }),
    },
  });
  assert.equal(pending.size, 0);
  console.log(
    "PASS real PostgreSQL + Redis + separate Socket process: global eviction, entry-only B eviction, continuous H receive/send/reconnect, late B rejection",
  );
} finally {
  for (const probe of pending.values()) {
    clearTimeout(probe.timer);
    probe.reject(new Error("Socket peer closed"));
  }
  if (child.connected) child.send({ kind: "close" });
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await app.close();
  await shutdownRedis();
}
