/**
 * A channel being made an external channel (Kirby, design DRI, 2026-11-19):
 * the status sits at the top of the conversation as a strip like the
 * announcement strip, not in the channel details. One title, one bar and one
 * percentage; the steps only in View's popover; Cancel asks first; a failure
 * becomes a PanelNotice with Retry; done, the strip goes away by itself.
 * Absence is asserted as `assert.ok(x === null)`, never with a DOM node
 * inside node:assert.
 */
import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "../../../../tests/helpers/intl";
import { ChannelConversionStrip } from "../../../components/channel/ChannelConversionStrip";
import type { ChannelConversionController } from "../../../components/channel/useChannelConversionController";
import { EditChannelDialog } from "../EditChannelDialog";
import { useChannelStore } from "../../../store/channelStore";
import { useServerStore } from "../../../store/serverStore";
import { useAuthStore } from "../../../store/authStore";
import { en as enMessages } from "../../../i18n/messages/en";
import { zhCn as zhCnMessages } from "../../../i18n/messages/zh-cn";

const en = enMessages as Record<string, string>;
const zh = zhCnMessages as Record<string, string>;

const controller = vi.hoisted(() => ({ current: null as unknown }));
const permissions = vi.hoisted(() => ({ federateChannels: true }));

vi.mock("../../../components/channel/useChannelConversionController", () => ({
  useChannelConversionController: () => controller.current,
}));
vi.mock("../../../hooks/useServerPermissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../hooks/useServerPermissions")>();
  return {
    ...actual,
    useServerPermissions: () => {
      const real = actual.useServerPermissions();
      return { ...real, capabilities: { ...real.capabilities, federateChannels: permissions.federateChannels } };
    },
  };
});
vi.mock("../../../store/serverFeatureFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../store/serverFeatureFlags")>();
  const { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } = await import("@botiverse/raft-shared");
  return {
    ...actual,
    useServerFeatureFlag: (key: Parameters<typeof actual.useServerFeatureFlag>[0]) => (key === EXTERNAL_CHANNELS_FEATURE_FLAG_KEY
      ? { enabled: true, resolved: true }
      : actual.useServerFeatureFlag(key)),
  };
});

type Job = NonNullable<ChannelConversionController["job"]>;

function job(overrides: Partial<Job> = {}): Job {
  return { id: "job-1", status: "running", phase: "move_parent_messages", progress: {}, error: null, canCancel: true, ...overrides } as Job;
}

function setController(overrides: Partial<ChannelConversionController> = {}) {
  const calls = { cancel: 0, retry: 0, checkStatus: 0 };
  controller.current = {
    job: job(),
    inProgress: true,
    admissionPending: false,
    connectionWarning: false,
    observationSettled: false,
    error: undefined,
    retryBusy: false,
    cancelBusy: false,
    retry: () => { calls.retry += 1; },
    cancel: async () => { calls.cancel += 1; },
    checkStatus: undefined,
    ...overrides,
  } satisfies ChannelConversionController;
  return calls;
}

function renderStrip(locale: "en" | "zh-cn" = "en", channelName = "lobby") {
  return render(
    <TestIntlProvider locale={locale}>
      <ChannelConversionStrip channelId="channel-lobby" channelName={channelName} />
    </TestIntlProvider>,
  );
}

afterEach(() => {
  cleanup();
  permissions.federateChannels = true;
  controller.current = null;
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useAuthStore.setState({ user: null } as never);
});

test("running: one strip with the title, one bar and the percentage; no step label, no notice", () => {
  setController();
  renderStrip();
  const strip = screen.getByTestId("channel-conversion-strip");
  assert.equal(screen.getByTestId("channel-conversion-strip-title").textContent, en["channel.conversionStrip.title"]);
  assert.equal(screen.getAllByRole("progressbar").length, 1, "one progress bar");
  const percent = screen.getByTestId("channel-conversion-strip-percent");
  assert.equal(percent.textContent, "45%");
  assert.match(percent.className, /tabular-nums/);
  // The bar goes under a 560px wide conversation; the strip is its container.
  assert.match(strip.className, /@container/);
  assert.match(screen.getByTestId("channel-conversion-strip-progress").className, /@max-\[560px\]:hidden/);
  // The current step is not repeated next to the bar (it was said twice in the details).
  assert.ok(!(strip.textContent ?? "").includes(en["channel.conversionStrip.step.preserveCurrent"]!));
  assert.ok(!(strip.textContent ?? "").includes(en["channel.conversionStrip.step.preserve"]!));
  assert.ok(!(strip.textContent ?? "").includes(en["channel.edit.convertStageInProgress"]!));
  // The steps are in View's popover only.
  assert.ok(screen.queryByTestId("channel-conversion-stages") === null);
  assert.ok(screen.queryByTestId("channel-conversion-error") === null);
  assert.equal(screen.getByTestId("channel-conversion-strip-view").tagName, "BUTTON");
});

test("100%: three digits fit and the bar reads complete", () => {
  setController({ job: job({ phase: "done" }) });
  renderStrip();
  assert.equal(screen.getByTestId("channel-conversion-strip-percent").textContent, "100%");
  assert.equal(screen.getByRole("progressbar").getAttribute("aria-valuenow"), "100");
});

