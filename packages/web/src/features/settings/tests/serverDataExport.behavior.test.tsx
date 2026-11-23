// Settings › Administration › Data & privacy (ServerDataPrivacySection.tsx;
// one section with the product analytics switch;
// server routes/dataExports.ts, routes/servers.ts data-export-settings):
// hidden unless the server's list answers `available` (the 404 while the
// flag is off, `available` false for a non-owner); the owner's context
// switch saved on toggle; the request dialog's summary, then the scope sent
// to the server's mount with its X-Server-Id; the personal dialog offering
// context only for a server that allows it; a server export's emailed link
// landing on that server's administration settings. The API is stubbed at
// the axios client.
import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, test } from "vitest";

import api from "../../../api/client";
import SecondFactorStepUpHost from "../../../components/settings/SecondFactorStepUpHost";
import { resetSecondFactorStepUpForTests } from "../../../components/settings/secondFactorStepUp";
import { IntlProviderWrapper } from "../../../i18n/IntlProviderWrapper";
import { LocaleProvider } from "../../../i18n/LocaleProvider";
import { useServerStore } from "../../../store/serverStore";
import { dataExportLandingPath } from "../../../utils/dataExportLink";
import { DataPrivacySection } from "../account/DataExportSection";
import { ServerDataPrivacySection } from "../administration/ServerDataPrivacySection";
import DeleteServerConfirmDialog from "../../../components/settings/DeleteServerConfirmDialog";

const SERVER = "66666666-6666-4666-8666-666666666666";
const EXPORT = "77777777-7777-4777-8777-777777777777";
const originals = { get: api.get, post: api.post, patch: api.patch };

afterEach(() => {
  cleanup();
  resetSecondFactorStepUpForTests();
  Object.assign(api, originals);
  useServerStore.setState({ current: null } as never);
});

type Call = { method: string; url: string; body: unknown; serverHeader: unknown };
type Handler = (body: unknown) => unknown;

function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
}

/** Every method answers by url from `routes` (a function so a test can change it). */
function stubApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const answer = (method: string) => (async (url: string, ...rest: unknown[]) => {
    const body = method === "GET" ? undefined : rest[0];
    const config = (method === "GET" ? rest[0] : rest[1]) as { headers?: Record<string, unknown> } | undefined;
    calls.push({ method, url, body, serverHeader: config?.headers?.["X-Server-Id"] });
    const handler = routes[`${method} ${url}`];
    if (!handler) throw new Error(`Unexpected ${method} ${url}`);
    return { data: handler(body) };
  });
  api.get = answer("GET") as typeof api.get;
  api.post = answer("POST") as typeof api.post;
  api.patch = answer("PATCH") as typeof api.patch;
  return calls;
}

function renderWith(node: React.ReactNode) {
  return render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <MemoryRouter initialEntries={["/s/acme/settings/administration"]}>
          {node}
          <SecondFactorStepUpHost />
        </MemoryRouter>
      </IntlProviderWrapper>
    </LocaleProvider>,
  );
}

const asOwner = () => useServerStore.setState({ current: { id: SERVER, slug: "acme", name: "Acme", role: "owner" } } as never);
const LIST = `/servers/${SERVER}/data-exports`;
const SETTINGS = `/servers/${SERVER}/data-export-settings`;

