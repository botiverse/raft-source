// Disposable transport peer for the native cross-process Socket regression.
import { openTestApp } from "../src/test/integration/app";
import { installRisingWaveReadReferences } from "../src/test/risingWaveReadReference";
import {
  initRedis,
  getRedis,
  getRedisPub,
  getRedisSub,
  shutdownRedis,
} from "../src/redis";
const databaseUrl = process.env.JOINT_MEMBERSHIP_TEST_DATABASE_URL,
  redisUrl = process.env.JOINT_MEMBERSHIP_TEST_REDIS_URL;
if (!databaseUrl || !redisUrl || !process.send)
  throw new Error("isolated database, Redis and IPC required");
process.env.JWT_SECRET = "joint-socket-test-only";
installRisingWaveReadReferences();
initRedis(redisUrl);
await Promise.all([
  getRedis().ping(),
  getRedisPub().ping(),
  getRedisSub().ping(),
]);
const app = await openTestApp(databaseUrl, 0);
process.on("message", (message: unknown) => {
  if (!message || typeof message !== "object" || !("kind" in message)) return;
  if (
    message.kind === "room" &&
    "requestId" in message &&
    typeof message.requestId === "string" &&
    "room" in message &&
    typeof message.room === "string"
  ) {
    process.send?.({
      kind: "room",
      requestId: message.requestId,
      size: app.io.of("/").adapter.rooms.get(message.room)?.size ?? 0,
    });
  }
  if (message.kind === "close")
    void (async () => {
      await app.close();
      await shutdownRedis();
      process.exit(0);
    })();
});
process.send({ kind: "ready", baseUrl: app.baseUrl });