test("View opens the five steps and a Cancel button that asks before it cancels", async () => {
  const calls = setController();
  renderStrip();
  fireEvent.click(screen.getByTestId("channel-conversion-strip-view"));
  const popover = await screen.findByTestId("channel-conversion-popover");
  const steps = within(popover).getByTestId("channel-conversion-stages").querySelectorAll("li");
  assert.deepEqual(
    Array.from(steps, (li) => `${li.getAttribute("data-stage")}:${li.getAttribute("data-stage-state")}`),
    ["prepare:complete", "preserve:current", "verify:pending", "access:pending", "done:pending"],
  );
  const current = Array.from(steps).filter((li) => li.getAttribute("aria-current") === "step");
  assert.equal(current.length, 1);
  assert.equal(current[0]!.getAttribute("aria-label"), `${en["channel.conversionStrip.step.preserveCurrent"]}, ${en["channel.edit.convertStageInProgress"]}`);
  // Only the current step reads as under way, once, with no extra "In progress" beside it;
  // the others are noun phrases.
  assert.deepEqual(Array.from(steps, (li) => li.textContent), [
    "Prepare the channel",
    "Preserving messages, files, threads, and tasks…",
    "Verify history",
    "Update server access",
    "Done",
  ]);

  const cancel = within(popover).getByTestId("channel-conversion-cancel");
  assert.equal(cancel.tagName, "BUTTON");
  assert.equal(cancel.textContent, en["channel.conversionStrip.cancel"]);
  fireEvent.click(cancel);
  await screen.findByText(en["channel.conversionStrip.cancelTitle"]!);
  assert.equal(calls.cancel, 0, "nothing is canceled before the confirmation");
  assert.ok(screen.getByText(en["channel.conversionStrip.keepConnecting"]!));
  fireEvent.click(screen.getByTestId("channel-conversion-cancel-confirm"));
  await waitFor(() => assert.equal(calls.cancel, 1));
});

test("a job that can't be canceled any more offers no Cancel", async () => {
  setController({ cancel: undefined });
  renderStrip();
  fireEvent.click(screen.getByTestId("channel-conversion-strip-view"));
  const popover = await screen.findByTestId("channel-conversion-popover");
  assert.ok(within(popover).queryByTestId("channel-conversion-cancel") === null);
});

test("failed: a PanelNotice with the error and Retry, and no strip", () => {
  const calls = setController({ job: job({ status: "failed", error: "Verification failed" }), error: "Verification failed" });
  renderStrip();
  assert.ok(screen.queryByTestId("channel-conversion-strip") === null);
  const notice = screen.getByTestId("channel-conversion-error");
  assert.match(notice.textContent ?? "", /Couldn't finish connecting outside\. Verification failed/);
  fireEvent.click(within(notice).getByTestId("channel-conversion-retry"));
  assert.equal(calls.retry, 1);
});

test("status unavailable: a PanelNotice with Check status, above the running strip", () => {
  const calls = setController({ connectionWarning: true, checkStatus: () => { calls.checkStatus += 1; } });
  renderStrip();
  const warning = screen.getByTestId("channel-conversion-connection-warning");
  assert.equal(warning.textContent?.includes(en["channel.edit.conversionStatusUnavailable"]!), true);
  fireEvent.click(within(warning).getByTestId("channel-conversion-check-status"));
  assert.equal(calls.checkStatus, 1);
  assert.ok(screen.getByTestId("channel-conversion-strip"));
});

test("done, or not someone who may connect servers: nothing shows", () => {
  setController({ inProgress: false, job: job({ status: "done", phase: "done" }) });
  const { container } = renderStrip();
  assert.equal(container.innerHTML, "");
  cleanup();
  setController();
  permissions.federateChannels = false;
  const second = renderStrip();
  assert.equal(second.container.innerHTML, "");
});

test("zh-CN: the strip and its View are in Chinese, with a long channel name in the confirmation", async () => {
  setController();
  const longName = "产品设计与工程协作讨论频道-二零二六年第四季度跨团队发布计划";
  renderStrip("zh-cn", longName);
  assert.equal(screen.getByTestId("channel-conversion-strip-title").textContent, "正在连接外部…");
  assert.equal(screen.getByTestId("channel-conversion-strip-view").textContent, zh["channel.conversionStrip.view"]);
  fireEvent.click(screen.getByTestId("channel-conversion-strip-view"));
  const popover = await screen.findByTestId("channel-conversion-popover");
  assert.deepEqual(
    Array.from(within(popover).getByTestId("channel-conversion-stages").querySelectorAll("li"), (li) => li.textContent),
    ["准备频道", "正在保留消息、文件、消息列和任务", "验证历史", "更新服务器权限", "完成"],
  );
  fireEvent.click(within(popover).getByTestId("channel-conversion-cancel"));
  await screen.findByText(`#${longName} 将恢复到连接前的样子。`);
});

test("the channel details no longer carry the conversion", () => {
  setController();
  const server = { id: "server-1", slug: "s", name: "S", role: "owner", plan: "pro" };
  useAuthStore.setState({ user: { id: "u1", name: "U" }, initialized: true } as never);
  useServerStore.setState({ servers: [server], current: server, members: [], loading: false } as never);
  useChannelStore.setState({
    channels: [{
      id: "channel-lobby", serverId: "server-1", name: "lobby", description: "", type: "channel",
      archivedAt: null, jointServers: [], joined: true,
      channelCapabilities: { editChannelMetadata: true, federateChannels: true },
      conversionJob: job(),
    }],
  } as never);
  render(
    <TestIntlProvider locale="en">
      <MemoryRouter>
        <EditChannelDialog channelId="channel-lobby" initialName="lobby" initialDescription="" onClose={() => {}} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
  assert.ok(screen.getByTestId("channel-settings-panel"));
  assert.ok(document.querySelector('[data-testid^="channel-settings-joint-conversion"]') === null);
  assert.ok(document.querySelector('[role="progressbar"]') === null);
});
