/**
 * Report a problem: who is offered the machine runner log tail (#15305).
 * The server attaches it for whoever may edit the Computer: the person who has
 * it attached now, or a role with `editMachines` (owner/admin). The box is
 * ticked by default only on the reporter's own attached machine; an
 * owner/admin on someone else's machine sees it unticked (the tail may hold
 * other people's agents' lines) and it is sent only when they tick it. A
 * member on someone else's machine is not offered it.
 */
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, test } from "vitest";
import type { ServerRole } from "@botiverse/raft-shared";

import api from "../src/api/client";
import ReportIssueDialog from "../src/components/agent/ReportIssueDialog";
import { en } from "../src/i18n/messages/en";
import type { Agent } from "../src/store/agentStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { resetPrivacyModeForTests, setPrivacyMode } from "../src/store/privacyMode";
import { renderWithIntl } from "./helpers/intl";

const EXPORT_URL = "https://feedback.test";
const LOG_TAIL_LABEL = new RegExp(en["agent.reportIssue.includeMachineLogTail"]!);
const TRANSCRIPT_URL = "/servers/server-1/machines/machine-1/agents/agent-1/feedback/report-1/transcript";
const AGENT = {
  id: "agent-1",
  name: "builder",
  displayName: "Builder",
  status: "active",
  runtime: "claude",
  machineId: "machine-1",
} as unknown as Agent;

const originalApiPost = api.post;
const originalFetch = globalThis.fetch;

function setViewer(role: ServerRole, { attachedByMe }: { attachedByMe: boolean }) {
  useServerStore.setState({ current: { id: "server-1", slug: "acme", name: "Acme", role } } as never);
  useMachineStore.setState({
    machines: [{
      id: "machine-1",
      name: "someones-computer",
      status: "online",
      runtimes: [],
      isComputer: true,
      computerAttachedByCurrentUser: attachedByMe,
    }],
  } as never);
}

function renderDialog() {
  renderWithIntl(
    <MemoryRouter>
      <ReportIssueDialog agent={AGENT} onClose={() => {}} feedbackExportUrl={EXPORT_URL} />
    </MemoryRouter>,
  );
}

function logTailBox() {
  return screen.queryByRole("checkbox", { name: LOG_TAIL_LABEL });
}

/** Stubs the report pipeline; returns the body of the session-record request once it is sent. */
function stubSubmission() {
  const posts: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    if (url === "/servers/server-1/scope-attestation") return { data: { attestation: "att", scope: "feedback-report:create", expiresAt: "" } };
    if (url === TRANSCRIPT_URL) return { data: {} };
    if (url === "/product-feedback") return { data: { id: "ticket-1" } };
    throw new Error(`Unexpected POST ${url}`);
  }) as typeof api.post;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${EXPORT_URL}/api/reports`) {
      return Response.json({
        id: "report-1",
        upload: { method: "PUT", url: `${EXPORT_URL}/upload/report-1`, headers: {} },
        completeToken: "tok",
        expiresAt: "",
      });
    }
    return Response.json({});
  }) as typeof fetch;
  return async () => {
    await waitFor(() => assert.ok(posts.some((post) => post.url === TRANSCRIPT_URL), "session record requested"));
    return posts.find((post) => post.url === TRANSCRIPT_URL)!.body as Record<string, unknown>;
  };
}

function submit() {
  fireEvent.click(screen.getByRole("checkbox", { name: en["agent.reportIssue.consent"] }));
  fireEvent.click(screen.getByRole("button", { name: en["agent.reportIssue.submit"] }));
}

beforeEach(() => {
  useServerStore.setState({ members: [] } as never);
  resetPrivacyModeForTests();
  setPrivacyMode(false);
});

afterEach(() => {
  cleanup();
  api.post = originalApiPost;
  globalThis.fetch = originalFetch;
});

test("the reporter's own attached machine: offered and ticked, and the tail is requested", async () => {
  setViewer("member", { attachedByMe: true });
  const transcriptBody = stubSubmission();
  renderDialog();

  assert.equal(logTailBox()?.getAttribute("aria-checked"), "true");
  submit();
  assert.equal((await transcriptBody()).includeMachineLogTail, true);
});

test("an owner/admin on someone else's machine: offered unticked, and nothing asked for until ticked", async () => {
  setViewer("admin", { attachedByMe: false });
  const transcriptBody = stubSubmission();
  renderDialog();

  assert.equal(logTailBox()?.getAttribute("aria-checked"), "false");
  submit();
  assert.equal("includeMachineLogTail" in (await transcriptBody()), false);
});

test("an owner on someone else's machine who ticks the box sends includeMachineLogTail", async () => {
  setViewer("owner", { attachedByMe: false });
  const transcriptBody = stubSubmission();
  renderDialog();

  fireEvent.click(logTailBox()!);
  assert.equal(logTailBox()?.getAttribute("aria-checked"), "true");
  submit();
  assert.equal((await transcriptBody()).includeMachineLogTail, true);
});

test("a member on someone else's machine is not offered the log tail", () => {
  setViewer("member", { attachedByMe: false });
  renderDialog();

  assert.equal(screen.queryAllByRole("checkbox", { name: en["agent.reportIssue.consent"] }).length, 1, "the dialog rendered");
  assert.equal(logTailBox() === null, true);
});

test("privacy mode on, or not answered yet: nothing is uploaded and the reason is shown", async () => {
  for (const answer of ["on", "unknown"] as const) {
    resetPrivacyModeForTests();
    if (answer === "on") setPrivacyMode(true);
    setViewer("member", { attachedByMe: true });
    const fetched: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return Response.json({});
    }) as typeof fetch;
    renderDialog();

    submit();
    await screen.findByText(en["agent.reportIssue.exportNotConfigured"]!);
    assert.deepEqual(fetched, [], `privacy ${answer}: no request to the receiver`);
    cleanup();
  }
});
