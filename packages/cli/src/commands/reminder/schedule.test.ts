import assert from "node:assert/strict";
import test from "node:test";

import { buildScheduleBody } from "./schedule.js";

const FIXED_TZ = () => "UTC";

test("buildScheduleBody requires delay-seconds, fire-at, or repeat", () => {
  const res = buildScheduleBody({ title: "t", msgId: "msg-1" }, FIXED_TZ);
  assert.ok(res.error);
  assert.equal(res.error?.code, "INVALID_ARG");
  assert.match(res.error!.message, /delay-seconds/);
});

test("buildScheduleBody rejects both delay-seconds and fire-at together", () => {
  const res = buildScheduleBody(
    { title: "t", delaySeconds: "10", fireAt: "2026-04-24T00:00:00Z", msgId: "msg-1" },
    FIXED_TZ,
  );
  assert.ok(res.error);
  assert.equal(res.error?.code, "INVALID_ARG");
  assert.match(res.error!.message, /not both/);
});

test("buildScheduleBody rejects non-positive delay-seconds", () => {
  const res = buildScheduleBody(
    { title: "t", delaySeconds: "0", msgId: "msg-1" },
    FIXED_TZ,
  );
  assert.ok(res.error);
  assert.equal(res.error?.code, "INVALID_ARG");
  assert.match(res.error!.message, /positive integer/);
});

test("buildScheduleBody rejects missing msgId for agent-created reminders", () => {
  const res = buildScheduleBody(
    { title: "standup", delaySeconds: "60" },
    FIXED_TZ,
  );
  assert.ok(res.error);
  assert.equal(res.error?.code, "INVALID_ARG");
  assert.match(res.error!.message, /anchor msgId/);
});

test("buildScheduleBody keeps an explicit msgId anchor", () => {
  const res = buildScheduleBody(
    { title: "ping", delaySeconds: "30", msgId: "msg-1" },
    FIXED_TZ,
  );
  assert.equal(res.body.msgId, "msg-1");
});

test("buildScheduleBody keeps a canonical messageId anchor", () => {
  const res = buildScheduleBody(
    { title: "ping", delaySeconds: "30", messageId: "msg-2" },
    FIXED_TZ,
  );
  assert.equal(res.body.msgId, "msg-2");
});

test("buildScheduleBody accepts matching legacy and canonical message anchors", () => {
  const res = buildScheduleBody(
    { title: "ping", delaySeconds: "30", messageId: "msg-3", msgId: "msg-3" },
    FIXED_TZ,
  );
  assert.equal(res.body.msgId, "msg-3");
});

test("buildScheduleBody rejects conflicting legacy and canonical message anchors", () => {
  const res = buildScheduleBody(
    { title: "ping", delaySeconds: "30", messageId: "msg-3", msgId: "msg-4" },
    FIXED_TZ,
  );
  assert.ok(res.error);
  assert.equal(res.error?.code, "INVALID_ARG");
  assert.match(res.error!.message, /--msg-id is a deprecated alias/);
});

test("buildScheduleBody keeps an explicit channel override when msgId is present", () => {
  const res = buildScheduleBody(
    { title: "followup", delaySeconds: "120", msgId: "msg-9", channel: "#general:abc12345" },
    FIXED_TZ,
  );
  assert.equal(res.body.channel, "#general:abc12345");
  assert.equal(res.body.msgId, "msg-9");
});

test("buildScheduleBody: --repeat snapshots tz from the injected now() helper", () => {
  const res = buildScheduleBody(
    { title: "daily-ping", repeat: "daily@09:00", msgId: "msg-1" },
    () => "Asia/Shanghai",
  );
  assert.equal(res.body.repeat, "daily@09:00");
  assert.equal(res.body.tz, "Asia/Shanghai");
});

test("buildScheduleBody: explicit --tz overrides a different host timezone", () => {
  const res = buildScheduleBody(
    { title: "daily-ping", repeat: "daily@10:00", tz: "Asia/Shanghai", msgId: "msg-1" },
    () => "America/Los_Angeles",
  );
  assert.equal(res.error, undefined);
  assert.equal(res.body.repeat, "daily@10:00");
  assert.equal(res.body.tz, "Asia/Shanghai");
});

test("buildScheduleBody: --tz requires repeat and rejects invalid IANA timezone", () => {
  const withoutRepeat = buildScheduleBody(
    { title: "ping", delaySeconds: "30", tz: "Asia/Shanghai", msgId: "msg-1" },
    FIXED_TZ,
  );
  assert.match(withoutRepeat.error?.message ?? "", /--tz requires --repeat/);

  const invalid = buildScheduleBody(
    { title: "daily-ping", repeat: "daily@10:00", tz: "Mars/Olympus", msgId: "msg-1" },
    FIXED_TZ,
  );
  assert.match(invalid.error?.message ?? "", /valid IANA timezone/);
});

test("buildScheduleBody: fire-at passes through unchanged", () => {
  const res = buildScheduleBody(
    { title: "t", fireAt: "2026-04-24T10:00:00Z", msgId: "msg-1" },
    FIXED_TZ,
  );
  assert.equal(res.body.fireAt, "2026-04-24T10:00:00Z");
  assert.equal(res.body.delaySeconds, undefined);
});
