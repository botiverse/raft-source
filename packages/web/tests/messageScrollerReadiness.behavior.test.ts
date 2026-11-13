import assert from "node:assert/strict";
import vm from "node:vm";

import {
  classifyMessageScrollerRequest,
  MESSAGE_SCROLLER_READINESS_TIMEOUT_MS,
  withMessageScrollerReadinessEvidence,
} from "./e2e/fixtures/messageScrollerReadiness";

type Listener = (value: unknown) => void;

class FakePage {
  readonly handlers = new Map<string, Set<Listener>>();
  disposed = false;
  probeUnavailable = false;
  executeProbeExpression = false;
  messageSurfaceText = "Loading…";
  surroundingColumnText = "";
  probeClockAdvanceMs = 50;

  async evaluateHandle(expression: unknown) {
    if (this.probeUnavailable) throw new Error("probe unavailable");
    assert.equal(typeof expression, "string");
    new vm.Script(expression);
    if (this.executeProbeExpression) {
      const receiptStartMatch = expression.match(/const receiptStartedAtEpochMs = (\d+);/);
      assert.ok(receiptStartMatch, "probe must bind the shared receipt-start epoch");
      const receiptStartedAtEpochMs = Number(receiptStartMatch[1]);
      const messageSurface = {
        innerText: this.messageSurfaceText,
        querySelectorAll: (selector: string) => selector === '[data-testid="message-scroller"]' ? [] : [],
      };
      const targetSurface = {
        innerText: `${this.surroundingColumnText}\n${this.messageSurfaceText}`,
        querySelector: (selector: string) => (
          selector === '[data-testid="message-content-surface"]' ? messageSurface : null
        ),
      };
      const probe = vm.runInNewContext(expression, {
        Date: { now: () => receiptStartedAtEpochMs + this.probeClockAdvanceMs },
        decodeURIComponent,
        document: {
          body: { innerText: this.surroundingColumnText },
          documentElement: {},
          querySelector: (selector: string) => (
            selector === '[data-testid="thread-main-column"]' ? targetSurface : null
          ),
        },
        location: { pathname: "/s/server/channel/target-channel" },
        MutationObserver: class {
          observe() {}
          disconnect() {}
        },
        performance: { now: () => 0 },
      }) as { stopAndRead: () => unknown };
      return {
        evaluate: async (read: (value: typeof probe) => unknown) => read(probe),
        dispose: async () => {
          this.disposed = true;
        },
      };
    }
    return {
      evaluate: async () => ({
        samples: [{ atMs: 0, stage: "message-loading", scrollerCount: 0 }],
        final: {
          atMs: 5000,
          stage: "message-loading",
          scrollerCount: 0,
          routeKind: "channel",
          routeChannelId: "target-channel",
          routeMatchesTarget: true,
        },
      }),
      dispose: async () => {
        this.disposed = true;
      },
    };
  }

  on(name: string, listener: Listener) {
    const listeners = this.handlers.get(name) ?? new Set<Listener>();
    listeners.add(listener);
    this.handlers.set(name, listeners);
  }

  off(name: string, listener: Listener) {
    this.handlers.get(name)?.delete(listener);
  }

  emit(name: string, value: unknown) {
    for (const listener of this.handlers.get(name) ?? []) listener(value);
  }

  get listenerCount() {
    let count = 0;
    for (const listeners of this.handlers.values()) count += listeners.size;
    return count;
  }
}

function fakeRequest(rawUrl: string, failureText?: string) {
  return {
    method: () => "GET",
    url: () => rawUrl,
    failure: () => failureText ? { errorText: failureText } : null,
  };
}

function fakeResponse(request: ReturnType<typeof fakeRequest>, status: number) {
  return { request: () => request, status: () => status };
}

test("request matcher accepts only exact target channel GETs and ignores queries", () => {
  assert.equal(
    classifyMessageScrollerRequest("GET", "http://localhost/api/channels/dm?secret=hidden", "target"),
    "dm-channels",
  );
  assert.equal(
    classifyMessageScrollerRequest("GET", "http://localhost/api/channels/target?secret=hidden", "target"),
    "channel",
  );
  assert.equal(
    classifyMessageScrollerRequest("GET", "http://localhost/api/messages/channel/target?limit=50", "target"),
    "messages",
  );
  assert.equal(
    classifyMessageScrollerRequest("GET", "http://localhost/api/messages/channel/other?limit=50", "target"),
    null,
  );
  assert.equal(
    classifyMessageScrollerRequest("POST", "http://localhost/api/channels/target", "target"),
    null,
  );
});

test("successful readiness keeps the five-second contract and emits no attachment", async () => {
  const page = new FakePage();
  let attachments = 0;

  const result = await withMessageScrollerReadinessEvidence(
    page as never,
    { retry: 0, attach: async () => { attachments += 1; } } as never,
    { consumer: "unread-click-read", channelId: "target-channel" },
    async (startRenderObservation) => {
      await startRenderObservation();
      return "ready";
    },
  );

  assert.equal(MESSAGE_SCROLLER_READINESS_TIMEOUT_MS, 5_000);
  assert.equal(result, "ready");
  assert.equal(attachments, 0);
  assert.equal(page.disposed, true);
  assert.equal(page.listenerCount, 0);
});