test("hidden while the server's list answers 404 (the flag off) or not `available` (not an owner)", async () => {
  asOwner();
  const calls = stubApi({ [`GET ${LIST}`]: () => { throw httpError(404, { code: "not_found" }); } });
  const { unmount } = renderWith(<ServerDataPrivacySection />);
  await waitFor(() => assert.ok(calls.some((call) => call.url === LIST)));
  assert.ok(screen.queryByTestId("server-data-export-section") === null, "no section");
  unmount();
  stubApi({ [`GET ${LIST}`]: () => ({ exports: [], available: false, nextAllowedAt: null, closed: false }) });
  renderWith(<ServerDataPrivacySection />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(screen.queryByTestId("server-data-export-section") === null, "no section");
});

test("with product analytics: one Data & privacy section while data export is on; Product analytics alone while it is off", async () => {
  asOwner();
  const ANALYTICS = `/servers/${SERVER}/product-analytics-settings`;
  const analytics = () => ({ productAnalyticsEnabled: true, canManageProductAnalytics: true });
  const calls = stubApi({ [`GET ${LIST}`]: () => { throw httpError(404, { code: "not_found" }); }, [`GET ${ANALYTICS}`]: analytics });
  const { unmount } = renderWith(<ServerDataPrivacySection />);
  await waitFor(() => assert.ok(calls.some((call) => call.url === LIST)));
  await screen.findByText("Product analytics");
  assert.ok(screen.queryByText("Data & privacy") === null, "no Data & privacy header");
  assert.ok(screen.queryByTestId("server-data-export-section") === null, "no export");
  unmount();
  stubApi({
    [`GET ${LIST}`]: () => ({ exports: [], available: true, nextAllowedAt: null, closed: false }),
    [`GET ${SETTINGS}`]: () => ({ memberContextExportEnabled: false, canManage: true }),
    [`GET ${ANALYTICS}`]: analytics,
  });
  renderWith(<ServerDataPrivacySection />);
  const exportSection = await screen.findByTestId("server-data-export-section");
  assert.equal(screen.getAllByText("Data & privacy").length, 1);
  assert.ok(screen.queryByText("Product analytics") === null, "no Product analytics header");
  assert.ok(screen.getByText("Product analytics for this workspace"), "the analytics switch, in the same section");
  assert.ok(exportSection.parentElement?.contains(screen.getByText("Product analytics for this workspace")), "one section holds both");
});

test("the owner's context switch reads the setting and saves on toggle", async () => {
  asOwner();
  let enabled = false;
  const calls = stubApi({
    [`GET ${LIST}`]: () => ({ exports: [], available: true, nextAllowedAt: null, closed: false }),
    [`GET ${SETTINGS}`]: () => ({ memberContextExportEnabled: enabled, canManage: true }),
    [`PATCH ${SETTINGS}`]: (body) => {
      enabled = (body as { memberContextExportEnabled: boolean }).memberContextExportEnabled;
      return { memberContextExportEnabled: enabled, canManage: true };
    },
  });
  renderWith(<ServerDataPrivacySection />);
  const toggle = await screen.findByTestId("server-data-export-context-switch");
  await waitFor(() => assert.equal(toggle.hasAttribute("disabled") || toggle.getAttribute("aria-disabled") === "true", false));
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "true"));
  assert.deepEqual(calls.filter((call) => call.method === "PATCH").map((call) => [call.url, call.body, call.serverHeader]), [[SETTINGS, { memberContextExportEnabled: true }, SERVER]]);
});

test("request: the summary shows before asking; the scope goes to the server's mount with its X-Server-Id; the new export shows as preparing", async () => {
  asOwner();
  const created = { id: EXPORT, kind: "server", status: "queued", createdAt: new Date().toISOString(), expiresAt: null, sizeBytes: null, volumes: [], errorCode: null };
  let exports: unknown[] = [];
  const calls = stubApi({
    [`GET ${LIST}`]: () => ({ exports, available: true, nextAllowedAt: null, closed: false }),
    [`GET ${SETTINGS}`]: () => ({ memberContextExportEnabled: false, canManage: true }),
    [`GET ${LIST}/summary`]: () => ({ publicChannels: 3, messages: 1200, messagesCapped: false, files: 4, fileBytes: 2048, filesCapped: false, historyFrom: "2026-10-19T00:00:00.000Z" }),
    [`POST ${LIST}`]: () => {
      exports = [created];
      return { export: created };
    },
  });
  renderWith(<ServerDataPrivacySection />);
  fireEvent.click(await screen.findByTestId("server-data-export-request"));
  const dialog = await screen.findByTestId("data-export-dialog-scope");
  const summary = within(dialog).getByTestId("server-data-export-summary");
  await waitFor(() => assert.match(summary.textContent ?? "", /3 public channels, 1,200 messages and 4 files/));
  assert.match(summary.textContent ?? "", /October 19/);
  fireEvent.click(within(dialog).getByTestId("server-data-export-include-files"));
  fireEvent.click(within(dialog).getByTestId("data-export-submit"));
  await waitFor(() => assert.ok(screen.queryByTestId("data-export-dialog-scope") === null, "the dialog closed"));
  assert.deepEqual(calls.filter((call) => call.method === "POST").map((call) => [call.url, call.body, call.serverHeader]),
    [[LIST, { scope: { includeFiles: true, fullHistoryAfterClose: false } }, SERVER]]);
  assert.match((await screen.findByTestId(`data-export-row-${EXPORT}`)).textContent ?? "", /Preparing/);
});

