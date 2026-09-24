import type { Page, Request, Response, TestInfo } from "@playwright/test";

// Observe only this drag and this server's sidebar-order PATCH. Never capture
// headers, auth, unrelated traffic, or DataTransfer contents.
export async function withWorkspaceDmDragEvidence(
  page: Page,
  testInfo: TestInfo,
  serverId: string,
  dmIds: string[],
  action: () => Promise<void>,
) {
  const browser = await page.evaluateHandle((ids) => {
    const events: Array<Record<string, unknown>> = [];
    const types = ["dragstart", "dragenter", "dragover", "drop", "dragend"];
    const listener = (event: Event) => {
      const drag = event as DragEvent;
      const row = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-sidebar-channel-id]") : null;
      const id = row?.dataset.sidebarChannelId;
      if (!id || !ids.includes(id) || events.length >= 200) return;
      const rect = row!.getBoundingClientRect();
      events.push({ type: event.type, at: performance.now(), id,
        x: drag.clientX, y: drag.clientY, top: rect.top, left: rect.left,
        width: rect.width, height: rect.height, viewportWidth: innerWidth,
        viewportHeight: innerHeight, defaultPrevented: event.defaultPrevented });
    };
    for (const type of types) document.addEventListener(type, listener, true);
    return { events, stop() { for (const type of types) document.removeEventListener(type, listener, true); } };
  }, dmIds);
  const patches: Array<Record<string, unknown>> = [];
  const requests = new Map<Request, Record<string, unknown>>();
  const pending: Promise<void>[] = [];
  const matches = (request: Request) => request.method() === "PATCH"
    && new URL(request.url()).pathname === `/api/servers/${serverId}/sidebar-order`;
  const onRequest = (request: Request) => {
    if (!matches(request)) return;
    const entry: Record<string, unknown> = { at: Date.now(), payload: request.postDataJSON() };
    patches.push(entry);
    requests.set(request, entry);
  };
  const onResponse = (response: Response) => {
    const entry = requests.get(response.request());
    if (!entry) return;
    entry.status = response.status();
    pending.push(response.json().then(body => { entry.response = body; }, () => { entry.responseUnavailable = true; }));
  };
  const onFailed = (request: Request) => {
    const entry = requests.get(request);
    if (entry) entry.failure = request.failure()?.errorText ?? "unknown";
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onFailed);
  try {
    await action();
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfailed", onFailed);
    await Promise.all(pending);
    const events = await browser.evaluate(state => { state.stop(); return state.events; }).catch(() => null);
    await browser.dispose();
    await testInfo.attach("workspace-dm-drag-evidence", {
      body: Buffer.from(JSON.stringify({ retry: testInfo.retry, dmIds, events, patches }, null, 2)),
      contentType: "application/json",
    });
  }
}
