// checkPage.ts's browser over Cloudflare Browser Rendering (the `BROWSER` binding) and
// `@cloudflare/puppeteer`. The only module that touches puppeteer; check.ts and the tests
// see the narrow interface.
//
// - A browser session per check at a time, in the check's own invocation (runner.ts
//   runLeasedCheck acquires it for a lease, so an idle minute starts none): one another check of
//   the account left running, else one launched for it (pool.ts: `sessions()`, `connect`,
//   `launch` with keep_alive), and a fresh incognito context inside it
//   (`browser.createBrowserContext()`: no cookies, storage or cache of any other context), closed
//   after the check. The session is then left running for the next check (`disconnect`) or
//   closed, as pool.ts decides.
// - Every request of the check's tab is intercepted and asked (navigation.ts); service
//   workers are bypassed so none escapes interception; popups are closed and dialogs
//   dismissed (neither can block the shot).
// - Viewports are emulated on a CDP session of the check's own, not with `page.setViewport`:
//   puppeteer reloads the page when the mobile or touch flag changes, and the ticket opens
//   once. Puppeteer's own default viewport is cleared first so one session alone emulates.
//   The shots are taken on that same session (`Page.captureScreenshot`, cdpPage.ts): an
//   emulation is its session's, and `page.screenshot` (puppeteer's session) took the phone at
//   a device scale of 1.
// - What failed to load: puppeteer's `requestfailed` (but `net::ERR_ABORTED`, a request the
//   page or a navigation cancelled), and the CSP issues Chromium reports (Audits), read on the
//   CDP session, out of the page's reach.
// - Errors are turned into code-shaped classes (report.ts errorClassOf): a browser's error
//   message names the URL it failed on, the ticket's included, so none is kept. No event
//   callback here can throw (`quietly`): a throw inside puppeteer's emitter would surface as an
//   uncaught exception, which Workers Logs would record with its message. A request whose
//   decision threw is aborted (the guard fails closed); a page crash (`error`) is absorbed (its
//   shot then fails, and is left out).
import puppeteer, { TimeoutError, type Browser, type BrowserContext, type BrowserWorker, type CDPSession, type Page } from "@cloudflare/puppeteer";
import type { ArtifactCheckViewport } from "@botiverse/raft-shared/src/artifactCheckContract";

import { sessionViewport, thrownAt, type CdpSend } from "./cdpPage";
import type { CheckBrowser, CheckContext, CheckPage, OpenResult } from "./checkPage";
import type { PageMeasure } from "./pageChecks";
import { openWith } from "./open";
import { createSessionPool, pooledCheckBrowser, type PoolBackend, type PoolDeps, type SessionHandle } from "./pool";

/** `callback`, made unable to throw: a throw ends it, silently (nothing of the error is kept). */
function quietly<Args extends unknown[]>(callback: (...args: Args) => void): (...args: Args) => void {
  return (...args) => {
    try {
      callback(...args);
    } catch {
      // Swallowed: an event callback's throw would be an uncaught exception, message and all.
    }
  };
}

interface PuppeteerSession extends SessionHandle {
  browser: Browser;
  /** The ids of the contexts this check made in it. */
  made: Set<string>;
}

function sessionOf(browser: Browser): PuppeteerSession {
  const made = new Set<string>();
  return {
    browser,
    made,
    sessionId: browser.sessionId(),
    // The contexts the session had when connected (puppeteer reads Target.getBrowserContexts), the default one not among them.
    openContexts: browser.browserContexts().filter((context) => context !== browser.defaultBrowserContext()).length,
    // Read fresh on the browser's own target: puppeteer's browserContexts() knows only the contexts
    // this connection made or found when it connected, never another client's made since.
    async othersOpen() {
      const cdp = await browser.target().createCDPSession();
      try {
        const { browserContextIds } = await cdp.send("Target.getBrowserContexts");
        return browserContextIds.filter((id) => !made.has(id)).length;
      } finally {
        await cdp.detach().catch(() => {});
      }
    },
    disconnect: () => browser.disconnect(),
    close: () => browser.close(),
  };
}

/** Browser Rendering's session API, as pool.ts reaches it. */
function backendOf(binding: BrowserWorker): PoolBackend<PuppeteerSession> {
  return {
    sessions: () => puppeteer.sessions(binding),
    connect: async (sessionId) => sessionOf(await puppeteer.connect(binding, sessionId)),
    launch: async (keepAliveMs) => sessionOf(await puppeteer.launch(binding, { keep_alive: keepAliveMs })),
  };
}

/**
 * A browser session for one check: with the pool on, a free one of the account's, else a new one;
 * off, always a new one, closed after (pool.ts). Throws when none can be had (a limit, an outage).
 */
