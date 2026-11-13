import assert from "node:assert/strict";
import { warmNotificationTransports } from "./warmup";

test("each provider warms on its own: a failing or slow one neither delays nor fails the others", async () => {
  const order: string[] = [];
  let releaseApns!: () => void;
  const apnsGate = new Promise<void>((resolve) => { releaseApns = resolve; });
  const warming = warmNotificationTransports({
    apns: async () => {
      await apnsGate;
      order.push("apns");
      throw new Error("connect ETIMEDOUT");
    },
    fcm: async () => {
      order.push("fcm");
      return "warmed";
    },
  });
  // FCM finished while APNs is still connecting.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["fcm"]);
  releaseApns();
  assert.deepEqual(await warming, { apns: "failed", fcm: "warmed" }, "never rejects");
});

test("unconfigured providers are reported, not warmed", async () => {
  assert.deepEqual(
    await warmNotificationTransports({ apns: async () => "not_configured", fcm: async () => "not_configured" }),
    { apns: "not_configured", fcm: "not_configured" },
  );
});
