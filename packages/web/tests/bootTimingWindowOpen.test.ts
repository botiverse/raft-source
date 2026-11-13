import assert from "node:assert/strict";
import "./helpers/domSetup";

import { __resetBootTimingForTest, markBootMilestone, startBootTiming } from "../src/boot/bootTiming";
import { __resetChannelWindowOpenForTest, openChannelWindow } from "../src/store/channelWindowOpen";
import { useMessageStore } from "../src/store/messageStore";

/** Boot timing: the page load's first conversation window is timed, whichever window it is. */

let events: Array<Record<string, unknown>> = [];

afterEach(() => {
  __resetBootTimingForTest();
  __resetChannelWindowOpenForTest();
});

test("the first window open marks messages_sent, and messages when it loads; later opens don't", async () => {
  events = [];
  __resetBootTimingForTest((_name, attrs) => events.push(attrs));
  __resetChannelWindowOpenForTest();
  const saved = useMessageStore.getState().loadMessages;
  let release: () => void = () => undefined;
  useMessageStore.setState({ loadMessages: () => new Promise<void>((resolve) => { release = resolve; }) } as never);
  try {
    startBootTiming({ pathname: "/s/acme/channel/c1", search: "" });
    const load = openChannelWindow("c-timed", null);
    release();
    await load;
    await Promise.resolve();
    void openChannelWindow("c-other", null);
    markBootMilestone("content");
    const [event] = events;
    assert.equal(typeof event.messages_sent_ms, "number");
    assert.equal(typeof event.messages_ms, "number");
    assert.ok((event.messages_ms as number) >= (event.messages_sent_ms as number));
  } finally {
    useMessageStore.setState({ loadMessages: saved } as never);
  }
});

test("a failed first window still marks messages", async () => {
  events = [];
  __resetBootTimingForTest((_name, attrs) => events.push(attrs));
  __resetChannelWindowOpenForTest();
  const saved = useMessageStore.getState().loadMessages;
  useMessageStore.setState({ loadMessages: () => Promise.reject(new Error("503")) } as never);
  try {
    startBootTiming({ pathname: "/s/acme/channel/c1", search: "" });
    await openChannelWindow("c-fail", null).catch(() => undefined);
    await Promise.resolve();
    markBootMilestone("content");
    assert.equal(typeof events[0].messages_ms, "number");
  } finally {
    useMessageStore.setState({ loadMessages: saved } as never);
  }
});
