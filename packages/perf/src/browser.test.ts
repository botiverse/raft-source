import type { Browser } from "playwright";
import { describe, expect, it } from "vitest";
import { BROWSER_RUN_IDLE_MS, BrowserError, type BrowserRunTransport, browserRunAccess, browserRunSessionId, browserRunSessionsUrl, browserRunSocketUrl, leftOutAsBusy, openBrowser, parseBrowserWhere, planBrowser, withoutAccess } from "./browser";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ENV = { RAFT_PERF_CF_ACCOUNT_ID: ACCOUNT, RAFT_PERF_CF_API_TOKEN: "s3cret-token" };
const SESSION = "0937fb2f-aaaa-bbbb-cccc-0123456789ab";

/** A transport that records what was asked of it; `answers` are the HTTP answers in order. */
function fake(answers: Array<{ status: number; body?: unknown } | Error>, connect: () => Promise<Browser> = async () => ({ version: () => "152.0", close: async () => {} }) as unknown as Browser) {
  const calls: string[] = [];
  const transport: BrowserRunTransport = {
    fetch: async (url, init) => {
      calls.push(`${init.method} ${url}`);
      const answer = answers.shift();
      if (!answer) throw new Error("no answer left");
      if (answer instanceof Error) throw answer;
      return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body };
    },
    connect: (url, options) => {
      calls.push(`CONNECT ${url} ${options.headers.Authorization === "Bearer s3cret-token" ? "authorized" : "no token"}`);
      return connect();
    },
  };
  return { calls, transport };
}