export async function acquireCheckBrowser(binding: BrowserWorker, deps: PoolDeps): Promise<CheckBrowser> {
  const pool = createSessionPool(backendOf(binding), deps);
  const acquired = await pool.acquire();
  return pooledCheckBrowser(pool, acquired, async (session) => {
    const context = await session.browser.createBrowserContext();
    if (context.id !== undefined) session.made.add(context.id);
    return contextOf(context);
  });
}

function contextOf(context: BrowserContext): CheckContext {
  return {
    async newPage() {
      const page = await context.newPage();
      // Puppeteer's default viewport off (no reload: the page is blank and not mobile), so the check's CDP session alone emulates.
      await page.setViewport(null);
      await page.setBypassServiceWorker(true);
      page.on("dialog", quietly((dialog) => void dialog.dismiss().catch(() => {})));
      page.on("popup", quietly((popup) => void popup?.close().catch(() => {})));
      // A crashed page: absorbed; what follows (the shots) fails on its own and is left out.
      page.on("error", quietly(() => {}));
      const cdp = await page.createCDPSession();
      // Chromium's issues (a CSP refusal among them) from here on; a browser without the domain still checks.
      await cdp.send("Audits.enable").catch(() => {});
      return pageOf(page, cdp);
    },
    async close() {
      await context.close();
    },
  };
}

function pageOf(page: Page, cdp: CDPSession): CheckPage {
  // Emulated and shot on the check's one session, so the shot is at the emulated device scale.
  const viewport = sessionViewport(cdp.send.bind(cdp) as unknown as CdpSend);
  return {
    async guardRequests(decide) {
      await page.setRequestInterception(true);
      page.on(
        "request",
        quietly((request) => {
          if (request.isInterceptResolutionHandled()) return;
          let allow = false;
          try {
            const frame = request.frame();
            const chain = request.redirectChain();
            allow = decide({
              url: request.url(),
              isNavigation: request.isNavigationRequest(),
              isMainFrame: frame === null || frame === page.mainFrame(),
              redirectedFrom: chain.length > 0 ? chain[0]!.url() : null,
            });
          } catch {
            allow = false;
          }
          void (allow ? request.continue() : request.abort("blockedbyclient")).catch(() => {});
        }),
      );
    },
    onConsoleError(handler) {
      page.on(
        "console",
        quietly((message) => {
          if (message.type() !== "error") return;
          const { url, lineNumber } = message.location();
          handler(message.text(), url ?? null, typeof lineNumber === "number" ? lineNumber + 1 : null);
        }),
      );
    },
    onPageError(handler) {
      page.on(
        "pageerror",
        quietly((error: unknown) => {
          const { source, line } = thrownAt(error);
          handler(error instanceof Error ? `${error.name}: ${error.message}` : String(error), source, line);
        }),
      );
    },
    onBlocked(handler) {
      page.on(
        "requestfailed",
        quietly((request) => {
          if (request.failure()?.errorText === "net::ERR_ABORTED") return;
          handler(request.url());
        }),
      );
      cdp.on(
        "Audits.issueAdded",
        quietly(({ issue }) => {
          const blockedURL = issue.details.contentSecurityPolicyIssueDetails?.blockedURL;
          if (issue.code === "ContentSecurityPolicyIssue" && blockedURL) handler(blockedURL);
        }),
      );
    },
    async emulate(given: ArtifactCheckViewport, userAgent: string | null) {
      await viewport.emulate(given);
      if (userAgent !== null) await page.setUserAgent(userAgent);
    },
    open(url, timeoutMs): Promise<OpenResult> {
      return openWith(() => page.goto(url, { waitUntil: "load", timeout: timeoutMs }), (error) => error instanceof TimeoutError);
    },
    async networkIdle(idleMs, timeoutMs) {
      await page.waitForNetworkIdle({ idleTime: idleMs, timeout: timeoutMs }).catch(() => {});
    },
    async shellHost() {
      // On the root, where the shell puts it: its own script goes with the body a whole page replaces.
      const said: unknown = await page.evaluate(() => document.documentElement.getAttribute("data-porthole-host"));
      return typeof said === "string" ? said : null;
    },
    async measure(): Promise<PageMeasure> {
      return page.evaluate(() => {
        const body = document.body;
        const scroller = document.scrollingElement ?? document.documentElement;
        return { textLength: body ? body.innerText.trim().length : 0, scrollWidth: scroller.scrollWidth, innerWidth: window.innerWidth };
      });
    },
    screenshot() {
      return viewport.screenshot();
    },
  };
}
