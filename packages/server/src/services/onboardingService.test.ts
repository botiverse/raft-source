import { afterEach, test } from "vitest";
import assert from "node:assert/strict";
import {
  ONBOARDING_OPENER_V2_FEATURE_FLAG_KEY,
  ONBOARDING_DAY2_RECAP_TITLE,
  ONBOARDING_DAY2_RECAP_VERSION,
  __resetOnboardingServiceDepsForTests,
  __setOnboardingServiceDepsForTests,
  computeOnboardingDay2FireAt,
  onboardingDay2ReminderId,
  resolveOnboardingDay2Timezone,
  triggerAgentIntroInAllChannel,
  triggerAllChannelUnlockOnboarding,
  triggerCrossChannelHint,
  triggerNewAgentAllChannelGreeting,
  triggerNewMemberOnboarding,
  triggerOwnerOnboardingOnAgentActivation,
} from "./onboardingService.js";

const OPENER_V2_ON = {
  key: ONBOARDING_OPENER_V2_FEATURE_FLAG_KEY,
  enabled: true,
  reason: "flag_on",
};

afterEach(() => {
  __resetOnboardingServiceDepsForTests();
});

function makeAgent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "agent-1",
    serverId: "server-1",
    name: "peng",
    displayName: "Peng",
    avatarUrl: null,
    description: "Runtime engineer",
    allChannelIntroSentAt: null,
    // The briefing only fires for a running agent: it is a transient wake, so
    // delivering it to a dead agent loses it while still stamping "sent".
    status: "active",
    sessionId: null,
    model: "sonnet",
    runtime: "claude",
    reasoningEffort: null,
    executionMode: "byoc",
    envVars: null,
    machineId: null,
    deletedAt: null,
    createdAt: new Date("2026-04-21T09:00:00.000Z"),
    updatedAt: new Date("2026-04-21T09:00:00.000Z"),
    ...overrides,
  };
}

function makeDeps(overrides: Record<string, unknown> = {}): any {
  return {
    getAgent: async () => makeAgent(),
    listAgents: async () => [],
    // Default to a lone owner (1 human). The unlock threshold is 3 total
    // members (humans + agents), so tests that supply 2 agents reach 3.
    listServerMemberIds: async () => ["owner-user"],
    tryMarkAllChannelIntroSent: async () => true,
    clearAllChannelIntroSentClaim: async () => {},
    listChannels: async () => [{ id: "channel-all", name: "all", type: "channel" }],
    createChannel: async () => ({ id: "channel-1", name: "onboarding-owner", type: "channel" }),
    getOrCreateThread: async (parentMessageId: string) => ({
      id: "team-mode-thread",
      serverId: "server-1",
      parentMessageId,
      created: true,
    }),
    addHuman: async () => {},
    addAgent: async () => {},
    findOrCreateDM: async () => null,
    broadcastSystemMessage: async () => {},
    deliverSystemNoticeToAgent: async () => {},
    broadcastAndDeliver: async () => {},
    evaluateFeatureFlag: async () => ({
      key: ONBOARDING_OPENER_V2_FEATURE_FLAG_KEY,
      enabled: false,
      reason: "missing_flag",
    }),
    createOwnerOpenerArtifactAttachment: async () => ({
      id: "team-mode-attachment",
      filename: "team-mode.html",
    }),
    getServer: async () => null,
    getServerOnboardingSettings: async () => ({
      onboardingAgentId: null,
      agentAllChannelGreetingEnabled: true,
      onboardingWizardEnabled: true,
    }),
    updateServerOnboardingAgent: async () => null,
    getMemberOnboardingPreferences: async () => null,
    updateMemberOnboardingPreferences: async () => null,
    getUser: async () => null,
    createSchedule: async (input: any) => input,
    ...overrides,
  };
}

function makeIo(events: Array<{ room: string; event: string; payload: any }> = [], joins: Array<{ rooms: string[]; channelRoom: string }> = []) {
  return {
    to(room: string) {
      return {
        emit(event: string, payload: any) {
          events.push({ room, event, payload });
        },
      };
    },
    in(room: string) {
      const rooms = [room];
      const chain = {
        in(nextRoom: string) {
          rooms.push(nextRoom);
          return chain;
        },
        socketsJoin(channelRoom: string) {
          joins.push({ rooms: [...rooms], channelRoom });
        },
      };
      return chain;
    },
  } as any;
}

function makeReminderSyncOrchestrator(overrides: Record<string, unknown> = {}): any {
  return {
    pushReminderUpsert: async () => {},
    ...overrides,
  };
}

function makeServer(overrides: Record<string, unknown> = {}) {
  return {
    id: "server-1",
    ownerId: "owner-1",
    onboardingAgentId: "agent-1",
    ...overrides,
  };
}

test("D2 recap uses the owner's timezone and the next calendar day's 10:00", () => {
  assert.equal(
    computeOnboardingDay2FireAt(new Date("2026-07-21T08:00:00.000Z"), "UTC").toISOString(),
    "2026-07-22T10:00:00.000Z",
    "an opener before 10:00 must not fire on the same calendar day",
  );
  assert.equal(
    computeOnboardingDay2FireAt(new Date("2026-07-21T15:30:00.000Z"), "Asia/Shanghai").toISOString(),
    "2026-07-22T02:00:00.000Z",
  );
  assert.equal(resolveOnboardingDay2Timezone({
    preferredTimezone: "America/Los_Angeles",
    firstObservedTimezone: "Asia/Shanghai",
  }), "America/Los_Angeles");
  assert.equal(resolveOnboardingDay2Timezone({
    preferredTimezone: "not/a-zone",
    firstObservedTimezone: "Asia/Shanghai",
  }), "Asia/Shanghai");
});

test("D2 recap reminder title fits the fire wake and stays user-facing", () => {
  assert.ok(ONBOARDING_DAY2_RECAP_TITLE.length <= 80);
  assert.match(ONBOARDING_DAY2_RECAP_TITLE, /explain wake/);
  assert.match(ONBOARDING_DAY2_RECAP_TITLE, /recap yesterday/);
  assert.match(ONBOARDING_DAY2_RECAP_TITLE, /ask about daily recap/);
  assert.doesNotMatch(ONBOARDING_DAY2_RECAP_TITLE, /invite/i);
});

test("triggerAgentIntroInAllChannel skips agents that already sent their #all intro", async () => {
  let markAttempts = 0;
  let delivered = false;

  __setOnboardingServiceDepsForTests(makeDeps({
    getAgent: async () => makeAgent({ allChannelIntroSentAt: new Date("2026-04-21T09:00:00.000Z") }),
    tryMarkAllChannelIntroSent: async () => {
      markAttempts += 1;
      return true;
    },
  }) as any);

  const agentOrchestrator = {
    async deliverMessage() {
      delivered = true;
    },
  } as any;

  const sent = await triggerAgentIntroInAllChannel(makeIo(), agentOrchestrator, "server-1", "agent-1");

  assert.equal(sent, false);
  assert.equal(markAttempts, 0);
  assert.equal(delivered, false);
});

test("triggerAgentIntroInAllChannel skips when server disables #all greetings", async () => {
  let markAttempts = 0;
  let delivered = false;

  __setOnboardingServiceDepsForTests(makeDeps({
    getServerOnboardingSettings: async () => ({
      onboardingAgentId: null,
      agentAllChannelGreetingEnabled: false,
      onboardingWizardEnabled: true,
    }),
    tryMarkAllChannelIntroSent: async () => {
      markAttempts += 1;
      return true;
    },
  }) as any);

  const agentOrchestrator = {
    async deliverMessage() {
      delivered = true;
    },
  } as any;

  const sent = await triggerAgentIntroInAllChannel(makeIo(), agentOrchestrator, "server-1", "agent-1");

  assert.equal(sent, false);
  assert.equal(markAttempts, 0);
  assert.equal(delivered, false);
});

