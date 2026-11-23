/**
 * The conversion strip's fallback read (useChannelConversionController): the
 * server pushes `channel:updated` after each conversion phase, so the client
 * only reads the job every CONVERSION_POLL_MS, and not at all while the tab is
 * hidden; coming back to the tab reads at once. A newer job in the store (a
 * realtime patch) wins over the hook's own last read of the same job.
 */
import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { TestIntlProvider } from "../../../../tests/helpers/intl";
import {
  CONVERSION_POLL_MS,
  useChannelConversionController,
} from "../../../components/channel/useChannelConversionController";
import { useChannelStore } from "../../../store/channelStore";
import { useServerStore } from "../../../store/serverStore";
import { useAuthStore } from "../../../store/authStore";

const CHANNEL_ID = "channel-lobby";
const runningJob = (phase = "move_parent_messages") => ({
  id: "job-1", status: "running", phase, progress: {}, error: null, canCancel: false,
});

let visibility: DocumentVisibilityState = "visible";
let reads = 0;

function seed() {
  const server = { id: "server-1", slug: "s", name: "S", role: "owner", plan: "pro" };
  useAuthStore.setState({ user: { id: "u1", name: "U" }, initialized: true } as never);
  useServerStore.setState({ servers: [server], current: server, members: [], loading: false } as never);
  useChannelStore.setState({
    channels: [{ id: CHANNEL_ID, serverId: "server-1", name: "lobby", type: "channel", joined: true, conversionJob: runningJob() }],
    getChannelConversionJob: async () => {
      reads += 1;
      return { conversionJob: runningJob() };
    },
  } as never);
}

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new document.defaultView!.Event("visibilitychange"));
}

const wrapper = ({ children }: { children: ReactNode }) => <TestIntlProvider locale="en">{children}</TestIntlProvider>;

beforeEach(() => {
  vi.useFakeTimers();
  reads = 0;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  seed();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useAuthStore.setState({ user: null } as never);
});

test("a running job is read every CONVERSION_POLL_MS while the tab is visible", async () => {
  renderHook(() => useChannelConversionController(CHANNEL_ID, "lobby", true), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(CONVERSION_POLL_MS - 100); });
  assert.equal(reads, 0, "no read before the fallback interval");
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  assert.equal(reads, 1);
});

test("hidden: no reads; visible again: one read at once", async () => {
  visibility = "hidden";
  renderHook(() => useChannelConversionController(CHANNEL_ID, "lobby", true), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(CONVERSION_POLL_MS * 6); });
  assert.equal(reads, 0, "paused while hidden");
  await act(async () => {
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
  });
  assert.equal(reads, 1, "read as soon as the tab is visible");
});

test("a realtime patch of the same job moves the strip, and done ends it", async () => {
  const { result } = renderHook(() => useChannelConversionController(CHANNEL_ID, "lobby", true), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(CONVERSION_POLL_MS + 10); });
  assert.equal(result.current.job?.phase, "move_parent_messages");
  act(() => {
    useChannelStore.getState().applyChannelPatch({ id: CHANNEL_ID, name: "lobby", conversionJob: runningJob("verify") } as never);
  });
  assert.equal(result.current.job?.phase, "verify");
  act(() => {
    useChannelStore.getState().applyChannelPatch({ id: CHANNEL_ID, name: "lobby", conversionJob: { ...runningJob("done"), status: "done" } } as never);
  });
  assert.equal(result.current.inProgress, false);
});

test("disabled (no permission): nothing is read", async () => {
  renderHook(() => useChannelConversionController(CHANNEL_ID, "lobby", false), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(CONVERSION_POLL_MS * 3); });
  assert.equal(reads, 0);
});