test("the personal dialog offers context only when a server in scope allows it, and sends it then", async () => {
  useServerStore.setState({ servers: [{ id: SERVER, slug: "acme", name: "Acme" }] } as never);
  let contextServerIds: string[] = [];
  const calls = stubApi({
    "GET /me/data-exports": () => ({ exports: [], available: true, nextAllowedAt: null, contextServerIds }),
    "POST /me/data-exports": () => ({ export: null }),
  });
  const { unmount } = renderWith(<DataPrivacySection />);
  fireEvent.click(await screen.findByTestId("data-export-request"));
  assert.ok(within(await screen.findByTestId("data-export-dialog-scope")).queryByTestId("data-export-include-context") === null, "no context option");
  unmount();

  contextServerIds = [SERVER];
  renderWith(<DataPrivacySection />);
  fireEvent.click(await screen.findByTestId("data-export-request"));
  const dialog = await screen.findByTestId("data-export-dialog-scope");
  fireEvent.click(within(dialog).getByTestId("data-export-include-context"));
  fireEvent.click(within(dialog).getByTestId("data-export-submit"));
  await waitFor(() => assert.ok(calls.some((call) => call.method === "POST")));
  assert.deepEqual(calls.filter((call) => call.method === "POST").map((call) => call.body), [{ scope: { serverIds: "all", includeContext: true, includeFiles: false } }]);
});

test("a server export's emailed link lands on that server's administration settings; one naming a server the person isn't in, on the account settings", () => {
  const servers = [{ id: SERVER, slug: "acme" }, { id: "88888888-8888-4888-8888-888888888888", slug: "last" }];
  assert.equal(dataExportLandingPath(`?data_export=${EXPORT}&data_export_server=${SERVER}`, servers, "last"), `/s/acme/settings/administration?data_export=${EXPORT}#server-data-export`);
  assert.equal(dataExportLandingPath(`?data_export=${EXPORT}&data_export_server=99999999-9999-4999-8999-999999999999`, servers, "last"), `/s/last/settings/account?data_export=${EXPORT}#data-export`);
});

test("the close-server confirmation points an owner who may export to Data & privacy, to export before closing; nothing while export is off there", async () => {
  asOwner();
  let available = true;
  const calls = stubApi({ [`GET ${LIST}`]: () => ({ exports: [], available, nextAllowedAt: null, closed: false }) });
  const { unmount } = renderWith(<DeleteServerConfirmDialog onClose={() => undefined} />);
  const hint = await screen.findByTestId("server-delete-export-hint");
  assert.match(hint.textContent ?? "", /before you delete it.*Data & privacy/);
  assert.ok(!/30 days/.test(hint.textContent ?? ""), "no promise about after closing");
  unmount();
  available = false;
  renderWith(<DeleteServerConfirmDialog onClose={() => undefined} />);
  await waitFor(() => assert.equal(calls.filter((call) => call.url === LIST).length, 2));
  assert.ok(screen.queryByTestId("server-delete-export-hint") === null, "no hint");
});
