import assert from "node:assert/strict";

import { __resetDeferredUiForTest, deferredModule } from "../src/boot/deferredUi";
import { fetchDeferredUiAfterFirstScreen } from "../src/boot/deferredUiStart";
import { useMessageStore } from "../src/store/messageStore";

// Every app entry (web main.tsx, the desktop's) starts the background fetch of
// the deferred UI, e.g. the detail panels MainLayout declares with lazyDeferred,
// once the first conversation's first page is in.

const idle = () => new Promise((resolve) => setTimeout(resolve, 5));

afterEach(() => {
  vi.useRealTimers();
  __resetDeferredUiForTest();
});

test("deferred modules are fetched once the first conversation's first page is in, not before", async () => {
  __resetDeferredUiForTest();
  const initial = useMessageStore.getState();
  let fetched = 0;
  deferredModule(async () => { fetched += 1; return {}; });
  let content = 0;
  fetchDeferredUiAfterFirstScreen(() => { content += 1; });
  useMessageStore.setState({ currentChannelId: "c1", channelMessages: {}, channelWindowMeta: {} });
  await idle();
  assert.equal(fetched, 0, "no conversation page yet");
  useMessageStore.setState({ channelWindowMeta: { c1: { loading: false } as never } });
  await idle();
  assert.equal(content, 1);
  assert.equal(fetched, 1);
  useMessageStore.setState({ channelWindowMeta: {} });
  useMessageStore.setState({ channelWindowMeta: { c1: { loading: false } as never } });
  await idle();
  assert.equal(content, 1, "the milestone fires once");
  useMessageStore.setState(initial, true);
});

test("a load that shows no conversation fetches them after the fallback", async () => {
  __resetDeferredUiForTest();
  vi.useFakeTimers();
  let fetched = 0;
  deferredModule(async () => { fetched += 1; return {}; });
  fetchDeferredUiAfterFirstScreen();
  vi.advanceTimersByTime(9_999);
  assert.equal(fetched, 0);
  vi.advanceTimersByTime(1);
  // fetchDeferredUi defers each load to idle time (setTimeout without requestIdleCallback).
  vi.runOnlyPendingTimers();
  assert.equal(fetched, 1);
});