test("triggerAgentIntroInAllChannel persists a claim and visible agent intro", async () => {
  let addAgentCalls = 0;
  let markAttempts = 0;
  let sentMessage: any = null;

  __setOnboardingServiceDepsForTests(makeDeps({
    tryMarkAllChannelIntroSent: async () => {
      markAttempts += 1;
      return true;
    },
    addAgent: async () => {
      addAgentCalls += 1;
    },
    broadcastAndDeliver: async (_io: any, _agentOrchestrator: any, message: Record<string, unknown>) => {
      sentMessage = message;
    },
  }) as any);

  const agentOrchestrator = {} as any;

  const sent = await triggerAgentIntroInAllChannel(makeIo(), agentOrchestrator, "server-1", "agent-1");

  assert.equal(sent, true);
  assert.equal(markAttempts, 1);
  assert.equal(addAgentCalls, 0, "virtual #all intro should not persist agent membership rows");
  assert.equal(sentMessage?.channelId, "channel-all");
  assert.equal(sentMessage?.senderType, "agent");
  assert.equal(sentMessage?.senderId, "agent-1");
  assert.equal(sentMessage?.senderName, "Peng");
  assert.match(String(sentMessage?.content), /^Hi, I'm Peng\./);
  assert.match(String(sentMessage?.content), /Runtime engineer/);
  assert.match(String(sentMessage?.content), /What language would you like to use\?/);
});

test("triggerAgentIntroInAllChannel rolls back the claim when delivery fails", async () => {
  let rollbackCalledWith: any = null;

  __setOnboardingServiceDepsForTests(makeDeps({
    clearAllChannelIntroSentClaim: async (agentId: string, claimedAt: Date) => {
      rollbackCalledWith = { agentId, claimedAt };
    },
    broadcastAndDeliver: async () => {
      throw new Error("daemon offline");
    },
  }) as any);

  await assert.rejects(
    triggerAgentIntroInAllChannel(makeIo(), {} as any, "server-1", "agent-1"),
    /daemon offline/,
  );

  assert.equal(rollbackCalledWith?.agentId, "agent-1");
  assert.ok(rollbackCalledWith?.claimedAt instanceof Date);
});

test("triggerNewAgentAllChannelGreeting delivers an agentic (non-canned) greeting instruction to the new agent", async () => {
  let markAttempts = 0;
  let deliveredTo: string | null = null;
  let deliveredMessage: any = null;

  __setOnboardingServiceDepsForTests(makeDeps({
    evaluateFeatureFlag: async () => OPENER_V2_ON,
    tryMarkAllChannelIntroSent: async () => {
      markAttempts += 1;
      return true;
    },
  }) as any);

  const agentOrchestrator = {
    async deliverMessage(agentId: string, message: any) {
      deliveredTo = agentId;
      deliveredMessage = message;
    },
  } as any;

  const sent = await triggerNewAgentAllChannelGreeting(makeIo(), agentOrchestrator, "server-1", "agent-1");

  assert.equal(sent, true);
  assert.equal(markAttempts, 1);
  assert.equal(deliveredTo, "agent-1");
  assert.equal(deliveredMessage?.channel_id, "channel-all");
  assert.equal(deliveredMessage?.sender_type, "system");
  // Agentic: it instructs the agent to author its own intro, not a fixed greeting string.
  assert.match(String(deliveredMessage?.content), /introduc/i);
  assert.match(String(deliveredMessage?.content), /Do NOT paste a fixed template/);
  assert.doesNotMatch(String(deliveredMessage?.content), /^Hi, I'm/);
});

test("triggerNewAgentAllChannelGreeting is opener-v2 only (no-op when flag off)", async () => {
  let delivered = false;
  let markAttempts = 0;

  __setOnboardingServiceDepsForTests(makeDeps({
    // default makeDeps flag is disabled
    tryMarkAllChannelIntroSent: async () => {
      markAttempts += 1;
      return true;
    },
  }) as any);

  const agentOrchestrator = {
    async deliverMessage() {
      delivered = true;
    },
  } as any;

  const sent = await triggerNewAgentAllChannelGreeting(makeIo(), agentOrchestrator, "server-1", "agent-1");

  assert.equal(sent, false);
  assert.equal(markAttempts, 0);
  assert.equal(delivered, false);
});

test("triggerNewAgentAllChannelGreeting stays silent until #all is unlocked", async () => {
  let delivered = false;
  let markAttempts = 0;

  __setOnboardingServiceDepsForTests(makeDeps({
    evaluateFeatureFlag: async () => OPENER_V2_ON,
    // #all still private → not an enabled #all → ensureAllChannel returns null
    listChannels: async () => [{ id: "channel-all", name: "all", type: "private" }],
    tryMarkAllChannelIntroSent: async () => {
      markAttempts += 1;
      return true;
    },
  }) as any);

  const agentOrchestrator = {
    async deliverMessage() {
      delivered = true;
    },
  } as any;

  const sent = await triggerNewAgentAllChannelGreeting(makeIo(), agentOrchestrator, "server-1", "agent-1");

  assert.equal(sent, false);
  assert.equal(markAttempts, 0);
  assert.equal(delivered, false);
});

test("triggerNewAgentAllChannelGreeting respects the agentAllChannelGreetingEnabled setting", async () => {
  let delivered = false;

  __setOnboardingServiceDepsForTests(makeDeps({
    evaluateFeatureFlag: async () => OPENER_V2_ON,
    getServerOnboardingSettings: async () => ({
      onboardingAgentId: null,
      agentAllChannelGreetingEnabled: false,
      onboardingWizardEnabled: true,
    }),
  }) as any);

  const agentOrchestrator = {
    async deliverMessage() {
      delivered = true;
    },
  } as any;

  const sent = await triggerNewAgentAllChannelGreeting(makeIo(), agentOrchestrator, "server-1", "agent-1");

  assert.equal(sent, false);
  assert.equal(delivered, false);
});

test("triggerNewAgentAllChannelGreeting skips an agent that already greeted", async () => {
  let delivered = false;

  __setOnboardingServiceDepsForTests(makeDeps({
    evaluateFeatureFlag: async () => OPENER_V2_ON,
    getAgent: async () => makeAgent({ allChannelIntroSentAt: new Date("2026-04-21T09:00:00.000Z") }),
  }) as any);

  const agentOrchestrator = {
    async deliverMessage() {
      delivered = true;
    },
  } as any;

  const sent = await triggerNewAgentAllChannelGreeting(makeIo(), agentOrchestrator, "server-1", "agent-1");

  assert.equal(sent, false);
  assert.equal(delivered, false);
});

test("triggerNewAgentAllChannelGreeting rolls back the claim when delivery fails", async () => {
  let rollbackCalledWith: any = null;

  __setOnboardingServiceDepsForTests(makeDeps({
    evaluateFeatureFlag: async () => OPENER_V2_ON,
    clearAllChannelIntroSentClaim: async (agentId: string, claimedAt: Date) => {
      rollbackCalledWith = { agentId, claimedAt };
    },
  }) as any);

  const agentOrchestrator = {
    async deliverMessage() {
      throw new Error("daemon offline");
    },
  } as any;

  await assert.rejects(
    triggerNewAgentAllChannelGreeting(makeIo(), agentOrchestrator, "server-1", "agent-1"),
    /daemon offline/,
  );

  assert.equal(rollbackCalledWith?.agentId, "agent-1");
  assert.ok(rollbackCalledWith?.claimedAt instanceof Date);
});

test("triggerOwnerOnboardingOnAgentActivation routes the owner onboarding instruction into #all", async () => {
  // Per cindyz directive 2026-05-27 (#proj-onboarding:3e24c78f, task #42):
  // owner onboarding must happen in the main #all channel — no extra private
  // `onboarding-<owner>` channel is created. #all is a virtual channel, so the
  // instruction broadcast can target #all directly without persisting membership.
  const broadcasts: Array<{ channelId: string; content: string; targetAgentIds?: string[] }> = [];
  const agentNotices: Array<{ agentId: string; channelId: string; content: string }> = [];
  const createCalls: any[] = [];
  const addedAgentChannels: string[] = [];

  __setOnboardingServiceDepsForTests(makeDeps({
    getServer: async () => makeServer(),
    getMemberOnboardingPreferences: async () => ({ onboardingDmSentAt: null }),
    getAgent: async () => makeAgent({
      id: "agent-1",
      serverId: "server-1",
      name: "Cindy",
      description: "Onboarding Assistant",
    }),
    tryMarkAllChannelIntroSent: async () => true,
    getUser: async () => ({ id: "owner-1", name: "Cindy Zhao", signupSurveyCompletedAt: new Date(), signupRole: "engineering_leader" }),
    listChannels: async () => [{ id: "channel-all", name: "all", type: "channel" }],
    createChannel: async (...args: any[]) => {
      createCalls.push(args);
      return { id: "should-not-be-created", name: args[1], type: args[3] };
    },
    addAgent: async (channelId: string) => {
      addedAgentChannels.push(channelId);
    },
    broadcastSystemMessage: async (
      _io: any,
      _agentOrchestrator: any,
      channelId: string,
      content: string,
      opts?: { targetAgentIds?: string[] },
    ) => {
      broadcasts.push({ channelId, content, targetAgentIds: opts?.targetAgentIds });
    },
    deliverSystemNoticeToAgent: async (_orch: any, agentId: string, notice: any) => {
      agentNotices.push({ agentId, channelId: notice.channel_id, content: notice.content });
    },
    updateMemberOnboardingPreferences: async () => {},
  }) as any);

  const fired = await triggerOwnerOnboardingOnAgentActivation(makeIo(), makeReminderSyncOrchestrator(), "server-1", "agent-1");
  assert.equal(fired, true);

  // No private `onboarding-<owner>` channel should have been created.
  assert.equal(
    createCalls.some((args) => typeof args[1] === "string" && args[1].startsWith("onboarding-")),
    false,
    "owner onboarding must not create an extra onboarding-<owner> channel",
  );

  // The instruction is Cindy's briefing — it names her playbook files and CLI
  // commands. It must reach the agent WITHOUT being written into #all, where every
  // human would read her whole prompt.
  const ownerNotice = agentNotices.find((n) => n.channelId === "channel-all");
  assert.ok(ownerNotice, "owner onboarding instruction must be delivered to the agent");
  assert.equal(ownerNotice.agentId, "agent-1");
  assert.match(ownerNotice.content, /in #all channel/);
  assert.equal(
    broadcasts.find((b) => b.channelId === "channel-all" && /Onboarding task/.test(b.content)),
    undefined,
    "the instruction must NOT be broadcast into the channel",
  );

  assert.deepEqual(addedAgentChannels, [], "virtual #all must not persist onboarding agent membership rows");

  // Action-card regression guard (#proj-permission msg=f398b0d8, xxchan
  // 2026-05-10): instruction must point Cindy at the action-card playbook.
  // The survey answer must actually reach her, as the label she reads (not the raw id).
  assert.match(ownerNotice.content, /their role is: Tech lead/);
  assert.match(ownerNotice.content, /Pitch Raft and pick a starting point that fits that/);
  assert.match(ownerNotice.content, /raft action prepare/);
  assert.match(ownerNotice.content, /onboarding_playbook\.md/);
  assert.match(ownerNotice.content, /onboarding_knowledge_faq\.md/);
});

// The briefing is a transient wake, not a stored message: delivered to an agent whose
// runtime is not running, it is simply dropped. This happened for real (2026-07-12) —
// Cindy's runtime had died on stale credentials, the briefing went out into nothing,
// and `onboardingDmSentAt` was stamped anyway, so she was never briefed again and never
// saw the survey answer. So a dead agent means "not yet", not "done".
test("a briefing is not sent, or marked sent, while the onboarding agent is not running", async () => {
  const agentNotices: Array<{ agentId: string }> = [];
  const marked: string[] = [];

  __setOnboardingServiceDepsForTests(makeDeps({
    getServer: async () => makeServer(),
    getMemberOnboardingPreferences: async () => ({ onboardingDmSentAt: null }),
    getAgent: async () => makeAgent({ id: "agent-1", name: "Cindy", status: "inactive" }),
    getUser: async () => ({ id: "owner-1", name: "Cindy Zhao", signupSurveyCompletedAt: new Date(), signupRole: "software_engineer" }),
    listChannels: async () => [{ id: "channel-all", name: "all", type: "channel" }],
    deliverSystemNoticeToAgent: async (_orch: any, agentId: string) => {
      agentNotices.push({ agentId });
    },
    updateMemberOnboardingPreferences: async (_serverId: string, userId: string) => {
      marked.push(userId);
    },
  }) as any);

  const fired = await triggerOwnerOnboardingOnAgentActivation(makeIo(), makeReminderSyncOrchestrator(), "server-1", "agent-1");

  assert.equal(fired, false);
  assert.deepEqual(agentNotices, [], "a dead agent must not be briefed into the void");
  assert.deepEqual(marked, [], "the one-shot sent flag must not be burned on a lost briefing");
});

// A transient wake to an agent that is not able to receive it is DROPPED, not queued.
// At activation her runtime is usually still coming up, so the briefing landed in nothing
// while the "sent" flags were stamped anyway — and Cindy, asked who she was talking to,
// answered honestly that she had no idea (stdrc, 2026-07-13 00:01).
test("a dropped ledger wake does not count as briefed, so the next activation retries", async () => {
  const marked: string[] = [];

  __setOnboardingServiceDepsForTests(makeDeps({
    getServer: async () => makeServer(),
    getMemberOnboardingPreferences: async () => ({ onboardingDmSentAt: null }),
    getAgent: async () => makeAgent({ id: "agent-1", name: "Cindy" }),
    getUser: async () => ({ id: "owner-1", name: "Cindy Zhao", signupSurveyCompletedAt: new Date(), signupRole: "founder" }),
    listChannels: async () => [
      { id: "channel-all", name: "all", type: "channel" },
      { id: "owner-channel", name: "onboarding-owner", type: "channel" },
    ],
    evaluateFeatureFlag: async () => OPENER_V2_ON,
    broadcastAndDeliver: async () => ({ id: "message-1" }),
    getOrCreateThread: async () => ({ id: "team-mode-thread" }),
    createOwnerOpenerArtifactAttachment: async () => ({ id: "team-mode-attachment", filename: "team-mode.html" }),
    updateMemberOnboardingPreferences: async (_serverId: string, userId: string) => {
      marked.push(userId);
    },
  }) as any);

  const agentOrchestrator = {
    async deliverMessage() {
      return { status: "dropped", reason: "agent_unavailable" };
    },
  } as any;

  const fired = await triggerOwnerOnboardingOnAgentActivation(makeIo(), agentOrchestrator, "server-1", "agent-1");

  assert.equal(fired, false);
  assert.deepEqual(marked, [], "a briefing that was dropped must not burn the one-shot sent flag");
});

// The survey is answered one screen AFTER Cindy is created. If the briefing went out
// at creation it would carry a blank where the role belongs, and the "sent" guard
// would stop it ever being sent again. So it waits for the answer.
test("the owner briefing is deferred while the signup survey is unanswered", async () => {
  // Per cindyz directive 2026-05-27 (#proj-onboarding:3e24c78f, task #42):
  // owner onboarding must happen in the main #all channel — no extra private
  // `onboarding-<owner>` channel is created. #all is a virtual channel, so the
  // instruction broadcast can target #all directly without persisting membership.
  const broadcasts: Array<{ channelId: string; content: string; targetAgentIds?: string[] }> = [];
  const agentNotices: Array<{ agentId: string; channelId: string; content: string }> = [];
  const createCalls: any[] = [];
  const addedAgentChannels: string[] = [];

  __setOnboardingServiceDepsForTests(makeDeps({
    getServer: async () => makeServer(),
    getMemberOnboardingPreferences: async () => ({ onboardingDmSentAt: null }),
    getAgent: async () => makeAgent({
      id: "agent-1",
      serverId: "server-1",
      name: "Cindy",
      description: "Onboarding Assistant",
    }),
    tryMarkAllChannelIntroSent: async () => true,
    getUser: async () => ({ id: "owner-1", name: "Cindy Zhao", signupSurveyCompletedAt: null, signupRole: null }),
    listChannels: async () => [{ id: "channel-all", name: "all", type: "channel" }],
    createChannel: async (...args: any[]) => {
      createCalls.push(args);
      return { id: "should-not-be-created", name: args[1], type: args[3] };
    },
    addAgent: async (channelId: string) => {
      addedAgentChannels.push(channelId);
    },
    broadcastSystemMessage: async (
      _io: any,
      _agentOrchestrator: any,
      channelId: string,
      content: string,
      opts?: { targetAgentIds?: string[] },
    ) => {
      broadcasts.push({ channelId, content, targetAgentIds: opts?.targetAgentIds });
    },
    deliverSystemNoticeToAgent: async (_orch: any, agentId: string, notice: any) => {
      agentNotices.push({ agentId, channelId: notice.channel_id, content: notice.content });
    },
    updateMemberOnboardingPreferences: async () => {},
  }) as any);

  const fired = await triggerOwnerOnboardingOnAgentActivation(makeIo(), makeReminderSyncOrchestrator(), "server-1", "agent-1");
  assert.equal(fired, false, "nothing is sent until the survey answer exists");
  assert.equal(agentNotices.length, 0, "she must not be briefed without the role");
});

test("triggerOwnerOnboardingOnAgentActivation seeds opener v2 after adding Cindy to the private owner channel", async () => {
  const visibleMessages: any[] = [];
  const deliveredMessages: any[] = [];
  const artifactInputs: any[] = [];
  const addedHumans: Array<{ channelId: string; userId: string }> = [];
  const addedAgents: Array<{ channelId: string; agentId: string }> = [];
  const ownerChannelAgents = new Set<string>();
  let updatedPrefs: any = null;
  const scheduledReminders: any[] = [];
  let allIntroClaimAttempts = 0;

  __setOnboardingServiceDepsForTests(makeDeps({
    getServer: async () => makeServer(),
    getMemberOnboardingPreferences: async () => ({
      onboardingDmSentAt: null,
      onboardingDmSentByAgentId: null,
      onboardingOwnerOpenerV2SentAt: null,
      onboardingOwnerOpenerV2SentByAgentId: null,
      onboardingOwnerOpenerV2MessageIds: [],
      onboardingOwnerOpenerV2Version: null,
      onboardingOwnerOpenerV2Topics: [],
    }),
    getAgent: async () => makeAgent({
      id: "agent-1",
      serverId: "server-1",
      name: "cindy",
      displayName: "Cindy",
      description: "Onboarding Assistant",
    }),
    tryMarkAllChannelIntroSent: async () => {
      allIntroClaimAttempts += 1;
      return true;
    },
    getUser: async () => ({
      id: "owner-1",
      name: "Cindy Zhao",
      signupSurveyCompletedAt: new Date(),
      signupRole: "engineering_leader",
      preferredTimezone: "Asia/Shanghai",
      firstObservedTimezone: "America/Los_Angeles",
    }),
    listChannels: async () => [
      { id: "channel-all", name: "all", type: "channel" },
      { id: "owner-channel", name: "onboarding-owner", type: "private" },
    ],
    addHuman: async (channelId: string, userId: string) => {
      addedHumans.push({ channelId, userId });
    },
    addAgent: async (channelId: string, agentId: string) => {
      addedAgents.push({ channelId, agentId });
      if (channelId === "owner-channel") ownerChannelAgents.add(agentId);
    },
    evaluateFeatureFlag: async () => ({
      key: ONBOARDING_OPENER_V2_FEATURE_FLAG_KEY,
      enabled: true,
      reason: "server_rule",
    }),
    createOwnerOpenerArtifactAttachment: async (input: any) => {
      artifactInputs.push(input);
      return { id: "team-mode-attachment", filename: "team-mode.html" };
    },
    broadcastAndDeliver: async (_io: any, _agentOrchestrator: any, message: Record<string, unknown>) => {
      assert.ok(
        ownerChannelAgents.has("agent-1"),
        "Cindy must be in #onboarding-owner before visible opener messages are posted",
      );
      const id = `message-${visibleMessages.length + 1}`;
      visibleMessages.push({ id, ...message });
      return { id };
    },
    deliverSystemNoticeToAgent: async () => {},
    broadcastSystemMessage: async () => {
      assert.fail("opener v2 ledger should be delivered directly to the agent runtime");
    },
    updateMemberOnboardingPreferences: async (_serverId: string, _userId: string, updates: any) => {
      updatedPrefs = updates;
    },
    createSchedule: async (input: any) => {
      scheduledReminders.push(input);
      return input;
    },
  }) as any);

  const agentOrchestrator = makeReminderSyncOrchestrator({
    async deliverMessage(agentId: string, message: any) {
      assert.ok(
        ownerChannelAgents.has(agentId),
        "targeted ledger agent must be a member of #onboarding-owner",
      );
      deliveredMessages.push({ agentId, message });
      // The delivery RECEIPT is what decides whether onboarding counts as done: a
      // transient wake to an agent that cannot receive is dropped, not queued.
      return { status: "queued", reason: "wake_accepted" };
    },
  });

  const fired = await triggerOwnerOnboardingOnAgentActivation(makeIo(), agentOrchestrator, "server-1", "agent-1");

  assert.equal(fired, true);
  assert.equal(allIntroClaimAttempts, 0, "opener v2 must not also send the old #all greeting");
  assert.deepEqual(addedHumans, [{ channelId: "owner-channel", userId: "owner-1" }]);
  assert.deepEqual(addedAgents, [{ channelId: "owner-channel", agentId: "agent-1" }]);
  // 4 top-level opener messages + 1 thread reply seeding the Team Mode artifact.
  assert.equal(visibleMessages.length, 5);
  assert.deepEqual(visibleMessages.map((message) => message.channelId), [
    "owner-channel",
    "owner-channel",
    "team-mode-thread",
    "owner-channel",
    "owner-channel",
  ]);
  assert.equal(visibleMessages[0].senderType, "agent");
  assert.equal(visibleMessages[0].senderId, "agent-1");
  assert.equal(visibleMessages[0].senderName, "Cindy");
  assert.match(visibleMessages[0].content, /I know Raft inside out/);
  // Team-mode opener is top-level with NO attachment and points to its thread;
  // the artifact is seeded into that thread instead (task #97 — thread from day one).
  assert.match(visibleMessages[1].content, /Raft is where your agents go into team mode/);
  assert.match(visibleMessages[1].content, /in the thread/);
  assert.equal(visibleMessages[1].attachmentIds, undefined);
  // The thread reply carries the Team Mode artifact.
  assert.equal(visibleMessages[2].channelId, "team-mode-thread");
  assert.match(visibleMessages[2].content, /team mode looks like in practice/);
  assert.deepEqual(visibleMessages[2].attachmentIds, ["team-mode-attachment"]);
  assert.equal(
    visibleMessages[3].content,
    "Message them like teammates — any channel, anytime, half-formed is fine.",
  );
  assert.match(visibleMessages[4].content, /look at your current agents setup/);
  assert.match(visibleMessages[4].content, /propose you a starter team/);
  assert.ok(visibleMessages.every((message) => String(message.agentSendKey).startsWith("owner-opener-v2.0:server-1:owner-1:")));

  // Artifact is hosted in the thread channel, not the parent channel.
  assert.deepEqual(artifactInputs, [{
    serverId: "server-1",
    channelId: "team-mode-thread",
    onboardingAgentId: "agent-1",
    targetUserId: "owner-1",
  }]);

  assert.equal(deliveredMessages.length, 1);
  assert.equal(deliveredMessages[0].agentId, "agent-1");
  assert.equal(deliveredMessages[0].message.channel_id, "owner-channel");
  assert.equal(deliveredMessages[0].message.channel_name, "onboarding-owner");
  assert.equal(deliveredMessages[0].message.sender_type, "system");
  assert.match(deliveredMessages[0].message.content, /opener_v2_sent=true/);
  assert.match(deliveredMessages[0].message.content, /opener_v2_version=owner-opener-v2\.0/);
  // Ledger message_ids track the 4 top-level topic messages only (the thread
  // reply = message-3 is artifact delivery, tracked via the artifact id below).
  assert.match(deliveredMessages[0].message.content, /opener_v2_message_ids=message-1,message-2,message-4,message-5/);
  assert.match(deliveredMessages[0].message.content, /team_mode_artifact_attachment_id=team-mode-attachment/);
  assert.match(deliveredMessages[0].message.content, /Do not repeat, rephrase, or send another opener/);
  assert.match(deliveredMessages[0].message.content, /notes\/onboarding_objectives\.md/);
  assert.match(deliveredMessages[0].message.content, /durable objectives state store/);
  assert.match(deliveredMessages[0].message.content, /status\/updated_at\/refusal_note/);
  assert.match(deliveredMessages[0].message.content, /todo, done, skipped, later, blocked/);
  assert.match(deliveredMessages[0].message.content, /skipped.*persistent refusal-memory/);
  assert.match(deliveredMessages[0].message.content, /later.*blocked.*Neither status upgrades a hard no/);
  assert.match(deliveredMessages[0].message.content, /raft manual get recipes\/seeded --intent "Choose a safe Raft workflow" --reason "Need the core recipe map now"/);
  assert.match(deliveredMessages[0].message.content, /raft manual search "preview before merge" --scope recipes --intent "Safely preview a change before merge" --reason "Need the recommended preview workflow now"/);
  assert.match(deliveredMessages[0].message.content, /raft manual get recipes\/technique\/preview-env --intent "Safely preview a change before merge" --reason "Need exact preview setup steps now"/);
  assert.match(deliveredMessages[0].message.content, /raft action prepare/);
  assert.match(deliveredMessages[0].message.content, /never auto-create agents\/channels/);
  // The survey answer only reaches Cindy if it rides this ledger wake: opener v2 is
  // the live path and returns before the legacy briefing is ever built. A real run
  // proved it — the owner said "Software engineer" and Cindy's transcript never saw it.
  assert.match(deliveredMessages[0].message.content, /their role is: Tech lead/);
  assert.match(deliveredMessages[0].message.content, /Pitch Raft and pick a starting point that fits that/);

  assert.ok(updatedPrefs.onboardingDmSentAt instanceof Date);
  assert.equal(updatedPrefs.onboardingDmSentByAgentId, "agent-1");
  assert.ok(updatedPrefs.onboardingOwnerOpenerV2SentAt instanceof Date);
  assert.equal(updatedPrefs.onboardingOwnerOpenerV2SentByAgentId, "agent-1");
  // The 4 top-level topic messages (message-3 is the artifact thread reply,
  // excluded from the ledger — it's artifact delivery, not a topic message).
  assert.deepEqual(updatedPrefs.onboardingOwnerOpenerV2MessageIds, [
    "message-1",
    "message-2",
    "message-4",
    "message-5",
  ]);
  assert.equal(updatedPrefs.onboardingOwnerOpenerV2Version, "owner-opener-v2.0");
  assert.deepEqual(updatedPrefs.onboardingOwnerOpenerV2Topics, [
    "language_preference",
    "team_mode_artifact",
    "message_like_teammates",
    "workflow_migration_or_create_agent_card",
  ]);

  assert.equal(scheduledReminders.length, 1);
  assert.equal(scheduledReminders[0].id, onboardingDay2ReminderId("server-1", "owner-1"));
  assert.equal(scheduledReminders[0].serverId, "server-1");
  assert.equal(scheduledReminders[0].ownerAgentId, "agent-1");
  assert.equal(scheduledReminders[0].targetChannelId, "owner-channel");
  assert.equal(scheduledReminders[0].msgId, "message-1");
  assert.equal(scheduledReminders[0].title, ONBOARDING_DAY2_RECAP_TITLE);
  assert.equal(scheduledReminders[0].payload.kind, "onboarding_d2_recap");
  assert.equal(scheduledReminders[0].payload.version, ONBOARDING_DAY2_RECAP_VERSION);
  assert.equal(scheduledReminders[0].payload.ownerId, "owner-1");
  assert.equal(scheduledReminders[0].payload.timezone, "Asia/Shanghai");
  assert.equal(scheduledReminders[0].createdBy.id, "agent-1");
});

test("triggerOwnerOnboardingOnAgentActivation does not resend opener v2 and idempotently ensures D2 when ledger exists", async () => {
  let visibleMessages = 0;
  let systemMessages = 0;
  let updatedPrefs = 0;
  let scheduledReminders = 0;

  __setOnboardingServiceDepsForTests(makeDeps({
    getServer: async () => makeServer(),
    listChannels: async () => [
      { id: "channel-all", name: "all", type: "channel" },
      { id: "owner-channel", name: "onboarding-owner", type: "private" },
    ],
    getMemberOnboardingPreferences: async () => ({
      onboardingDmSentAt: null,
      onboardingDmSentByAgentId: null,
      onboardingOwnerOpenerV2SentAt: new Date("2026-07-07T02:00:00.000Z"),
      onboardingOwnerOpenerV2SentByAgentId: "agent-1",
      onboardingOwnerOpenerV2MessageIds: ["message-1", "message-2", "message-3", "message-4"],
      onboardingOwnerOpenerV2Version: "owner-opener-v2.0",
      onboardingOwnerOpenerV2Topics: [
        "language_preference",
        "team_mode_artifact",
        "message_like_teammates",
        "workflow_migration_or_create_agent_card",
      ],
    }),
    evaluateFeatureFlag: async () => ({
      key: ONBOARDING_OPENER_V2_FEATURE_FLAG_KEY,
      enabled: true,
      reason: "server_rule",
    }),
    broadcastAndDeliver: async () => {
      visibleMessages += 1;
    },
    deliverSystemNoticeToAgent: async () => {},
    broadcastSystemMessage: async () => {
      systemMessages += 1;
    },
    updateMemberOnboardingPreferences: async () => {
      updatedPrefs += 1;
    },
    createSchedule: async () => {
      scheduledReminders += 1;
      return {} as any;
    },
  }) as any);

  const fired = await triggerOwnerOnboardingOnAgentActivation(makeIo(), makeReminderSyncOrchestrator(), "server-1", "agent-1");

  assert.equal(fired, false);
  assert.equal(visibleMessages, 0);
  assert.equal(systemMessages, 0);
  assert.equal(updatedPrefs, 0);
  assert.equal(scheduledReminders, 1);
});

test("D2 reminder schedule failure retries independently without resending opener or duplicating under concurrency", async () => {
  let prefs: any = {
    onboardingDmSentAt: null,
    onboardingDmSentByAgentId: null,
    onboardingOwnerOpenerV2SentAt: null,
    onboardingOwnerOpenerV2SentByAgentId: null,
    onboardingOwnerOpenerV2MessageIds: [],
    onboardingOwnerOpenerV2Version: null,
    onboardingOwnerOpenerV2Topics: [],
  };
  let visibleMessages = 0;
  let scheduleAttempts = 0;
  const durableReminderIds = new Set<string>();

  __setOnboardingServiceDepsForTests(makeDeps({
    getServer: async () => makeServer(),
    getMemberOnboardingPreferences: async () => prefs,
    getUser: async () => ({
      id: "owner-1",
      name: "Owner",
      signupSurveyCompletedAt: new Date(),
      signupRole: "engineering_leader",
      preferredTimezone: "Asia/Shanghai",
      firstObservedTimezone: "America/Los_Angeles",
    }),
    getAgent: async () => makeAgent(),
    listChannels: async () => [
      { id: "channel-all", name: "all", type: "channel" },
      { id: "owner-channel", name: "onboarding-owner", type: "private" },
    ],
    evaluateFeatureFlag: async () => OPENER_V2_ON,
    broadcastAndDeliver: async () => {
      visibleMessages += 1;
      return { id: `message-${visibleMessages}` };
    },
    updateMemberOnboardingPreferences: async (_serverId: string, _userId: string, updates: any) => {
      prefs = { ...prefs, ...updates };
      return prefs;
    },
    createSchedule: async (input: any) => {
      scheduleAttempts += 1;
      if (scheduleAttempts === 1) throw new Error("transient database failure");
      durableReminderIds.add(input.id);
      return input;
    },
  }) as any);

  const orchestrator = makeReminderSyncOrchestrator({
    deliverMessage: async () => ({ status: "queued", reason: "wake_accepted" }),
  });

  const first = await triggerOwnerOnboardingOnAgentActivation(makeIo(), orchestrator, "server-1", "agent-1");
  assert.equal(first, true, "the opener succeeds even when its independent reminder side effect fails");
  assert.equal(visibleMessages, 5);
  assert.equal(scheduleAttempts, 1);
  assert.equal(durableReminderIds.size, 0);

  const second = await triggerOwnerOnboardingOnAgentActivation(makeIo(), orchestrator, "server-1", "agent-1");
  assert.equal(second, false, "retry sends no second opener");
  assert.equal(visibleMessages, 5);
  assert.equal(scheduleAttempts, 2);
  assert.deepEqual([...durableReminderIds], [onboardingDay2ReminderId("server-1", "owner-1")]);

  await Promise.all([
    triggerOwnerOnboardingOnAgentActivation(makeIo(), orchestrator, "server-1", "agent-1"),
    triggerOwnerOnboardingOnAgentActivation(makeIo(), orchestrator, "server-1", "agent-1"),
  ]);
  assert.equal(visibleMessages, 5, "concurrent retries never resend the opener");
  assert.equal(durableReminderIds.size, 1, "every retry uses one stable reminder identity");
});

test("triggerNewMemberOnboarding does not instruct the agent to use action cards", async () => {
  // Member onboarding explicitly tells Cindy NOT to set up server / create
  // agents/channels for the new member. The action-card guidance must stay
  // owner-only so we do not accidentally encourage Cindy to prepare cards
  // for non-owner users (who likely lack permission anyway).
  const broadcasts: Array<{ channelId: string; content: string }> = [];
  const agentNotices: Array<{ agentId: string; channelId: string; content: string }> = [];

  __setOnboardingServiceDepsForTests(makeDeps({
    getServer: async () => makeServer(),
    getMemberOnboardingPreferences: async () => ({ onboardingDmSentAt: null }),
    getAgent: async () => makeAgent({
      id: "agent-1",
      serverId: "server-1",
      name: "Cindy",
      description: "Onboarding Assistant",
    }),
    getUser: async () => ({ id: "member-1", name: "New Member" }),
    listChannels: async () => [{ id: "channel-all", name: "all", type: "channel" }],
    createChannel: async (...args: any[]) => ({
      id: "member-onboarding",
      name: args[1],
      type: args[3],
    }),
    addHuman: async () => {},
    addAgent: async () => {},
    deliverSystemNoticeToAgent: async (_orch: any, agentId: string, notice: any) => {
      agentNotices.push({ agentId, channelId: notice.channel_id, content: notice.content });
    },
    broadcastSystemMessage: async (
      _io: any,
      _agentOrchestrator: any,
      channelId: string,
      content: string,
    ) => {
      broadcasts.push({ channelId, content });
    },
    updateMemberOnboardingPreferences: async () => {},
  }) as any);

  await triggerNewMemberOnboarding(makeIo(), {} as any, "server-1", "member-1");

  const memberNotice = agentNotices.find((n) => n.channelId === "member-onboarding");
  assert.ok(memberNotice, "member onboarding instruction must be delivered to the agent");
  assert.doesNotMatch(memberNotice.content, /raft action prepare/);
  assert.match(memberNotice.content, /Do NOT ask them to set up the server/);
  assert.equal(
    broadcasts.find((b) => /Onboarding task/.test(b.content)),
    undefined,
    "the instruction must NOT be broadcast into the channel",
  );
});

test("triggerNewMemberOnboarding creates a private member onboarding channel that includes the server owner", async () => {
  const events: Array<{ room: string; event: string; payload: any }> = [];
  const joins: Array<{ rooms: string[]; channelRoom: string }> = [];
  const io = makeIo(events, joins);
  const createCalls: any[] = [];
  const listCalls: any[] = [];
  const addedHumans: string[] = [];
  const deliveredChannels: string[] = [];
  let prefsUpdated = false;

  __setOnboardingServiceDepsForTests(makeDeps({
    getServer: async () => makeServer(),
    getMemberOnboardingPreferences: async () => ({ onboardingDmSentAt: null }),
    getAgent: async () => makeAgent({
      id: "agent-1",
      serverId: "server-1",
      name: "Cindy",
      description: "Onboarding Assistant",
    }),
    getUser: async () => ({ id: "member-1", name: "New Member" }),
    listChannels: async (...args: any[]) => {
      listCalls.push(args);
      return [{ id: "channel-all", name: "all", type: "channel" }];
    },
    createChannel: async (...args: any[]) => {
      createCalls.push(args);
      return { id: "member-onboarding", name: args[1], type: args[3] };
    },
    addHuman: async (_channelId: string, userId: string) => {
      addedHumans.push(userId);
    },
    addAgent: async () => {},
    broadcastSystemMessage: async (_io: any, _agentOrchestrator: any, channelId: string) => {
      deliveredChannels.push(channelId);
    },
    // The instruction now reaches the agent as an agent-only notice rather than a
    // channel broadcast; it still targets the member onboarding channel.
    deliverSystemNoticeToAgent: async (_orch: any, _agentId: string, notice: any) => {
      deliveredChannels.push(notice.channel_id);
    },
    updateMemberOnboardingPreferences: async () => {
      prefsUpdated = true;
    },
  }) as any);

  const sent = await triggerNewMemberOnboarding(io, {} as any, "server-1", "member-1");

  assert.equal(sent, true);
  assert.deepEqual(listCalls[0], ["server-1", "member-1"]);
  assert.equal(createCalls[0][3], "private");
  assert.deepEqual(addedHumans, ["member-1", "owner-1"]);
  assert.deepEqual(deliveredChannels, ["member-onboarding"]);
  assert.equal(prefsUpdated, true);
  assert.equal(events.some((event) => event.room === "server:server-1"), false);
  assert.ok(events.some((event) => event.room === "user:member-1" && event.event === "channel:updated"));
  assert.ok(events.some((event) => event.room === "user:owner-1" && event.event === "channel:updated"));
  assert.deepEqual(joins, [{ rooms: ["user:member-1:server:server-1"], channelRoom: "channel:member-onboarding" }]);
});

test("triggerNewMemberOnboarding reuses an existing private onboarding channel", async () => {
  const channelName = "onboarding-new-member";
  let createAttempts = 0;

  __setOnboardingServiceDepsForTests(makeDeps({
    getServer: async () => makeServer(),
    getMemberOnboardingPreferences: async () => ({ onboardingDmSentAt: null }),
    getAgent: async () => makeAgent({
      id: "agent-1",
      serverId: "server-1",
      name: "Cindy",
      description: "Onboarding Assistant",
    }),
    getUser: async () => ({ id: "member-1", name: "New Member" }),
    listChannels: async (_serverId: string, userId?: string) => {
      assert.equal(userId, "member-1");
      return [{ id: "existing-private", name: channelName, type: "private" }];
    },
    createChannel: async () => {
      createAttempts += 1;
      throw new Error("should not create");
    },
    addHuman: async () => {},
    addAgent: async () => {},
    broadcastSystemMessage: async () => {},
    deliverSystemNoticeToAgent: async () => {},
    updateMemberOnboardingPreferences: async () => {},
  }) as any);

  const sent = await triggerNewMemberOnboarding(makeIo(), {} as any, "server-1", "member-1");

  assert.equal(sent, true);
  assert.equal(createAttempts, 0);
});

test("triggerNewMemberOnboarding uses onboarding-{name} channel naming without id suffix", async () => {
  let createdChannelName = "";

  __setOnboardingServiceDepsForTests(makeDeps({
    getServer: async () => ({
      id: "server-1",
      ownerId: "owner-1",
      onboardingAgentId: "agent-1",
    }),
    getAgent: async () => makeAgent({ id: "agent-1" }),
    getMemberOnboardingPreferences: async () => ({
      onboardingDmSentAt: null,
      onboardingDmSentByAgentId: null,
      setupModalReminderOptOut: false,
    }),
    getUser: async () => ({
      id: "member-1",
      name: "Alice Example",
    }),
    listChannels: async () => [],
    createChannel: async (_serverId: string, name: string, _description?: string, type?: string) => {
      createdChannelName = name;
      return { id: "channel-1", name, type };
    },
    addHuman: async () => {},
    addAgent: async () => {},
    broadcastSystemMessage: async () => {},
    deliverSystemNoticeToAgent: async () => {},
    updateMemberOnboardingPreferences: async () => {},
  }) as any);

  const io = {
    to() {
      return {
        emit() {},
      };
    },
    in() {
      return this;
    },
    socketsJoin() {},
  } as any;

  const sent = await triggerNewMemberOnboarding(io, {} as any, "server-1", "member-1");
  assert.equal(sent, true);
  assert.equal(createdChannelName, "onboarding-alice-example");
  assert.equal(/-[0-9a-f]{8}$/.test(createdChannelName), false);
});

test("triggerAllChannelUnlockOnboarding sends instruction exactly once via atomic claim", async () => {
  const broadcasts: Array<{ channelId: string; content: string }> = [];
  const agentNotices: Array<{ agentId: string; channelId: string; content: string }> = [];
  let claimCalled = false;

  __setOnboardingServiceDepsForTests(makeDeps({
    evaluateFeatureFlag: async () => ({
      key: ONBOARDING_OPENER_V2_FEATURE_FLAG_KEY,
      enabled: true,
      reason: "server_rule",
    }),
    listAgents: async () => [makeAgent({ id: "agent-1" }), makeAgent({ id: "agent-2", name: "second" })],
    getServer: async () => makeServer(),
    getAgent: async () => makeAgent({ id: "agent-1" }),
    listChannels: async () => [{ id: "channel-all", name: "all", type: "channel" }],
    tryClaimAllChannelUnlockInstruction: async () => { claimCalled = true; return true; },
    clearAllChannelUnlockInstructionClaim: async () => {},
    broadcastSystemMessage: async (_io: any, _ao: any, channelId: string, content: string) => {
      broadcasts.push({ channelId, content });
    },
  }) as any);

  const fired = await triggerAllChannelUnlockOnboarding(makeIo(), {} as any, "server-1");
  assert.equal(fired, true);
  assert.equal(broadcasts.length, 1);
  assert.match(broadcasts[0].content, /#all is now live/);
  assert.equal(claimCalled, true);
});

test("triggerAllChannelUnlockOnboarding unlocks when the 3rd member is a human", async () => {
  const broadcasts: Array<{ content: string }> = [];

  __setOnboardingServiceDepsForTests(makeDeps({
    evaluateFeatureFlag: async () => ({
      key: ONBOARDING_OPENER_V2_FEATURE_FLAG_KEY,
      enabled: true,
      reason: "server_rule",
    }),
    // Just the Cindy OA, but the server now has 2 humans (owner + 1 invited) —
    // 1 agent + 2 humans = 3 members must unlock #all.
    listAgents: async () => [makeAgent({ id: "agent-1" })],
    listServerMemberIds: async () => ["owner-user", "invited-human"],
    getServer: async () => makeServer(),
    getAgent: async () => makeAgent({ id: "agent-1" }),
    listChannels: async () => [{ id: "channel-all", name: "all", type: "channel" }],
    tryClaimAllChannelUnlockInstruction: async () => true,
    clearAllChannelUnlockInstructionClaim: async () => {},
    broadcastSystemMessage: async (_io: any, _ao: any, _channelId: string, content: string) => {
      broadcasts.push({ content });
    },
  }) as any);

  const fired = await triggerAllChannelUnlockOnboarding(makeIo(), {} as any, "server-1");
  assert.equal(fired, true);
  assert.equal(broadcasts.length, 1);
  // A human-triggered unlock (no 2nd agent) must not claim an agent joined.
  assert.match(broadcasts[0].content, /your team is growing/);
});

test("triggerAllChannelUnlockOnboarding stays hidden below 3 members (owner + OA)", async () => {
  let broadcastCount = 0;
  let claimCalled = false;

  __setOnboardingServiceDepsForTests(makeDeps({
    evaluateFeatureFlag: async () => ({
      key: ONBOARDING_OPENER_V2_FEATURE_FLAG_KEY,
      enabled: true,
      reason: "server_rule",
    }),
    // Baseline onboarding: solo owner (1 human) + OA (1 agent) = 2 members.
    listAgents: async () => [makeAgent({ id: "agent-1" })],
    listServerMemberIds: async () => ["owner-user"],
    getServer: async () => makeServer(),
    getAgent: async () => makeAgent({ id: "agent-1" }),
    listChannels: async () => [{ id: "channel-all", name: "all", type: "private" }],
    tryClaimAllChannelUnlockInstruction: async () => { claimCalled = true; return true; },
    clearAllChannelUnlockInstructionClaim: async () => {},
    broadcastSystemMessage: async () => { broadcastCount += 1; },
  }) as any);

  const fired = await triggerAllChannelUnlockOnboarding(makeIo(), {} as any, "server-1");
  assert.equal(fired, false);
  assert.equal(broadcastCount, 0);
  assert.equal(claimCalled, false, "must bail before claiming below the 3-member threshold");
});

test("triggerAllChannelUnlockOnboarding skips when atomic claim loses (concurrent/3rd+ agent)", async () => {
  let broadcastCount = 0;

  __setOnboardingServiceDepsForTests(makeDeps({
    evaluateFeatureFlag: async () => ({
      key: ONBOARDING_OPENER_V2_FEATURE_FLAG_KEY,
      enabled: true,
      reason: "server_rule",
    }),
    listAgents: async () => [makeAgent({ id: "agent-1" }), makeAgent({ id: "agent-2" }), makeAgent({ id: "agent-3" })],
    getServer: async () => makeServer(),
    getAgent: async () => makeAgent({ id: "agent-1" }),
    listChannels: async () => [{ id: "channel-all", name: "all", type: "channel" }],
    tryClaimAllChannelUnlockInstruction: async () => false,
    clearAllChannelUnlockInstructionClaim: async () => {},
    broadcastSystemMessage: async () => { broadcastCount += 1; },
  }) as any);

  const fired = await triggerAllChannelUnlockOnboarding(makeIo(), {} as any, "server-1");
  assert.equal(fired, false);
  assert.equal(broadcastCount, 0);
});

test("triggerAllChannelUnlockOnboarding rolls back claim on send failure and retries", async () => {
  let markerValue: Date | null = null;
  let sendAttempts = 0;
  let clearCalledWithClaimedAt: Date | null = null;

  const baseDeps = {
    evaluateFeatureFlag: async () => ({
      key: ONBOARDING_OPENER_V2_FEATURE_FLAG_KEY,
      enabled: true,
      reason: "server_rule",
    }),
    listAgents: async () => [makeAgent({ id: "agent-1" }), makeAgent({ id: "agent-2", name: "second" })],
    getServer: async () => makeServer(),
    getAgent: async () => makeAgent({ id: "agent-1" }),
    listChannels: async () => [{ id: "channel-all", name: "all", type: "channel" }],
    tryClaimAllChannelUnlockInstruction: async (_sid: string, _uid: string, claimedAt: Date) => {
      markerValue = claimedAt;
      return true;
    },
    clearAllChannelUnlockInstructionClaim: async (_sid: string, _uid: string, claimedAt: Date) => {
      clearCalledWithClaimedAt = claimedAt;
      markerValue = null;
    },
    deliverSystemNoticeToAgent: async () => {},
    broadcastSystemMessage: async () => {
      sendAttempts += 1;
      if (sendAttempts === 1) throw new Error("daemon offline");
    },
  };

  // First attempt: send fails → claim should be rolled back with matching claimedAt
  __setOnboardingServiceDepsForTests(makeDeps(baseDeps) as any);
  await assert.rejects(
    triggerAllChannelUnlockOnboarding(makeIo(), {} as any, "server-1"),
    /daemon offline/,
  );
  assert.equal(markerValue, null, "marker must be cleared after send failure");
  assert.ok(clearCalledWithClaimedAt !== null, "clear must pass the original claimedAt");

  // Second attempt: send succeeds → marker should persist
  clearCalledWithClaimedAt = null;
  __setOnboardingServiceDepsForTests(makeDeps(baseDeps) as any);
  const retried = await triggerAllChannelUnlockOnboarding(makeIo(), {} as any, "server-1");
  assert.equal(retried, true);
  assert.ok(markerValue !== null, "marker must be set after successful send");
  assert.equal(clearCalledWithClaimedAt, null, "clear must not be called on success");
  assert.equal(sendAttempts, 2);
});

test("triggerAllChannelUnlockOnboarding concurrent callers: only the winner sends", async () => {
  let broadcastCount = 0;
  let claimCallCount = 0;

  const sharedDeps = {
    evaluateFeatureFlag: async () => ({
      key: ONBOARDING_OPENER_V2_FEATURE_FLAG_KEY,
      enabled: true,
      reason: "server_rule",
    }),
    listAgents: async () => [makeAgent({ id: "agent-1" }), makeAgent({ id: "agent-2", name: "second" })],
    getServer: async () => makeServer(),
    getAgent: async () => makeAgent({ id: "agent-1" }),
    listChannels: async () => [{ id: "channel-all", name: "all", type: "channel" }],
    tryClaimAllChannelUnlockInstruction: async () => {
      claimCallCount += 1;
      // First caller wins, second loses the CAS race
      return claimCallCount === 1;
    },
    clearAllChannelUnlockInstructionClaim: async () => {},
    broadcastSystemMessage: async () => { broadcastCount += 1; },
  };

  __setOnboardingServiceDepsForTests(makeDeps(sharedDeps) as any);

  // Simulate two concurrent callers
  const [result1, result2] = await Promise.all([
    triggerAllChannelUnlockOnboarding(makeIo(), {} as any, "server-1"),
    triggerAllChannelUnlockOnboarding(makeIo(), {} as any, "server-1"),
  ]);

  assert.equal(claimCallCount, 2, "both callers must attempt the claim");
  assert.equal(broadcastCount, 1, "exactly one broadcast must be sent");
  // Exactly one wins, one loses
  const winners = [result1, result2].filter(Boolean);
  assert.equal(winners.length, 1, "exactly one caller must succeed");
});

test("triggerCrossChannelHint fires during active wizard step and suppresses after completion", async () => {
  const broadcasts: Array<{ channelId: string; content: string }> = [];
  const agentNotices: Array<{ agentId: string; channelId: string; content: string }> = [];
  let prefsUpdated = false;

  const makeHintDeps = (wizardStep: string | null, hintShownAt: Date | null = null) => makeDeps({
    evaluateFeatureFlag: async () => ({
      key: ONBOARDING_OPENER_V2_FEATURE_FLAG_KEY,
      enabled: true,
      reason: "server_rule",
    }),
    getServer: async () => makeServer(),
    getMemberOnboardingPreferences: async () => ({
      crossChannelHintShownAt: hintShownAt,
      onboardingOwnerOpenerV2SentAt: new Date("2026-07-07T01:00:00.000Z"),
      onboardingWizardCurrentStep: wizardStep,
    }),
    updateMemberOnboardingPreferences: async () => { prefsUpdated = true; },
    getAgent: async () => makeAgent({ id: "agent-1" }),
    listChannels: async () => [
      { id: "channel-all", name: "all", type: "channel" },
      { id: "channel-general", name: "general", type: "channel" },
    ],
    broadcastSystemMessage: async (_io: any, _ao: any, channelId: string, content: string) => {
      broadcasts.push({ channelId, content });
    },
  });

  // Active wizard step → should fire
  __setOnboardingServiceDepsForTests(makeHintDeps("create-agent") as any);
  const fired = await triggerCrossChannelHint(makeIo(), {} as any, "server-1", "owner-1", "channel-general");
  assert.equal(fired, true);
  assert.equal(broadcasts.length, 1);
  assert.equal(prefsUpdated, true);

  // Reset
  broadcasts.length = 0;
  prefsUpdated = false;

  // Wizard completed (step=null) → should suppress
  __setOnboardingServiceDepsForTests(makeHintDeps(null) as any);
  const firedNull = await triggerCrossChannelHint(makeIo(), {} as any, "server-1", "owner-1", "channel-general");
  assert.equal(firedNull, false);
  assert.equal(broadcasts.length, 0);

  // Wizard at "complete" step → should suppress
  __setOnboardingServiceDepsForTests(makeHintDeps("complete") as any);
  const firedComplete = await triggerCrossChannelHint(makeIo(), {} as any, "server-1", "owner-1", "channel-general");
  assert.equal(firedComplete, false);

  // Already shown → should suppress
  __setOnboardingServiceDepsForTests(makeHintDeps("create-agent", new Date("2026-07-07T02:00:00.000Z")) as any);
  const firedAgain = await triggerCrossChannelHint(makeIo(), {} as any, "server-1", "owner-1", "channel-general");
  assert.equal(firedAgain, false);
});
