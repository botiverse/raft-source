import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  admitJointInvite,
  JOINT_INVITE_RATE_LIMIT_MAX_PEOPLE,
  JOINT_INVITE_RATE_LIMIT_WINDOW_SECONDS,
  resetJointInviteRateLimitForTests,
} from "./jointInviteRateLimit";

afterEach(() => resetJointInviteRateLimitForTests());

test("a person's invited people are counted until the window's budget is spent, then refused until it resets", async () => {
  const now = 1_000_000;
  assert.deepEqual(await admitJointInvite("u1", JOINT_INVITE_RATE_LIMIT_MAX_PEOPLE - 1, now), { admitted: true });
  assert.deepEqual(await admitJointInvite("u1", 1, now), { admitted: true });
  assert.deepEqual(
    await admitJointInvite("u1", 1, now + 1000),
    { admitted: false, retryAfterSeconds: JOINT_INVITE_RATE_LIMIT_WINDOW_SECONDS - 1 },
  );
  // Another person has their own budget.
  assert.deepEqual(await admitJointInvite("u2", 1, now), { admitted: true });
  // A new window starts afresh.
  assert.deepEqual(await admitJointInvite("u1", 1, now + JOINT_INVITE_RATE_LIMIT_WINDOW_SECONDS * 1000), { admitted: true });
});

test("a request naming nobody still counts as one", async () => {
  const now = 2_000_000;
  for (let index = 0; index < JOINT_INVITE_RATE_LIMIT_MAX_PEOPLE; index += 1) {
    assert.equal((await admitJointInvite("u3", 0, now)).admitted, true);
  }
  assert.equal((await admitJointInvite("u3", 0, now)).admitted, false);
});
