import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  REFERRAL_SOURCES,
  SIGNUP_ROLES,
  isAcceptedReferralSourceId,
  referralSourceLabel,
} from "@botiverse/raft-shared";

import api from "../src/api/client";
import ServerSetupHandoffStep from "../src/components/onboarding/ServerSetupHandoffStep";
import ServerSetupSurveyStep from "../src/components/onboarding/ServerSetupSurveyStep";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";
import { requiresAccountProfileSetup } from "../src/utils/accountProfileSetup";
import { TestIntlProvider } from "./helpers/intl";

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

const user = (over: Partial<User>): User => ({
  id: "u1",
  email: "a@b.com",
  name: "a",
  emailVerified: true,
  profileSetupCompletedAt: null,
  signupSurveyCompletedAt: null,
  ...over,
} as User);

afterEach(() => {
  cleanup();
  api.get = originalGet as typeof api.get;
  api.post = originalPost as typeof api.post;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

test("identity setup is the only account-local gate", () => {
  assert.equal(
    requiresAccountProfileSetup(user({ name: "pending_9f2c1a", profileSetupCompletedAt: null })),
    true,
  );
  assert.equal(
    requiresAccountProfileSetup(user({ name: "wenyi", profileSetupCompletedAt: null })),
    false,
    "a legacy account with a real handle must not be routed into the signup survey",
  );
});

test("the referral choices remain the canonical persisted option set", () => {
  assert.deepEqual(REFERRAL_SOURCES.map((source) => source.id), [
    "twitter_x",
    "linkedin",
    "friend_colleague",
    "search",
    "hn_reddit",
    "podcast_blog_newsletter",
    "other",
  ]);
  assert.equal(isAcceptedReferralSourceId("hn_reddit"), true);
  assert.equal(referralSourceLabel("hn_reddit"), "Hacker News / Reddit");
  assert.equal(isAcceptedReferralSourceId("myspace"), false);
});

test("the survey is asked after Cindy is created and before the handoff", async () => {
  const updates: unknown[] = [];
  let done = 0;
  useAuthStore.setState({
    loading: false,
    updateProfile: async (patch: unknown) => {
      updates.push(patch);
    },
  } as never);

  render(createElement(
    TestIntlProvider,
    null,
    createElement(ServerSetupSurveyStep, { agentName: "Cindy", onDone: () => { done += 1; } }),
  ));

  const submit = screen.getByTestId("server-setup-survey-continue") as HTMLButtonElement;
  assert.equal(submit.disabled, true);
  const role = screen.getByRole("radio", { name: SIGNUP_ROLES[0].label });
  fireEvent.click(role);
  assert.match(role.className, /bg-soft-signal/);
  assert.doesNotMatch(role.className, /bg-brutal-pink/);
  assert.equal(submit.disabled, true, "one answer cannot submit the survey");

  fireEvent.click(screen.getByTestId("signup-source-other"));
  const other = screen.getByTestId("signup-source-other-input");
  fireEvent.change(other, { target: { value: "  Local meetup  " } });
  assert.equal(submit.disabled, false);
  fireEvent.click(submit);

  await waitFor(() => assert.equal(done, 1));
  assert.deepEqual(updates, [{
    signupRole: SIGNUP_ROLES[0].id,
    referralSource: "other",
    referralSourceOther: "Local meetup",
  }]);
  assert.ok(screen.getByTestId("server-setup-survey").classList.contains("shadow-brutal"));
});

test("the handoff screen is answered by the server alone, with no session-local memory", async () => {
  const requests: string[] = [];
  let done = 0;
  api.post = (async (url: string) => {
    requests.push(url);
    return { data: {} };
  }) as typeof api.post;

  render(createElement(
    TestIntlProvider,
    null,
    createElement(ServerSetupHandoffStep, {
      serverId: "server-1",
      agentName: "Cindy",
      onDone: () => { done += 1; },
    }),
  ));
  assert.match(screen.getByTestId("server-setup-handoff").textContent ?? "", /Cindy/);
  fireEvent.click(screen.getByRole("button", { name: "Let's Go" }));

  await waitFor(() => assert.equal(done, 1));
  assert.deepEqual(requests, ["/servers/server-1/setup-handoff"]);
  assert.equal(screen.getByRole("button", { name: "Starting…" }).hasAttribute("disabled"), true);
});

test("the handoff just says Let's Go, and is what briefs Cindy", async () => {
  const requests: string[] = [];
  api.post = (async (url: string) => {
    requests.push(url);
    return { data: {} };
  }) as typeof api.post;

  render(createElement(
    TestIntlProvider,
    null,
    createElement(ServerSetupHandoffStep, {
      serverId: "server-1",
      agentName: "Cindy",
      onDone: () => undefined,
    }),
  ));

  assert.match(screen.getByTestId("server-setup-handoff").textContent ?? "", /Cindy/);
  fireEvent.click(screen.getByRole("button", { name: "Let's Go" }));
  await waitFor(() => assert.deepEqual(requests, ["/servers/server-1/setup-handoff"]));
});
