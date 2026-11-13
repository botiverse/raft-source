import assert from "node:assert/strict";
import { agentInboxPushPausedNoticeText, agentReadinessBlockedNoticeText, agentPauseRetryCappedNoticeText, agentStartFailurePausedNoticeText, agentStartTimeoutPausedNoticeText } from "./agentActionRequiredNoticeService";

test("the start-timeout pause notice names the model, says when Raft tries again, and how to resume now", () => {
  assert.equal(
    agentStartTimeoutPausedNoticeText({
      agentName: "scout",
      runtime: "opencode",
      model: "opencode/mimo-v2.6-flash-free",
      failedStarts: 5,
      retryInMs: 30 * 60_000,
      agentUrl: "https://raft.example.test/s/acme/agent/a1",
    }),
    [
      "@scout could not start: OpenCode did not respond 5 times in a row; its model (opencode/mimo-v2.6-flash-free) may be slow, queued or rate-limited by its provider.",
      "Automatic wakes are paused. Raft tries again by itself in about 30 minutes, then less often while it keeps failing; messages and reminders wait until then.",
      "To resume now, restart the agent, or switch it to another model.",
      "Agent page: https://raft.example.test/s/acme/agent/a1",
    ].join("\n"),
  );
});

test("when a start-timeout pause's try fails for another reason, the notice says Raft stopped trying and what to fix", () => {
  assert.equal(
    agentStartFailurePausedNoticeText({ agentName: "scout", runtime: "opencode", reason: "runtime_login_required", agentUrl: null }),
    [
      "@scout still could not start: OpenCode needs you to log in on its computer. The agent page shows the error.",
      "Raft no longer tries again by itself. Messages and reminders wait until you fix it and restart the agent, or change its model or runtime.",
    ].join("\n"),
  );
});

test("a session that cannot be resumed points to Reset Session, a known-bad runtime version to updating it", () => {
  for (const reason of ["session_needs_reset", "session_runtime_mismatch"]) {
    const text = agentStartFailurePausedNoticeText({ agentName: "scout", runtime: "pi", reason, agentUrl: null });
    assert.match(text, /Reset Session & Restart/, reason);
    assert.match(text, /a plain restart resumes the same session/, reason);
  }
  assert.match(
    agentStartFailurePausedNoticeText({ agentName: "scout", runtime: "opencode", reason: "session_runtime_mismatch", agentUrl: null }),
    /or install the OpenCode version line the session was made with on that computer and restart the agent/,
  );
  assert.equal(
    agentStartFailurePausedNoticeText({ agentName: "scout", runtime: "codex", reason: "runtime_version_too_old", agentUrl: null }),
    [
      "@scout still could not start: the Codex CLI version on its computer is known not to work with Raft. The agent page shows the error.",
      "Raft no longer tries again by itself. Messages and reminders wait until you update Codex CLI on that computer and restart the agent.",
    ].join("\n"),
  );
});

test("a start refused for a disallowed env var says which kind of setting and that removing it gets the agent going", () => {
  assert.equal(
    agentStartFailurePausedNoticeText({ agentName: "scout", runtime: "claude", reason: "env_var_not_allowed", agentUrl: null }),
    [
      "@scout still could not start: its settings set an environment variable its computer no longer accepts from the server (such as PATH or NODE_OPTIONS). The agent page shows the error.",
      "Raft no longer tries again by itself. Messages and reminders wait until you remove that variable from the agent's environment variables and restart the agent.",
    ].join("\n"),
  );
});

test("a stopped inbox push names the agent, why delivery is paused, and how it resumes", () => {
  assert.equal(
    agentInboxPushPausedNoticeText({ agentName: "Ottie", cause: "endpoint_failing", agentUrl: "https://raft.example.test/s/acme/agent/a1" }),
    [
      "@Ottie isn't being woken up for new messages right now: its runtime's push endpoint kept failing, so Raft paused push delivery. New messages still reach its inbox, but it may not reply until it checks in on its own. Raft keeps checking the endpoint and resumes push delivery by itself once it answers again. If it stays paused, check the runtime's push endpoint; registering it again resumes delivery at once.",
      "Agent page: https://raft.example.test/s/acme/agent/a1",
    ].join("\n"),
  );
  assert.equal(
    agentInboxPushPausedNoticeText({ agentName: "Ottie", cause: "credential_revoked", agentUrl: null }),
    "@Ottie isn't being woken up for new messages right now: the credential its runtime registered push delivery with was revoked, so Raft paused push delivery. New messages still reach its inbox, but it may not reply until it checks in on its own. Push delivery resumes when its runtime registers its push endpoint again with an active credential.",
  );
});

test("step 12 follow-up: a repeated-failure pause at its 8-hour cap says Raft keeps trying every 8 hours, the last error by reason, and what gets it going sooner", () => {
  assert.equal(
    agentPauseRetryCappedNoticeText({ agentName: "scout", runtime: "codex", reason: "runtime_repeated_failure", retryEveryMs: 8 * 60 * 60_000, agentUrl: "https://raft.example/s/acme/agent/a1" }),
    [
      "@scout still can't run: its automatic tries keep failing. Last error: Codex CLI kept failing after it started (the same error again and again, or crashes in a row). The agent page shows the error.",
      "Raft keeps trying again automatically every 8 hours; messages and reminders wait until a try works.",
      "To get it going sooner, change its model or settings, or restart it.",
      "Agent page: https://raft.example/s/acme/agent/a1",
    ].join("\n"),
  );
  // A try that failed some other transient way names that reason, never the runtime's text.
  assert.match(
    agentPauseRetryCappedNoticeText({ agentName: "scout", runtime: "codex", reason: "runtime_spawn_failed", retryEveryMs: 8 * 60 * 60_000, agentUrl: null }),
    /Last error: Codex CLI failed to start\./,
  );
});

test("#68: one readiness notice names every agent a machine login holds, who acts, and the fixed verification portal", () => {
  assert.equal(
    agentReadinessBlockedNoticeText({ code: "verification_required", runtime: "claude", computerName: "box", machineLogin: true, agentNames: ["ada", "bo", "cy"], agentUrl: null }),
    [
      "@ada, @bo and @cy can't reply right now: the Claude Code account signed in on the computer \"box\" can't receive replies until it is verified.",
      "The account holder must finish the step in the Anthropic Verification Portal (https://portal.anthropic.com/verify), then choose Retry on the agent. Messages are kept and will be delivered.",
    ].join("\n"),
  );
  assert.match(
    agentReadinessBlockedNoticeText({ code: "a_code_from_the_future", runtime: "claude", computerName: "box", machineLogin: false, agentNames: ["ada"], agentUrl: "https://raft.example/s/acme/agent/a1" }),
    /^@ada can't reply right now: something on the computer "box" needs attention\. Messages are kept[^\n]*\nAgent page: https:\/\/raft\.example\/s\/acme\/agent\/a1$/,
  );
});