describe("browser", () => {
  it("defaults to this machine and refuses an unknown place", () => {
    expect(parseBrowserWhere(undefined)).toBe("local");
    expect(parseBrowserWhere("browser-run")).toBe("browser-run");
    expect(() => parseBrowserWhere("cloud")).toThrow(/--browser must be local or browser-run, not cloud/);
  });
  it("reads Browser Run access from the environment and says which variables are missing", () => {
    expect(browserRunAccess({ RAFT_PERF_CF_ACCOUNT_ID: ` ${ACCOUNT}\n`, RAFT_PERF_CF_API_TOKEN: " t0ken " })).toEqual({ accountId: ACCOUNT, token: "t0ken" });
    expect(() => browserRunAccess({ RAFT_PERF_CF_ACCOUNT_ID: ACCOUNT })).toThrow(/RAFT_PERF_CF_ACCOUNT_ID and RAFT_PERF_CF_API_TOKEN/);
    expect(() => browserRunAccess({ RAFT_PERF_CF_API_TOKEN: "t" })).toThrow(BrowserError);
  });
  it("refuses an account id or a session id that would change the endpoint's path", () => {
    expect(() => browserRunAccess({ RAFT_PERF_CF_ACCOUNT_ID: "abc/../other", RAFT_PERF_CF_API_TOKEN: "t" })).toThrow(/not a Cloudflare account id/);
    expect(() => browserRunSessionId("../../zones")).toThrow(/named no session this tool recognises/);
    expect(() => browserRunSessionId(undefined)).toThrow(BrowserError);
    expect(browserRunSessionId(SESSION)).toBe(SESSION);
    expect(browserRunSocketUrl(ACCOUNT, SESSION)).toBe(`wss://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-run/devtools/browser/${SESSION}`);
  });
  it("plans without the network: a local plan keeps its switches, a Browser Run plan refuses them and needs its access", () => {
    expect(planBrowser(undefined, ["--marker=1"], {})).toEqual({ where: "local", chromiumArgs: ["--marker=1"] });
    expect(planBrowser("browser-run", [], ENV)).toEqual({ where: "browser-run", access: { accountId: ACCOUNT, token: "s3cret-token" } });
    expect(() => planBrowser("browser-run", ["--marker=1"], ENV)).toThrow(/--chromium-arg has no effect/);
    expect(() => planBrowser("browser-run", [], {})).toThrow(/RAFT_PERF_CF_ACCOUNT_ID/);
  });
  it("builds the endpoint that creates a session with an idle time in the service's range", () => {
    expect(browserRunSessionsUrl(ACCOUNT, BROWSER_RUN_IDLE_MS)).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-run/devtools/browser?keep_alive=300000`);
    expect(browserRunSessionsUrl(ACCOUNT)).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-run/devtools/browser`);
    expect(() => browserRunSessionsUrl(ACCOUNT, 9_999)).toThrow(/10000 to 1200000/);
    expect(() => browserRunSessionsUrl(ACCOUNT, 1_200_001)).toThrow(BrowserError);
  });
  it("takes the account and the token out of an error's text", () => {
    expect(withoutAccess(`connect wss://api/accounts/${ACCOUNT}/x failed for Bearer s3cret (s3cret)`, { accountId: ACCOUNT, token: "s3cret" })).toBe("connect wss://api/accounts/<account>/x failed for Bearer <token> (<token>)");
  });
  it("leaves no pair out as busy when they are kept on request or the browser was on another machine", () => {
    expect(leftOutAsBusy([1, 3], { keepBusy: false, where: "local" })).toEqual([1, 3]);
    expect(leftOutAsBusy([1, 3], { keepBusy: true, where: "local" })).toEqual([]);
    expect(leftOutAsBusy([1, 3], { keepBusy: false, where: "browser-run" })).toEqual([]);
  });
  it("creates a session, connects to it by its id, and ends it by its id when closed", async () => {
    const { calls, transport } = fake([{ status: 200, body: { sessionId: SESSION, webSocketDebuggerUrl: "wss://ignored" } }, { status: 200 }]);
    const opened = await openBrowser(planBrowser("browser-run", [], ENV), transport);
    expect(opened.describe).toEqual({ where: "browser-run", version: "152.0" });
    expect(await opened.close()).toBeNull();
    expect(calls).toEqual([
      `POST https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-run/devtools/browser?keep_alive=300000`,
      `CONNECT wss://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-run/devtools/browser/${SESSION} authorized`,
      `DELETE https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-run/devtools/browser/${SESSION}`,
    ]);
  });
  it("says so when the session could not be ended, and treats one already gone as ended", async () => {
    const failing = fake([{ status: 200, body: { result: { sessionId: SESSION } } }, { status: 500 }]);
    expect(await (await openBrowser(planBrowser("browser-run", [], ENV), failing.transport)).close()).toMatch(/was not ended \(the service answered 500\); it ends by itself after 300 s/);
    const gone = fake([{ status: 200, body: { sessionId: SESSION } }, { status: 404 }]);
    expect(await (await openBrowser(planBrowser("browser-run", [], ENV), gone.transport)).close()).toBeNull();
  });
  it("reports a session it could not reach to end, without the account, and adds that to a connect failure", async () => {
    const lost = fake([{ status: 200, body: { sessionId: SESSION } }, new Error(`fetch failed for accounts/${ACCOUNT}`)]);
    expect(await (await openBrowser(planBrowser("browser-run", [], ENV), lost.transport)).close()).toBe("the Browser Run session was not ended (fetch failed for accounts/<account>); it ends by itself after 300 s without a command");
    const both = fake([{ status: 200, body: { sessionId: SESSION } }, { status: 500 }], async () => {
      throw new Error("socket refused");
    });
    await expect(openBrowser(planBrowser("browser-run", [], ENV), both.transport)).rejects.toThrow("could not connect to the Browser Run session: socket refused; the Browser Run session was not ended (the service answered 500); it ends by itself after 300 s without a command");
  });
  it("ends the session when connecting to it fails, and its error names neither the account nor the token", async () => {
    const { calls, transport } = fake([{ status: 200, body: { sessionId: SESSION } }, { status: 200 }], async () => {
      throw new Error(`WebSocket error: wss://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-run 401 for s3cret-token\nCall log: ${ACCOUNT}`);
    });
    const error = await openBrowser(planBrowser("browser-run", [], ENV), transport).then(
      () => null,
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(BrowserError);
    expect(error!.message).toBe("could not connect to the Browser Run session: WebSocket error: wss://api.cloudflare.com/client/v4/accounts/<account>/browser-run 401 for <token>");
    expect(calls.at(-1)).toMatch(/^DELETE /);
  });
  it("fails with a redacted reason when no session can be started", async () => {
    await expect(openBrowser(planBrowser("browser-run", [], ENV), fake([{ status: 503 }]).transport)).rejects.toThrow("could not start a Browser Run session: the service answered 503");
    await expect(openBrowser(planBrowser("browser-run", [], ENV), fake([{ status: 200, body: {} }]).transport)).rejects.toThrow(/named no session/);
    // an id that would change the path is refused where it is read: nothing is connected to and nothing is deleted with it
    const odd = fake([{ status: 200, body: { sessionId: "../../zones" } }, { status: 200 }]);
    await expect(openBrowser(planBrowser("browser-run", [], ENV), odd.transport)).rejects.toThrow(/named no session this tool recognises/);
    expect(odd.calls).toHaveLength(1);
    await expect(openBrowser(planBrowser("browser-run", [], ENV), fake([new Error(`getaddrinfo failed for ${ACCOUNT}`)]).transport)).rejects.toThrow("could not start a Browser Run session: getaddrinfo failed for <account>");
  });
});