test("failed readiness attaches a bounded sanitized lifecycle receipt and rethrows the same error", async () => {
  const page = new FakePage();
  const original = new Error("original visibility assertion");
  const targetRequest = fakeRequest("http://localhost/api/messages/channel/target-channel?secret=do-not-record");
  const unrelatedRequest = fakeRequest("http://localhost/api/messages/channel/other-channel?secret=also-hidden");
  const overflowRequests = Array.from({ length: 9 }, (_, index) =>
    fakeRequest(`http://localhost/api/channels/target-channel?secret=overflow-${index}`)
  );
  let attachmentName = "";
  let receipt: Record<string, unknown> | null = null;

  const caught = await withMessageScrollerReadinessEvidence(
    page as never,
    {
      retry: 0,
      attach: async (name: string, attachment: { body: Buffer }) => {
        attachmentName = name;
        receipt = JSON.parse(attachment.body.toString("utf8"));
      },
    } as never,
    { consumer: "channel-task-board", channelId: "target-channel" },
    async (startRenderObservation) => {
      page.emit("request", unrelatedRequest);
      page.emit("request", targetRequest);
      page.emit("response", fakeResponse(targetRequest, 200));
      page.emit("requestfinished", targetRequest);
      for (const request of overflowRequests) page.emit("request", request);
      await startRenderObservation();
      throw original;
    },
  ).catch(error => error);

  assert.equal(caught, original);
  assert.equal(attachmentName, "message-scroller-readiness-channel-task-board.json");
  assert.equal(page.listenerCount, 0);
  assert.equal(receipt?.consumer, "channel-task-board");
  assert.equal((receipt?.requests as unknown[]).length, 8);
  assert.deepEqual((receipt?.requests as unknown[])[0], {
    id: 1,
    kind: "messages",
    startedAtMs: (receipt?.requests as Array<{ startedAtMs: number }>)[0].startedAtMs,
    responseAtMs: (receipt?.requests as Array<{ responseAtMs: number }>)[0].responseAtMs,
    status: 200,
    finishedAtMs: (receipt?.requests as Array<{ finishedAtMs: number }>)[0].finishedAtMs,
  });
  assert.deepEqual(receipt?.unavailable, ["message-store-state", "receiver-ingress-generation"]);
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("do-not-record"), false);
  assert.equal(serialized.includes("other-channel"), false);
  assert.equal(serialized.includes("http://"), false);
});


test("browser probe scopes loading state to the message content surface and shares the request timeline", async () => {
  const page = new FakePage();
  page.executeProbeExpression = true;
  page.surroundingColumnText = "Loading channel";
  page.messageSurfaceText = "Loading…";
  const original = new Error("original visibility assertion");
  const targetRequest = fakeRequest("http://localhost/api/messages/channel/target-channel");
  let receipt: {
    timeline?: { origin?: string; unit?: string };
    browser?: { final?: { atMs?: number; stage?: string; routeMatchesTarget?: boolean } };
    requests?: Array<{ startedAtMs?: number }>;
  } | null = null;

  const caught = await withMessageScrollerReadinessEvidence(
    page as never,
    {
      retry: 0,
      attach: async (_name: string, attachment: { body: Buffer }) => {
        receipt = JSON.parse(attachment.body.toString("utf8"));
      },
    } as never,
    { consumer: "unread-click-read", channelId: "target-channel" },
    async (startRenderObservation) => {
      page.emit("request", targetRequest);
      await startRenderObservation();
      throw original;
    },
  ).catch(error => error);

  assert.equal(caught, original);
  assert.deepEqual(receipt?.timeline, {
    origin: "receipt-start-before-navigation",
    unit: "ms",
  });
  assert.equal(receipt?.browser?.final?.stage, "message-loading");
  assert.equal(receipt?.browser?.final?.routeMatchesTarget, true);
  assert.equal(receipt?.browser?.final?.atMs, page.probeClockAdvanceMs);
  assert.ok((receipt?.browser?.final?.atMs ?? -1) >= (receipt?.requests?.[0]?.startedAtMs ?? Infinity));
});

test("diagnostic setup and attachment failures never replace the original assertion error", async () => {
  const page = new FakePage();
  page.probeUnavailable = true;
  const original = new Error("original visibility assertion");

  const caught = await withMessageScrollerReadinessEvidence(
    page as never,
    { retry: 0, attach: async () => { throw new Error("attachment unavailable"); } } as never,
    { consumer: "unread-click-read", channelId: "target-channel" },
    async (startRenderObservation) => {
      await startRenderObservation();
      throw original;
    },
  ).catch(error => error);

  assert.equal(caught, original);
  assert.equal(page.listenerCount, 0);
});
